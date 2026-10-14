/**
 * Ordered match-strategy chain for `patch` — following hermes' reference
 * order (docs/EDIT-TOOL-ANALYSIS.md Appendix A):
 *
 *   exact → line_trimmed → whitespace_normalized → indentation_flexible
 *         → escape_normalized → trimmed_boundary → unicode_normalized
 *         → block_anchor → context_aware
 *
 * The first four are implemented (the ones needing no span algebra); Tier 1
 * of the exact-port plan (docs/PLAN.md) adds the missing five in exactly
 * this order.
 * Ported from hermes' fuzzy_match.py. Key properties copied verbatim:
 *
 * - First strategy with ≥1 match wins; >1 match → ambiguous error with the
 *   match locations. No fall-through past an ambiguous result.
 * - Uniqueness is counted **per strategy, in that strategy's space**. This
 *   avoids pi's normalize-then-count false-ambiguity bug (§3.1 of the
 *   analysis): two regions differing only by smart quotes cannot make a
 *   byte-unique oldText report "Found 2 occurrences".
 * - Strategies return spans into the (LF-normalized) original content, so the
 *   matched file bytes — not the pattern's — drive the splice.
 */
import { buildLineIndex, countOccurrences, lineAt, type LineIndex } from "./text.js";

export type StrategyName = "exact" | "line_trimmed" | "indentation_flexible" | "trimmed_boundary";

export const STRATEGY_CHAIN: readonly StrategyName[] = [
	"exact",
	"line_trimmed",
	"indentation_flexible",
	"trimmed_boundary",
];

export interface ChainMatch {
	strategy: StrategyName;
	/** Start offset of the matched span in the LF-normalized content */
	start: number;
	/** End offset (exclusive) of the matched span */
	end: number;
	/** True when the matched bytes equal oldText exactly (strategy "exact") */
	exact: boolean;
}

export interface MatchLocation {
	/** 1-based line number of the match start */
	line: number;
	/** Trimmed first line of the match, truncated for display */
	snippet: string;
}

export type ChainFailure =
	| { kind: "ambiguous"; strategy: StrategyName; count: number; locations: MatchLocation[] }
	| { kind: "no_match" };

export type ChainResult = { ok: true; match: ChainMatch } | { ok: false; failure: ChainFailure };

interface PatternLines {
	lines: string[];
	requiresTrailingNewline: boolean;
}

function parsePattern(oldText: string): PatternLines {
	if (oldText.endsWith("\n")) {
		return { lines: oldText.slice(0, -1).split("\n"), requiresTrailingNewline: true };
	}
	return { lines: oldText.split("\n"), requiresTrailingNewline: false };
}

type LineComparator = (patternLine: string, contentLine: string, k: number, n: number) => boolean;

function comparatorFor(strategy: StrategyName): LineComparator {
	switch (strategy) {
		case "line_trimmed":
			// Margin whitespace churn: leading and trailing whitespace ignored per line.
			return (p, c) => p.trim() === c.trim();
		case "indentation_flexible":
			// The classic small-model error: dropped/shifted indentation.
			return (p, c) => p.replace(/^\s+/, "") === c.replace(/^\s+/, "");
		case "trimmed_boundary":
			// Decorative whitespace on the anchor lines only; interior lines exact.
			return (p, c, k, n) => (k === 0 || k === n - 1 ? p.trim() === c.trim() : p === c);
		case "exact":
			return (p, c) => p === c;
	}
}

function findLineMatches(
	index: LineIndex,
	pattern: PatternLines,
	compare: LineComparator,
): { start: number; end: number }[] {
	const n = pattern.lines.length;
	const coreCount = index.endsWithNewline ? index.lines.length - 1 : index.lines.length;
	const matches: { start: number; end: number }[] = [];
	if (n === 0) return matches;
	for (let i = 0; i + n <= coreCount; i++) {
		let ok = true;
		for (let k = 0; k < n; k++) {
			if (!compare(pattern.lines[k], index.lines[i + k], k, n)) {
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		if (pattern.requiresTrailingNewline) {
			const last = i + n - 1;
			// Pattern demands a newline after the last line; a window that ends at
			// a final line without trailing newline cannot satisfy it.
			if (last === coreCount - 1 && !index.endsWithNewline) continue;
			matches.push({ start: index.starts[i], end: index.starts[last + 1] });
		} else {
			matches.push({ start: index.starts[i], end: index.lineEnd(i + n - 1) });
		}
	}
	return matches;
}

function locationAt(index: LineIndex, content: string, offset: number): MatchLocation {
	const line = lineAt(index, offset);
	const text = index.lines[line - 1] ?? "";
	const snippet = text.trim().length > 80 ? `${text.trim().slice(0, 79)}…` : text.trim();
	return { line, snippet };
}

function exactLocations(index: LineIndex, content: string, needle: string, max: number): MatchLocation[] {
	const locations: MatchLocation[] = [];
	let idx = content.indexOf(needle);
	while (idx !== -1 && locations.length < max) {
		locations.push(locationAt(index, content, idx));
		idx = content.indexOf(needle, idx + 1);
	}
	return locations;
}

/**
 * Run the ordered strategy chain for one edit against LF-normalized content.
 * Returns the first winning strategy's span, or the terminal failure:
 * ambiguity in the strategy that found candidates, or no match at all.
 */
export function runChain(content: string, oldText: string): ChainResult {
	const index = buildLineIndex(content);
	const pattern = parsePattern(oldText);

	for (const strategy of STRATEGY_CHAIN) {
		if (strategy === "exact") {
			const count = countOccurrences(content, oldText);
			if (count === 1) {
				const start = content.indexOf(oldText);
				return { ok: true, match: { strategy, start, end: start + oldText.length, exact: true } };
			}
			if (count > 1) {
				return {
					ok: false,
					failure: {
						kind: "ambiguous",
						strategy,
						count,
						locations: exactLocations(index, content, oldText, 5),
					},
				};
			}
			continue;
		}
		// trimmed_boundary needs distinct anchor lines to be meaningful; smaller
		// patterns are already covered by line_trimmed.
		if (strategy === "trimmed_boundary" && pattern.lines.length < 3) continue;
		const matches = findLineMatches(index, pattern, comparatorFor(strategy));
		if (matches.length === 1) {
			return { ok: true, match: { strategy, start: matches[0].start, end: matches[0].end, exact: false } };
		}
		if (matches.length > 1) {
			return {
				ok: false,
				failure: {
					kind: "ambiguous",
					strategy,
					count: matches.length,
					locations: matches.slice(0, 5).map((m) => locationAt(index, content, m.start)),
				},
			};
		}
	}
	return { ok: false, failure: { kind: "no_match" } };
}
