/**
 * Span-mapping algebra for the tolerant match strategies — a verbatim port of
 * the position helpers in hermes' `fuzzy_match.py` (docs/EDIT-TOOL-ANALYSIS.md
 * §3.2, Tier 1 task 1 in docs/PLAN.md). These helpers let a strategy match in
 * a *normalized* space (whitespace-collapsed, Unicode-mapped) while returning
 * spans into the content the splice will run on, so the matched file bytes —
 * not the pattern's — drive the replacement.
 *
 * Ported functions (hermes name → this file):
 * - `_calculate_line_positions` → `calculateLinePositions`
 * - `_window_spans`             → `windowSpans`
 * - `_match_transformed_lines`  → `matchTransformedLines`
 * - `_strip_boundary`           → `stripBoundary`
 * - `_unicode_normalize`        → `unicodeNormalize` (+ `UNICODE_MAP`)
 * - `_build_orig_to_norm_map`   → `buildOrigToNormMap`
 * - `_invert_norm_map`          → `invertNormMap`
 * - `_norm_end_to_orig`         → `normEndToOrig`
 * - `_map_positions_norm_to_orig` → `mapPositionsNormToOrig`
 * - `_map_normalized_positions` → `mapNormalizedPositions`
 *
 * Two deliberate platform adaptations, both no-ops for the data these
 * functions see:
 * - Python iterates code points; we iterate UTF-16 code units. Equivalent
 *   because every `UNICODE_MAP` key is a single BMP unit mapping to ASCII, so
 *   astral characters pass through with their 2 units intact on both sides.
 * - Python's `str.replace` replaces all occurrences; JS needs `replaceAll`.
 */

/** A half-open `[start, end)` span into the content being spliced. */
export interface Span {
	start: number;
	end: number;
}

/**
 * Exact, non-overlapping occurrences (hermes `_strategy_exact`: `re.finditer`
 * semantics — overlapping spans would corrupt the file under `replace_all`).
 * Unlike Python's `finditer`, an empty pattern returns no spans rather than a
 * match at every position; every caller validates non-empty input upstream.
 */
export function exactSpans(content: string, pattern: string): Span[] {
	if (pattern.length === 0) return [];
	const spans: Span[] = [];
	let idx = content.indexOf(pattern);
	while (idx !== -1) {
		spans.push({ start: idx, end: idx + pattern.length });
		idx = content.indexOf(pattern, idx + pattern.length);
	}
	return spans;
}

/** Collapse runs of spaces/tabs to a single space (hermes: `re.sub(r'[ \t]+', ' ', s)`). */
export function collapseWhitespace(s: string): string {
	return s.replace(/[ \t]+/g, " ");
}

function isSpaceOrTab(c: string): boolean {
	return c === " " || c === "\t";
}

// ── Line windowing ───────────────────────────────────────────────────────

/**
 * Character span covering `contentLines[startLine:endLine]` (end exclusive).
 * The span ends at the last character of the final line — the newline after
 * it is only included via `min(contentLength, ...)` when a trailing newline
 * exists in the content.
 */
export function calculateLinePositions(
	contentLines: string[],
	startLine: number,
	endLine: number,
	contentLength: number,
): Span {
	let startPos = 0;
	for (let i = 0; i < startLine; i++) startPos += contentLines[i].length + 1;
	let endPos = -1;
	for (let i = 0; i < endLine; i++) endPos += contentLines[i].length + 1;
	return { start: startPos, end: Math.min(contentLength, endPos) };
}

/** Spans of every `n`-line window starting at `i` for which `accept(i)`. */
export function windowSpans(
	content: string,
	contentLines: string[],
	n: number,
	accept: (i: number) => boolean,
): Span[] {
	const spans: Span[] = [];
	for (let i = 0; i + n <= contentLines.length; i++) {
		if (accept(i)) spans.push(calculateLinePositions(contentLines, i, i + n, content.length));
	}
	return spans;
}

/**
 * Match `pattern` against `content` after applying `transform` to each line
 * block. `transform` sees the full line list (it may be boundary-aware, as
 * `stripBoundary` is), so per window it is applied to the window's slice and
 * compared element-wise against the transformed pattern lines.
 */
export function matchTransformedLines(
	content: string,
	pattern: string,
	transform: (lines: string[]) => string[],
): Span[] {
	const contentLines = content.split("\n");
	const patternNorm = transform(pattern.split("\n"));
	const n = patternNorm.length;
	return windowSpans(content, contentLines, n, (i) => {
		const transformed = transform(contentLines.slice(i, i + n));
		if (transformed.length !== patternNorm.length) return false;
		for (let k = 0; k < n; k++) {
			if (transformed[k] !== patternNorm[k]) return false;
		}
		return true;
	});
}

/** Strip whitespace on the first and last lines only (middle lines untouched). */
export function stripBoundary(lines: string[]): string[] {
	const out = lines.slice();
	out[0] = out[0].trim();
	if (out.length > 1) out[out.length - 1] = out[out.length - 1].trim();
	return out;
}

// ── Unicode normalization ────────────────────────────────────────────────

/** Typographic Unicode variants → ASCII equivalents (hermes `UNICODE_MAP`, same order). */
export const UNICODE_MAP: ReadonlyMap<string, string> = new Map([
	["\u201c", '"'], ["\u201d", '"'], // smart double quotes
	["\u2018", "'"], ["\u2019", "'"], // smart single quotes
	["\u2014", "--"], ["\u2013", "-"], // em/en dashes
	["\u2026", "..."], ["\u00a0", " "], // ellipsis and non-breaking space
	["\u2212", "-"], // typographic minus (math/scientific docs)
	// Space-separator family (Zs): otherwise such files fall to the similarity fallback.
	["\u2000", " "], ["\u2001", " "], ["\u2002", " "], ["\u2003", " "],
	["\u2004", " "], ["\u2005", " "], ["\u2006", " "], ["\u2007", " "],
	["\u2008", " "], ["\u2009", " "], ["\u200a", " "], ["\u202f", " "],
	["\u205f", " "], ["\u3000", " "],
]);

/** Map typographic Unicode variants to ASCII equivalents. */
export function unicodeNormalize(text: string): string {
	for (const [char, repl] of UNICODE_MAP) text = text.replaceAll(char, repl);
	return text;
}

/**
 * Map each original UTF-16 unit index to its index in `unicodeNormalize(original)`
 * (replacements can expand one char into several). Length `original.length + 1`;
 * the last entry is a sentinel one past the final character.
 */
export function buildOrigToNormMap(original: string): number[] {
	const result: number[] = [];
	let normPos = 0;
	for (let i = 0; i < original.length; i++) {
		result.push(normPos);
		const repl = UNICODE_MAP.get(original[i]);
		normPos += repl !== undefined ? repl.length : 1;
	}
	result.push(normPos);
	return result;
}

/** normPos → first original position mapping to it. */
export function invertNormMap(origToNorm: number[]): Map<number, number> {
	const inverted = new Map<number, number>();
	for (let origPos = 0; origPos < origToNorm.length - 1; origPos++) {
		const normPos = origToNorm[origPos];
		if (!inverted.has(normPos)) inverted.set(normPos, origPos);
	}
	return inverted;
}

/** Walk from `origStart` until the mapped position reaches `normEnd`. */
export function normEndToOrig(origToNorm: number[], origStart: number, normEnd: number): number {
	const origLen = origToNorm.length - 1;
	let origEnd = origStart;
	while (origEnd < origLen && origToNorm[origEnd] < normEnd) origEnd++;
	return origEnd;
}

/**
 * Convert spans in the normalized string to original-string spans.
 * Best-effort: a normalized span whose start falls inside a multi-char
 * expansion (no direct original position) is dropped.
 */
export function mapPositionsNormToOrig(origToNorm: number[], normMatches: Span[]): Span[] {
	const normToOrigStart = invertNormMap(origToNorm);
	const results: Span[] = [];
	for (const { start: normStart, end: normEnd } of normMatches) {
		const origStart = normToOrigStart.get(normStart);
		if (origStart !== undefined) {
			results.push({ start: origStart, end: normEndToOrig(origToNorm, origStart, normEnd) });
		}
	}
	return results;
}

/**
 * Best-effort span mapping for `[ \t]+` → `' '` whitespace collapsing.
 * Runs over the original and its collapsed form in lockstep, then maps each
 * normalized match back. Two subtleties ported verbatim:
 * - a collapsed run advances `normIdx` only once the run is consumed;
 * - trailing collapsed whitespace is absorbed into the match ONLY when the
 *   normalized match itself ended in a space — otherwise the first space
 *   after the match is a word boundary that must survive the splice.
 */
export function mapNormalizedPositions(original: string, normalized: string, normalizedMatches: Span[]): Span[] {
	const origToNorm: number[] = [];
	let origIdx = 0;
	let normIdx = 0;
	while (origIdx < original.length && normIdx < normalized.length) {
		if (original[origIdx] === normalized[normIdx]) {
			origToNorm.push(normIdx);
			origIdx++;
			normIdx++;
		} else if (isSpaceOrTab(original[origIdx]) && normalized[normIdx] === " ") {
			// Collapsed run: advance norm_idx only once the run is consumed.
			origToNorm.push(normIdx);
			origIdx++;
			if (origIdx < original.length && !isSpaceOrTab(original[origIdx])) normIdx++;
		} else {
			// Extra whitespace in original, or a mismatch normalization should
			// never produce — either way, pin to the current norm_idx.
			origToNorm.push(normIdx);
			origIdx++;
		}
	}
	while (origIdx < original.length) origToNorm.push(normalized.length);

	const normToOrigStart = new Map<number, number>();
	const normToOrigEnd = new Map<number, number>();
	for (let origPos = 0; origPos < origToNorm.length; origPos++) {
		const normPos = origToNorm[origPos];
		if (!normToOrigStart.has(normPos)) normToOrigStart.set(normPos, origPos);
		normToOrigEnd.set(normPos, origPos);
	}

	const originalMatches: Span[] = [];
	for (const { start: normStart, end: normEnd } of normalizedMatches) {
		let origStart = normToOrigStart.get(normStart);
		if (origStart === undefined) {
			// First original position whose mapping reaches normStart.
			origStart = -1;
			for (let i = 0; i < origToNorm.length; i++) {
				if (origToNorm[i] >= normStart) {
					origStart = i;
					break;
				}
			}
			if (origStart === -1) throw new Error("mapNormalizedPositions: no original position maps to the match start");
		}
		const normEndPrev = normToOrigEnd.get(normEnd - 1);
		let origEnd = normEndPrev !== undefined ? normEndPrev + 1 : origStart + (normEnd - normStart);
		// Absorb trailing collapsed whitespace only when the normalized match
		// itself ended in a space; otherwise the first whitespace after the
		// match is a word boundary that must survive.
		if (normEnd < normalized.length && normalized[normEnd - 1] === " ") {
			while (origEnd < original.length && isSpaceOrTab(original[origEnd])) origEnd++;
		}
		originalMatches.push({ start: origStart, end: Math.min(origEnd, original.length) });
	}
	return originalMatches;
}
