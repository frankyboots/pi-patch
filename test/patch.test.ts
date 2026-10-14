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
import {
	runChain,
	strategyContextAware,
	strategyEscapeNormalized,
} from "../src/chain.js";
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
import { detectEscapeDrift } from "../src/escape-drift.js";
import { escapeDriftErrorMessage } from "../src/errors.js";
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
			expect(content.slice(r.match.spans[0].start, r.match.spans[0].end)).toBe("beta");
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
			expect(content.slice(r.match.spans[0].start, r.match.spans[0].end)).toBe("return 1;   ");
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
		if (r.ok) expect(content.slice(r.match.spans[0].start, r.match.spans[0].end)).toBe("two\n");
	});
});

// ── hermes corpus port (tests/tools/test_fuzzy_match.py) ─────────────────
//
// Ported per docs/PLAN.md's validation bar. `fuzzyReplace` mirrors hermes'
// fuzzy_find_and_replace: chain (replaceAll included, Tier 1 #2) + escape-drift
// guards on non-exact matches (Tier 1 #3) + splice with reindent shaping onto
// EACH region. Unicode-preserving replacement opcodes (Tier 1 #4) land with
// that step — corpus cases needing them are ported there.

function fuzzyReplace(
	content: string,
	oldText: string,
	newText: string,
	opts: { replaceAll?: boolean } = {},
): { ok: true; out: string; count: number; strategy: string } | { ok: false; error: string } {
	const r = runChain(content, oldText, { ...opts, newText });
	if (!r.ok) {
		return {
			ok: false,
			error:
				r.failure.kind === "ambiguous"
					? `Found ${r.failure.count} matches for old_string.`
					: r.failure.kind === "escape_drift"
						// hermes returns the raw drift text from the orchestrator
						? escapeDriftErrorMessage("f", 1, r.failure.drift)
						: r.failure.kind === "replace_all_similarity"
							? "replace_all only applies to exact matches"
							: "Could not find a match for old_string in the file",
		};
	}
	// hermes _apply_replacements: splice end-to-start; non-exact matches are
	// re-indented onto each region's own indent (regions slice the ORIGINAL
	// content — offsets stay valid because spans never overlap).
	let out = content;
	for (const span of [...r.match.spans].reverse()) {
		const replacement = r.match.exact
			? newText
			: reindentReplacement(oldText, newText, content.slice(span.start, span.end));
		out = out.slice(0, span.start) + replacement + out.slice(span.end);
	}
	return { ok: true, out, count: r.match.spans.length, strategy: r.match.strategy };
}

describe("corpus: TestWhitespaceDifference (hermes)", () => {
	it("test_extra_spaces_match", () => {
		const r = fuzzyReplace("def  foo(  x,  y  ):", "def foo( x, y ):", "def bar(x, y):");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "whitespace_normalized" });
		if (r.ok) expect(r.out).toBe("def bar(x, y):");
	});

	it("test_boundary_space_preserved_after_match (issue #52491)", () => {
		// A whitespace_normalized match ending in a non-space character must NOT
		// consume the word-boundary space that follows.
		const r = fuzzyReplace("foo   bar baz", "foo bar", "XY");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "whitespace_normalized" });
		if (r.ok) expect(r.out).toBe("XY baz");
	});

	it("test_boundary_space_preserved_in_code_edit", () => {
		const r = fuzzyReplace("result = compute(a,  b) + tail", "compute(a, b)", "compute(a, b, c)");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "whitespace_normalized" });
		if (r.ok) expect(r.out).toBe("result = compute(a, b, c) + tail");
	});

	it("test_trailing_ws_still_consumed_when_match_ends_with_space", () => {
		// Pattern's trailing space sits inside a whitespace RUN in the file —
		// the whole run is part of the match.
		const r = fuzzyReplace("a = foo   + bar", "foo +", "XY");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "whitespace_normalized" });
		if (r.ok) expect(r.out).toBe("a = XY bar");
	});
});

describe("corpus: indentation (hermes)", () => {
	it("TestIndentDifference.test_different_indentation", () => {
		const r = fuzzyReplace(
			"    def foo():\n        pass",
			"def foo():\n    pass",
			"def bar():\n    return 1",
		);
		expect(r).toMatchObject({ ok: true, count: 1 });
		if (r.ok) expect(r.out).toContain("bar");
	});

	it("TestIndentationPreservation: unindented input re-indented to match file", () => {
		const content = "class Calculator:\n    def add(self, a, b):\n        result = a + b\n        return result\n";
		const r = fuzzyReplace(
			content,
			"result = a + b\nreturn result",
			"result = a + b\nresult *= 2\nreturn result",
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.strategy).not.toBe("exact");
		for (const marker of ["result = a + b", "result *= 2", "return result"]) {
			const line = r.out.split("\n").find((l) => l.includes(marker));
			expect(line?.length).toBe(8 + marker.length); // 8-space indent
		}
	});

	it("TestIndentationPreservation: blank lines left alone", () => {
		const r = fuzzyReplace("    a = 1\n    b = 2\n", "a = 1\nb = 2", "a = 1\n\nb = 99");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const lines = r.out.split("\n");
		expect(lines[0]).toBe("    a = 1");
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("    b = 99");
	});
});

describe("corpus: TestUnicodeNormalized (hermes)", () => {
	it("test_em_dash_matched", () => {
		const r = fuzzyReplace(
			"return value\u2014fallback",
			"return value--fallback",
			"return value or fallback",
		);
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "unicode_normalized" });
		if (r.ok) expect(r.out).toContain("return value or fallback");
	});

	// The remaining TestUnicodeNormalized/SpaceAndMinus cases (ellipsis, mixed
	// multiline, expansion boundaries, unicode minus, ideographic space) assert
	// the FILE's typographic characters survive the replacement — that is the
	// unicode-preserving opcode application, landing with Tier 1 #4. Until then,
	// pin the matching side: right strategy, right ORIGINAL bytes matched.
	it("matches at unicode_normalized with spans into the original bytes", () => {
		const cases: [string, string][] = [
			["Wait for it\u2026and done", "Wait for it...and done"],
			["value = x\u2014y\n", "value = x--y"],
			["offset = value \u2212 1\nprint(offset)\n", "offset = value - 1"],
			["\u6a19\u984c\u3000\u7b2c\u4e00\u7ae0\nbody text\n", "\u6a19\u984c \u7b2c\u4e00\u7ae0"],
		];
		for (const [content, pattern] of cases) {
			const r = runChain(content, pattern);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.match.strategy).toBe("unicode_normalized");
				expect(content.slice(r.match.spans[0].start, r.match.spans[0].end)).not.toContain("--"); // original bytes, not the normalized form
			}
		}
		// em-dash expansion boundary: the span must snap to the expansion's
		// original byte, not shift positions (hermes equal-boundary regression).
		const r = runChain("value = x\u2014y\n", "value = x--y");
		expect(r.ok).toBe(true);
		if (r.ok) expect("value = x\u2014y\n".slice(r.match.spans[0].start, r.match.spans[0].end)).toBe("value = x\u2014y");
	});
});

describe("corpus: TestBlockAnchorThreshold (hermes)", () => {
	it("test_high_similarity_matches", () => {
		const r = fuzzyReplace(
			"def foo():\n    x = 1\n    y = 2\n    return x + y\n",
			"def foo():\n    x = 1\n    y = 9\n    return x + y",
			"def foo():\n    return 0\n",
		);
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "block_anchor" });
	});

	it("test_completely_different_middle_does_not_match", () => {
		const r = fuzzyReplace(
			"class Foo:\n    completely = 'unrelated'\n    content = 'here'\n    nothing = 'in common'\n    pass\n",
			"class Foo:\n    x = 1\n    y = 2\n    z = 3\n    pass",
			"replaced",
		);
		expect(r).toMatchObject({ ok: false, error: "Could not find a match for old_string in the file" });
	});
});

describe("corpus: escape_normalized (hermes)", () => {
	it("literal \\t in the pattern matches the file's real tab", () => {
		// Matching side of TestEscapeNormalizedNewString.test_tab_in_new_string_
		// unescaped_under_escape_normalized; the new_string unescape lands in #4.
		const content = "def hello():\n\tprint(\"before\")\n";
		const r = runChain(content, "def hello():\n\\tprint(\"before\")\n");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.match.strategy).toBe("escape_normalized");
			expect(content.slice(r.match.spans[0].start, r.match.spans[0].end)).toBe(content);
		}
	});

	it("literal \\r in the pattern matches the file's real CR (chain level, raw bytes)", () => {
		// Matching side of test_carriage_return_in_new_string_unescaped. The
		// TOOL layer pre-normalizes LF (deviations ledger #2), so a literal-\r
		// anchor on a CRLF file falls through to the similarity rungs there;
		// at chain level the strategy behaves exactly like hermes.
		const content = "line1\r\nline2\r\n";
		const r = runChain(content, "line1\\r\nline2\\r\n");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.match.strategy).toBe("escape_normalized");
			expect(content.slice(r.match.spans[0].start, r.match.spans[0].end)).toBe(content);
		}
	});

	it("literal \\n in the pattern matches the file's real newline", () => {
		// Matching side of TestNewlineLiteralDrift.test_drifted_line_break_rejected;
		// the drift GUARD that blocks the write is ported below (Tier 1 #3).
		const content = 'def greet():\n    print("hi")\n';
		const r = runChain(content, 'def greet():\\n    print("hi")');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.match.strategy).toBe("escape_normalized");
			expect(content.slice(r.match.spans[0].start, r.match.spans[0].end)).toBe(content.slice(0, -1));
		}
	});

	it("is inert when the pattern has no escape sequences", () => {
		expect(strategyEscapeNormalized("abc", "abc")).toEqual([]);
		expect(strategyEscapeNormalized("a\\qb", "a\\qb")).toEqual([]);
	});
});

describe("corpus: TestEscapeDriftGuard (hermes)", () => {
	it("test_drift_blocked_apostrophe", () => {
		// File has ', old/new both carry \' — classic tool-call drift. The guard
		// must block with a helpful error instead of writing \' literals into
		// source code (the match itself lands via line_trimmed).
		const content = "line\n    x = 1\nline";
		const r = fuzzyReplace(content, "line\n  x = \\'a\\'\nline", "line\n  x = \\'b\\'\nline");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("Escape-drift");
			expect(r.error.toLowerCase()).toContain("backslash");
		}
	});

	it("test_drift_blocked_double_quote", () => {
		// Same idea but with \" drift instead of \'
		const content = "line\n    x = 1\nline";
		const r = fuzzyReplace(content, 'line\n  x = \\"a\\"\nline', 'line\n  x = \\"b\\"\nline');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("Escape-drift");
	});

	it("test_drift_allowed_when_file_genuinely_has_backslash_escapes", () => {
		// The file already contains \' (existing escaped string) — the model is
		// legitimately preserving it; the guard must NOT fire.
		const content = "line\n  x = \\'a\\'\nline";
		const r = fuzzyReplace(content, "line\n  x = \\'a\\'\nline", "line\n  x = \\'b\\'\nline");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.count).toBe(1);
			expect(r.out).toBe("line\n  x = \\'b\\'\nline");
		}
	});

	it("test_drift_allowed_on_exact_match", () => {
		// Exact matches bypass the drift guard entirely — if the file really
		// contains the exact bytes oldText specified, it's not drift.
		const content = "hello \\'world\\'";
		const r = fuzzyReplace(content, "hello \\'world\\'", "hello \\'there\\'");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.count).toBe(1);
			expect(r.strategy).toBe("exact");
			expect(r.out).toBe("hello \\'there\\'");
		}
	});

	it("test_no_drift_check_when_new_string_lacks_suspect_chars", () => {
		// Fast path: no \' or \" in newText and no backslash in oldText —
		// the guard must not fire even on a fuzzy match.
		const r = fuzzyReplace("def foo():\n    pass", "def foo():\n  pass", "def bar():\n  return 1");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.count).toBe(1);
	});
});

describe("corpus: TestNewlineLiteralDrift (hermes)", () => {
	it("test_drifted_line_break_rejected", () => {
		// A line break escaped one extra time arrives as literal backslash + n;
		// escape_normalized still matches it, but the guard blocks the write.
		const content = 'def greet():\n    print("hi")\n';
		const r = fuzzyReplace(
			content,
			'def greet():\\n    print("hi")',
			'def greet():\\n    print("hello")',
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("Escape-drift");
	});

	it("test_legitimate_backslash_n_in_code_applies", () => {
		// Non-exact match (indent differs) on code that really contains "\n":
		// the file-side literal counts, so the guard stays silent.
		const r = fuzzyReplace(
			'def greet():\n    print("hi\\n")\n    return 1\n',
			'def greet():\n  print("hi\\n")\n  return 1',
			'def greet():\n  print("hello\\n")\n  return 1',
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.count).toBe(1);
			expect(r.out).toContain('print("hello\\n")');
		}
	});

	it("test_drift_next_to_legitimate_backslash_n_rejected", () => {
		// One drifted line break plus a "\n" the code really has: the file-side
		// literal must not mask the drifted one (context_aware lands this).
		const r = fuzzyReplace(
			'def greet():\n    message = build_greeting_message("hi\\n")\n    return message\n',
			'def greet():\\n    message = build_greeting_message("hi\\n")\n    return message',
			'def greet():\\n    message = build_greeting_message("hello\\n")\n    return message',
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("Escape-drift");
	});

	it("test_drift_rejected_under_replace_all", () => {
		// Regions are compared one by one — joining them would multiply the
		// file-side literal count.
		const r = fuzzyReplace(
			"x = 1\ny = 2\n\nx = 1\ny = 2\n",
			"x = 1\\ny = 2",
			"x = 1\\ny = 3",
			{ replaceAll: true },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("Escape-drift");
	});
});

describe("escape-drift: guard units (hermes _detect_escape_drift)", () => {
	const whole = (content: string): Span[] => [{ start: 0, end: content.length }];

	it("backslash doubling fires only when every run is exactly 2x the file's", () => {
		const regions = "a\\\\b"; // one run of 2 in the file
		const old = "a\\\\\\\\b"; // one run of 4 in oldText
		expect(detectEscapeDrift(regions, whole(regions), old, "a\\\\\\\\c")).toEqual({
			kind: "backslash_doubling",
		});
		// newText already matches the file's counts — nothing to fix
		expect(detectEscapeDrift(regions, whole(regions), old, "a\\\\c")).toBeUndefined();
		// 2x relation violated (3 is not 2*2)
		expect(detectEscapeDrift(regions, whole(regions), "a\\\\\\\\\\\\b", "x")).toBeUndefined();
		// trivial signal: a single run of 1 in the file
		expect(detectEscapeDrift("a\\b", whole("a\\b"), "a\\\\b", "x")).toBeUndefined();
		// non-trivial: 2+ runs, each exactly doubled
		expect(detectEscapeDrift("a\\b", whole("a\\b"), "a\\\\b", "a\\\\\\\\b")).toBeUndefined();
	});

	it("quote suspects need both strings, and must be absent from the file", () => {
		// suspect only in newText — an edit that ADDS an escaped quote is legit
		expect(detectEscapeDrift("x = 1", whole("x = 1"), "x = 1", "x = \\'2\\'")).toBeUndefined();
		// file genuinely has the sequence — no drift
		expect(detectEscapeDrift("x = \\'1\\'", whole("x = \\'1\\'"), "x = \\'1\\'", "x = \\'2\\'")).toBeUndefined();
		// both strings carry it, file doesn't → drift
		expect(detectEscapeDrift("x = '1'", whole("x = '1'"), "x = \\'1\\'", "x = \\'2\\'")).toEqual({
			kind: "quote_suspect",
			suspect: "\\'",
			plain: "'",
		});
	});

	it("newline-literal guard: needs a literal in newText and a real break in the region", () => {
		// no literal \n in newText → never drift
		expect(detectEscapeDrift("a\nb", whole("a\nb"), "a\nb", "a\nc")).toBeUndefined();
		// region has no real newline → nothing for the literal to stand in for
		expect(detectEscapeDrift("a\\nb", whole("a\\nb"), "a\\nb", "a\\nc")).toBeUndefined();
		// the drifted case
		expect(detectEscapeDrift("a\nb", whole("a\nb"), "a\\nb", "a\\nc")).toEqual({
			kind: "newline_literal",
		});
	});
});

describe("escape-drift: teaching texts (Appendix B)", () => {
	// Byte-exact against the JSON-probed hermes messages, modulo the pi tool
	// name (read_file → read), param names (old_string/new_string → the old/new
	// text and our oldText/newText params), and the edit-#N-in-path context
	// (ledger #10 + the transitional multi-edit surface).
	it("quote-suspect message keeps hermes' repr formatting", () => {
		const msg = escapeDriftErrorMessage("f.py", 1, { kind: "quote_suspect", suspect: "\\'", plain: "'" });
		expect(msg).toBe(
			String.raw`Escape-drift detected: the old and new text of edit #1 in f.py contain the literal sequence "\\'" but the matched region of the file does not. This is almost always a tool-call serialization artifact where an apostrophe or quote got prefixed with a spurious backslash. Re-read the file with read and pass oldText/newText without backslash-escaping "'" characters.`,
		);
		const dquote = escapeDriftErrorMessage("f.py", 1, { kind: "quote_suspect", suspect: '\\"', plain: '"' });
		expect(dquote).toContain(String.raw`sequence '\\"'`);
		expect(dquote).toContain(String.raw`escaping '"' characters.`);
	});

	it("newline-literal message keeps hermes' repr formatting", () => {
		const msg = escapeDriftErrorMessage("f.py", 2, { kind: "newline_literal" });
		expect(msg).toBe(
			String.raw`Escape-drift detected: the old text of edit #2 in f.py contains more literal '\\n' sequences than the matched region of the file, which has real line breaks there instead. This is almost always a tool-call serialization artifact where a line break got escaped one extra time; the new text would write it as backslash + n. Re-read the file with read and pass oldText/newText with actual line breaks, keeping only the '\\n' sequences that appear literally in the file.`,
		);
	});

	it("backslash-doubling message keeps hermes' backtick examples", () => {
		const msg = escapeDriftErrorMessage("f.py", 1, { kind: "backslash_doubling" });
		expect(msg).toBe(
			String.raw`Escape-drift detected: every backslash run in the old text of edit #1 in f.py is exactly twice as long as in the matched region of the file (e.g. the file has ` +
				"`\\\\` where the old text has `\\\\\\\\`)." +
				String.raw` The tool-call arguments were JSON-escaped one extra time; applying the new text verbatim would double every backslash in the file. Re-read the file with read and resend oldText/newText with the backslash counts exactly as they appear in the file.`,
		);
	});
});

describe("corpus: TestContextAwareCorrectness (hermes)", () => {
	it("test_half_garbage_block_does_not_match", () => {
		const r = fuzzyReplace(
			"config_value = 100\nthreshold = 200\n",
			"config_value = 999\ntotally_unrelated_line_here",
			"config_value = 42\ntotally_unrelated_line_here",
		);
		expect(r).toMatchObject({ ok: false, error: "Could not find a match for old_string in the file" });
	});

	it("test_all_lines_matching_still_replaces (lands at block_anchor per chain order)", () => {
		const r = fuzzyReplace(
			"alpha one\nbeta two\ngamma three\n",
			"alpha one\nbeta 2\ngamma three",
			"alpha one\nbeta TWO\ngamma three",
		);
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "block_anchor" });
		if (r.ok) expect(r.out).toContain("beta TWO");
	});

	it("test_no_match_on_large_file_is_fast (anchor pre-filter)", () => {
		const big = Array.from({ length: 10000 }, (_, i) => `line ${i} content here`).join("\n");
		const patt = Array.from({ length: 40 }, (_, i) => `nomatch xyzzy ${i}`).join("\n");
		const start = performance.now();
		const matches = strategyContextAware(big, patt);
		const elapsed = (performance.now() - start) / 1000;
		expect(matches).toEqual([]);
		// Was ~5.5s before anchoring in hermes; generous ceiling to avoid CI flake.
		expect(elapsed).toBeLessThan(2.0);
	});
});

describe("corpus: TestReplaceAll (hermes)", () => {
	it("test_multiple_matches_without_flag_errors", () => {
		const r = fuzzyReplace("aaa bbb aaa", "aaa", "ccc");
		expect(r).toMatchObject({ ok: false, error: "Found 2 matches for old_string." });
	});

	it("test_multiple_matches_with_flag", () => {
		const r = fuzzyReplace("aaa bbb aaa", "aaa", "ccc", { replaceAll: true });
		expect(r).toMatchObject({ ok: true, count: 2, strategy: "exact" });
		if (r.ok) expect(r.out).toBe("ccc bbb ccc");
	});

	it("test_self_overlapping_pattern_non_overlapping_matches", () => {
		// hermes regression: exact must advance by len(pattern) (str.replace
		// semantics) — 2 non-overlapping matches in "aaaa", not 3 overlapping.
		const r = fuzzyReplace("aaaa", "aa", "b", { replaceAll: true });
		expect(r).toMatchObject({ ok: true, count: 2 });
		if (r.ok) expect(r.out).toBe("bb");

		// single-char pattern still counts every occurrence
		const single = fuzzyReplace("aaa", "a", "b", { replaceAll: true });
		expect(single).toMatchObject({ ok: true, count: 3 });
		if (single.ok) expect(single.out).toBe("bbb");

		// embedded in surrounding content — non-matched parts preserved
		const embedded = fuzzyReplace("prefix aaaa suffix", "aa", "b", { replaceAll: true });
		expect(embedded).toMatchObject({ ok: true, count: 2 });
		if (embedded.ok) expect(embedded.out).toBe("prefix bb suffix");

		// without the flag, the non-overlapping count is reported (2, not 3)
		const noFlag = fuzzyReplace("aaaa", "aa", "b");
		expect(noFlag).toMatchObject({ ok: false, error: "Found 2 matches for old_string." });
	});

	it("test_replace_all_refuses_similarity_strategy", () => {
		// 'aX\nbZ' never appears exactly; only approximately (bY != bZ) — and no
		// strategy clears its bar, so hermes reports a plain no-match.
		const r = fuzzyReplace("aX\nbY\naX\nbY\naX\nbY\n", "aX\nbZ", "QQ\nRR", { replaceAll: true });
		expect(r).toMatchObject({ ok: false, error: "Could not find a match for old_string in the file" });
	});

	it("refuses mass-overwrite when a similarity strategy finds several approximate blocks", () => {
		// hermes refusal path proper: block_anchor finds 2 approximate matches.
		const content = "start\nmid1\nend\nstart\nmid2\nend";
		const refused = fuzzyReplace(content, "start\nmid\nend", "QQ", { replaceAll: true });
		expect(refused).toMatchObject({ ok: false, error: "replace_all only applies to exact matches" });
		// the same call without the flag is the ordinary ambiguity error
		const ambiguous = fuzzyReplace(content, "start\nmid\nend", "QQ");
		expect(ambiguous).toMatchObject({ ok: false, error: "Found 2 matches for old_string." });
	});

	it("a single approximate match still applies under replace_all (hermes parity)", () => {
		const r = fuzzyReplace("alpha one\nbeta two\ngamma three\n", "alpha one\nbeta 2\ngamma three", "QQ", {
			replaceAll: true,
		});
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "block_anchor" });
		if (r.ok) expect(r.out).toBe("QQ\n");
	});

	it("line_trimmed replace_all re-indents onto EACH region's depth", () => {
		const r = fuzzyReplace(
			"    alpha\n    beta\n        alpha\n        beta\n",
			"alpha\nbeta",
			"gamma\ndelta",
			{ replaceAll: true },
		);
		expect(r).toMatchObject({ ok: true, count: 2, strategy: "line_trimmed" });
		if (r.ok) expect(r.out).toBe("    gamma\n    delta\n        gamma\n        delta\n");
	});

	it("self-overlapping line-window matches are de-duplicated, not spliced overlapping", () => {
		// DEVIATION from hermes (ledger #12): hermes splices the two overlapping
		// line_trimmed windows and corrupts "a\na\na" into "R"; we keep the
		// leftmost window (str.replace semantics — the invariant hermes itself
		// enforces for _strategy_exact) and replace once.
		const r = fuzzyReplace("a\na\na", " a\na", "R", { replaceAll: true });
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "line_trimmed" });
		if (r.ok) expect(r.out).toBe("R\na");
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

	it("folds a flat replace_all flag into the legacy flat edit", () => {
		const snake = prepareEditArguments({ path: "f", oldText: "a", newText: "b", replace_all: true });
		expect(snake.edits).toEqual([{ oldText: "a", newText: "b", replaceAll: true }]);
		const camel = prepareEditArguments({ path: "f", oldText: "a", newText: "b", replaceAll: "true" });
		expect(camel.edits).toEqual([{ oldText: "a", newText: "b", replaceAll: true }]);
	});

	it("normalizes per-edit replace_all (snake_case and string booleans)", () => {
		const out = prepareEditArguments({
			path: "f",
			edits: [
				{ oldText: "a", newText: "b", replace_all: "false" },
				{ oldText: "c", newText: "d" },
			],
		});
		expect(out.edits).toEqual([
			{ oldText: "a", newText: "b", replaceAll: false },
			{ oldText: "c", newText: "d" },
		]);
		// unrecognized values pass through untouched — schema validation reports them
		const junk = prepareEditArguments({ path: "f", edits: [{ oldText: "a", newText: "b", replaceAll: 5 }] });
		expect(junk.edits).toEqual([{ oldText: "a", newText: "b", replaceAll: 5 }]);
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

	it("replaceAll replaces every occurrence in one edit", async () => {
		const { dir, file, name } = await tmpFile("aaa bbb aaa\n");
		const res = await run(
			{ path: name, edits: [{ oldText: "aaa", newText: "ccc", replaceAll: true }] },
			dir,
		);
		expect(await fs.readFile(file, "utf-8")).toBe("ccc bbb ccc\n");
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toContain("Successfully replaced 2 block(s)");
	});

	it("mixed call: replaceAll edit + unique edit, both applied all-or-nothing", async () => {
		const { dir, file, name } = await tmpFile("aaa bbb aaa\nccc\n");
		const res = await run(
			{
				path: name,
				edits: [
					{ oldText: "aaa", newText: "X", replaceAll: true },
					{ oldText: "ccc", newText: "Y" },
				],
			},
			dir,
		);
		expect(await fs.readFile(file, "utf-8")).toBe("X bbb X\nY\n");
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toContain("Successfully replaced 3 block(s)");
	});

	it("replaceAll re-indents onto EACH occurrence's depth", async () => {
		const { dir, file, name } = await tmpFile("    alpha\n    beta\n        alpha\n        beta\n");
		await run(
			{ path: name, edits: [{ oldText: "alpha\nbeta", newText: "gamma\ndelta", replaceAll: true }] },
			dir,
		);
		expect(await fs.readFile(file, "utf-8")).toBe("    gamma\n    delta\n        gamma\n        delta\n");
	});

	it("refuses replace_all over approximate (similarity) matches without writing", async () => {
		const { dir, file, name } = await tmpFile("start\nmid1\nend\nstart\nmid2\nend\n");
		await expect(
			run(
				{ path: name, edits: [{ oldText: "start\nmid\nend", newText: "QQ", replaceAll: true }] },
				dir,
			),
		).rejects.toThrow(/replaceAll only applies to exact matches/);
		expect(await fs.readFile(file, "utf-8")).toBe("start\nmid1\nend\nstart\nmid2\nend\n");
	});

	it("already-applied no-op still wins for a replaceAll edit", async () => {
		const { dir, file, name } = await tmpFile("value = 42\n");
		const res = await run(
			{ path: name, edits: [{ oldText: "zzz = 41", newText: "value = 42", replaceAll: true }] },
			dir,
		);
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toMatch(/already applied/);
		expect(await fs.readFile(file, "utf-8")).toBe("value = 42\n");
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
		// oldText must be unmatchable by the FULL chain: context_aware matches
		// near-misses at >=0.80 similarity, and "value = 41" vs "value = 42" is 0.9.
		const res = await run({ path: name, edits: [{ oldText: "zzz = 41", newText: "value = 42" }] }, dir);
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toMatch(/already applied/);
		expect(await fs.readFile(file, "utf-8")).toBe("value = 42\n");
	});

	it("context_aware matches near-miss anchors like hermes (0.9 similarity)", async () => {
		// hermes applies this edit too: the chain runs BEFORE already-applied
		// detection (_no_match_result only sees genuine no-matches).
		const { dir, file, name } = await tmpFile("value = 42\n");
		const res = await run({ path: name, edits: [{ oldText: "value = 41", newText: "value = 42" }] }, dir);
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toMatch(/Successfully replaced/);
		expect(await fs.readFile(file, "utf-8")).toBe("value = 42\n");
	});

	it("ambiguity errors name the match locations", async () => {
		const { dir, name } = await tmpFile("dup\nmid\ndup\n");
		await expect(
			run({ path: name, edits: [{ oldText: "dup", newText: "x" }] }, dir),
		).rejects.toThrow(/Found 2 matches[\s\S]*L1[\s\S]*L3/);
	});

	it("no-match errors carry the did-you-mean sections", async () => {
		// "function comput() {...}" is 0.974 similar to the file's first line —
		// context_aware matches it (hermes parity). Use a first line below the
		// 0.80 bar ("def comput..." is 0.706) but above the 0.30 suggestion floor.
		const { dir, name } = await tmpFile("function compute() {\n\treturn 7;\n}\n");
		await expect(
			run({ path: name, edits: [{ oldText: "def comput() {\n\treturn 7;\n}", newText: "x" }] }, dir),
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

	it("escape-drift errors block the write and teach the fix", async () => {
		// A line break escaped one extra time: escape_normalized matches, the
		// guard refuses, and the file is untouched.
		const { dir, file, name } = await tmpFile('def greet():\n    print("hi")\n');
		await expect(
			run(
				{
					path: name,
					edits: [
						{
							oldText: 'def greet():\\n    print("hi")',
							newText: 'def greet():\\n    print("hello")',
						},
					],
				},
				dir,
			),
		).rejects.toThrow(/Escape-drift detected[\s\S]*backslash \+ n/);
		expect(await fs.readFile(file, "utf-8")).toBe('def greet():\n    print("hi")\n');
	});

	it("mixed call: drift refusal names its edit and reports the other failure", async () => {
		const { dir, file, name } = await tmpFile('def greet():\n    print("hi")\n');
		await expect(
			run(
				{
					path: name,
					edits: [
						{
							oldText: 'def greet():\\n    print("hi")',
							newText: 'def greet():\\n    print("hello")',
						},
						{ oldText: "totally absent text", newText: "x" },
					],
				},
				dir,
			),
		).rejects.toThrow(
			/Escape-drift detected[\s\S]*edit #1[\s\S]*other edit\(s\) in this call also failed to apply/,
		);
		expect(await fs.readFile(file, "utf-8")).toBe('def greet():\n    print("hi")\n');
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
