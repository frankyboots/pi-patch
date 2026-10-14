/**
 * Escape-drift guards (analysis §4, Appendix B; PLAN.md Tier 1 #3) — a
 * verbatim port of hermes' `_detect_escape_drift` block in fuzzy_match.py.
 *
 * Tolerant (non-exact) matches came through some normalization, so the
 * arguments may carry tool-call serialization artifacts the file does not
 * have: a literal `\n` standing in for a real line break, spurious `\'`/`\"`
 * quote escapes, or every backslash run exactly doubled (JSON-escaped one
 * extra time). Writing such arguments verbatim corrupts the file, so the
 * orchestrator runs these guards BEFORE anything is written and refuses with
 * a teaching error instead (hermes: `fuzzy_find_and_replace`, between the
 * strategy match and `_apply_replacements`).
 *
 * Detection returns structured results; the model-facing texts are built by
 * `escapeDriftErrorMessage` in errors.ts (this repo keeps error text in one
 * place; hermes builds the strings inside the guards).
 */
import type { Span } from "./span-map.js";

/** Structured drift result: which artifact was detected. */
export type EscapeDrift =
	/** Literal `\n` in the arguments standing in for a real line break. */
	| { kind: "newline_literal" }
	/** `\'` or `\"` in both strings but not the matched region. */
	| { kind: "quote_suspect"; suspect: string; plain: string }
	/** Every backslash run in oldText exactly 2x the file's. */
	| { kind: "backslash_doubling" };

/** hermes `_matched_regions`: the matched file bytes, concatenated. Shared
 * with the Tier 1 #4 shaping (`_maybe_unescape_new_string`'s region probe). */
export function matchedRegions(content: string, spans: readonly Span[]): string {
	return spans.map((s) => content.slice(s.start, s.end)).join("");
}

/** Non-overlapping occurrence count — Python `str.count` semantics. */
function countOccurrences(s: string, needle: string): number {
	return needle === "" ? 0 : s.split(needle).length - 1;
}

/**
 * hermes `_detect_newline_literal_drift`: error when a literal two-character
 * `\n` in the arguments stands in for a real line break in the file
 * (arguments JSON-escaped one extra time).
 *
 * Fires when some matched region contains a real newline and oldText holds
 * MORE literal `\n` than that region. oldText is copied from the file, so a
 * genuine edit has equal counts even when the code legitimately contains
 * `"\n"`; only the surplus is drift. Regions are compared one by one because
 * joining them would multiply the file-side count under replaceAll.
 * newText must carry a literal `\n` too: that is what gets written in place
 * of a line break, since the `\t`/`\r` unescape (Tier 1 #4) deliberately
 * never rewrites `\n`. Drift in newText alone is indistinguishable from an
 * edit that adds a `\n` literal.
 */
function detectNewlineLiteralDrift(
	content: string,
	spans: readonly Span[],
	oldText: string,
	newText: string,
): EscapeDrift | undefined {
	if (!newText.includes("\\n")) return undefined;
	const oldLiterals = countOccurrences(oldText, "\\n");
	for (const span of spans) {
		const region = content.slice(span.start, span.end);
		if (region.includes("\n") && oldLiterals > countOccurrences(region, "\\n")) {
			return { kind: "newline_literal" };
		}
	}
	return undefined;
}

/** Lengths of maximal backslash runs in `s`, in order (hermes `_backslash_runs`,
 * `re.findall(r"\\+", s)` — greedy, so runs are maximal). */
function backslashRuns(s: string): number[] {
	return (s.match(/\\+/g) ?? []).map((run) => run.length);
}

function sameRuns(a: number[], b: number[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * hermes `_detect_backslash_doubling`: detect oldText whose every backslash
 * run is exactly 2x the file's (arguments JSON-escaped one extra time).
 * Requires the same run count, a non-trivial signal (a run >= 2 or 2+ runs),
 * and newText not already matching the file's counts.
 */
function detectBackslashDoubling(regions: string, oldText: string, newText: string): EscapeDrift | undefined {
	const oldRuns = backslashRuns(oldText);
	const fileRuns = backslashRuns(regions);
	if (
		oldRuns.length === 0 ||
		fileRuns.length === 0 ||
		oldRuns.length !== fileRuns.length ||
		sameRuns(oldRuns, fileRuns) ||
		oldRuns.some((o, i) => o !== fileRuns[i] * 2) ||
		!(fileRuns.some((f) => f >= 2) || fileRuns.length >= 2) ||
		sameRuns(backslashRuns(newText), fileRuns)
	) {
		return undefined;
	}
	return { kind: "backslash_doubling" };
}

/**
 * hermes `_detect_escape_drift`: structured drift result when newText carries
 * tool-call escape artifacts, else undefined: `\'`/`\"` in both strings but
 * not the matched region, a literal `\n` standing in for a real line break,
 * or doubled backslash runs. Call with the winning strategy's FINAL spans
 * (all of them under replaceAll) — only regions that will actually be
 * written may vote.
 */
export function detectEscapeDrift(
	content: string,
	spans: readonly Span[],
	oldText: string,
	newText: string,
): EscapeDrift | undefined {
	const hasQuoteSuspects = newText.includes("\\'") || newText.includes('\\"');
	if (!hasQuoteSuspects && !oldText.includes("\\")) return undefined;

	const regions = matchedRegions(content, spans);
	if (hasQuoteSuspects) {
		for (const suspect of ["\\'", '\\"']) {
			if (newText.includes(suspect) && oldText.includes(suspect) && !regions.includes(suspect)) {
				return { kind: "quote_suspect", suspect, plain: suspect.charAt(1) };
			}
		}
	}
	const newlineDrift = detectNewlineLiteralDrift(content, spans, oldText, newText);
	if (newlineDrift) return newlineDrift;
	return detectBackslashDoubling(regions, oldText, newText);
}
