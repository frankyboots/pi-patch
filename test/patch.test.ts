/**
 * pi-patch test corpus — Tier 1 acceptance per docs/PLAN.md:
 * the strategy chain, per-strategy uniqueness counting, replacement shaping,
 * teaching errors, and the tool-level file behaviors (multi-edit, overlap,
 * CRLF/BOM, already-applied no-op, argument normalization).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { runChain } from "../src/chain.js";
import {
	buildOrigToNormMap,
	calculateLinePositions,
	collapseWhitespace,
	exactSpans,
	mapNormalizedPositions,
	mapPositionsNormToOrig,
	matchTransformedLines,
	stripBoundary,
	unicodeNormalize,
	windowSpans,
	type Span,
} from "../src/span-map.js";
import { reindentReplacement } from "../src/shaping.js";
import { createPatchToolDefinition, prepareEditArguments } from "../src/tool.js";
import { generateDiffString } from "../src/diff-utils.js";

describe("chain: strategy selection", () => {
	it("matches exactly and reports the exact span", () => {
		const content = "alpha\nbeta\ngamma\n";
		const r = runChain(content, "beta");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.match.strategy).toBe("exact");
			expect(r.match.exact).toBe(true);
			expect(content.slice(r.match.start, r.match.end)).toBe("beta");
		}
	});

	it("falls back to line_trimmed when the pattern is not an exact substring", () => {
		// model added indentation the file does not have; margin whitespace churn too
		const content = "function f() {\nreturn 1;   \n}\n";
		const r = runChain(content, "\treturn 1;");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.match.strategy).toBe("line_trimmed");
			expect(r.match.exact).toBe(false);
			// span keeps the file's real bytes, including the margin
			expect(content.slice(r.match.start, r.match.end)).toBe("return 1;   ");
		}
	});

	it("survives the pi false-ambiguity regression: two regions differing only by smart quotes stay unique", () => {
		// pi normalizes-then-counts and reports "Found 2 occurrences" here;
		// per-strategy counting must keep the exact match unique.
		const content = 'say("he said \u201chello\u201d")\nsay("plain")\n';
		const r = runChain(content, 'say("plain")');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.match.strategy).toBe("exact");
	});

	it("reports ambiguity with locations instead of guessing", () => {
		const content = "x = 1\ny = 2\nx = 1\n";
		const r = runChain(content, "x = 1");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.failure.kind).toBe("ambiguous");
			if (r.failure.kind === "ambiguous") {
				expect(r.failure.count).toBe(2);
				expect(r.failure.locations.length).toBeGreaterThanOrEqual(2);
			}
		}
	});

	it("fails with no_match when nothing is close", () => {
		const r = runChain("a\nb\nc\n", "completely different text");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.failure.kind).toBe("no_match");
	});

	it("honors trailing-newline patterns", () => {
		const content = "one\ntwo\nthree\n";
		const r = runChain(content, "two\n");
		expect(r.ok).toBe(true);
		if (r.ok) expect(content.slice(r.match.start, r.match.end)).toBe("two\n");
	});
});

describe("shaping: reindent replacement", () => {
	it("re-anchors a dedented replacement onto the file's indent", () => {
		const oldText = "return 1;";
		const newText = "return 2;";
		const matched = "\treturn 1;   ";
		expect(reindentReplacement(oldText, newText, matched)).toBe("\treturn 2;");
	});

	it("preserves relative nesting when re-anchoring", () => {
		const oldText = "if (x) {\nreturn 1;\n}";
		const newText = "if (x) {\nreturn 2;\n}";
		const matched = "    if (x) {\n    return 1;\n    }";
		const out = reindentReplacement(oldText, newText, matched);
		expect(out).toBe("    if (x) {\n    return 2;\n    }");
	});

	it("leaves exact matches alone (patIndent === fileIndent)", () => {
		expect(reindentReplacement("a", "b", "a")).toBe("b");
	});
});

describe("diff-utils: display diff", () => {
	it("produces +/- rows with line numbers and firstChangedLine", () => {
		const oldC = "one\ntwo\nthree\n";
		const newC = "one\ntwo!\nthree\n";
		const { diff, firstChangedLine } = generateDiffString(oldC, newC);
		expect(diff).toContain("-2 two");
		expect(diff).toContain("+2 two!");
		expect(firstChangedLine).toBe(2);
	});
});

describe("tool: prepareEditArguments", () => {
	it("parses edits from a JSON string (model drift)", () => {
		const out = prepareEditArguments({ path: "f", edits: '[{"oldText":"a","newText":"b"}]' });
		expect(out.edits).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("wraps a single edit object into edits[]", () => {
		const out = prepareEditArguments({ path: "f", edits: { oldText: "a", newText: "b" } });
		expect(out.edits).toHaveLength(1);
	});

	it("accepts legacy flat oldText/newText", () => {
		const out = prepareEditArguments({ path: "f", oldText: "a", newText: "b" });
		expect(out.edits).toEqual([{ oldText: "a", newText: "b" }]);
	});
});

describe("tool: execute against real files", () => {
	async function tmpFile(content: string): Promise<{ dir: string; file: string; name: string }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-"));
		const file = path.join(dir, "sample.txt");
		await fs.writeFile(file, content, "utf-8");
		return { dir, file, name: "sample.txt" };
	}

	const tool = createPatchToolDefinition("/tmp");

	async function run(input: object, cwd: string) {
		return tool.execute("test-call", input as never, undefined, undefined, { cwd } as never);
	}

	it("applies an edit with indent shaping and returns a model-facing diff", async () => {
		const { dir, file, name } = await tmpFile("function f() {\n\treturn 1;\n}\n");
		const res = await run(
			{ path: name, edits: [{ oldText: "  return 1;", newText: "  return 42;" }] },
			dir,
		);
		const after = await fs.readFile(file, "utf-8");
		expect(after).toBe("function f() {\n\treturn 42;\n}\n");
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(text).toContain("---"); // unified patch in model-facing content
		expect(res.details?.firstChangedLine).toBe(2);
	});

	it("applies multiple disjoint edits all-or-nothing against the same snapshot", async () => {
		const { dir, file, name } = await tmpFile("a\nb\nc\nd\n");
		const res = await run(
			{ path: name, edits: [{ oldText: "a", newText: "A" }, { oldText: "d", newText: "D" }] },
			dir,
		);
		expect(await fs.readFile(file, "utf-8")).toBe("A\nb\nc\nD\n");
		expect(res.details?.diff).toContain("+1 A");
		expect(res.details?.diff).toContain("+4 D");
	});

	it("rejects overlapping edits without writing", async () => {
		const { dir, file, name } = await tmpFile("keep\nchange me please\nkeep\n");
		await expect(
			run(
				{
					path: name,
					edits: [
						{ oldText: "change me", newText: "x" },
						{ oldText: "me please", newText: "y" },
					],
				},
				dir,
			),
		).rejects.toThrow(/overlapping/i);
		expect(await fs.readFile(file, "utf-8")).toBe("keep\nchange me please\nkeep\n");
	});

	it("preserves CRLF line endings and BOM", async () => {
		const { dir, file, name } = await tmpFile("\uFEFFone\r\ntwo\r\n");
		await run({ path: name, edits: [{ oldText: "two", newText: "TWO" }] }, dir);
		const raw = await fs.readFile(file, "utf-8");
		expect(raw).toBe("\uFEFFone\r\nTWO\r\n");
	});

	it("returns a success-shaped no-op for an already-applied edit", async () => {
		const { dir, file, name } = await tmpFile("value = 42\n");
		const res = await run({ path: name, edits: [{ oldText: "value = 41", newText: "value = 42" }] }, dir);
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toMatch(/already applied/);
		expect(await fs.readFile(file, "utf-8")).toBe("value = 42\n");
	});

	it("ambiguity errors name the match locations", async () => {
		const { dir, name } = await tmpFile("dup\nmid\ndup\n");
		await expect(
			run({ path: name, edits: [{ oldText: "dup", newText: "x" }] }, dir),
		).rejects.toThrow(/Found 2 matches[\s\S]*L1[\s\S]*L3/);
	});

	it("no-match errors carry the did-you-mean sections", async () => {
		const { dir, name } = await tmpFile("function compute() {\n\treturn 7;\n}\n");
		await expect(
			run({ path: name, edits: [{ oldText: "function comput() {\n\treturn 7;\n}", newText: "x" }] }, dir),
		).rejects.toThrow(/Did you mean one of these sections\?/);
	});

	it("identical old/new and empty old are rejected with recovery text", async () => {
		const { dir, name } = await tmpFile("abc\n");
		await expect(
			run({ path: name, edits: [{ oldText: "abc", newText: "abc" }] }, dir),
		).rejects.toThrow(/identical/);
		await expect(
			run({ path: name, edits: [{ oldText: "   ", newText: "x" }] }, dir),
		).rejects.toThrow(/whitespace-only|empty/);
	});
});

describe("span-map: hermes port unit tests", () => {
	it("unicodeNormalize maps every hermes UNICODE_MAP class and leaves ASCII alone", () => {
		expect(unicodeNormalize("a\u2014b\u2013c\u2026d\u00a0e\u2212f")).toBe("a--b-c...d e-f");
		expect(unicodeNormalize("\u201cq\u201d \u2018s\u2019 \u3000\u2007\u202f")).toBe('"q" \'s\'    ');
		expect(unicodeNormalize("plain ASCII stays")).toBe("plain ASCII stays");
	});

	it("exactSpans is non-overlapping (hermes re.finditer semantics)", () => {
		expect(exactSpans("aaaaaa", "aa").map((s) => [s.start, s.end])).toEqual([[0, 2], [2, 4], [4, 6]]);
		expect(exactSpans("abc", "")).toEqual([]);
		expect(exactSpans("xyz", "q")).toEqual([]);
	});

	it("astral characters pass through the unicode map in UTF-16 units (platform adaptation)", () => {
		// Python iterates code points; the TS port iterates UTF-16 units — the maps
		// must stay consistent with JS string indices so spans slice correctly.
		const content = "a\u{1D54F}\u2014b"; // 𝕏 (2 units) + em dash
		const norm = unicodeNormalize(content);
		expect(norm).toBe("a\u{1D54F}--b");
		const map = buildOrigToNormMap(content);
		expect(map).toEqual([0, 1, 2, 3, 5, 6]); // a, 𝕏-hi, 𝕏-lo, —, b, sentinel
		const mapped = mapPositionsNormToOrig(map, exactSpans(norm, "--"));
		expect(mapped).toEqual([{ start: 3, end: 4 }]);
		expect(content.slice(mapped[0].start, mapped[0].end)).toBe("\u2014");
	});

	it("whitespace collapse mapping keeps the word-boundary space after a match", () => {
		// hermes issue #52491: "foo bar" matching "foo   bar baz" must splice
		// "foo   bar" and leave the single separating space alone.
		const content = "foo   bar baz";
		const collapsed = collapseWhitespace(content);
		const mapped = mapNormalizedPositions(content, collapsed, exactSpans(collapsed, "foo bar"));
		expect(mapped).toEqual([{ start: 0, end: 9 }]);
		expect(content.slice(0, mapped[0].end) + content.slice(mapped[0].end)).toBe(content);
		expect(content.slice(0, mapped[0].end)).toBe("foo   bar");
	});

	it("whitespace collapse mapping absorbs a trailing run when the match ends in a space", () => {
		// pattern "foo " (trailing space) vs "foo   bar baz": the whole 3-space
		// run is part of the match, so a replacement keeps the separation.
		const content = "foo   bar baz";
		const collapsed = collapseWhitespace(content);
		const mapped = mapNormalizedPositions(content, collapsed, exactSpans(collapsed, "foo "));
		expect(mapped).toEqual([{ start: 0, end: 6 }]);
		expect(content.slice(0, mapped[0].end)).toBe("foo   ");
	});

	it("calculateLinePositions covers windows without the trailing newline and clamps to content", () => {
		const lines = "one\ntwo\nthree".split("\n");
		expect(calculateLinePositions(lines, 0, 1, 12)).toEqual({ start: 0, end: 3 });
		expect(calculateLinePositions(lines, 1, 2, 12)).toEqual({ start: 4, end: 7 });
		// final line has no newline; the span ends at the content length
		expect(calculateLinePositions(lines, 2, 3, 12)).toEqual({ start: 8, end: 12 });
	});

	it("stripBoundary strips only the first and last lines", () => {
		expect(stripBoundary(["  a  ", "  b  ", "  c  "])).toEqual(["a", "  b  ", "c"]);
		expect(stripBoundary(["  a  "])).toEqual(["a"]);
	});

	it("matchTransformedLines finds all windows and reports content-byte spans", () => {
		const content = "  x = 1\n\ty = 2\n  x = 1\n\ty = 2\n";
		const spans = matchTransformedLines(content, "x = 1\n\ty = 2", (ls) => ls.map((l) => l.trim()));
		// spans end at the last matched character — the newline after the window
		// is not part of the span (hermes _calculate_line_positions semantics)
		expect(spans).toEqual([
			{ start: 0, end: 14 },
			{ start: 15, end: 29 },
		]);
		expect(content.slice(spans[0].start, spans[0].end)).toBe("  x = 1\n\ty = 2");
	});
});

describe("span-map: golden differential vs hermes fuzzy_match.py", () => {
	interface GoldenCase {
		name: string;
		content: string;
		pattern: string;
		unicode: {
			norm_content: string;
			norm_pattern: string;
			content_map: number[];
			pattern_map: number[];
			norm_matches: [number, number][];
			mapped: [number, number][];
		};
		whitespace: {
			collapsed_content: string;
			collapsed_pattern: string;
			norm_matches: [number, number][];
			mapped: [number, number][];
		};
		lines_strip: [number, number][];
		lines_lstrip: [number, number][];
		lines_strip_boundary: [number, number][];
		line_positions: [number, number, number, number][];
	}

	const doc = JSON.parse(
		readFileSync(new URL("./golden/span-map.json", import.meta.url), "utf-8"),
	) as { cases: GoldenCase[] };

	const pairs = (spans: Span[]): [number, number][] => spans.map((s) => [s.start, s.end]);

	for (const c of doc.cases) {
		it(`matches hermes: ${c.name}`, () => {
			// Unicode space (strategy 7 plumbing)
			expect(unicodeNormalize(c.content)).toBe(c.unicode.norm_content);
			expect(unicodeNormalize(c.pattern)).toBe(c.unicode.norm_pattern);
			expect(buildOrigToNormMap(c.content)).toEqual(c.unicode.content_map);
			expect(buildOrigToNormMap(c.pattern)).toEqual(c.unicode.pattern_map);
			const normMatches = exactSpans(c.unicode.norm_content, c.unicode.norm_pattern);
			expect(pairs(normMatches)).toEqual(c.unicode.norm_matches);
			expect(pairs(mapPositionsNormToOrig(buildOrigToNormMap(c.content), normMatches)))
				.toEqual(c.unicode.mapped);

			// Whitespace space (strategy 3 plumbing)
			const collapsed = collapseWhitespace(c.content);
			expect(collapsed).toBe(c.whitespace.collapsed_content);
			expect(collapseWhitespace(c.pattern)).toBe(c.whitespace.collapsed_pattern);
			const wsMatches = exactSpans(collapsed, c.whitespace.collapsed_pattern);
			expect(pairs(wsMatches)).toEqual(c.whitespace.norm_matches);
			expect(pairs(mapNormalizedPositions(c.content, collapsed, wsMatches)))
				.toEqual(c.whitespace.mapped);

			// Line-window strategies
			expect(pairs(matchTransformedLines(c.content, c.pattern, (ls) => ls.map((l) => l.trim()))))
				.toEqual(c.lines_strip);
			expect(pairs(matchTransformedLines(c.content, c.pattern, (ls) => ls.map((l) => l.replace(/^\s+/, "")))))
				.toEqual(c.lines_lstrip);
			expect(pairs(matchTransformedLines(c.content, c.pattern, stripBoundary)))
				.toEqual(c.lines_strip_boundary);

			// Windowing math: every recorded (i, j) window, plus windowSpans
			// consistency for n = 1..3 (accept always → all windows of that size).
			const lines = c.content.split("\n");
			for (const [i, j, start, end] of c.line_positions) {
				expect(calculateLinePositions(lines, i, j, c.content.length)).toEqual({ start, end });
			}
			for (const n of [1, 2, 3]) {
				const expected = c.line_positions
					.filter(([i, j]) => j - i === n)
					.map(([, , start, end]) => ({ start, end }));
				expect(windowSpans(c.content, lines, n, () => true)).toEqual(expected);
			}
		});
	}
});
