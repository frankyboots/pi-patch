/**
 * Ordered match-strategy chain for `patch` — a verbatim port of hermes'
 * fuzzy_match.py STRATEGIES (docs/EDIT-TOOL-ANALYSIS.md Appendix A):
 *
 *   exact → line_trimmed → whitespace_normalized → indentation_flexible
 *         → escape_normalized → trimmed_boundary → unicode_normalized
 *         → block_anchor → context_aware
 *
 * Each strategy is a standalone `(content, pattern) => Span[]` function, as in
 * hermes. Spans are returned into the content the splice runs on (here the
 * LF-normalized file text — deviations ledger #2; hermes matches raw bytes).
 * Key properties copied verbatim:
 *
 * - First strategy with ≥1 match wins; >1 match → ambiguous error with the
 *   match locations. No fall-through past an ambiguous result.
 * - Uniqueness is counted **per strategy, in that strategy's space**. This
 *   avoids pi's normalize-then-count false-ambiguity bug (§3.1 of the
 *   analysis): two regions differing only by smart quotes cannot make a
 *   byte-unique oldText report "Found 2 occurrences".
 * - Line-window strategies go through `matchTransformedLines`; character-level
 *   strategies (whitespace/unicode normalized) match in normalized space and
 *   map spans back with the span-map algebra, so the matched file bytes — not
 *   the pattern's — drive the replacement.
 *
 * `runChain` is the strategy sweep: single-replacement semantics by default,
 * `replaceAll` over every match of the winning strategy (Tier 1 #2), and the
 * escape-drift guards on every non-exact match (Tier 1 #3) — hermes runs
 * them inside the orchestrator, before anything is written. `fuzzyFindAndReplace`
 * is hermes' full `fuzzy_find_and_replace` on top of it — argument gates,
 * chain, then the orchestrator tail (conditional \t/\r unescape,
 * unicode-preserving opcodes, reindent, splice from `shaping.ts`) — shared by
 * BOTH surfaces: replace mode (`tool.ts`) and the V4A patch mode's Update
 * hunks (`v4a.ts`, Tier 3 #8). Its error strings are hermes' Appendix B texts
 * verbatim, WITHOUT the "did you mean" hint — that layer belongs to the
 * callers (`formatNoMatchHint`), exactly as in hermes.
 */
import { buildLineIndex, lineAt, similarity, type LineIndex } from "./text.js";
import { detectEscapeDrift, type EscapeDrift } from "./escape-drift.js";
import { ambiguityErrorMessage, emptyOldStringError, escapeDriftErrorMessage, identicalStringsError, replaceAllRefusalMessage, whitespaceOnlyOldStringError } from "./errors.js";
import { applyReplacements, maybeUnescapeNewString, unicodeEditPlan } from "./shaping.js";
import {
	buildOrigToNormMap,
	collapseWhitespace,
	exactSpans,
	mapNormalizedPositions,
	mapPositionsNormToOrig,
	matchTransformedLines,
	stripBoundary,
	unicodeNormalize,
	windowSpans,
	type Span,
} from "./span-map.js";

export type StrategyName =
	| "exact"
	| "line_trimmed"
	| "whitespace_normalized"
	| "indentation_flexible"
	| "escape_normalized"
	| "trimmed_boundary"
	| "unicode_normalized"
	| "block_anchor"
	| "context_aware";

export interface ChainMatch {
	strategy: StrategyName;
	/** Matched spans in the LF-normalized content, ascending and
	 * non-overlapping. Exactly one span unless `replaceAll` was requested and
	 * the winning strategy found several occurrences. */
	spans: Span[];
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
	/** replace_all requested but the winning strategy only approximates oldText */
	| { kind: "replace_all_similarity"; strategy: StrategyName; count: number }
	/** Non-exact match succeeded but newText carries tool-call escape
	 * artifacts the file does not have — writing it verbatim would corrupt
	 * the file (Tier 1 #3, hermes `_detect_escape_drift`). */
	| { kind: "escape_drift"; drift: EscapeDrift }
	| { kind: "no_match" };

export type ChainResult = { ok: true; match: ChainMatch } | { ok: false; failure: ChainFailure };

export interface RunChainOptions {
	/** hermes `replace_all`: apply over EVERY match of the winning strategy
	 * instead of requiring a unique one. Similarity strategies refuse it
	 * (approximate matches must never be mass-overwritten — Tier 1 #2). */
	replaceAll?: boolean;
	/** Replacement text. Arms the escape-drift guards on non-exact matches
	 * (Tier 1 #3) — hermes' orchestrator always has new_string available;
	 * match-only probing without a replacement leaves the guards inert. */
	newText?: string;
}

// ── Strategies ───────────────────────────────────────────────────────────
// Each takes (content, pattern) and returns spans in the ORIGINAL
// (LF-normalized) content.

/** Strategy 1: exact, non-overlapping occurrences (str.replace semantics —
 * overlapping spans would corrupt the file under replace_all). */
export function strategyExact(content: string, pattern: string): Span[] {
	return exactSpans(content, pattern);
}

/** Strategy 2: strip each line before comparing. */
export function strategyLineTrimmed(content: string, pattern: string): Span[] {
	return matchTransformedLines(content, pattern, (ls) => ls.map((l) => l.trim()));
}

/** Strategy 3: collapse runs of spaces/tabs to a single space. */
export function strategyWhitespaceNormalized(content: string, pattern: string): Span[] {
	const contentNormalized = collapseWhitespace(content);
	const matchesInNormalized = exactSpans(contentNormalized, collapseWhitespace(pattern));
	if (matchesInNormalized.length === 0) return [];
	return mapNormalizedPositions(content, contentNormalized, matchesInNormalized);
}

/** Strategy 4: ignore leading indentation entirely. */
export function strategyIndentationFlexible(content: string, pattern: string): Span[] {
	return matchTransformedLines(content, pattern, (ls) => ls.map((l) => l.replace(/^\s+/, "")));
}

/** Strategy 5: treat literal `\n`/`\t`/`\r` in the pattern as control chars. */
export function strategyEscapeNormalized(content: string, pattern: string): Span[] {
	const patternUnescaped = pattern
		.replaceAll("\\n", "\n")
		.replaceAll("\\t", "\t")
		.replaceAll("\\r", "\r");
	if (patternUnescaped === pattern) return [];
	return exactSpans(content, patternUnescaped);
}

/** Strategy 6: strip whitespace on the first and last lines only. */
export function strategyTrimmedBoundary(content: string, pattern: string): Span[] {
	return matchTransformedLines(content, pattern, stripBoundary);
}

/** Strategy 7: exact/line-trimmed match after Unicode->ASCII normalisation of both sides. */
export function strategyUnicodeNormalized(content: string, pattern: string): Span[] {
	const normPattern = unicodeNormalize(pattern);
	const normContent = unicodeNormalize(content);
	if (normContent === content && normPattern === pattern) return [];
	let normMatches = exactSpans(normContent, normPattern);
	if (normMatches.length === 0) {
		normMatches = matchTransformedLines(normContent, normPattern, (ls) => ls.map((l) => l.trim()));
	}
	if (normMatches.length === 0) return [];
	return mapPositionsNormToOrig(buildOrigToNormMap(content), normMatches);
}

/** Strategy 8: anchor on first+last lines, similarity-score the middle. */
export function strategyBlockAnchor(content: string, pattern: string): Span[] {
	const patternLines = unicodeNormalize(pattern).split("\n");
	if (patternLines.length < 2) return [];
	const firstLine = patternLines[0].trim();
	const lastLine = patternLines[patternLines.length - 1].trim();
	const n = patternLines.length;

	// Match on normalized lines; compute offsets from the ORIGINAL lines so
	// multi-char expansions (em-dash -> '--') don't shift positions.
	const normContentLines = unicodeNormalize(content).split("\n");
	const potentialMatches = new Set<number>();
	for (let i = 0; i + n <= normContentLines.length; i++) {
		if (normContentLines[i].trim() === firstLine && normContentLines[i + n - 1].trim() === lastLine) {
			potentialMatches.add(i);
		}
	}
	// Looser thresholds (0.10/0.30) matched unrelated blocks; these are the safe floor.
	const threshold = potentialMatches.size === 1 ? 0.5 : 0.7;
	const patternMiddle = patternLines.slice(1, -1).join("\n");

	const similar = (i: number): boolean => {
		if (!potentialMatches.has(i)) return false;
		if (n <= 2) return true;
		const contentMiddle = normContentLines.slice(i + 1, i + n - 1).join("\n");
		return similarity(contentMiddle, patternMiddle) >= threshold;
	};

	return windowSpans(content, content.split("\n"), n, similar);
}

/** Strategy 9 (last resort): anchored per-line similarity, every non-blank line >= 0.80.
 * The anchor pre-filter bounds the scan; the all-lines rule stops coincidental matches. */
export function strategyContextAware(content: string, pattern: string): Span[] {
	const patternLines = pattern.split("\n");
	const contentLines = content.split("\n");
	const n = patternLines.length;
	if (n > contentLines.length) return [];
	const firstPat = patternLines[0].trim();
	const lastPat = patternLines[n - 1].trim();

	const sim = (a: string, b: string): number => (a === b ? 1 : similarity(a, b));

	const accept = (i: number): boolean => {
		const blockLines = contentLines.slice(i, i + n);
		if (sim(firstPat, blockLines[0].trim()) < 0.8) return false;
		if (sim(lastPat, blockLines[blockLines.length - 1].trim()) < 0.8) return false;
		for (let k = 0; k < n; k++) {
			const pLine = patternLines[k].trim();
			if (pLine.length === 0) continue;
			if (sim(pLine, blockLines[k].trim()) < 0.8) return false;
		}
		return true;
	};

	return windowSpans(content, contentLines, n, accept);
}

/** Matches from these only *approximately* resemble oldText — fine for one
 * unique replacement, never safe under replace_all (Tier 1 #2). */
export const SIMILARITY_STRATEGIES: ReadonlySet<StrategyName> = new Set([
	"block_anchor",
	"context_aware",
]);

/** Ordered chain: precise strategies first, similarity-based last. */
export const STRATEGIES: readonly {
	name: StrategyName;
	fn: (content: string, pattern: string) => Span[];
}[] = [
	{ name: "exact", fn: strategyExact },
	{ name: "line_trimmed", fn: strategyLineTrimmed },
	{ name: "whitespace_normalized", fn: strategyWhitespaceNormalized },
	{ name: "indentation_flexible", fn: strategyIndentationFlexible },
	{ name: "escape_normalized", fn: strategyEscapeNormalized },
	{ name: "trimmed_boundary", fn: strategyTrimmedBoundary },
	{ name: "unicode_normalized", fn: strategyUnicodeNormalized },
	{ name: "block_anchor", fn: strategyBlockAnchor },
	{ name: "context_aware", fn: strategyContextAware },
];

// ── Orchestrator (single-replacement path) ───────────────────────────────

const MAX_LOCATIONS = 5;

function locationAt(index: LineIndex, content: string, offset: number): MatchLocation {
	const line = lineAt(index, offset);
	const text = index.lines[line - 1] ?? "";
	let snippet = text.trim();
	if (snippet.length > 80) snippet = `${snippet.slice(0, 77)}...`;
	return { line, snippet };
}

/** Leftmost-greedy non-overlap filter — str.replace/re.finditer semantics.
 * Exact spans are non-overlapping by construction (golden-tested); line-window
 * strategies can emit self-overlapping adjacent windows (e.g. pattern " a\na"
 * over "a\na\na" matches at lines 0 and 1). Splicing overlapping spans
 * corrupts the file — the exact failure hermes fixed for `_strategy_exact`
 * ("aligns with str.replace") but left open for the window rungs; we enforce
 * the invariant for every strategy (deviations ledger #12). */
function nonOverlappingSpans(matches: Span[]): Span[] {
	const ordered = [...matches].sort((a, b) => a.start - b.start);
	const kept: Span[] = [];
	let lastEnd = -1;
	for (const span of ordered) {
		if (span.start < lastEnd) continue;
		kept.push(span);
		lastEnd = span.end;
	}
	return kept;
}

/**
 * Run the ordered strategy chain for one edit against LF-normalized content.
 * Returns the first winning strategy's spans (all of them under `replaceAll`),
 * or the terminal failure: ambiguity in the strategy that found candidates, a
 * replace_all refusal from a similarity strategy, or no match at all.
 */
export function runChain(content: string, oldText: string, options: RunChainOptions = {}): ChainResult {
	const replaceAll = options.replaceAll === true;
	const index = buildLineIndex(content);
	for (const { name, fn } of STRATEGIES) {
		const matches = fn(content, oldText);
		if (matches.length === 0) continue;
		if (matches.length > 1 && !replaceAll) {
			return {
				ok: false,
				failure: {
					kind: "ambiguous",
					strategy: name,
					count: matches.length,
					locations: matches.slice(0, MAX_LOCATIONS).map((m) => locationAt(index, content, m.start)),
				},
			};
		}
		if (replaceAll && matches.length > 1 && SIMILARITY_STRATEGIES.has(name)) {
			// Matches only *approximately* resemble oldText — mass-overwriting
			// every loose block would be corruption by design (hermes refusal).
			return {
				ok: false,
				failure: { kind: "replace_all_similarity", strategy: name, count: matches.length },
			};
		}
		const spans = replaceAll ? nonOverlappingSpans(matches) : matches;
		// Non-exact matches came through some normalization, so newText may
		// carry serialization drift the file doesn't have — refuse before
		// anything is written (hermes runs this between the strategy match and
		// _apply_replacements). The spans voted on are exactly the ones that
		// will be spliced (post non-overlap filter, ledger #12).
		if (name !== "exact" && options.newText !== undefined) {
			const drift = detectEscapeDrift(content, spans, oldText, options.newText);
			if (drift) return { ok: false, failure: { kind: "escape_drift", drift } };
		}
		return { ok: true, match: { strategy: name, spans, exact: name === "exact" } };
	}
	return { ok: false, failure: { kind: "no_match" } };
}

// ── Orchestrator (hermes fuzzy_find_and_replace) ─────────────────────────

/** Conservative already-applied bar (hermes): new_string must be non-trivial
 * (≥ 8 non-blank chars) and present EXACTLY, old_string gone. It gates EVERY
 * orchestrator failure in the replace surface (hermes `_no_match_result`
 * checks it before formatting any error) and every failed Update hunk in V4A
 * validation/apply — it must never mask a real partial application. */
const ALREADY_APPLIED_MIN_CHARS = 8;

/** hermes `is_already_applied` (fuzzy_match.py:307). */
export function isAlreadyApplied(content: string, oldString: string, newString: string): boolean {
	if (!newString || newString.trim().length < ALREADY_APPLIED_MIN_CHARS) return false;
	if (!content.includes(newString)) return false;
	return oldString === newString || !content.includes(oldString);
}

/** Chain failure → hermes' orchestrator error text, WITHOUT the "did you
 * mean" hint (hermes' fuzzy_find_and_replace returns the bare texts; callers
 * attach the hint — see `formatNoMatchHint`). */
function chainFailureMessage(failure: ChainFailure): string {
	switch (failure.kind) {
		case "ambiguous":
			return ambiguityErrorMessage(failure.count, failure.locations);
		case "escape_drift":
			return escapeDriftErrorMessage(failure.drift);
		case "replace_all_similarity":
			return replaceAllRefusalMessage(failure.count, failure.strategy);
		case "no_match":
			return "Could not find a match for old_string in the file";
	}
}

export interface FuzzyReplaceResult {
	/** Content after the replacement — identical to the input on failure. */
	newContent: string;
	/** Number of regions spliced (0 on failure). */
	count: number;
	/** Winning strategy (null on failure). */
	strategy: StrategyName | null;
	/** hermes' orchestrator error text (null on success). */
	error: string | null;
}

/**
 * hermes `fuzzy_find_and_replace` (fuzzy_match.py:338) — the shared matching
 * entry for both surfaces. Returns `(new_content, count, strategy, error)`:
 * hermes' argument gates (empty / whitespace-only / identical old_string),
 * then the chain, then the shaping tail. On failure the input content comes
 * back unchanged with `count === 0`; the already-applied check is the
 * CALLER's (hermes' replace surface does it in `_no_match_result`, V4A in its
 * validate/apply hunk loops).
 */
export function fuzzyFindAndReplace(
	content: string,
	oldString: string,
	newString: string,
	replaceAll = false,
): FuzzyReplaceResult {
	// hermes' argument validation inside the orchestrator, before the chain.
	if (!oldString) {
		return { newContent: content, count: 0, strategy: null, error: emptyOldStringError() };
	}
	if (!oldString.trim()) {
		return { newContent: content, count: 0, strategy: null, error: whitespaceOnlyOldStringError() };
	}
	if (oldString === newString) {
		return { newContent: content, count: 0, strategy: null, error: identicalStringsError() };
	}
	const result = runChain(content, oldString, { replaceAll, newText: newString });
	if (!result.ok) {
		return { newContent: content, count: 0, strategy: null, error: chainFailureMessage(result.failure) };
	}
	// Orchestrator tail: effective_new = conditional \t/\r unescape over the
	// matched regions (ALL strategies including exact — issue #33733), then
	// _apply_replacements: unicode opcodes (unicode_normalized match) + reindent
	// onto EACH region's depth, spliced end-to-start.
	const { spans, strategy, exact } = result.match;
	const effectiveNew = maybeUnescapeNewString(newString, content, spans);
	const newContent = applyReplacements(content, spans, effectiveNew, {
		oldText: exact ? undefined : oldString,
		unicodePlan: strategy === "unicode_normalized" ? unicodeEditPlan(oldString, effectiveNew) : undefined,
	});
	return { newContent, count: spans.length, strategy, error: null };
}
