/**
 * pi-patch test corpus — the acceptance bar in docs/PLAN.md: the strategy
 * chain, per-strategy uniqueness counting, replacement shaping, teaching-error
 * fidelity (hermes Appendix B texts), the tool-level file behaviors of the
 * single-replacement surface (path + old_string + new_string + replace_all):
 * CRLF/BOM, already-applied no-op, argument normalization, hermes' arg gates —
 * and the V4A patch mode (test_patch_parser.py corpora, Tier 3 #8).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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
import {
	applyReplacements,
	maybeUnescapeNewString,
	preserveUnicodeInReplacement,
	reindentReplacement,
	SequenceMatcher,
	unicodeEditPlan,
} from "../src/shaping.js";
import { detectEscapeDrift } from "../src/escape-drift.js";
import { isOpenaiFamilyMain, shouldAdvertiseV4A } from "../src/gate.js";
import { editFormatFamily, editFormatGuideline } from "../src/edit-guidance.js";
import {
	collectV4AHeaderPaths,
	createHostV4AFileOps,
	hasTraversalComponent,
	rewriteV4APatchPathsForHost,
} from "../src/v4a-fs.js";
import { clearPatchFailures, recordPatchFailure, resetPatchFailures } from "../src/failure-tracker.js";
import {
	clearReadStamps,
	drifted,
	fileVersion,
	noteRead,
	noteWrite,
	READ_STAMPS_CAP,
	readStampCount,
	stalenessWarnings,
	stampForToolResult,
} from "../src/staleness.js";
import { verifyPatchPersisted, verifyWrittenHash } from "../src/verify.js";
import {
	applyV4AOperations,
	applyV4APatch,
	parseV4APatch,
	type PatchResult,
	type RawReadResult,
	type V4AFileOps,
	type V4AWriteResult,
} from "../src/v4a.js";
import { countOccurrences } from "../src/text.js";
import {
	applyReplacement,
	computePatchDiff,
	createPatchToolDefinition,
	preparePatchArguments,
	resolveToCwd,
} from "../src/tool.js";
import {
	emptyOldStringError,
	escapeDriftErrorMessage,
	findClosestLines,
	formatNoMatchHint,
	identicalStringsError,
	staleFileWarning,
	visualizeWhitespace,
	whitespaceOnlyOldStringError,
} from "../src/errors.js";
import { generateDiffString } from "../src/diff-utils.js";
import { patchRenderers } from "../src/render.js";

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
// fuzzy_find_and_replace end to end: chain (replaceAll included, Tier 1 #2) +
// escape-drift guards on the RAW new_string of non-exact matches (Tier 1 #3) +
// the full replacement shaping (Tier 1 #4): conditional \t/\r unescape,
// unicode-preserving opcodes, and reindent onto EACH region — hermes'
// _apply_replacements, spliced end-to-start.

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
						? escapeDriftErrorMessage(r.failure.drift)
						: r.failure.kind === "replace_all_similarity"
							? "replace_all only applies to exact matches"
							: "Could not find a match for old_string in the file",
		};
	}
	// hermes orchestrator tail: effective_new = conditional \t/\r unescape over
	// the matched regions (ALL strategies — issue #33733), then
	// _apply_replacements: unicode plan (unicode_normalized) + reindent per
	// region, spliced end-to-start (offsets stay valid — spans never overlap).
	// Exact matches keep the (unescaped) bytes verbatim.
	const effectiveNew = maybeUnescapeNewString(newText, content, r.match.spans);
	const unicodePlan =
		r.match.strategy === "unicode_normalized" ? unicodeEditPlan(oldText, effectiveNew) : undefined;
	const out = applyReplacements(content, r.match.spans, effectiveNew, {
		oldText: r.match.exact ? undefined : oldText,
		unicodePlan,
	});
	return { ok: true, out, count: r.match.spans.length, strategy: r.match.strategy };
}

// This VM's clocksource (kvm-clock) resolves inode timestamps to ~1ms, so a
// same-size rewrite landing inside the read stamp's millisecond leaves hermes'
// (dev, ino, size, mtime_ns, ctime_ns) tuple byte-identical and `drifted()`
// correctly reports no change — drift tests then flake on which millisecond
// they land in (2026-10-17: 5–6 staleness tests red per run). Force the
// "external" writer's mtime forward so the tuple is guaranteed to differ
// regardless of clock granularity.
// The bump is strictly increasing ACROSS CALLS: `Date.now()` may not tick
// between the test's writes (a suite step lands inside one millisecond), so
// each call must push the mtime past every earlier stamp, not just "now".
let mtimeBump = Date.now() + 5000;
function advanceMtime(file: string): void {
	mtimeBump += 1000;
	utimesSync(file, new Date(mtimeBump), new Date(mtimeBump));
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

	// Tier 1 #4: the remaining TestUnicodeNormalized/SpaceAndMinus cases assert
	// the FILE's typographic characters survive the replacement — the
	// unicode-preserving opcode application.
	it("test_ellipsis_preserved", () => {
		const r = fuzzyReplace("Wait for it\u2026and done", "Wait for it...and done", "Wait for it...then done");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "unicode_normalized" });
		if (r.ok) expect(r.out).toBe("Wait for it\u2026then done");
	});

	it("test_mixed_unicode_multiline", () => {
		const r = fuzzyReplace(
			"Line 1 \u2014 with dash\nLine 2 \u201cquoted\u201d text\nLine 3 plain",
			"Line 1 -- with dash\nLine 2 \"quoted\" text\nLine 3 plain",
			"Line 1 -- with dash\nLine 2 \"quoted\" text\nLine 3 changed",
		);
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "unicode_normalized" });
		if (r.ok) {
			expect(r.out).toBe("Line 1 \u2014 with dash\nLine 2 \u201cquoted\u201d text\nLine 3 changed");
		}
	});

	it("test_equal_boundary_inside_expansion_keeps_region_text", () => {
		// An edit boundary falling inside a multi-char expansion (em-dash ->
		// '--') must snap to the expansion, not copy text from the region start
		// (the old fallback spliced the whole region text after every edit).
		const r = fuzzyReplace("value = x\u2014y\n", "value = x--y", "value = x-@-y");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "unicode_normalized" });
		if (r.ok) expect(r.out).toBe("value = x\u2014@\u2014y\n");

		// Same boundary class for a 3-char expansion (ellipsis -> '...').
		const r2 = fuzzyReplace("a\u2026b\n", "a...b", "a..X.b");
		expect(r2).toMatchObject({ ok: true, count: 1, strategy: "unicode_normalized" });
		if (r2.ok) expect(r2.out).toBe("a\u2026X\u2026b\n");
	});

	describe("corpus: TestUnicodeSpaceAndMinusNormalized (hermes)", () => {
		it("test_unicode_minus_matched_and_preserved", () => {
			const r = fuzzyReplace(
				"offset = value \u2212 1\nprint(offset)\n",
				"offset = value - 1",
				"offset = delta - 1",
			);
			expect(r).toMatchObject({ ok: true, count: 1, strategy: "unicode_normalized" });
			if (r.ok) expect(r.out).toContain("delta \u2212 1");
		});

		it("test_ideographic_space_cjk_line", () => {
			const r = fuzzyReplace(
				"\u6a19\u984c\u3000\u7b2c\u4e00\u7ae0\nbody text\n",
				"\u6a19\u984c \u7b2c\u4e00\u7ae0",
				"\u6a19\u984c \u7b2c\u4e8c\u7ae0",
			);
			expect(r).toMatchObject({ ok: true, count: 1, strategy: "unicode_normalized" });
			if (r.ok) expect(r.out).toContain("\u6a19\u984c\u3000\u7b2c\u4e8c\u7ae0");
		});
	});

	it("TestReplaceAll.test_unicode_normalized_preserves_each_matches_own_unicode", () => {
		// Each normalized match keeps ITS typographic characters; hermes once
		// concatenated the regions, which spliced both matches' text into every
		// replacement.
		const r = fuzzyReplace(
			"Price \u2018old\u2019\u2014ready\nPrice 'old'\u2014ready\n",
			"Price 'old'--ready",
			"Price 'new'--ready",
			{ replaceAll: true },
		);
		expect(r).toMatchObject({ ok: true, count: 2, strategy: "unicode_normalized" });
		if (r.ok) expect(r.out).toBe("Price \u2018new\u2019\u2014ready\nPrice 'new'\u2014ready\n");
	});

	// Matching side still pinned: right strategy, right ORIGINAL bytes matched.
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
	// Tier 1 #4: the new_string unescape corpus (hermes
	// TestEscapeNormalizedNewString — issue #33733). fuzzyReplace mirrors
	// hermes' orchestrator: drift guards on the RAW new_string, then the
	// conditional \t/\r unescape over the matched regions (exact included),
	// then the splice.
	it("TestEscapeNormalizedNewString: tab unescaped under escape_normalized", () => {
		const content = "def hello():\n\tprint(\"before\")\n";
		const r = fuzzyReplace(content, "def hello():\n\\tprint(\"before\")\n", "def hello():\n\\tprint(\"after\")\n");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "escape_normalized" });
		if (r.ok) {
			expect(r.out).toContain("\tprint(\"after\")");
			expect(r.out).not.toContain("\\t");
		}
	});

	it("TestEscapeNormalizedNewString: tab unescaped under exact (issue headline)", () => {
		// File has real tab, old_string has real tab too (matches via `exact`),
		// but new_string still arrives with literal \t.
		const content = "def hello():\n\tprint(\"before\")\n";
		const r = fuzzyReplace(content, "\tprint(\"before\")", "\\tprint(\"after\")");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "exact" });
		if (r.ok) {
			expect(r.out).toContain("\tprint(\"after\")");
			expect(r.out).not.toContain("\\t");
		}
	});

	it("TestEscapeNormalizedNewString: carriage return unescaped (chain level, raw bytes)", () => {
		// The TOOL layer pre-normalizes LF (deviations ledger #2), so a
		// literal-\r anchor on a CRLF file falls through to the similarity
		// rungs there; at chain level the strategy behaves exactly like hermes.
		const content = "line1\r\nline2\r\n";
		const r = fuzzyReplace(content, "line1\\r\nline2\\r\n", "replaced\\r\n");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "escape_normalized" });
		if (r.ok) expect(r.out).toContain("replaced\r\n");
	});

	it("TestEscapeNormalizedNewString: \\n is NOT unescaped", () => {
		// \n serializes correctly through JSON; unescaping it would corrupt
		// source-code escape sequences far more often than help.
		const r = fuzzyReplace("line1\nline2\n", "line1\nline2", "alpha\\nbeta");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "exact" });
		if (r.ok) {
			expect(r.out).toContain("alpha\\nbeta");
			expect(r.out).not.toContain("alpha\nbeta");
		}
	});

	it("TestEscapeNormalizedNewString: mixed tab+newline, only tab unescaped", () => {
		const r = fuzzyReplace("def foo():\n\tpass\n", "def foo():\n\tpass\n", "def bar():\\n\\treturn 1\\n");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "exact" });
		if (r.ok) {
			expect(r.out).toContain("\treturn 1");
			expect(r.out).not.toContain("\\t");
			expect(r.out).toContain("\\n");
		}
	});

	it("TestEscapeNormalizedNewString: literal \\t preserved when the file has none", () => {
		// The file genuinely uses a backslash-t sequence (a Python source line
		// sep = "\t") — no tab byte may be injected.
		const content = "sep = \"\\t\"\n";
		const r = fuzzyReplace(content, "sep = \"\\t\"\n", "sep = \"\\tab\"\n");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "exact" });
		if (r.ok) {
			expect(r.out).toContain("sep = \"\\tab\"");
			expect(r.out).not.toContain("\t");
		}
	});

	it("TestEscapeNormalizedNewString: no escape sequences passthrough", () => {
		const r = fuzzyReplace("def foo():\n    return 1\n", "def foo():\n    return 1\n", "def foo():\n    return 2\n");
		expect(r).toMatchObject({ ok: true, count: 1, strategy: "exact" });
		if (r.ok) expect(r.out).toContain("return 2");
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
	// Byte-exact against the hermes messages: the only mapping left is the tool
	// name the recovery hint points at (read_file → read, ledger #10) — the
	// param names are hermes' own now that the surface is `old_string`/`new_string`.
	it("quote-suspect message keeps hermes' repr formatting", () => {
		const msg = escapeDriftErrorMessage({ kind: "quote_suspect", suspect: "\\'", plain: "'" });
		expect(msg).toBe(
			String.raw`Escape-drift detected: old_string and new_string contain the literal sequence "\\'" but the matched region of ` +
				String.raw`the file does not. This is almost always a tool-call serialization artifact where an apostrophe or quote got ` +
				String.raw`prefixed with a spurious backslash. Re-read the file with read and pass old_string/new_string without ` +
				String.raw`backslash-escaping "'" characters.`,
		);
		const dquote = escapeDriftErrorMessage({ kind: "quote_suspect", suspect: '\\"', plain: '"' });
		expect(dquote).toContain(String.raw`sequence '\\"'`);
		expect(dquote).toContain(String.raw`escaping '"' characters.`);
	});

	it("newline-literal message keeps hermes' repr formatting", () => {
		const msg = escapeDriftErrorMessage({ kind: "newline_literal" });
		expect(msg).toBe(
			String.raw`Escape-drift detected: old_string contains more literal '\n' sequences than the matched region of the file, which ` +
				String.raw`has real line breaks there instead. This is almost always a tool-call serialization artifact where a line break got escaped ` +
				String.raw`one extra time; new_string would write it as backslash + n. Re-read the file with read and pass old_string/new_string ` +
				String.raw`with actual line breaks, keeping only the '\n' sequences that appear literally in the file.`,
		);
	});

	it("backslash-doubling message keeps hermes' backtick examples", () => {
		const bs = (n: number) => "\\".repeat(n);
		const msg = escapeDriftErrorMessage({ kind: "backslash_doubling" });
		expect(msg).toBe(
			"Escape-drift detected: every backslash run in old_string is exactly " +
				"twice as long as in the matched region of the file (e.g. the file " +
				// hermes backticks these examples instead of using repr
				`has \`${bs(2)}\` where old_string has \`${bs(4)}\`). The tool-call arguments ` +
				"were JSON-escaped one extra time; applying new_string verbatim would " +
				"double every backslash in the file. Re-read the file with read " +
				"and resend old_string/new_string with the backslash counts exactly " +
				"as they appear in the file.",
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

describe("shaping: reindent replacement (hermes _reindent_replacement)", () => {
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

	it("anchors on the first MEANINGFUL line, not the first line", () => {
		// hermes _first_meaningful_line: a leading blank line must not make
		// the base indent "".
		const out = reindentReplacement("\n\treturn 1;", "\treturn 2;", "            return 1;");
		expect(out).toBe("            return 2;");
	});

	it("anchors shallower lines to the file base (else branch)", () => {
		// oldText's base is a tab; "  shallow()" uses spaces — its indent does
		// not start with the old base, so it anchors to the file base instead
		// of being spliced with a foreign prefix.
		const out = reindentReplacement("\tdeep();", "\tdeep();\n  shallow();", "        deep();");
		expect(out).toBe("        deep();\n        shallow();");
	});

	it("strips only spaces and tabs when measuring indentation", () => {
		// hermes _leading_whitespace lstrips " \t" — \f/\v are not indentation,
		// so the \f survives as part of the line body.
		const out = reindentReplacement("\freturn 1;", "\freturn 2;", "\treturn 1;");
		expect(out).toBe("\t\freturn 2;");
	});

	it("returns empty newText as-is; leaves matching indents alone", () => {
		expect(reindentReplacement("old", "", "\told")).toBe("");
		expect(reindentReplacement("a", "b", "a")).toBe("b");
	});
});

describe("shaping: conditional \\t/\\r unescape (hermes _maybe_unescape_new_string)", () => {
	it("is a no-op without \\t or \\r literals", () => {
		expect(maybeUnescapeNewString("a\nb", "\t\r", [{ start: 0, end: 2 }])).toBe("a\nb");
	});

	it("unescapes \\t only when a matched region contains the real tab", () => {
		expect(maybeUnescapeNewString("a\\tb", "x\ty", [{ start: 0, end: 3 }])).toBe("a\tb");
		expect(maybeUnescapeNewString("a\\tb", "xty", [{ start: 0, end: 3 }])).toBe("a\\tb");
	});

	it("unescapes \\r only when a matched region contains the real CR", () => {
		expect(maybeUnescapeNewString("a\\rb", "x\ry", [{ start: 0, end: 3 }])).toBe("a\rb");
		expect(maybeUnescapeNewString("a\\rb", "xry", [{ start: 0, end: 3 }])).toBe("a\\rb");
	});

	it("never touches \\n literals (would mangle source escape literals)", () => {
		expect(maybeUnescapeNewString("a\\nb", "x\ny", [{ start: 0, end: 3 }])).toBe("a\\nb");
	});

	it("scans every matched region (replace_all)", () => {
		const spans: Span[] = [
			{ start: 0, end: 3 },
			{ start: 4, end: 7 },
		];
		expect(maybeUnescapeNewString("x\\ty", "foo\n\tbar", spans)).toBe("x\ty");
	});
});

describe("shaping: unicode-preserving opcodes (hermes _unicode_edit_plan/_preserve_unicode_in_replacement)", () => {
	it("SequenceMatcher.getOpcodes mirrors difflib (CPython doctests)", () => {
		expect(new SequenceMatcher("abc", "abc").getOpcodes()).toEqual([["equal", 0, 3, 0, 3]]);
		expect(new SequenceMatcher("aXc", "aYc").getOpcodes()).toEqual([
			["equal", 0, 1, 0, 1],
			["replace", 1, 2, 1, 2],
			["equal", 2, 3, 2, 3],
		]);
		expect(new SequenceMatcher("ab", "b").getOpcodes()).toEqual([
			["delete", 0, 1, 0, 0],
			["equal", 1, 2, 0, 1],
		]);
		// difflib's get_opcodes doctest (qabxcd -> abycdf).
		expect(new SequenceMatcher("qabxcd", "abycdf").getOpcodes()).toEqual([
			["delete", 0, 1, 0, 0],
			["equal", 1, 3, 0, 2],
			["replace", 3, 4, 2, 3],
			["equal", 4, 6, 3, 5],
			["insert", 6, 6, 5, 6],
		]);
		// find_longest_match doctest: prefers the EARLIEST maximal block in a,
		// then the earliest in b — " abcd" vs "abcd abcd" matches at a[0:5].
		expect(new SequenceMatcher(" abcd", "abcd abcd").getMatchingBlocks()).toEqual([
			{ a: 0, b: 4, size: 5 },
			{ a: 5, b: 9, size: 0 },
			]);
	});

	it("keeps the region's typography for equal blocks (expansion boundary included)", () => {
		const plan = unicodeEditPlan("value = x--y", "value = x-@-y");
		expect(preserveUnicodeInReplacement("value = x\u2014y", "value = x-@-y", plan)).toBe(
			"value = x\u2014@\u2014y",
		);
	});

	it("falls back to newText when the region doesn't normalize to the plan's normOld", () => {
		const plan = unicodeEditPlan("value = x--y", "value = x-@-y");
		expect(preserveUnicodeInReplacement("value = x--y (different)", "R", plan)).toBe("R");
	});
});

describe("shaping: applyReplacements (hermes _apply_replacements)", () => {
	it("shapes each region and splices end-to-start (offsets stay valid)", () => {
		const out = applyReplacements(
			"    a = 1\n    b = 2\n",
			[
				{ start: 0, end: 9 },
				{ start: 10, end: 19 },
			],
			"a = 1\n\nb = 99",
			{ oldText: "a = 1\nb = 2" },
		);
		expect(out).toBe("    a = 1\n\n    b = 99\n    a = 1\n\n    b = 99\n");
	});

	it("keeps the bytes when oldText is not given (exact match)", () => {
		expect(applyReplacements("a\tb", [{ start: 0, end: 3 }], "a\\tb")).toBe("a\\tb");
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

describe("render: TUI shell (dogfood: box was ragged on the right, double-padded top/bottom)", () => {
	// docs/DOGFOOD.md: with the default render shell, core wraps whatever
	// renderCall() returns in its own background Box. Ours already draws a box,
	// so the header got two blank rows above and below it, and every line that
	// passed through the inner box lost its last column: the inner box closes
	// each line with a background reset, which cancels the OUTER box's
	// background before the padding cell it appends is written. Core's built-in
	// edit tool declares renderShell: "self" for exactly this reason.
	const WIDTH = 110;

	/** Render a `patch` call through the same shell the interactive mode uses. */
	function renderCallShell(args: Record<string, unknown>, width = WIDTH): string[] {
		initTheme("dark", false);
		const definition = { ...createPatchToolDefinition(process.cwd()), ...patchRenderers };
		const component = new ToolExecutionComponent(
			"patch",
			"tc-shell",
			args,
			{ outputPad: 1 },
			definition as never,
			{ requestRender: () => {} } as never,
			process.cwd(),
		);
		component.setArgsComplete();
		// The diff preview is async; render() right here shows the settled-off
		// header box, which is all this regression is about.
		return component.render(width);
	}

	it("declares renderShell: self so core does not nest a second background box", () => {
		expect(patchRenderers.renderShell).toBe("self");
	});

	it("paints every box line flush to the right edge with a single background wrap", () => {
		const boxLines = renderCallShell({ path: "src/tool.ts", old_string: "x", new_string: "y" }).filter(
			(line) => visibleWidth(line) > 0,
		);
		expect(boxLines.length).toBeGreaterThan(0);
		for (const line of boxLines) {
			expect(line.match(/\u001b\[48;/g) ?? []).toHaveLength(1);
			expect(line.endsWith("\u001b[49m")).toBe(true);
			expect(visibleWidth(line)).toBe(WIDTH);
		}
	});

	it("keeps exactly one padding row above and below the header", () => {
		const lines = renderCallShell({ path: "src/tool.ts", old_string: "x", new_string: "y" });
		const header = lines.findIndex((line) => line.includes("patch"));
		expect(header).toBe(2); // core's leading spacer, our box's top pad, header
		expect(visibleWidth(lines[header - 1] ?? "")).toBe(WIDTH);
		expect(visibleWidth(lines[header + 1] ?? "")).toBe(WIDTH);
		expect(lines.length).toBe(4); // + box bottom pad — nothing else is padded yet
	});
});

describe("render: already-applied no-op preview (dogfood: header painted toolErrorBg on a success-shaped no-op)", () => {
	// docs/DOGFOOD.md: a call whose new_string is already in the file settles
	// SUCCESS-shaped in execute(), but computePatchDiff returned { error: … } so
	// renderCall painted the header box with toolErrorBg. computePatchDiff now
	// returns a { note } outcome and the header must paint exactly like a real
	// diff preview — never like a miss.
	const WIDTH = 110;

	/** Render a fully settled call box (async preview included) as lines. */
	async function settledBoxLines(dir: string, args: Record<string, unknown>): Promise<string[]> {
		initTheme("dark", false);
		const definition = { ...createPatchToolDefinition(dir), ...patchRenderers };
		const component = new ToolExecutionComponent(
			"patch",
			"tc-noop",
			args,
			{ outputPad: 1 },
			definition as never,
			{ requestRender: () => {} } as never,
			dir,
		);
		component.setArgsComplete();
		component.render(WIDTH); // kicks off the async preview
		await new Promise((resolve) => setTimeout(resolve, 100));
		return component.render(WIDTH).filter((line) => visibleWidth(line) > 0);
	}

	/** The 48-series SGR the settled box paints its lines with. */
	function boxBgSeq(lines: string[]): string {
		const seq = (lines[0] ?? "").match(/\u001b\[48;[0-9;]+m/)?.[0] ?? "";
		expect(seq).not.toBe("");
		return seq;
	}

	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-noop-preview-"));
		await fs.writeFile(path.join(dir, "f.py"), "value = 42\nsecond line\n");
	});

	it("computePatchDiff returns a note, not an error, for the already-applied no-op", async () => {
		const preview = await computePatchDiff("f.py", { oldString: "zzz = 41", newString: "value = 42", replaceAll: false }, dir);
		expect("note" in preview).toBe(true);
		expect("error" in preview).toBe(false);
		if ("note" in preview) expect(preview.note).toContain("already applied");
	});

	it("computePatchDiff still returns an error for a genuine miss", async () => {
		const preview = await computePatchDiff(
			"f.py",
			{ oldString: "completely absent text here", newString: "and nothing balances this zzz", replaceAll: false },
			dir,
		);
		expect("error" in preview).toBe(true);
		expect("note" in preview).toBe(false);
	});

	it("paints the settled no-op header like a diff preview, not like a miss", async () => {
		const noop = await settledBoxLines(dir, { path: "f.py", old_string: "zzz = 41", new_string: "value = 42" });
		const diff = await settledBoxLines(dir, { path: "f.py", old_string: "second line", new_string: "second line!" });
		const miss = await settledBoxLines(dir, { path: "f.py", old_string: "completely absent text here", new_string: "and nothing balances this zzz" });

		// The no-op header background must equal the success-painted diff header,
		// and the miss must genuinely paint differently (guards the comparison).
		expect(boxBgSeq(noop)).toBe(boxBgSeq(diff));
		expect(boxBgSeq(miss)).not.toBe(boxBgSeq(diff));
		// The note text shows in the body — neutrally, as hermes' message.
		expect(noop.join("\n")).toContain("already applied");
		expect(miss.join("\n")).toContain("Could not find");
	});
});

describe("tool: advertised schema is hermes' base PATCH_SCHEMA", () => {
	const tool = createPatchToolDefinition("/tmp");
	const params = tool.parameters as unknown as { properties: Record<string, unknown>; required?: string[] };

	it("advertises path + old_string + new_string (+ optional replace_all) and nothing else", () => {
		expect(Object.keys(params.properties).sort()).toEqual(["new_string", "old_string", "path", "replace_all"]);
		expect([...(params.required ?? [])].sort()).toEqual(["new_string", "old_string", "path"]);
		// the retired transitional surface must not come back through the schema
		expect(params.properties).not.toHaveProperty("edits");
		// hermes layers mode/patch only behind the OpenAI-family gate (Tier 3 #9): the
		// base schema stays replace-only, and the handler still answers them (ledger #15)
		expect(params.properties).not.toHaveProperty("mode");
		expect(params.properties).not.toHaveProperty("patch");
	});

	it("keeps the tolerance promise the schema text makes", () => {
		// AGENTS.md: the schema promises tolerance — the implementation must keep it
		expect(tool.description).toContain("fuzzy matching (9 strategies)");
		expect(tool.description).toContain("Returns a unified diff");
		// hermes' base promise, minus the syntax-check line pi can't honor (ledger #13)
		expect(tool.description).not.toContain("syntax");
		expect((params.properties.old_string as { description: string }).description).toContain(
			"Must be unique in the file unless replace_all=true",
		);
	});
});

describe("gate: OpenAI family (hermes _is_openai_family_main, Tier 3 #9)", () => {
	it("matches hermes' provider allowlist, case- and whitespace-insensitively", () => {
		for (const provider of ["openai", "openai-chat", "openai-codex", "azure-openai", "codex"]) {
			expect(isOpenaiFamilyMain(provider, "anything")).toBe(true);
			expect(isOpenaiFamilyMain(` ${provider.toUpperCase()} `, "anything")).toBe(true);
		}
		expect(isOpenaiFamilyMain("anthropic", "claude-sonnet-4-5")).toBe(false);
		expect(isOpenaiFamilyMain("google", "gemini-2.5-pro")).toBe(false);
	});

	it("reads the family from the model slug on aggregators", () => {
		// slug after the FIRST slash (Python model.split("/", 1)[-1])
		expect(isOpenaiFamilyMain("openrouter", "openai/gpt-5")).toBe(true);
		expect(isOpenaiFamilyMain("openrouter", "OpenAI/GPT-5")).toBe(true);
		expect(isOpenaiFamilyMain("openrouter", "anthropic/claude-sonnet-4.5")).toBe(false);
		expect(isOpenaiFamilyMain("nous", "x-ai/grok-4")).toBe(false);
		// bare slugs are their own family signal
		expect(isOpenaiFamilyMain("gateway", "gpt-4o")).toBe(true);
		expect(isOpenaiFamilyMain("gateway", "gpt.5")).toBe(true);
		expect(isOpenaiFamilyMain("gateway", "o3-mini")).toBe(true);
		expect(isOpenaiFamilyMain("gateway", "codex-mini-latest")).toBe(true);
		expect(isOpenaiFamilyMain("gateway", "chatgpt-4o-latest")).toBe(true);
		// the substring rule is hermes' `"openai/" in model`
		expect(isOpenaiFamilyMain("gateway", "proxy/openai/gpt-4")).toBe(true);
		// NOT prefix-based on the full id: "o1" only counts as a slug
		expect(isOpenaiFamilyMain("gateway", "sonnet-o1")).toBe(false);
	});

	it("fails closed without a model identity", () => {
		expect(isOpenaiFamilyMain(undefined, undefined)).toBe(false);
		expect(isOpenaiFamilyMain("", "")).toBe(false);
		expect(isOpenaiFamilyMain("  ", "  ")).toBe(false);
	});

	it("prefers the live model, falls back to PI_PROVIDER/PI_MODEL (ledger #9)", () => {
		expect(shouldAdvertiseV4A({ provider: "openai", id: "gpt-5" }, {})).toBe(true);
		// a live non-OpenAI model is NOT overridden by a stale environment pair
		expect(
			shouldAdvertiseV4A({ provider: "anthropic", id: "claude-sonnet-4-5" }, { PI_PROVIDER: "openai", PI_MODEL: "gpt-5" }),
		).toBe(false);
		expect(shouldAdvertiseV4A(undefined, { PI_PROVIDER: "openrouter", PI_MODEL: "openai/gpt-5" })).toBe(true);
		expect(shouldAdvertiseV4A(undefined, {})).toBe(false);
	});
});

describe("tool: V4A schema layering (hermes _patch_schema_overrides, Tier 3 #9)", () => {
	const layered = createPatchToolDefinition("/tmp", { advertiseV4A: true });
	const base = createPatchToolDefinition("/tmp");
	const params = layered.parameters as unknown as { properties: Record<string, unknown>; required?: string[] };
	const baseParams = base.parameters as unknown as { properties: Record<string, unknown>; required?: string[] };

	it("composes mode first, base properties, patch last; mode is the only required param", () => {
		expect(Object.keys(params.properties)).toEqual(["mode", "path", "old_string", "new_string", "replace_all", "patch"]);
		expect(params.required).toEqual(["mode"]);
		// the base schema is untouched by the layer's existence (ledger #15 closes:
		// off-family sessions keep paying zero V4A tokens)
		expect(Object.keys(baseParams.properties).sort()).toEqual(["new_string", "old_string", "path", "replace_all"]);
		expect([...(baseParams.required ?? [])].sort()).toEqual(["new_string", "old_string", "path"]);
	});

	it("swaps in hermes' dual-mode description and one extra guideline", () => {
		const description = String(layered.description);
		expect(description).toContain("REPLACE MODE (mode='replace', default): find a unique string and replace it.");
		expect(description).toContain("REQUIRED PARAMETERS: mode, path, old_string, new_string.");
		expect(description).toContain("PATCH MODE (mode='patch'): apply V4A multi-file patches for bulk changes.");
		expect(description).toContain("REQUIRED PARAMETERS: mode, patch.");
		// ledger #13 covers BOTH description variants: no syntax-check promise
		expect(description).not.toContain("syntax");
		expect(String(base.description)).not.toContain("PATCH MODE");
		expect(layered.promptGuidelines?.some((g) => g.includes('mode="patch"'))).toBe(true);
		expect(base.promptGuidelines?.some((g) => g.includes('mode="patch"'))).toBe(false);
	});

	it("keeps hermes' layered param descriptions verbatim", () => {
		expect((params.properties.mode as { description: string }).description).toBe(
			"Edit mode. 'replace' (default): requires path + old_string + new_string. 'patch': requires patch content only.",
		);
		expect((params.properties.patch as { description: string }).description).toBe(
			"REQUIRED when mode='patch'. V4A format patch content. Format:\n*** Begin Patch\n*** Update File: path/to/file\n@@ context hint @@\n context line\n-removed line\n+added line\n*** End Patch",
		);
	});

	it("keeps the replace gates handler-side: layered replace calls land, hollow ones answer hermes' texts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-layered-"));
		const file = path.join(dir, "s.txt");
		await fs.writeFile(file, "abc\n", "utf-8");
		const run = (input: object) => layered.execute("t", input as never, undefined, undefined, { cwd: dir } as never);
		// mode="replace" alongside path/old/new is hermes' normal path
		await run({ mode: "replace", path: "s.txt", old_string: "abc", new_string: "xyz" });
		expect(await fs.readFile(file, "utf-8")).toBe("xyz\n");
		await expect(run({ mode: "patch" })).rejects.toThrow(/^patch content required$/);
		await expect(run({ mode: "replace" })).rejects.toThrow(/^path required$/);
	});
});

describe("edit-guidance: hermes _EDIT_FORMAT_GUIDANCE prompt steering (ledger #17)", () => {
	it("selects the patch family for gpt/codex ids (substring, patch needles first)", () => {
		expect(editFormatFamily("gpt-5")).toBe("patch");
		expect(editFormatFamily("openai/gpt-4.1-mini")).toBe("patch");
		expect(editFormatFamily("codex-mini-latest")).toBe("patch");
		expect(editFormatFamily("GPT-5")).toBe("patch");
		// hermes' dict order checks the patch needles before the replace ones
		expect(editFormatFamily("hermes-codex-merge")).toBe("patch");
	});
	it("selects the replace family for the other known coder slugs", () => {
		const ids = [
			"claude-sonnet-4.5", "claude-opus-4", "gemini-2.5-pro", "gemma-3",
			"deepseek-coder-v2", "qwen3.8-flash-next", "kimi-k2", "glm-4.6",
			"grok-4", "hermes-4", "llama-3.3-70b", "mistral-large",
			"devstral-small", "minimax-m2",
		];
		for (const id of ids) expect(editFormatFamily(id)).toBe("replace");
	});
	it("returns null for unknown/empty ids (hermes: unknown families get nothing)", () => {
		expect(editFormatFamily("zephyr-7b-beta")).toBeNull();
		expect(editFormatFamily("")).toBeNull();
		expect(editFormatFamily(undefined)).toBeNull();
		expect(editFormatGuideline("zephyr-7b-beta")).toBeNull();
	});
	it("ports hermes' steering texts verbatim modulo ledger #10 tool names", () => {
		const patchLine = editFormatGuideline("gpt-5") ?? "";
		expect(patchLine).toContain("author new files with `write`;");
		expect(patchLine).toContain("mode='patch' (V4A diff) — including single-file edits");
		expect(patchLine).toContain("It's the edit format you handle most reliably.");
		expect(patchLine).not.toContain("write_file");
		const replaceLine = editFormatGuideline("qwen3.8") ?? "";
		expect(replaceLine).toContain("prefer `patch` in mode='replace'");
		expect(replaceLine).toContain("Reach for mode='patch' (V4A) only when an edit genuinely spans several files at once");
	});
	it("teaches V4A on the BASE schema for off-family coder models (prompt, not schema)", () => {
		const def = createPatchToolDefinition("/tmp", { modelId: "qwen3.8-flash-next" });
		const params = def.parameters as unknown as { properties: Record<string, unknown> };
		// schema stays the exact replace-only base (ledger #15)...
		expect(params.properties.mode).toBeUndefined();
		expect(params.properties.patch).toBeUndefined();
		// ...while the prompt steering names the V4A dialect anyway (ledger #17)
		expect(def.promptGuidelines?.some((g) => g.includes("mode='patch' (V4A)"))).toBe(true);
	});
	it("steering supersedes the generic V4A guideline; unknown ids keep it only with the layer", () => {
		const steeredLayered = createPatchToolDefinition("/tmp", { advertiseV4A: true, modelId: "gpt-5" });
		expect(steeredLayered.promptGuidelines?.some((g) => g.includes("*** Begin Patch"))).toBe(false);
		expect(steeredLayered.promptGuidelines?.some((g) => g.includes("most reliably"))).toBe(true);
		const unknownLayered = createPatchToolDefinition("/tmp", { advertiseV4A: true });
		expect(unknownLayered.promptGuidelines?.some((g) => g.includes('mode="patch"'))).toBe(true);
		const unknownBase = createPatchToolDefinition("/tmp", { modelId: "zephyr-7b-beta" });
		expect(unknownBase.promptGuidelines?.every((g) => !g.includes("mode"))).toBe(true);
	});
});

describe("tool: preparePatchArguments (schema_sanitizer analog, ledger #8)", () => {
	it("passes hermes' flat shape through untouched", () => {
		expect(preparePatchArguments({ path: "f", old_string: "a", new_string: "b", replace_all: true })).toEqual({
			path: "f",
			old_string: "a",
			new_string: "b",
			replace_all: true,
		});
	});

	it("maps pi's edit param names onto hermes'", () => {
		expect(preparePatchArguments({ path: "f", oldText: "a", newText: "b" })).toEqual({
			path: "f",
			old_string: "a",
			new_string: "b",
		});
		expect(preparePatchArguments({ file_path: "f", oldString: "a", newString: "b" })).toEqual({
			path: "f",
			old_string: "a",
			new_string: "b",
		});
	});

	it("flattens a single-entry edits[] (array, JSON string, or lone object)", () => {
		expect(preparePatchArguments({ path: "f", edits: '[{"old_text":"a","new_text":"b","replace_all":"true"}]' })).toEqual({
			path: "f",
			old_string: "a",
			new_string: "b",
			replace_all: true,
		});
		expect(preparePatchArguments({ path: "f", edits: { old_string: "a", new_string: "b" } })).toEqual({
			path: "f",
			old_string: "a",
			new_string: "b",
		});
	});

	it("leaves a multi-entry edits[] intact for the handler to refuse", () => {
		const out = preparePatchArguments({
			path: "f",
			edits: [
				{ old_string: "a", new_string: "b" },
				{ old_string: "c", new_string: "d" },
			],
		});
		expect(out.old_string).toBeUndefined();
		expect(Array.isArray(out.edits) && out.edits).toHaveLength(2);
	});

	it("coerces string booleans and drops junk flag values", () => {
		// a mass overwrite needs an explicit true — a junk value must not enable it
		expect(preparePatchArguments({ path: "f", old_string: "a", new_string: "b", replaceAll: "true" })).toMatchObject({
			replace_all: true,
		});
		expect(preparePatchArguments({ path: "f", old_string: "a", new_string: "b", replace_all: 5 })).toEqual({
			path: "f",
			old_string: "a",
			new_string: "b",
		});
	});

	it("drops unparseable edits junk so the ordinary missing-param error wins", () => {
		expect(preparePatchArguments({ path: "f", old_string: "a", new_string: "b", edits: "not json" })).toEqual({
			path: "f",
			old_string: "a",
			new_string: "b",
		});
	});
});

describe("tool: resolveToCwd (~ expansion)", () => {
	const originalHome = process.env.HOME;
	afterEach(() => {
		process.env.HOME = originalHome;
	});

	it("resolves ~/sub/dir against $HOME (regression: path.resolve dropped $HOME on the leading /)", () => {
		process.env.HOME = "/home/fake";
		expect(resolveToCwd("~/sub/dir", "/tmp")).toBe("/home/fake/sub/dir");
	});

	it("resolves bare ~ to $HOME", () => {
		process.env.HOME = "/home/fake";
		expect(resolveToCwd("~", "/tmp")).toBe("/home/fake");
	});

	it("leaves absolute and relative paths untouched", () => {
		process.env.HOME = "/home/fake";
		expect(resolveToCwd("/etc/hosts", "/tmp")).toBe("/etc/hosts");
		expect(resolveToCwd("sub/dir", "/tmp")).toBe("/tmp/sub/dir");
	});

	it("falls back to cwd resolution when no home env is available", () => {
		const home = process.env.HOME;
		const userProfile = process.env.USERPROFILE;
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		try {
			expect(resolveToCwd("~/sub/dir", "/tmp")).toBe("/tmp/~/sub/dir");
		} finally {
			if (home !== undefined) process.env.HOME = home;
			if (userProfile !== undefined) process.env.USERPROFILE = userProfile;
		}
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

	// Raw tool-call arguments, as the model sent them: execute() re-runs the
	// (idempotent) argument normalization itself, so both the harness path and a
	// direct SDK call see the same gates.
	async function run(input: object, cwd: string) {
		return tool.execute("test-call", input as never, undefined, undefined, { cwd } as never);
	}

	it("applies one replacement with indent shaping and returns a model-facing diff", async () => {
		const { dir, file, name } = await tmpFile("function f() {\n\treturn 1;\n}\n");
		const res = await run({ path: name, old_string: "  return 1;", new_string: "  return 42;" }, dir);
		const after = await fs.readFile(file, "utf-8");
		expect(after).toBe("function f() {\n\treturn 42;\n}\n");
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(text).toContain("---"); // unified patch in model-facing content
		expect(res.details?.firstChangedLine).toBe(2);
	});

	it("resolves a ~/ path against $HOME and writes there (regression: ~/folder went to /, forcing full paths)", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-home-"));
		const homeFile = path.join(home, "sample.txt");
		await fs.writeFile(homeFile, "one\ntwo\n");
		const savedHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const res = await run({ path: "~/sample.txt", old_string: "two", new_string: "TWO" }, "/tmp");
			expect(await fs.readFile(homeFile, "utf-8")).toBe("one\nTWO\n");
			const text = res.content.map((c) => (c as { text: string }).text).join("");
			expect(text).toContain(homeFile);
		} finally {
			process.env.HOME = savedHome;
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	it("accepts a pi-shaped call (edits[] with one entry, camelCase names)", async () => {
		const { dir, file, name } = await tmpFile("a\nb\n");
		const res = await run({ path: name, edits: [{ oldText: "a", newText: "A" }] }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("A\nb\n");
		expect(res.content.map((c) => (c as { text: string }).text).join("")).toContain("Successfully replaced 1");
	});

	it("refuses a multi-replacement edits[] call without writing", async () => {
		// one replacement per call is the hermes surface (Tier 2 #5); silently
		// applying the first entry would report work that never happened
		const { dir, file, name } = await tmpFile("a\nb\nc\nd\n");
		await expect(
			run(
				{
					path: name,
					edits: [
						{ oldText: "a", newText: "A" },
						{ oldText: "d", newText: "D" },
					],
				},
				dir,
			),
		).rejects.toThrow(/no edits\[\] parameter[\s\S]*exactly one replacement per call/);
		expect(await fs.readFile(file, "utf-8")).toBe("a\nb\nc\nd\n");
	});

	it("deletes the matched text when new_string is empty (schema promise)", async () => {
		const { dir, file, name } = await tmpFile("keep\ndrop me\nkeep\n");
		await run({ path: name, old_string: "drop me\n", new_string: "" }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("keep\nkeep\n");
	});

	it("unicode_normalized edit keeps the file's typographic characters on disk", async () => {
		const { dir, file, name } = await tmpFile("Wait for it\u2026and done\n");
		await run({ path: name, old_string: "Wait for it...and done", new_string: "Wait for it...then done" }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("Wait for it\u2026then done\n");
	});

	it("exact edit unescapes literal \\t in new_string when the file has real tabs (issue #33733)", async () => {
		const { dir, file, name } = await tmpFile("def hello():\n\tprint(\"before\")\n");
		await run({ path: name, old_string: "\tprint(\"before\")", new_string: "\\tprint(\"after\")" }, dir);
		const after = await fs.readFile(file, "utf-8");
		expect(after).toBe("def hello():\n\tprint(\"after\")\n");
		expect(after).not.toContain("\\t");
	});

	it("replace_all replaces every occurrence in one call", async () => {
		const { dir, file, name } = await tmpFile("aaa bbb aaa\n");
		const res = await run({ path: name, old_string: "aaa", new_string: "ccc", replace_all: true }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("ccc bbb ccc\n");
		expect(res.content.map((c) => (c as { text: string }).text).join("")).toContain("Successfully replaced 2 block(s)");
	});

	it("replace_all arrives as a string boolean and still means all", async () => {
		const { dir, file, name } = await tmpFile("aaa bbb aaa\n");
		await run({ path: name, old_string: "aaa", new_string: "ccc", replace_all: "true" }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("ccc bbb ccc\n");
	});

	it("replace_all re-indents onto EACH occurrence's depth", async () => {
		const { dir, file, name } = await tmpFile("    alpha\n    beta\n        alpha\n        beta\n");
		await run({ path: name, old_string: "alpha\nbeta", new_string: "gamma\ndelta", replace_all: true }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("    gamma\n    delta\n        gamma\n        delta\n");
	});

	it("refuses replace_all over approximate (similarity) matches without writing", async () => {
		const { dir, file, name } = await tmpFile("start\nmid1\nend\nstart\nmid2\nend\n");
		await expect(
			run({ path: name, old_string: "start\nmid\nend", new_string: "QQ", replace_all: true }, dir),
		).rejects.toThrow(/replace_all only applies to exact matches/);
		expect(await fs.readFile(file, "utf-8")).toBe("start\nmid1\nend\nstart\nmid2\nend\n");
	});

	it("returns a success-shaped no-op for an already-applied edit", async () => {
		const { dir, file, name } = await tmpFile("value = 42\n");
		// old_string must be unmatchable by the FULL chain: context_aware matches
		// near-misses at >=0.80 similarity, and "value = 41" vs "value = 42" is 0.9.
		const res = await run({ path: name, old_string: "zzz = 41", new_string: "value = 42" }, dir);
		const text = res.content.map((c) => (c as { text: string }).text).join("");
		expect(text).toContain("already applied");
		expect(await fs.readFile(file, "utf-8")).toBe("value = 42\n");
	});

	it("already-applied no-op still wins for a replace_all edit", async () => {
		const { dir, file, name } = await tmpFile("value = 42\n");
		const res = await run({ path: name, old_string: "zzz = 41", new_string: "value = 42", replace_all: true }, dir);
		expect(res.content.map((c) => (c as { text: string }).text).join("")).toContain("already applied");
		expect(await fs.readFile(file, "utf-8")).toBe("value = 42\n");
	});

	it("context_aware matches near-miss anchors like hermes (0.9 similarity)", async () => {
		// hermes applies this edit too: the chain runs BEFORE already-applied
		// detection (_no_match_result only sees genuine no-matches).
		const { dir, file, name } = await tmpFile("value = 42\n");
		const res = await run({ path: name, old_string: "value = 41", new_string: "value = 42" }, dir);
		expect(res.content.map((c) => (c as { text: string }).text).join("")).toContain("Successfully replaced");
		expect(await fs.readFile(file, "utf-8")).toBe("value = 42\n");
	});

	it("ambiguity errors name the match locations", async () => {
		const { dir, name } = await tmpFile("dup\nmid\ndup\n");
		await expect(run({ path: name, old_string: "dup", new_string: "x" }, dir)).rejects.toThrow(
			/Found 2 matches for old_string[\s\S]*L1: dup[\s\S]*L3: dup/,
		);
	});

	it("no-match errors carry the did-you-mean sections", async () => {
		// "def comput() {...}" is 0.706 similar to the file's first line — below
		// context_aware's 0.80 bar, above the 0.30 suggestion floor.
		const { dir, name } = await tmpFile("function compute() {\n\treturn 7;\n}\n");
		await expect(
			run({ path: name, old_string: "def comput() {\n\treturn 7;\n}", new_string: "x" }, dir),
		).rejects.toThrow(/Did you mean one of these sections\?/);
	});

	it("preserves CRLF line endings and BOM", async () => {
		const { dir, file, name } = await tmpFile("\uFEFFone\r\ntwo\r\n");
		await run({ path: name, old_string: "two", new_string: "TWO" }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("\uFEFFone\r\nTWO\r\n");
	});

	it("escape-drift errors block the write and teach the fix", async () => {
		// A line break escaped one extra time: escape_normalized matches, the
		// guard refuses, and the file is untouched.
		const { dir, file, name } = await tmpFile('def greet():\n    print("hi")\n');
		await expect(
			run(
				{
					path: name,
					old_string: 'def greet():\\n    print("hi")',
					new_string: 'def greet():\\n    print("hello")',
				},
				dir,
			),
		).rejects.toThrow(/Escape-drift detected[\s\S]*backslash \+ n/);
		expect(await fs.readFile(file, "utf-8")).toBe('def greet():\n    print("hi")\n');
	});

	it("runs hermes' argument gates before touching the file", async () => {
		const { dir, name } = await tmpFile("abc\n");
		await expect(run({ old_string: "abc", new_string: "x" }, dir)).rejects.toThrow(/^path required$/);
		await expect(run({ path: name }, dir)).rejects.toThrow(/^old_string and new_string required$/);
		await expect(run({ path: name, old_string: "", new_string: "x" }, dir)).rejects.toThrow(
			/^old_string is empty — nothing to match/,
		);
		await expect(run({ path: name, old_string: "   ", new_string: "x" }, dir)).rejects.toThrow(
			/^old_string is only whitespace/,
		);
		await expect(run({ path: name, old_string: "abc", new_string: "abc" }, dir)).rejects.toThrow(
			/^No edit was applied because old_string and new_string are identical/,
		);
	});

	it("dispatches the unadvertised V4A shape instead of refusing it", async () => {
		// The base schema does not advertise `mode`, but hermes' handler accepts
		// both shapes from any model (replay compat): mode="patch" runs the real
		// V4A path, and hermes' gates answer in hermes' order.
		const { dir, file, name } = await tmpFile("abc\n");
		await expect(run({ path: name, mode: "sideways", old_string: "abc", new_string: "x" }, dir)).rejects.toThrow(
			/^Unknown mode: sideways$/,
		);
		expect(await fs.readFile(file, "utf-8")).toBe("abc\n");
		// hermes' mode='patch' gate: `if not patch: tool_error("patch content required")`.
		await expect(run({ path: name, mode: "patch" }, dir)).rejects.toThrow(/^patch content required$/);
		expect(await fs.readFile(file, "utf-8")).toBe("abc\n");
		// A syntactically valid but content-free patch reaches VALIDATION (not a
		// refusal): hermes' empty-ops text rides the validation wrapper — proving
		// the V4A pipeline dispatched — and nothing is written.
		await expect(run({ path: name, mode: "patch", patch: "*** Begin Patch\n*** End Patch" }, dir)).rejects.toThrow(
			/^Patch validation failed \(no files were modified\):\n {2}• Patch contains no changes \(only context lines were provided\)$/,
		);
		expect(await fs.readFile(file, "utf-8")).toBe("abc\n");
	});

	it("ignores a stray patch param on a complete replace call, like hermes", async () => {
		// hermes defaults to mode="replace" and never looks at `patch` there, so a
		// model that leaks the param must not turn a landable edit into a refusal
		const { dir, file, name } = await tmpFile("abc\n");
		await run({ path: name, old_string: "abc", new_string: "xyz", patch: "*** Begin Patch\n*** End Patch" }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("xyz\n");
	});
});

describe("v4a-fs: header plumbing (hermes patch_tool support layer, Tier 3 #10)", () => {
	it("has_traversal_component matches path COMPONENTS, not substrings", () => {
		expect(hasTraversalComponent("a/../b")).toBe(true);
		expect(hasTraversalComponent("../b")).toBe(true);
		expect(hasTraversalComponent("a/..")).toBe(true);
		expect(hasTraversalComponent("a\\..\\b")).toBe(true);
		expect(hasTraversalComponent("a..b")).toBe(false);
		expect(hasTraversalComponent("..hidden/x")).toBe(false);
		expect(hasTraversalComponent("a/b.txt")).toBe(false);
	});

	it("collects header paths split by write-kind and vetoes traversal with hermes' text", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			" x",
			"*** Add File: b.txt",
			"+y",
			"*** Delete File: c.txt",
			"*** Move File: old.txt -> new.txt",
			"*** End Patch",
		].join("\n");
		expect(collectV4AHeaderPaths(patch)).toEqual({
			all: ["a.txt", "b.txt", "c.txt", "old.txt", "new.txt"],
			contentWrite: ["a.txt", "b.txt"],
			entry: ["c.txt", "old.txt", "new.txt"],
		});
		const bad = collectV4AHeaderPaths("*** Update File: ../etc/passwd\n@@\n x");
		expect(typeof bad).toBe("string");
		expect(String(bad)).toBe(
			"V4A patch header contains '..' traversal: '../etc/passwd'. " +
				"Use the agent's cwd-relative path (no '..') or an absolute " +
				"path in '*** Update File:' / '*** Add File:' / '*** Delete File:' / '*** Move File:' headers.",
		);
	});

	it("rewrites headers to resolved paths; Delete and Move take the ENTRY path", () => {
		const patch = ["*** Update File: a.txt", "*** Delete File: c.txt", "*** Move File: o.txt -> n.txt"].join("\n");
		const resolved = new Map([
			["a.txt", "/abs/a.txt"],
			["c.txt", "/abs/c.txt"],
			["o.txt", "/abs/o.txt"],
			["n.txt", "/abs/n.txt"],
		]);
		const entry = new Map([
			["c.txt", "/entry/c.txt"],
			["o.txt", "/entry/o.txt"],
			["n.txt", "/entry/n.txt"],
		]);
		expect(rewriteV4APatchPathsForHost(patch, resolved, entry)).toBe(
			["*** Update File: /abs/a.txt", "*** Delete File: /entry/c.txt", "*** Move File: /entry/o.txt -> /entry/n.txt"].join("\n"),
		);
	});

	it("host file ops round-trip BOM and CRLF through the raw read/write pair", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-v4afops-"));
		const file = path.join(dir, "f.txt");
		await fs.writeFile(file, "\uFEFFone\r\ntwo\r\n", "utf-8");
		const ops = createHostV4AFileOps();
		const read = ops.readFileRaw(file);
		expect(read.error).toBeNull();
		// matched on LF-normalized content, BOM split off (ledger #2 fidelity)
		expect(read.content).toBe("one\ntwo\n");
		ops.writeFile(file, "one\nTWO\n");
		expect(await fs.readFile(file, "utf-8")).toBe("\uFEFFone\r\nTWO\r\n");
		// absent path reports NOT FOUND — the answer that frees an Add target
		expect(ops.readFileRaw(path.join(dir, "missing.txt"))).toMatchObject({ content: null, notFound: true });
	});
});

describe("tool: V4A execute against real files (Tier 3 #10)", () => {
	const tool = createPatchToolDefinition("/tmp");

	async function tmpDir(): Promise<string> {
		return fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-v4a-"));
	}
	async function run(patch: string, cwd: string) {
		return tool.execute("v4a-call", { mode: "patch", patch } as never, undefined, undefined, { cwd } as never);
	}
	function textOf(result: { content: { type: string; text?: string }[] }): string {
		return result.content.map((c) => c.text ?? "").join("\n");
	}

	it("applies Update + Add + Delete + Move in one call and reports every path", async () => {
		const dir = await tmpDir();
		await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n", "utf-8");
		await fs.writeFile(path.join(dir, "old.txt"), "move me\n", "utf-8");
		await fs.writeFile(path.join(dir, "gone.txt"), "bye\n", "utf-8");
		const result = await run(
			[
				"*** Begin Patch",
				"*** Update File: a.txt",
				"@@",
				" one",
				"-two",
				"+TWO",
				" three",
				"*** Add File: new.txt",
				"+created",
				"*** Delete File: gone.txt",
				"*** Move File: old.txt -> moved.txt",
				"*** End Patch",
			].join("\n"),
			dir,
		);
		expect(await fs.readFile(path.join(dir, "a.txt"), "utf-8")).toBe("one\nTWO\nthree\n");
		// hermes' Add-File content joins the '+' body lines without a trailing
		// newline (add one with a bare '+' line if you want one)
		expect(await fs.readFile(path.join(dir, "new.txt"), "utf-8")).toBe("created");
		expect(await fs.readFile(path.join(dir, "moved.txt"), "utf-8")).toBe("move me\n");
		await expect(fs.readFile(path.join(dir, "gone.txt"), "utf-8")).rejects.toThrow();
		await expect(fs.readFile(path.join(dir, "old.txt"), "utf-8")).rejects.toThrow();
		const text = textOf(result);
		expect(text).toContain("Successfully applied V4A patch.");
		// hermes reports ABSOLUTE paths; Move reports BOTH endpoints (entry paths)
		expect(text).toContain(`files_modified: ${[
			path.join(dir, "a.txt"),
			path.join(dir, "new.txt"),
			path.join(dir, "gone.txt"),
			path.join(dir, "old.txt"),
			path.join(dir, "moved.txt"),
		].join(", ")}`);
		expect(text).toContain(`files_created: ${path.join(dir, "new.txt")}`);
		expect(text).toContain(`files_deleted: ${path.join(dir, "gone.txt")}`);
		expect((result.details as { diff: string }).diff).toContain(`--- a/${path.join(dir, "a.txt")}`);
	});

	it("single-file patches carry resolved_path", async () => {
		const dir = await tmpDir();
		await fs.writeFile(path.join(dir, "solo.txt"), "alpha\n", "utf-8");
		const result = await run("*** Begin Patch\n*** Update File: solo.txt\n@@\n-alpha\n+ALPHA\n*** End Patch", dir);
		const text = textOf(result);
		expect(text).toContain(`resolved_path: ${path.join(dir, "solo.txt")}`);
		expect(text).not.toContain("files_created");
	});

	it("vetoes '..' traversal in headers before touching the filesystem", async () => {
		const dir = await tmpDir();
		const outside = path.join(dir, "..", "outside.txt");
		const patch = "*** Begin Patch\n*** Update File: ../outside.txt\n@@\n-a\n+b\n*** End Patch";
		await expect(run(patch, dir)).rejects.toThrow(
			/^V4A patch header contains '\.\.' traversal: '\.\.\/outside\.txt'\. Use the agent's cwd-relative path/,
		);
		await expect(fs.readFile(outside, "utf-8")).rejects.toThrow();
	});

	it("preserves CRLF and BOM through V4A updates (host file ops)", async () => {
		const dir = await tmpDir();
		await fs.writeFile(path.join(dir, "crlf.txt"), "\uFEFFone\r\ntwo\r\n", "utf-8");
		await run("*** Begin Patch\n*** Update File: crlf.txt\n@@\n-one\n+ONE\n*** End Patch", dir);
		expect(await fs.readFile(path.join(dir, "crlf.txt"), "utf-8")).toBe("\uFEFFONE\r\ntwo\r\n");
	});

	it("routes Update hunks through the shared chain: tolerant matching lands sloppy hunks", async () => {
		const dir = await tmpDir();
		await fs.writeFile(path.join(dir, "t.txt"), "def greet():\n\treturn 1\n", "utf-8");
		// the hunk carries space indent where the file has a tab — the
		// indentation_flexible rung still lands the match. Shaping then keeps the
		// hunk's indentation verbatim: hermes' re-indent only shifts by a COMMON
		// prefix, and tab vs spaces share none — same written text as hermes.
		await run(
			"*** Begin Patch\n*** Update File: t.txt\n@@\n-def greet():\n-    return 1\n+def greet():\n+    return 42\n*** End Patch",
			dir,
		);
		expect(await fs.readFile(path.join(dir, "t.txt"), "utf-8")).toBe("def greet():\n    return 42\n");
	});

	it("a failed patch modifies nothing (two-phase validation) and teaches the hermes error", async () => {
		const dir = await tmpDir();
		await fs.writeFile(path.join(dir, "keep.txt"), "one\ntwo\n", "utf-8");
		await expect(
			run(
				[
					"*** Begin Patch",
					"*** Update File: keep.txt",
					"@@",
					"-one",
					"+ONE",
					"*** Add File: keep.txt",
					"+would clobber",
					"*** End Patch",
				].join("\n"),
				dir,
			),
		).rejects.toThrow(/already exists/);
		expect(await fs.readFile(path.join(dir, "keep.txt"), "utf-8")).toBe("one\ntwo\n");
	});

	it("V4A misses bypass the failure tracker; V4A success resets it", async () => {
		const dir = await tmpDir();
		await fs.writeFile(path.join(dir, "miss.txt"), "alpha\n", "utf-8");
		const replaceMiss = (oldString: string) =>
			tool.execute("c", { path: "miss.txt", old_string: oldString, new_string: "q" } as never, undefined, undefined, {
				cwd: dir,
			} as never);
		// two replace misses (below the escalation threshold)
		await expect(replaceMiss("zzz")).rejects.toThrow(/Could not find/);
		await expect(replaceMiss("yyy")).rejects.toThrow(/Could not find/);
		// a V4A miss on the SAME path: hermes does not count these ("V4A misses
		// are rare"), so the next replace miss is failure #3 — if the V4A miss
		// had counted it would read failure #4
		await expect(run("*** Begin Patch\n*** Update File: miss.txt\n@@\n-nope\n+yes\n*** End Patch", dir)).rejects.toThrow(
			/Could not find/,
		);
		await expect(replaceMiss("xxx")).rejects.toThrow(/This is failure #3 patching/);
		// success (either mode) resets the per-path count: the next miss teaches
		// a fresh streak (no counter yet — escalation only speaks from #3)
		await run("*** Begin Patch\n*** Update File: miss.txt\n@@\n-alpha\n+ALPHA\n*** End Patch", dir);
		let finalMessage = "";
		try {
			await replaceMiss("bbb");
		} catch (error) {
			finalMessage = error instanceof Error ? error.message : String(error);
		}
		expect(finalMessage).toContain("Could not find");
		expect(finalMessage).not.toContain("This is failure");
	});
});

describe("tool: failure escalation (hermes _patch_failure_tracker, Tier 2 #6)", () => {
	async function tmpFile(content: string): Promise<{ dir: string; file: string; name: string }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-escalate-"));
		const file = path.join(dir, "sample.txt");
		await fs.writeFile(file, content, "utf-8");
		return { dir, file, name: "sample.txt" };
	}

	const tool = createPatchToolDefinition("/tmp");

	async function run(input: object, cwd: string) {
		return tool.execute("test-call", input as never, undefined, undefined, { cwd } as never);
	}

	async function runError(input: object, cwd: string): Promise<string> {
		const error = await run(input, cwd).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		return error instanceof Error ? error.message : String(error);
	}

	// A no-match that still resembles a file line (≈0.7 anchor similarity —
	// below context_aware's 0.80 bar, above the 0.30 suggestion floor): the
	// error carries a "Did you mean" snippet, which suppresses the generic hint.
	const SIMILAR = "def comput() {\n	return 7;\n}";
	// A no-match with nothing above the 0.30 floor in the file: plain
	// "Could not find…", so the below-threshold generic hint layer shows.
	const DISSIMILAR = "qqq www eee";

	beforeEach(() => clearPatchFailures());

	it("escalates at failure #3 on the same path and keeps counting", async () => {
		const { dir, name } = await tmpFile("function compute() {\n	return 7;\n}\n");
		const call = { path: name, old_string: SIMILAR, new_string: "x" };
		// Failures 1 and 2 stay below the threshold: did-you-mean only.
		for (let i = 0; i < 2; i++) {
			const message = await runError(call, dir);
			expect(message).toContain("Did you mean one of these sections?");
			expect(message).not.toContain("old_string not found.");
			expect(message).not.toContain("This is failure #");
		}
		const third = await runError(call, dir);
		expect(third).toContain("Did you mean one of these sections?");
		expect(third.endsWith(
			"\n\nThis is failure #3 patching 'sample.txt'. " +
				"Stop retrying with variations of the same old_string. " +
				"Either: (1) re-read the file fresh to verify current " +
				"content, (2) use a longer / more unique old_string with " +
				"surrounding context lines, or (3) use write to " +
				"replace the entire file if the targeted region is hard " +
				"to anchor.",
		)).toBe(true);
		expect(await runError(call, dir)).toContain("This is failure #4 patching 'sample.txt'.");
	});

	it("below the threshold, a no-match without a did-you-mean carries the generic hint", async () => {
		const { dir, name } = await tmpFile("aaa bbb ccc\n");
		const call = { path: name, old_string: DISSIMILAR, new_string: "x" };
		const message = await runError(call, dir);
		// hermes attaches `_hint` alongside the error; per ledger #6 it rides in
		// the message text, so the whole text is byte-exact here.
		expect(message).toBe(
			"Could not find a match for old_string in the file\n\n" +
				"old_string not found. Use read to verify the current content, or grep to locate the text.",
		);
	});

	it("a success resets the consecutive count (hermes _reset_patch_failures)", async () => {
		const { dir, file, name } = await tmpFile("aaa bbb ccc\n");
		const miss = { path: name, old_string: DISSIMILAR, new_string: "x" };
		await runError(miss, dir);
		await runError(miss, dir);
		await run({ path: name, old_string: "aaa", new_string: "AAA" }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("AAA bbb ccc\n");
		// Without the reset this miss would be failure #3 and escalate.
		const message = await runError(miss, dir);
		expect(message).toContain("old_string not found.");
		expect(message).not.toContain("This is failure #");
	});

	it("the already-applied no-op resets the count too (hermes' success branch)", async () => {
		// hermes' already-applied PatchResult is success=True with no error, so
		// its handler resets the tracker exactly like a landed write.
		const { dir, name } = await tmpFile("value = 42\n");
		const miss = { path: name, old_string: DISSIMILAR, new_string: "x" };
		await runError(miss, dir);
		await runError(miss, dir);
		const noop = await run({ path: name, old_string: "zzz = 41", new_string: "value = 42" }, dir);
		expect(noop.content.map((c) => (c as { text: string }).text).join("")).toContain("already applied");
		// Without the reset this miss would be failure #3 and escalate.
		const message = await runError(miss, dir);
		expect(message).toContain("old_string not found.");
		expect(message).not.toContain("This is failure #");
	});

	it("ambiguity and escape-drift refusals are not counted (hermes counts 'Could not find' only)", async () => {
		const { dir, name } = await tmpFile("aaa bbb ccc\ndup\ndup\n");
		const miss = { path: name, old_string: DISSIMILAR, new_string: "x" };
		await runError(miss, dir);
		await runError(miss, dir);
		// Ambiguity explains itself — no generic hint, no escalation, no count.
		const ambiguous = await runError({ path: name, old_string: "dup", new_string: "x" }, dir);
		expect(ambiguous).toContain("Found 2 matches for old_string");
		expect(ambiguous).not.toContain("old_string not found.");
		expect(ambiguous).not.toContain("This is failure #");
		// If the ambiguity refusal had been counted, this would be failure #4.
		expect(await runError(miss, dir)).toContain("This is failure #3 patching 'sample.txt'.");
	});

	it("escape-drift refusals are not counted either", async () => {
		const { dir, name } = await tmpFile('def greet():\n    print("hi")\n');
		const drift = {
			path: name,
			old_string: 'def greet():\\n    print("hi")',
			new_string: 'def greet():\\n    print("hello")',
		};
		for (let i = 0; i < 2; i++) {
			const message = await runError(drift, dir);
			expect(message).toContain("Escape-drift detected");
			expect(message).not.toContain("old_string not found.");
			expect(message).not.toContain("This is failure #");
		}
		// The next no-match is only failure #1: drift calls never incremented.
		const message = await runError({ path: name, old_string: SIMILAR, new_string: "x" }, dir);
		expect(message).toContain("Did you mean one of these sections?");
		expect(message).not.toContain("This is failure #");
	});

	it("different paths count independently", async () => {
		const { dir, name } = await tmpFile("aaa bbb ccc\n");
		const other = path.join(dir, "other.txt");
		await fs.writeFile(other, "aaa bbb ccc\n", "utf-8");
		const miss = { path: name, old_string: DISSIMILAR, new_string: "x" };
		await runError(miss, dir);
		await runError(miss, dir);
		// other.txt has never failed: generic hint, not escalation.
		const otherMessage = await runError({ path: "other.txt", old_string: DISSIMILAR, new_string: "x" }, dir);
		expect(otherMessage).toContain("old_string not found.");
		expect(otherMessage).not.toContain("This is failure #");
		// sample.txt is still at streak #2 → this miss is its #3.
		expect(await runError(miss, dir)).toContain("This is failure #3 patching 'sample.txt'.");
	});
});

describe("post-write verification (hermes persistence gates, Tier 4 #11)", () => {
	// Port of the hermes write-persistence corpus (test_write_verification.py
	// + TestPatchReplacePostWriteVerification): a silent persistence failure
	// must surface as an ERROR, never as success-with-diff. The transport mock
	// hermes' tests use becomes our injected read/write seams.
	const hashError = (p: string) =>
		`Post-write verification failed for ${p}: on-disk content hash differs from the intended write. ` +
		"The write did not persist correctly — re-read the file and retry.";

	beforeEach(() => clearPatchFailures());

	it("verifyWrittenHash: bytes match passes, bytes differ errors verbatim", () => {
		const intended = Buffer.from("\uFEFFone\r\ntwo\r\n", "utf-8");
		expect(verifyWrittenHash("/f", intended, () => Buffer.from(intended))).toBeNull();
		expect(verifyWrittenHash("/f", intended, () => Buffer.from("stale\n"))).toBe(hashError("/f"));
	});

	it("verifyWrittenHash: hash that cannot be taken leaves the write standing (verified=None)", () => {
		// hermes: sha256sum missing/failing → verified omitted, write still ok.
		expect(
			verifyWrittenHash("/f", Buffer.from("x"), () => {
				throw new Error("no hash binary");
			}),
		).toBeNull();
	});

	it("verifyPatchPersisted compares BOM-less, LF-normalized text on both sides", () => {
		// Windows-text-mode persistence (LF written as CRLF) and the BOM we
		// prepend on write must not read back as a mismatch.
		const read = () => Buffer.from("\uFEFFone\r\ntwo\r\n", "utf-8");
		expect(verifyPatchPersisted("/f", "one\ntwo\n", read)).toBeNull();
	});

	it("verifyPatchPersisted mismatch is hermes' text with code-point counts", () => {
		// Python len() counts code points: "😀 ok" is 4 chars, not 5 UTF-16 units.
		expect(verifyPatchPersisted("/f", "\u{1F600} ok", () => Buffer.from("ab", "utf-8"))).toBe(
			"Post-write verification failed for /f: on-disk content differs from intended write " +
				"(wrote 4 chars, read back 2 chars after normalizing line endings). " +
				"The patch did not persist. Re-read the file and try again.",
		);
	});

	it("verifyPatchPersisted read failure is hermes' could-not-re-read text", () => {
		expect(
			verifyPatchPersisted("/f", "x", () => {
				throw new Error("EIO");
			}),
		).toBe("Post-write verification failed: could not re-read /f");
	});

	describe("replace mode (TestPatchReplacePostWriteVerification analog)", () => {
		async function tmpFile(content: string): Promise<{ dir: string; file: string }> {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-verify-"));
			const file = path.join(dir, "a.txt");
			await fs.writeFile(file, content, "utf-8");
			return { dir, file };
		}
		async function runFailing(tool: ReturnType<typeof createPatchToolDefinition>, dir: string): Promise<string> {
			const error = await tool
				.execute("verify-call", { path: "a.txt", old_string: "hello", new_string: "hi" } as never, undefined, undefined, {
					cwd: dir,
				} as never)
				.then(
					() => undefined,
					(e: unknown) => e,
				);
			expect(error).toBeInstanceOf(Error);
			return error instanceof Error ? error.message : String(error);
		}

		it("surfaces a silent persistence failure as the wrapped write_file error", async () => {
			const { dir, file } = await tmpFile("hello world\n");
			// Seed the streak: a verification failure may neither count (no "Could
			// not find") nor reset it — only real misses count, only successes reset.
			expect(recordPatchFailure(file)).toBe(1);
			// The write reports success but the bytes never land: the sha256 gate
			// (hermes' write_file) fires first, wrapped like every other
			// write_file failure by patch_replace.
			const tool = createPatchToolDefinition("/tmp", { operations: { writeFile: () => Promise.resolve() } });
			expect(await runFailing(tool, dir)).toBe(`Failed to write changes: ${hashError(file)}`);
			expect(readFileSync(file, "utf-8")).toBe("hello world\n");
			expect(recordPatchFailure(file)).toBe(2);
		});

		it("a verify re-read that fails answers hermes' could-not-re-read", async () => {
			const { dir, file } = await tmpFile("hello world\n");
			// Read-back failing means the hash cannot be taken (verified=None, no
			// error) and the persisted re-read fails outright — hermes' second
			// corpus case: the write itself landed and stands unverified.
			const tool = createPatchToolDefinition("/tmp", {
				operations: {
					readExact: () => {
						throw new Error("EIO: verify read failed");
					},
				},
			});
			expect(await runFailing(tool, dir)).toBe(`Post-write verification failed: could not re-read ${file}`);
			expect(readFileSync(file, "utf-8")).toBe("hi world\n");
		});

		it("a real BOM+CRLF write verifies byte-exactly and succeeds", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-verify-ok-"));
			const file = path.join(dir, "bom.txt");
			await fs.writeFile(file, "\uFEFFalpha\r\nbeta\r\n", "utf-8");
			const tool = createPatchToolDefinition("/tmp");
			const result = await tool.execute(
				"verify-call",
				{ path: "bom.txt", old_string: "alpha", new_string: "ALPHA" } as never,
				undefined,
				undefined,
				{ cwd: dir } as never,
			);
			const text = result.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
			expect(text).toContain("Successfully replaced 1 block(s)");
			expect(readFileSync(file, "utf-8")).toBe("\uFEFFALPHA\r\nbeta\r\n");
		});
	});

	describe("V4A host writes (hash gate inside the host write)", () => {
		it("a lying read-back fails the Update with hermes' verbatim hash error", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-v4averify-"));
			const file = path.join(dir, "a.txt");
			await fs.writeFile(file, "one\ntwo\n", "utf-8");
			// Writes do nothing, reads always answer the on-disk (pre-patch) bytes:
			// validation passes, the apply-phase persistence gate fires, and the
			// error rides patch_parser's apply wrapper — nothing is reported applied.
			const ops = createHostV4AFileOps({ read: (p) => readFileSync(p), write: () => {} });
			const result = applyV4APatch(
				["*** Begin Patch", `*** Update File: ${file}`, "@@", " one", "-two", "+TWO", "*** End Patch"].join("\n"),
				ops,
			);
			expect(result.success).toBe(false);
			expect(result.error).toBe(
				"Apply phase failed (state may be inconsistent — run `git diff` to assess):\n" +
					`  • Failed to update ${file}: ${hashError(file)}`,
			);
			expect(result.filesModified).toEqual([]);
			expect(readFileSync(file, "utf-8")).toBe("one\ntwo\n");
		});

		it("hash that cannot be taken leaves the V4A write standing (verified=None)", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-v4averify2-"));
			const file = path.join(dir, "ok.txt");
			await fs.writeFile(file, "one\ntwo\n", "utf-8");
			let written = false;
			const ops = createHostV4AFileOps({
				read: (p) => {
					if (written) throw new Error("no hash binary");
					return readFileSync(p);
				},
				write: (p, data) => {
					written = true;
					writeFileSync(p, data, "utf-8");
				},
			});
			expect(ops.readFileRaw(file).error).toBeNull();
			expect(ops.writeFile(file, "one\nTWO\n")).toEqual({});
			expect(readFileSync(file, "utf-8")).toBe("one\nTWO\n");
		});
	});
});

describe("staleness: read-time version capture + edit-time warning (hermes _check_file_staleness, Tier 4 #12)", () => {
	async function tmpDir(): Promise<string> {
		return fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-stale-"));
	}
	async function tmpFile(content: string): Promise<{ dir: string; file: string; name: string }> {
		const dir = await tmpDir();
		const file = path.join(dir, "sample.txt");
		await fs.writeFile(file, content, "utf-8");
		return { dir, file, name: "sample.txt" };
	}

	const tool = createPatchToolDefinition("/tmp");
	async function run(input: object, cwd: string) {
		return tool.execute("stale-call", input as never, undefined, undefined, { cwd } as never);
	}
	function textOf(result: { content: { type: string; text?: string }[] }): string {
		return result.content.map((c) => c.text ?? "").join("\n");
	}
	function partsOf(result: { content: { type: string; text?: string }[] }): string[] {
		return result.content.map((c) => c.text ?? "");
	}
	async function errorOf(input: object, cwd: string): Promise<string> {
		const error = await run(input, cwd).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		return error instanceof Error ? error.message : String(error);
	}

	beforeEach(() => clearReadStamps());

	it("fileVersion answers hermes' 5-tuple (dev, ino, size, mtime_ns, ctime_ns)", async () => {
		const { dir, file } = await tmpFile("content\n");
		const version = fileVersion(file);
		expect(version).not.toBeNull();
		const st = statSync(file, { bigint: true });
		expect(version).toEqual([st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs]);
		expect(version!.every((field) => typeof field === "bigint")).toBe(true);
		// hermes `_file_metadata` answers None when the path cannot be stat'ed
		expect(fileVersion(path.join(dir, "missing.txt"))).toBeNull();
	});

	it("the warning text is hermes' `_check_file_staleness` verbatim", () => {
		expect(staleFileWarning("src/tool.ts")).toBe(
			"Warning: src/tool.ts was modified since you last read it " +
				"(external edit or concurrent agent). The content you read may be " +
				"stale. Consider re-reading the file to verify before writing.",
		);
	});

	it("warns when the file changed after the read stamp — and still writes (warn, never block)", async () => {
		const { dir, file, name } = await tmpFile("alpha\nbeta\ngamma\n");
		noteRead(file);
		writeFileSync(file, "alpha\nBETA (external editor)\ngamma\n");
		const result = await run({ path: name, old_string: "gamma", new_string: "delta" }, dir);
		expect(await fs.readFile(file, "utf-8")).toBe("alpha\nBETA (external editor)\ndelta\n");
		const text = textOf(result);
		expect(text).toContain("Successfully replaced 1 block(s)");
		// hermes sets `_warning` alongside the payload; ledger #6 rides it in the text
		expect(text.endsWith(`\n\n${staleFileWarning(name)}`)).toBe(true);
	});

	it("stays silent for a file the session never read (first-touch edits are quiet)", async () => {
		const { dir, name } = await tmpFile("alpha\nbeta\n");
		const text = textOf(await run({ path: name, old_string: "beta", new_string: "gamma" }, dir));
		expect(text).toContain("Successfully replaced 1 block(s)");
		expect(text).not.toContain("Warning:");
		// …and an unchanged file after a read is quiet too
		noteRead(path.join(dir, "sample.txt"));
		expect(textOf(await run({ path: name, old_string: "alpha", new_string: "alfa" }, dir))).not.toContain("Warning:");
	});

	it("its own write refreshes the stamp: consecutive patches by one session never warn", async () => {
		const { dir, file, name } = await tmpFile("a\nb\nc\n");
		noteRead(file);
		expect(textOf(await run({ path: name, old_string: "b", new_string: "B" }, dir))).not.toContain("Warning:");
		// the file has moved twice since the model's read, but both writers were us
		expect(textOf(await run({ path: name, old_string: "c", new_string: "C" }, dir))).not.toContain("Warning:");
		expect(drifted(file)).toBe(false);
	});

	it("a failed patch carries the warning too and leaves the stale stamp in place", async () => {
		const { dir, file, name } = await tmpFile("alpha\nbeta\n");
		noteRead(file);
		writeFileSync(file, "alpha\nBETA\n"); // same size: coarse clock might not see it
		advanceMtime(file);
		const message = await errorOf({ path: name, old_string: "nothing like this at all", new_string: "x" }, dir);
		expect(message).toContain("Could not find a match for old_string");
		expect(message.endsWith(`\n\n${staleFileWarning(name)}`)).toBe(true);
		// hermes' `_note_edited` runs on success only: the miss keeps the old stamp
		expect(drifted(file)).toBe(true);
	});

	it("flags a file replaced under the same path even with bytes, size and mtime restored", async () => {
		// The point of the version tuple over hermes' bare mtime: an editor,
		// `cp --preserve` or `git checkout` can hand back the same bytes, the
		// same size and a re-applied mtime — the inode (and the un-backdatable
		// ctime) cannot lie. `utimes` can only restate mtime to millisecond
		// precision, so this pins the millisecond part and still flags.
		const { file } = await tmpFile("same bytes\n");
		noteRead(file);
		const before = statSync(file);
		const mtimeMs = Math.floor(before.mtimeMs);
		// let the coarse clock (~1ms here) tick so the strict ctime comparison
		// below is deterministic; `utimes` stamps ctime with "now"
		await new Promise((r) => setTimeout(r, 10));
		rmSync(file);
		writeFileSync(file, "same bytes\n");
		utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
		const after = statSync(file);
		expect(after.size).toBe(before.size);
		// mtime is restated to the recorded value (within the millisecond the
		// `utimes` round trip loses to float seconds), so a size+mtime check
		// would call this file unchanged…
		expect(Math.abs(after.mtimeMs - mtimeMs)).toBeLessThanOrEqual(2);
		// …but the ctime cannot be faked without root: `utimes` stamps it with
		// NOW. The version tuple sees that, which is why it carries ctime_ns.
		expect(after.ctimeMs).toBeGreaterThan(before.ctimeMs);
		expect(drifted(file)).toBe(true);
	});

	it("noteWrite (pi's edit/write results) clears an external-change warning", async () => {
		const { file } = await tmpFile("a\nb\n");
		noteRead(file);
		writeFileSync(file, "a\nB\n"); // same size: coarse clock might not see it
		advanceMtime(file);
		expect(drifted(file)).toBe(true);
		// pi's built-in `edit`/`write` just rewrote it: hermes would have stamped
		// the write in `_note_edited`, and so does the event handler.
		noteWrite(file);
		expect(drifted(file)).toBe(false);
	});

	it("stamps nothing for failed calls, non-file tools, or patch (which stamps itself)", () => {
		expect(stampForToolResult({ toolName: "read", isError: false, input: { path: "a.ts" } })).toEqual({
			kind: "read",
			path: "a.ts",
		});
		expect(stampForToolResult({ toolName: "edit", isError: false, input: { path: "a.ts" } })).toEqual({
			kind: "write",
			path: "a.ts",
		});
		expect(stampForToolResult({ toolName: "write", isError: false, input: { path: "a.ts" } })).toEqual({
			kind: "write",
			path: "a.ts",
		});
		// a failed read served no content; hermes records no stamp
		expect(stampForToolResult({ toolName: "read", isError: true, input: { path: "a.ts" } })).toBeUndefined();
		// hermes' search_files never stamped, so grep/find/ls do not either
		expect(stampForToolResult({ toolName: "grep", isError: false, input: { path: "a.ts" } })).toBeUndefined();
		expect(stampForToolResult({ toolName: "ls", isError: false })).toBeUndefined();
		// patch stamps every path it touched inside execute() (V4A headers are
		// not in `input`, so the event could not cover them)
		expect(stampForToolResult({ toolName: "patch", isError: false, input: { path: "a.ts" } })).toBeUndefined();
		// a call with no usable path is not a read of anything
		expect(stampForToolResult({ toolName: "read", isError: false, input: { path: "" } })).toBeUndefined();
	});

	it("bounds tracked paths at hermes' _READ_TIMESTAMPS_CAP, evicting the oldest", async () => {
		const dir = await tmpDir();
		const paths: string[] = [];
		for (let i = 0; i < READ_STAMPS_CAP; i++) {
			const file = path.join(dir, `f${i}.txt`);
			writeFileSync(file, "x\n");
			noteRead(file);
			paths.push(file);
		}
		expect(readStampCount()).toBe(READ_STAMPS_CAP);
		writeFileSync(paths[0], "changed and longer\n");
		expect(drifted(paths[0])).toBe(true);
		// one more path trims the oldest, like `_cap_read_tracker_data`
		const extra = path.join(dir, "extra.txt");
		writeFileSync(extra, "x\n");
		noteRead(extra);
		expect(readStampCount()).toBe(READ_STAMPS_CAP);
		expect(drifted(paths[0])).toBe(false); // stamp evicted: never-read, never-warn
		expect(drifted(paths[1])).toBe(false); // still tracked, still unchanged
		writeFileSync(paths[1], "changed and longer\n");
		expect(drifted(paths[1])).toBe(true);
	});

	it("V4A: every stale header path warns, joined like hermes' ' | '", async () => {
		const dir = await tmpDir();
		await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n", "utf-8");
		await fs.writeFile(path.join(dir, "b.txt"), "three\nfour\n", "utf-8");
		noteRead(path.join(dir, "a.txt"));
		noteRead(path.join(dir, "b.txt"));
		writeFileSync(path.join(dir, "a.txt"), "one\nTWO\n"); // same size: coarse clock might not see it
		advanceMtime(path.join(dir, "a.txt"));
		writeFileSync(path.join(dir, "b.txt"), "three\nFOUR\n"); // same size: coarse clock might not see it
		advanceMtime(path.join(dir, "b.txt"));
		const result = await run(
			{
				mode: "patch",
				patch: [
					"*** Begin Patch",
					"*** Update File: a.txt",
					"@@",
					" one",
					"-TWO",
					"+ZED",
					"*** Update File: b.txt",
					"@@",
					" three",
					"-FOUR",
					"+YAK",
					"*** End Patch",
				].join("\n"),
			},
			dir,
		);
		const summary = partsOf(result)[0] ?? "";
		const text = textOf(result);
		expect(summary).toContain("Successfully applied V4A patch.");
		// hermes appends `_warning` to the patch_tool payload; the unified diff
		// rides as a SECOND content part (ledger #6), so the warning closes the
		// summary part and lists every stale header path, hermes-joined.
		expect(summary.endsWith(`\n\n${staleFileWarning("a.txt")} | ${staleFileWarning("b.txt")}`)).toBe(true);
		expect(text).toContain("-FOUR");
		// the successful apply stamped both files (hermes `_note_edited`)
		expect(stalenessWarnings([["a.txt", path.join(dir, "a.txt")], ["b.txt", path.join(dir, "b.txt")]])).toEqual([]);
	});

	it("V4A misses carry the warning on the error too", async () => {
		const dir = await tmpDir();
		const file = path.join(dir, "a.txt");
		await fs.writeFile(file, "one\ntwo\n", "utf-8");
		noteRead(file);
		writeFileSync(file, "one\nTWO\n"); // same size: coarse clock might not see it
		advanceMtime(file);
		const message = await errorOf(
			{
				mode: "patch",
				patch: ["*** Begin Patch", "*** Update File: a.txt", "@@", " one", "-never matched", "+x", "*** End Patch"].join(
					"\n",
				),
			},
			dir,
		);
		expect(message).toContain("Could not find a match for old_string");
		expect(message.endsWith(`\n\n${staleFileWarning("a.txt")}`)).toBe(true);
	});
});

describe("extension wiring: tool_result stamps the versions (Tier 4 #12, ledger #19)", () => {
	it("stamps successful read/edit/write results, keyed the way patch resolves them", async () => {
		clearReadStamps();
		const { default: piPatchExtension } = await import("../src/index.js");
		const handlers = new Map<string, (event: never, ctx: never) => void>();
		piPatchExtension({
			registerTool: () => undefined,
			on: (name: string, handler: (event: never, ctx: never) => void) => handlers.set(name, handler),
		} as never);
		const toolResult = handlers.get("tool_result");
		expect(toolResult).toBeTypeOf("function");

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-wiring-"));
		const file = path.join(dir, "sample.txt");
		writeFileSync(file, "a\nb\n");
		// A `read` of the RELATIVE spelling must key the stamp the way `patch`
		// resolves the same call, or the warning would never clear.
		toolResult!(
			{ toolName: "read", isError: false, input: { path: "sample.txt" } } as never,
			{ cwd: dir } as never,
		);
		writeFileSync(file, "a\nB\n"); // same size: coarse clock might not see it
		advanceMtime(file);
		expect(drifted(file)).toBe(true);
		// pi's `edit` rewrote it — a write is an implicit read (hermes _note_edited)
		toolResult!(
			{ toolName: "edit", isError: false, input: { path: "sample.txt" } } as never,
			{ cwd: dir } as never,
		);
		expect(drifted(file)).toBe(false);
		// a failed read saw nothing; `grep` never stamped in hermes; `patch`
		// stamps inside its own execute
		writeFileSync(file, "a\nC\n"); // same size: coarse clock might not see it
		advanceMtime(file);
		toolResult!({ toolName: "read", isError: true, input: { path: "sample.txt" } } as never, { cwd: dir } as never);
		expect(drifted(file)).toBe(true);
		toolResult!({ toolName: "grep", isError: false, input: { path: "sample.txt" } } as never, { cwd: dir } as never);
		expect(drifted(file)).toBe(true);
		toolResult!({ toolName: "patch", isError: false, input: { path: "sample.txt" } } as never, { cwd: dir } as never);
		expect(drifted(file)).toBe(true);
		// `write` clears it
		toolResult!({ toolName: "write", isError: false, input: { path: "sample.txt" } } as never, { cwd: dir } as never);
		expect(drifted(file)).toBe(false);
	});
});

describe("failure-tracker: hermes _record_patch_failure units", () => {
	beforeEach(() => clearPatchFailures());

	it("evicts the oldest path beyond the 64-path cap", () => {
		for (let i = 0; i < 64; i++) recordPatchFailure(`/f${i}`);
		expect(recordPatchFailure("/f0")).toBe(2); // still tracked; update keeps its insertion age
		recordPatchFailure("/f64"); // cap reached: /f0 — the oldest — is evicted
		expect(recordPatchFailure("/f0")).toBe(1); // re-recorded fresh after eviction
	});

	it("reset clears only the given paths", () => {
		recordPatchFailure("/a");
		recordPatchFailure("/b");
		resetPatchFailures(["/a"]);
		expect(recordPatchFailure("/a")).toBe(1);
		expect(recordPatchFailure("/b")).toBe(2);
	});
});

describe("errors: hermes Appendix B fidelity (single-replacement surface)", () => {
	// The param names are hermes' own, so these are byte-exact against
	// fuzzy_match.py / file_operations.py — only the recovery tool names are
	// mapped to pi (ledger #10).
	it("empty and whitespace-only old_string carry hermes' recovery texts", () => {
		expect(emptyOldStringError()).toBe(
			"old_string is empty — nothing to match. Set old_string to the exact existing text the replacement should " +
				"replace (read the file first if unsure). To create a new file or fully rewrite one, use write instead. " +
				"Do not re-send this call unchanged.",
		);
		expect(whitespaceOnlyOldStringError()).toBe(
			"old_string is only whitespace — provide non-blank text to match. Set it to the exact existing text the " +
				"replacement should replace (read the file first if unsure). Do not re-send this call unchanged.",
		);
		expect(identicalStringsError()).toBe(
			"No edit was applied because old_string and new_string are identical. Provide the existing text to replace " +
				"in old_string and the changed replacement text in new_string.",
		);
	});

	it("ambiguity names up to 5 locations and counts the rest", () => {
		const r = applyReplacement("dup\n".repeat(7), { oldString: "dup", newString: "x", replaceAll: false }, "f.py");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errorMessage).toBe(
				"Found 7 matches for old_string. Provide more context to make it unique, or use replace_all=True. Matches:\n" +
					["  L1: dup", "  L2: dup", "  L3: dup", "  L4: dup", "  L5: dup", "  ... and 2 more"].join("\n"),
			);
		}
	});

	it("replace_all refusal is hermes' text", () => {
		const r = applyReplacement(
			"start\nmid1\nend\nstart\nmid2\nend",
			{ oldString: "start\nmid\nend", newString: "QQ", replaceAll: true },
			"f.py",
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errorMessage).toBe(
				"Found 2 approximate matches via the 'block_anchor' strategy; replace_all only applies to exact " +
					"matches. Provide the precise text (whitespace included) so an exact/line-trimmed match can be made.",
			);
		}
	});

	it("already-applied no-op is hermes' text and stays success-shaped", () => {
		const r = applyReplacement("value = 42\n", { oldString: "zzz = 41", newString: "value = 42", replaceAll: false }, "f.py");
		expect(r).toEqual({
			ok: false,
			alreadyApplied: true,
			errorMessage:
				"File already contains the target text — the edit appears to be already applied to f.py. " +
				"No write performed; do not re-send this patch.",
		});
	});

	it("no-match error is hermes' base text plus the did-you-mean hint", () => {
		// "def qux():" is 0.70 from old_string — under context_aware's 0.80 bar,
		// over the 0.30 suggestion floor ("def bar():" would have matched at 0.90).
		const r = applyReplacement(
			"def qux():\n    pass\ndef zork():\n    pass\n",
			{ oldString: "def baz():", newString: "x", replaceAll: false },
			"f.py",
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(
				r.errorMessage.startsWith(
					"Could not find a match for old_string in the file\n\nDid you mean one of these sections?\n",
				),
			).toBe(true);
			expect(r.errorMessage).toContain("def qux():");
			// hermes renders 4-wide right-aligned line numbers ("   1| …")
			expect(r.errorMessage).toMatch(/^ {3}1\| def qux\(\):/m);
		}
	});
});

describe("diagnostics: find_closest_lines + format_no_match_hint (hermes corpora)", () => {
	it("finds the most similar line (TestFindClosestLines)", () => {
		const hint = findClosestLines("def baz():", "def foo():\n    pass\ndef bar():\n    return 1\n");
		expect(hint.includes("def foo") || hint.includes("def bar")).toBe(true);
	});

	it("whitespace-shaped miss shows both lines (TestWhitespaceDiagnosis)", () => {
		// File uses tabs; the model sends 4 spaces AND a wrong second line so every
		// fuzzy strategy misses, but line 1 is a whitespace-only difference.
		const content = "def f():\n\tvalue = compute_thing()\n\treturn value\n";
		const hint = findClosestLines("    value = compute_thing()\n    return wrong_name", content);
		expect(hint).toContain("Whitespace difference detected");
		expect(hint).toContain("→value = compute_thing()");
		expect(hint).toContain("····value = compute_thing()");
	});

	it("content miss carries no whitespace block", () => {
		expect(findClosestLines("alpha = 999", "alpha = 1\nbeta = 2\n")).not.toContain("Whitespace difference detected");
	});

	it("exact line present needs no whitespace diagnosis", () => {
		expect(findClosestLines("  x = 1\n  z = 3", "  x = 1\n  y = 2\n")).not.toContain("Whitespace difference detected");
	});

	it("visualizeWhitespace renders only the leading run (hermes _visualize_whitespace)", () => {
		expect(visualizeWhitespace("\t x = a b")).toBe("→·x = a b");
	});

	it("no-match error end to end carries the whitespace diagnosis (TestEndToEndHint)", () => {
		const content = "class A:\n\tdef run(self):\n\t\tstart_engine()\n\t\treturn 1\n";
		const r = applyReplacement(content, {
			oldString: "    def run(self):\n        boot_engine_wrong()\n        return 2",
			newString: "    def run(self):\n        start_engine()\n        return 3",
			replaceAll: false,
		}, "a.py");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errorMessage).toContain("Did you mean");
			expect(r.errorMessage).toContain("Whitespace difference detected");
		}
	});

	it("the hint only rides on plain no-match errors (TestFormatNoMatchHint)", () => {
		const content = "def foo():\n    pass\n";
		expect(formatNoMatchHint("Could not find a match for old_string in the file", 0, "def baz():", content)).toContain(
			"Did you mean",
		);
		// ambiguous / escape-drift / identical failures already explain themselves
		expect(formatNoMatchHint("Found 2 matches for old_string.", 0, "def baz():", content)).toBe("");
		expect(formatNoMatchHint("Escape-drift detected: old_string contains more literal '\\n' …", 0, "def baz():", content)).toBe("");
		expect(formatNoMatchHint(identicalStringsError(), 0, "def baz():", content)).toBe("");
		// and never on a result that actually matched
		expect(formatNoMatchHint("Could not find a match for old_string in the file", 1, "def baz():", content)).toBe("");
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

// ── V4A patch mode (patch_parser port, Tier 3 #8) ────────────────────────

/** hermes tests' `_DictFileOps`: in-memory file_ops backing store supporting
 * update/move/delete/add. */
class DictFileOps implements V4AFileOps {
	readonly files = new Map<string, string>();
	constructor(files: Record<string, string> = {}) {
		for (const [p, c] of Object.entries(files)) this.files.set(p, c);
	}
	readFileRaw(p: string): RawReadResult {
		if (this.files.has(p)) return { content: this.files.get(p) as string, error: null };
		return { content: "", error: "file not found", notFound: true };
	}
	writeFile(p: string, content: string): V4AWriteResult {
		this.files.set(p, content);
		return { error: null };
	}
	moveFile(src: string, dst: string): { error: string | null } {
		const content = this.files.get(src);
		if (content === undefined) return { error: `file not found: ${src}` };
		this.files.delete(src);
		this.files.set(dst, content);
		return { error: null };
	}
	deleteFile(p: string): { error: string | null } {
		this.files.delete(p);
		return { error: null };
	}
}

function parse(patch: string) {
	const { operations, error } = parseV4APatch(patch);
	expect(error).toBeUndefined();
	return operations;
}

function expectParseError(patch: string): string {
	const { operations, error } = parseV4APatch(patch);
	expect(operations).toEqual([]);
	expect(error).toBeDefined();
	return error as string;
}

function applyOk(ops: ReturnType<typeof parse>, fo: V4AFileOps): PatchResult {
	const result = applyV4AOperations(ops, fo);
	expect(result.error ?? "(no error)").toBe("(no error)");
	expect(result.success).toBe(true);
	return result;
}

describe("V4A parse: hermes test_patch_parser corpora", () => {
	it("parses a basic Update op with hint and mixed prefixes", () => {
		const ops = parse(`*** Begin Patch
*** Update File: src/main.py
@@ def greet @@
 def greet():
-    print("hello")
+    print("hi")
*** End Patch`);
		expect(ops.length).toBe(1);
		const op = ops[0];
		expect(op.operation).toBe("update");
		expect(op.filePath).toBe("src/main.py");
		expect(op.hunks.length).toBe(1);
		const hunk = op.hunks[0];
		expect(hunk.contextHint).toBe("def greet");
		const prefixes = hunk.lines.map((l) => l.prefix);
		expect(prefixes).toContain(" ");
		expect(prefixes).toContain("-");
		expect(prefixes).toContain("+");
	});

	it("parses multiple hunks with their own hints", () => {
		const ops = parse(`*** Begin Patch
*** Update File: f.py
@@ first @@
 a
-b
+c
@@ second @@
 x
-y
+z
*** End Patch`);
		expect(ops.length).toBe(1);
		expect(ops[0].hunks.length).toBe(2);
		expect(ops[0].hunks[0].contextHint).toBe("first");
		expect(ops[0].hunks[1].contextHint).toBe("second");
	});

	it("parses an Add op with blank + lines kept", () => {
		const ops = parse(`*** Begin Patch
*** Add File: new/module.py
+import os
+
+print("hello")
*** End Patch`);
		expect(ops.length).toBe(1);
		const op = ops[0];
		expect(op.operation).toBe("add");
		expect(op.filePath).toBe("new/module.py");
		expect(op.hunks.length).toBe(1);
		const contents = ops[0].hunks[0].lines.filter((l) => l.prefix === "+").map((l) => l.content);
		expect(contents[0]).toBe("import os");
		expect(contents[2]).toBe('print("hello")');
	});

	it("parses a Delete op", () => {
		const ops = parse(`*** Begin Patch
*** Delete File: old/stuff.py
*** End Patch`);
		expect(ops.length).toBe(1);
		expect(ops[0]).toMatchObject({ operation: "delete", filePath: "old/stuff.py" });
	});

	it("parses a Move op with both endpoints", () => {
		const ops = parse(`*** Begin Patch
*** Move File: old/path.py -> new/path.py
*** End Patch`);
		expect(ops.length).toBe(1);
		expect(ops[0]).toMatchObject({ operation: "move", filePath: "old/path.py", newPath: "new/path.py" });
	});

	it("keeps an End Patch marker mentioned inside Add content (no truncation)", () => {
		const ops = parse(`*** Begin Patch
*** Add File: notes.md
+doc line one
+*** End Patch
+content after the marker mention
*** End Patch`);
		expect(ops.length).toBe(1);
		const contents = ops[0].hunks[0].lines.filter((l) => l.prefix === "+").map((l) => l.content);
		expect(contents).toEqual([
			"doc line one",
			"*** End Patch",
			"content after the marker mention",
		]);
	});

	it("keeps a Begin Patch marker mentioned inside Add content (no discarded ops)", () => {
		const ops = parse(`*** Begin Patch
*** Add File: first.md
+first file content
*** Add File: second.md
+*** Begin Patch
+second file content
*** End Patch`);
		expect(ops.map((op) => [op.operation, op.filePath])).toEqual([
			["add", "first.md"],
			["add", "second.md"],
		]);
	});

	it("keeps an End Patch marker as a context line (no truncation)", () => {
		const ops = parse(`*** Begin Patch
*** Update File: guide.md
@@ section @@
 old line
 *** End Patch
+new line
*** End Patch`);
		expect(ops.length).toBe(1);
		const hunkLines = ops[0].hunks[0].lines.map((l) => [l.prefix, l.content]);
		expect(hunkLines).toContainEqual([" ", "*** End Patch"]);
		expect(hunkLines).toContainEqual(["+", "new line"]);
	});

	it("empty patch returns empty ops, no error", () => {
		const { operations, error } = parseV4APatch("");
		expect(error).toBeUndefined();
		expect(operations).toEqual([]);
	});

	it("parses multiple operations in order", () => {
		const ops = parse(`*** Begin Patch
*** Add File: a.py
+content_a
*** Delete File: b.py
*** Update File: c.py
 keep
-remove
+add
*** End Patch`);
		expect(ops.length).toBe(3);
		expect(ops.map((op) => op.operation)).toEqual(["add", "delete", "update"]);
	});

	it("UPDATE with no hunks is a parse error", () => {
		expectParseError(`*** Begin Patch
*** Update File: foo.py
*** End Patch`);
	});

	it("a well-formed patch parses without error", () => {
		const ops = parse(`*** Begin Patch
*** Update File: f.py
 ctx
-old
+new
*** End Patch`);
		expect(ops.length).toBe(1);
	});

	it("empty file path and hunk-less UPDATE parse errors accumulate", () => {
		// '*** Update File:  ' — the marker's (.+) captures a space, stripped to ""
		expect(expectParseError("*** Begin Patch\n*** Update File:  \n*** End Patch")).toBe(
			"Parse error: Operation with empty file path; UPDATE '': no hunks found",
		);
	});

	it("MOVE with a whitespace destination is a parse error", () => {
		expect(expectParseError("*** Begin Patch\n*** Move File: a.py -> \n*** End Patch")).toBe(
			"Parse error: MOVE 'a.py': missing destination path (expected 'src -> dst')",
		);
	});

	it("counts occurrences with overlaps (hermes _count_occurrences)", () => {
		// The shared helper the addition-only hint checks ride on: advancing one
		// char per hit means overlapping matches each count.
		expect(countOccurrences("aaa", "a")).toBe(3);
		expect(countOccurrences("aaa", "aa")).toBe(2);
		expect(countOccurrences("hello world", "xyz")).toBe(0);
		expect(countOccurrences("", "x")).toBe(0);
	});
});

describe("V4A apply: hermes test_patch_parser corpora", () => {
	it("preserves non-prefix pipe characters in unmodified lines", () => {
		const ops = parse(`*** Begin Patch
*** Update File: sample.py
@@ result @@
    result = 1
-    return result
+    return result + 1
*** End Patch`);
		const fo = new DictFileOps({
			"sample.py": 'def run():\n    cmd = "echo a | sed s/a/b/"\n    result = 1\n    return result',
		});
		const result = applyOk(ops, fo);
		expect(fo.files.get("sample.py")).toBe(
			'def run():\n    cmd = "echo a | sed s/a/b/"\n    result = 1\n    return result + 1',
		);
		// The diff is Python difflib.unified_diff byte-for-byte (CPython 3.12,
		// including the missing newline between the - and + rows on a file that
		// lacks a trailing newline).
		expect(result.diff).toBe(
			'--- a/sample.py\n+++ b/sample.py\n@@ -1,4 +1,4 @@\n def run():\n     cmd = "echo a | sed s/a/b/"\n     result = 1\n-    return result+    return result + 1',
		);
	});

	it("inserts an addition-only hunk after its context hint (#3081)", () => {
		const ops = parse(`*** Begin Patch
*** Update File: src/app.py
@@ def main @@
+def helper():
+    return 42
*** End Patch`);
		// All lines should be additions
		expect(ops[0].hunks[0].lines.every((l) => l.prefix === "+")).toBe(true);
		const fo = new DictFileOps({ "src/app.py": "def main():\n    pass\n" });
		applyOk(ops, fo);
		const written = fo.files.get("src/app.py") as string;
		expect(written).toContain("def helper():");
		expect(written).toContain("return 42");
		expect(written).toBe("def main():\ndef helper():\n    return 42\n    pass\n");
	});

	it("appends an addition-only hunk without a hint at end of file", () => {
		const ops = parse(`*** Begin Patch
*** Update File: src/app.py
+def new_func():
+    return True
*** End Patch`);
		const fo = new DictFileOps({ "src/app.py": "existing = True\n" });
		applyOk(ops, fo);
		const written = fo.files.get("src/app.py") as string;
		expect(written.endsWith("def new_func():\n    return True\n")).toBe(true);
		expect(written).toContain("existing = True");
	});

	it("applies to files over 2000 lines without truncation", () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line_${i + 1}`);
		lines[2199] = "line_2200";
		lines[2200] = "old_value";
		const ops = parse(`*** Begin Patch
*** Update File: big.py
@@ marker_at_2200 @@
 line_2200
-old_value
+new_value
*** End Patch`);
		const fo = new DictFileOps({ "big.py": lines.join("\n") });
		applyOk(ops, fo);
		const writtenLines = (fo.files.get("big.py") as string).split("\n");
		expect(writtenLines.length).toBe(2500);
		expect(writtenLines.join("\n")).toContain("new_value");
		expect(writtenLines.join("\n")).not.toContain("old_value");
	});

	it("preserves lines over 2000 chars verbatim", () => {
		const longLine = "x".repeat(3000);
		const ops = parse(`*** Begin Patch
*** Update File: wide.py
@@ short_func @@
 def short_func():
-    return 1
+    return 2
*** End Patch`);
		const fo = new DictFileOps({ "wide.py": `def short_func():\n    return 1\n${longLine}\n` });
		applyOk(ops, fo);
		const written = fo.files.get("wide.py") as string;
		expect(written).toContain(longLine);
		expect(written).not.toContain("... [truncated]");
	});

	it("validation failure writes nothing", () => {
		const ops = parse(`*** Begin Patch
*** Update File: a.py
 def good():
-    return 1
+    return 2
*** Update File: b.py
 THIS LINE DOES NOT EXIST
-    old
+    new
*** End Patch`);
		const fo = new DictFileOps({
			"a.py": "def good():\n    return 1\n",
			"b.py": "completely different content\n",
		});
		const result = applyV4AOperations(ops, fo);
		expect(result.success).toBe(false);
		expect([...fo.files.entries()]).toEqual([
			["a.py", "def good():\n    return 1\n"],
			["b.py", "completely different content\n"],
		]);
		expect(result.error).toContain("validation failed");
		expect(result.error).toContain("  • b.py: hunk 1");
	});

	it("validation errors identify the hunk number", () => {
		const ops = parse(`*** Begin Patch
*** Update File: a.py
@@ first @@
-first = 1
+first = 2
@@ missing @@
-does_not_exist = 1
+does_not_exist = 2
*** End Patch`);
		const fo = new DictFileOps({ "a.py": "first = 1\n" });
		const result = applyV4AOperations(ops, fo);
		expect(result.success).toBe(false);
		expect(result.error?.toLowerCase()).toContain("hunk 2");
	});

	it("Add onto an existing file fails and preserves the original contents", () => {
		const ops = parse(`*** Begin Patch
*** Add File: exists.py
+brand new
+content
*** End Patch`);
		const fo = new DictFileOps({ "exists.py": "def keep_me():\n    return 1\n" });
		const result = applyV4AOperations(ops, fo);
		expect(result.success).toBe(false);
		expect(fo.files.get("exists.py")).toBe("def keep_me():\n    return 1\n");
		expect(result.error).toContain("already exists");
		expect(result.error?.toLowerCase()).toContain("validation failed");
	});

	it("Delete then Add of the same path still validates (overlay frees the path)", () => {
		const ops = parse(`*** Begin Patch
*** Delete File: rewrite.py
*** Add File: rewrite.py
+fresh = True
*** End Patch`);
		const fo = new DictFileOps({ "rewrite.py": "old = True\n" });
		applyOk(ops, fo);
		expect(fo.files.get("rewrite.py")).toBe("fresh = True");
	});

	it("a context-only patch is rejected as containing no changes", () => {
		const ops = parse(`*** Begin Patch
*** Update File: f.py
 keep
 keep2
*** End Patch`);
		const fo = new DictFileOps({ "f.py": "keep\nkeep2\n" });
		const result = applyV4AOperations(ops, fo);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Patch contains no changes (only context lines were provided)");
	});

	it("delete diff embeds the removed lines, not a placeholder", () => {
		const ops = parse(`*** Begin Patch
*** Delete File: old/stuff.py
*** End Patch`);
		const fo = new DictFileOps({ "old/stuff.py": "def old_func():\n    return 42\n" });
		const result = applyOk(ops, fo);
		expect(result.diff).toBe(
			"--- a/old/stuff.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-def old_func():\n-    return 42\n",
		);
	});

	it("delete of an empty file falls back to the comment diff", () => {
		const ops = parse(`*** Begin Patch
*** Delete File: empty.py
*** End Patch`);
		const fo = new DictFileOps({ "empty.py": "" });
		const result = applyOk(ops, fo);
		// unified_diff produces nothing for two empty inputs — fallback comment expected
		expect(result.diff).toBe("# Deleted: empty.py");
	});

	it("two-arg write implementations still work (one call, no double write)", () => {
		const calls: string[] = [];
		class BasicOps extends DictFileOps {
			writeFile(p: string, content: string) {
				// no preContent parameter — hermes' duck-typed two-arg contract
				calls.push(p);
				return super.writeFile(p, content);
			}
		}
		const ops = parse(`*** Begin Patch
*** Update File: f.py
@@
-x = 1
+x = 2
*** End Patch`);
		const fo = new BasicOps({ "f.py": "x = 1\n" });
		applyOk(ops, fo);
		expect(fo.files.get("f.py")).toBe("x = 2\n");
		expect(calls).toEqual(["f.py"]); // exactly one write, no double invocation
	});

	it("a TypeError inside write is surfaced once, never retried with fewer args", () => {
		const calls: string[] = [];
		class ExplodingOps extends DictFileOps {
			writeFile(_p: string, _content: string, _preContent?: string): { error: string | null } {
				calls.push(_p);
				throw new TypeError("bug inside a pre_content-capable impl");
			}
		}
		const ops = parse(`*** Begin Patch
*** Update File: f.py
@@
-x = 1
+x = 2
*** End Patch`);
		const fo = new ExplodingOps({ "f.py": "x = 1\n" });
		const result = applyV4AOperations(ops, fo);
		expect(result.success).toBe(false);
		expect(result.error).toContain("bug inside");
		expect(calls).toEqual(["f.py"]); // not silently retried with 2 args
	});

	it("move-then-update of the same file validates and applies", () => {
		const ops = parse(`*** Begin Patch
*** Move File: a.py -> b.py
*** Update File: b.py
@@
-x = 1
+x = 42
*** End Patch\n`);
		const fo = new DictFileOps({ "a.py": "x = 1\nkeep = 2\n" });
		applyOk(ops, fo);
		expect(fo.files.has("a.py")).toBe(false);
		expect(fo.files.get("b.py")).toBe("x = 42\nkeep = 2\n");
	});

	it("the overlay does not mask a genuine move-destination conflict", () => {
		const ops = parse(`*** Begin Patch
*** Move File: a.py -> b.py
*** End Patch\n`);
		const fo = new DictFileOps({ "a.py": "1\n", "b.py": "2\n" });
		const result = applyV4AOperations(ops, fo);
		expect(result.success).toBe(false);
		expect(result.error).toContain("already exists");
	});

	it("a CRLF patch body does not inject stray carriage returns", () => {
		const ops = parse(
			"*** Begin Patch\r\n*** Update File: f.py\r\n@@\r\n-    x = 1\r\n+    x = 2\r\n*** End Patch\r\n",
		);
		const fo = new DictFileOps({ "f.py": "def f():\n    x = 1\n    return x\n" });
		applyOk(ops, fo);
		expect(fo.files.get("f.py")).toBe("def f():\n    x = 2\n    return x\n");
	});

	it("reports apply-phase failures as possibly inconsistent state", () => {
		// The fake's write always fails: validation passed, apply must report the
		// race note, not the validation one.
		const ops = parse(`*** Begin Patch
*** Update File: f.py
@@
-x = 1
+x = 2
*** End Patch`);
		const fo = new DictFileOps({ "f.py": "x = 1\n" });
		fo.writeFile = () => ({ error: "disk on fire" });
		const result = applyV4AOperations(ops, fo);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Apply phase failed (state may be inconsistent — run `git diff` to assess)");
		expect(result.error).toContain("Failed to update f.py: disk on fire");
	});
});

describe("V4A apply: unified diff is Python difflib.unified_diff (CPython goldens)", () => {
	// Goldens generated with: python3 -c "import difflib; print(repr(''.join(
	//   difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True),
	//   fromfile='a/f.py', tofile='b/f.py'))))" — hunk grouping (get_grouped_opcodes),
	// range formatting (_format_range_unified) and trailing-newline handling included.

	function updateDiff(fo: DictFileOps, patch: string): PatchResult {
		return applyOk(parse(patch), fo);
	}

	it("splits hunks on equal runs longer than 2n", () => {
		const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n";
		const fo = new DictFileOps({ "f.py": old });
		const result = updateDiff(fo, `*** Begin Patch
*** Update File: f.py
@@ l2 @@
-l2
+L2
@@ l15 @@
-l15
+L15
*** End Patch`);
		expect(result.diff).toBe(
			"--- a/f.py\n+++ b/f.py\n@@ -1,6 +1,6 @@\n l0\n l1\n-l2\n+L2\n l3\n l4\n l5\n"
			+ "@@ -13,7 +13,7 @@\n l12\n l13\n l14\n-l15\n+L15\n l16\n l17\n l18\n",
		);
	});

	it("formats single-line ranges without a length and handles no-trailing-newline files", () => {
		const fo = new DictFileOps({ "f.py": "x\n" });
		expect(updateDiff(fo, `*** Begin Patch
*** Update File: f.py
-x
+y
*** End Patch`).diff).toBe("--- a/f.py\n+++ b/f.py\n@@ -1 +1 @@\n-x\n+y\n");

		const fo2 = new DictFileOps({ "f.py": "a\nb" });
		expect(updateDiff(fo2, `*** Begin Patch
*** Update File: f.py
-b
+B
*** End Patch`).diff).toBe("--- a/f.py\n+++ b/f.py\n@@ -1,2 +1,2 @@\n a\n-b+B");
	});

	it("trims context to n=3 at file boundaries (CPython grouping)", () => {
		const old7 = "a\n" + Array.from({ length: 7 }, (_, i) => `e${i}`).join("\n") + "\nz\n";
		const fo = new DictFileOps({ "f.py": old7 });
		expect(updateDiff(fo, `*** Begin Patch
*** Update File: f.py
@@ top @@
-a
+A
@@ bottom @@
-z
+Z
*** End Patch`).diff).toBe(
			"--- a/f.py\n+++ b/f.py\n@@ -1,4 +1,4 @@\n-a\n+A\n e0\n e1\n e2\n@@ -6,4 +6,4 @@\n e4\n e5\n e6\n-z\n+Z\n",
		);

		// 8 equal lines between the changes: the second group starts one line
		// later than the 7-line case (CPython's exact shapes, regenerated
		// directly from difflib to avoid hand-copied goldens).
		const old8 = "a\n" + Array.from({ length: 8 }, (_, i) => `e${i}`).join("\n") + "\nz\n";
		const fo2 = new DictFileOps({ "f.py": old8 });
		expect(updateDiff(fo2, `*** Begin Patch
*** Update File: f.py
@@ top @@
-a
+A
@@ bottom @@
-z
+Z
*** End Patch`).diff).toBe(
			"--- a/f.py\n+++ b/f.py\n@@ -1,4 +1,4 @@\n-a\n+A\n e0\n e1\n e2\n@@ -7,4 +7,4 @@\n e5\n e6\n e7\n-z\n+Z\n",
		);
	});

	it("insertions format the new-side range CPython-style", () => {
		const fo = new DictFileOps({ "f.py": "a\nc\n" });
		expect(updateDiff(fo, `*** Begin Patch
*** Update File: f.py
@@ a @@
 a
+B
*** End Patch`).diff).toBe("--- a/f.py\n+++ b/f.py\n@@ -1,2 +1,3 @@\n a\n+B\n c\n");
	});
});

describe("V4A apply: LSP diagnostics propagation (hermes corpora)", () => {
	const diagBlock = '<diagnostics file="foo.ts">\nERROR [1:7] some diagnostic\n</diagnostics>';

	function opsAdding(path: string, content: string) {
		const lines = content.split("\n").map((l) => `+${l}`).join("\n");
		return parse(`*** Begin Patch\n*** Add File: ${path}\n${lines}\n*** End Patch`);
	}

	it("ADD op: WriteResult.lsp_diagnostics flows through", () => {
		const fo = new DictFileOps();
		fo.writeFile = () => ({ error: null, lspDiagnostics: diagBlock });
		const result = applyOk(opsAdding("foo.ts", "const x: number = 1"), fo);
		expect(result.lspDiagnostics).toBe(diagBlock);
	});

	it("UPDATE op: WriteResult.lsp_diagnostics flows through", () => {
		const ops = parse(`*** Begin Patch\n*** Update File: bar.ts\n-old\n+new\n*** End Patch`);
		const block = '<diagnostics file="bar.ts">\nERROR [3:1] something\n</diagnostics>';
		const fo = new DictFileOps({ "bar.ts": "ctx\nold\nctx\n" });
		fo.writeFile = () => ({ error: null, lspDiagnostics: block });
		const result = applyOk(ops, fo);
		expect(result.lspDiagnostics).toBe(block);
	});

	it("stays null when no write produced diagnostics", () => {
		const fo = new DictFileOps();
		fo.writeFile = () => ({ error: null }); // lsp_diagnostics omitted entirely
		const result = applyOk(opsAdding("foo.py", "x = 1"), fo);
		expect(result.lspDiagnostics).toBeNull();
	});

	it("combines per-file blocks so attribution is preserved", () => {
		const perFile: Record<string, string> = {
			"a.ts": '<diagnostics file="a.ts">\nERR a\n</diagnostics>',
			"b.ts": '<diagnostics file="b.ts">\nERR b\n</diagnostics>',
		};
		const fo = new DictFileOps();
		fo.writeFile = (p) => ({ error: null, lspDiagnostics: perFile[p] });
		const ops = parse(`*** Begin Patch\n*** Add File: a.ts\n+const a = 1\n*** Add File: b.ts\n+const b = 2\n*** End Patch`);
		const result = applyOk(ops, fo);
		expect(result.lspDiagnostics).not.toBeNull();
		expect(result.lspDiagnostics).toContain(perFile["a.ts"]);
		expect(result.lspDiagnostics).toContain(perFile["b.ts"]);
	});
});

describe("V4A apply: validate/apply race defenses", () => {
	it("retries a failed hunk inside the ±500/+2000 context-hint window", () => {
		// The file changed between validation and apply (the race the retry
		// exists for): the pattern is now ambiguous in the full content but
		// unique within 500 chars before the hint.
		const drifted = "s".repeat(600) + "alpha\nbeta\n" + "t".repeat(600) + "\nmid\n" + "alpha\nbeta\n" + "end\n";
		let reads = 0;
		const writes: string[] = [];
		const fileOps: V4AFileOps = {
			readFileRaw: () => {
				reads++;
				return reads === 1 ? { content: "alpha\nbeta\nkeep\n", error: null } : { content: drifted, error: null };
			},
			writeFile: (_p, content) => {
				writes.push(content);
				return { error: null };
			},
			deleteFile: () => ({ error: null }),
			moveFile: () => ({ error: null }),
		};
		const result = applyV4APatch(`*** Begin Patch
*** Update File: f.py
@@ mid @@
-alpha
-beta
+alpha
+gamma
*** End Patch`, fileOps);
		expect(result.success).toBe(true);
		expect(writes.length).toBe(1);
		// The edit landed at the SECOND occurrence (inside the hint window); the
		// first occurrence, outside the window, is untouched.
		const firstNeedleEnd = drifted.indexOf("beta") + "beta".length;
		expect(writes[0].indexOf("gamma")).toBeGreaterThan(firstNeedleEnd);
		expect(writes[0].split("beta").length - 1).toBe(1);
	});

	it("mirrors validation's already-applied skip when the file moved under the patch", () => {
		let reads = 0;
		const writes: string[] = [];
		const fileOps: V4AFileOps = {
			readFileRaw: () => {
				reads++;
				return reads === 1
					? { content: "alpha\nbeta\nkeep\n", error: null }
					: { content: "alpha\ngamma\nkeep\n", error: null };
			},
			writeFile: (_p, content) => {
				writes.push(content);
				return { error: null };
			},
			deleteFile: () => ({ error: null }),
			moveFile: () => ({ error: null }),
		};
		const result = applyV4APatch(`*** Begin Patch
*** Update File: f.py
@@
-alpha
-beta
+alpha
+gamma
*** End Patch`, fileOps);
		// The apply-phase fuzzy fails, the already-applied check matches, and the
		// hunk is skipped instead of failing the whole patch.
		expect(result.success).toBe(true);
		expect(writes.length).toBe(1);
		expect(writes[0]).toBe("alpha\ngamma\nkeep\n");
	});
});

describe("V4A apply: BOM round trip (hermes corpora)", () => {
	const BOM = "\uFEFF";

	/** Fake file_ops mimicking the real read/write contract the tool layer
	 * implements (Tier 3 #10): raw reads arrive BOM-stripped, writes probe the
	 * target on disk and restore a BOM the original had. */
	function bomPreservingFileOps(file: string, originalBytes: string): V4AFileOps {
		return {
			readFileRaw: () => {
				const decoded = originalBytes;
				return { content: decoded.startsWith(BOM) ? decoded.slice(1) : decoded, error: null };
			},
			writeFile: (_p, content) => {
				// Simulate the real write: probe the target for a BOM and prepend
				// if the original had one.
				const disk = readFileSync(file, "utf-8");
				const hadBom = disk.startsWith(BOM);
				const out = hadBom && !content.startsWith(BOM) ? BOM + content : content;
				writeFileSync(file, out, "utf-8");
				return { error: null };
			},
			deleteFile: () => ({ error: null }),
			moveFile: () => ({ error: null }),
		};
	}

	it("a V4A UPDATE on a BOM-bearing file keeps the BOM", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-v4a-"));
		const file = path.join(dir, "bom_config.py");
		const original = BOM + "setting = 'old'\n";
		await fs.writeFile(file, original, "utf-8");
		const ops = parse(`*** Begin Patch
*** Update File: bom_config.py
@@ setting @@
-setting = 'old'
+setting = 'new'
*** End Patch`);
		const result = applyOk(ops, bomPreservingFileOps(file, original));
		expect(result.success).toBe(true);
		const raw = await fs.readFile(file, "utf-8");
		expect(raw.startsWith(BOM)).toBe(true);
		expect(raw).toContain("setting = 'new'");
		expect(raw).not.toContain("setting = 'old'");
	});

	it("a V4A UPDATE on a plain file must NOT inject a BOM", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-patch-v4a-"));
		const file = path.join(dir, "plain.py");
		const original = "print('hello')\n";
		await fs.writeFile(file, original, "utf-8");
		const ops = parse(`*** Begin Patch
*** Update File: plain.py
@@ print @@
-print('hello')
+print('world')
*** End Patch`);
		const result = applyOk(ops, bomPreservingFileOps(file, original));
		expect(result.success).toBe(true);
		const raw = await fs.readFile(file, "utf-8");
		expect(raw.startsWith(BOM)).toBe(false);
		expect(raw).toContain("print('world')");
	});
});

describe("orchestrator: fuzzyFindAndReplace unification (Tier 3 #8)", () => {
	it("an identical old/new re-send whose text is present is hermes' success-shaped no-op", () => {
		// hermes gates identical strings inside fuzzy_find_and_replace, so
		// _no_match_result's already-applied check sees the error first and the
		// re-send lands as a no-op — not as the identical-strings teaching error.
		const r = applyReplacement("value = 42\n", { oldString: "value = 42", newString: "value = 42", replaceAll: false }, "f.py");
		expect(r).toEqual({
			ok: false,
			alreadyApplied: true,
			errorMessage:
				"File already contains the target text — the edit appears to be already applied to f.py. " +
				"No write performed; do not re-send this patch.",
		});
	});

	it("short identical strings keep the identical-strings teaching error", () => {
		const r = applyReplacement("abc\n", { oldString: "abc", newString: "abc", replaceAll: false }, "f.py");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.alreadyApplied).toBeUndefined();
			expect(r.errorMessage).toMatch(/^No edit was applied because old_string and new_string are identical/);
		}
	});
});
