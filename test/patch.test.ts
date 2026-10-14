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
import { runChain } from "../src/chain.js";
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
