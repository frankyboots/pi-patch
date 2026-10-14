/**
 * Replacement shaping (hermes fuzzy_match.py, Tier 1 #4) — everything that
 * happens to `new_string` between a strategy win and the splice:
 *
 * - `maybeUnescapeNewString` (hermes `_maybe_unescape_new_string`): convert
 *   literal `\t`/`\r` in newText to control chars, once per edit, only when
 *   the matched regions already contain the real control char — so a
 *   `sep = "\t"` file is left alone. Runs for ALL strategies including
 *   exact (issue #33733's headline repro). `\n` is deliberately excluded:
 *   rewriting it would mangle source escape literals.
 * - `unicodeEditPlan` + `preserveUnicodeInReplacement` (hermes
 *   `_unicode_edit_plan` + `_preserve_unicode_in_replacement`): for a
 *   unicode_normalized match, apply only the old->new edits onto each
 *   region's ORIGINAL (Unicode) text via the old->new opcode plan, so the
 *   file's em-dashes/smart quotes are not flattened to the model's ASCII.
 * - `reindentReplacement` (hermes `_reindent_replacement`): re-anchor
 *   newText's indentation onto the file's actual base indent after a
 *   non-exact match, preserving relative nesting; shallower lines anchor to
 *   the file base.
 * - `applyReplacements` (hermes `_apply_replacements`): splice over every
 *   span end-to-start, shaping each region — `shapeReplacement` is the
 *   per-region body (used by the transitional multi-edit surface, which
 *   must splice several edits' spans against one snapshot).
 *
 * Opcodes come from a verbatim port of `difflib.SequenceMatcher` (see
 * `SequenceMatcher` below): the diff-package stand-in is only sound for
 * RATIOS — for opcode application the edit script itself drives which region
 * chars are kept, and a differential fuzz showed jsdiff's greedy script
 * diverges from SequenceMatcher's longest-block search in ways that change
 * the written text.
 *
 * Matching runs on LF-normalized content (deviations ledger #2), so regions
 * there can lack the real CRs a raw-byte hermes match would see — the
 * unescape condition follows the regions that will actually be written.
 */
import { buildOrigToNormMap, normEndToOrig, unicodeNormalize, type Span } from "./span-map.js";
import { matchedRegions } from "./escape-drift.js";

// ── Conditional \t/\r unescape (hermes `_maybe_unescape_new_string`) ──────

/**
 * Convert literal `\\t`/`\\r` in newText to control chars, per edit, only
 * when the matched regions already contain the real control char (so
 * `sep = "\\t"` files are left alone). `\\n` is excluded: rewriting it would
 * mangle source escape literals.
 */
export function maybeUnescapeNewString(newText: string, content: string, spans: Span[]): string {
	if (!newText.includes("\\t") && !newText.includes("\\r")) return newText;
	const regions = matchedRegions(content, spans);
	let result = newText;
	for (const [literal, control] of [["\\t", "\t"], ["\\r", "\r"]] as const) {
		if (result.includes(literal) && regions.includes(control)) {
			result = result.replaceAll(literal, control);
		}
	}
	return result;
}

// ── Reindent (hermes `_reindent_replacement`) ────────────────────────────

function leadingWhitespace(line: string): string {
	return line.match(/^[ \t]*/)?.[0] ?? "";
}

function firstMeaningfulLine(text: string): string | undefined {
	return text.split("\n").find((line) => line.trim() !== "");
}

/**
 * Re-anchor newText's indentation onto the file's actual base indent after a
 * non-exact match: swap the model's base prefix (first non-blank oldText
 * line) for the file's, preserving relative nesting; shallower lines anchor
 * to the file base.
 */
export function reindentReplacement(oldText: string, newText: string, fileRegion: string): string {
	if (newText === "") return newText;
	const oldFirst = firstMeaningfulLine(oldText);
	const fileFirst = firstMeaningfulLine(fileRegion);
	if (oldFirst === undefined || fileFirst === undefined) return newText;
	const oldIndent = leadingWhitespace(oldFirst);
	const fileIndent = leadingWhitespace(fileFirst);
	if (oldIndent === fileIndent) return newText;

	return newText
		.split("\n")
		.map((line) => {
			if (line.trim() === "") return line;
			if (leadingWhitespace(line).startsWith(oldIndent)) return fileIndent + line.slice(oldIndent.length);
			return fileIndent + line.replace(/^[ \t]+/, "");
		})
		.join("\n");
}

// ── Unicode-preserving opcodes (hermes `_unicode_edit_plan` +
//    `_preserve_unicode_in_replacement`) ──────────────────────────────────

/** `(normalized old, old->new opcodes)` — independent of the file region, so
 * a replace_all computes it once for every match. */
export interface UnicodePlan {
	normOld: string;
	opcodes: Opcode[];
}

/** rightmost insertion point — Python `bisect.bisect_right` on a
 * nondecreasing array. */
function bisectRight(arr: number[], x: number): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid] <= x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export function unicodeEditPlan(oldText: string, newText: string): UnicodePlan {
	const normOld = unicodeNormalize(oldText);
	return { normOld, opcodes: new SequenceMatcher(normOld, newText).getOpcodes() };
}

/**
 * Apply only the old->new edits onto fileRegion's original (Unicode) text,
 * so a unicode_normalized match doesn't flatten the file's em-dashes/smart
 * quotes. `plan` is `unicodeEditPlan(oldText, newText)`.
 */
export function preserveUnicodeInReplacement(
	fileRegion: string,
	newText: string,
	plan: UnicodePlan,
): string {
	const { normOld, opcodes } = plan;
	if (normOld !== unicodeNormalize(fileRegion)) return newText; // strategy shouldn't have fired; fall back

	const fileOrigToNorm = buildOrigToNormMap(fileRegion);

	const parts: string[] = [];
	for (const [tag, i1, i2, j1, j2] of opcodes) {
		if (tag === "equal") {
			// The original char owning norm index i1, even one inside a
			// multi-char expansion (em-dash -> '--').
			const origStart = bisectRight(fileOrigToNorm, i1) - 1;
			const origEnd = normEndToOrig(fileOrigToNorm, origStart, i2);
			parts.push(fileRegion.slice(origStart, origEnd));
		} else if (tag !== "delete") {
			parts.push(newText.slice(j1, j2));
		}
	}
	return parts.join("");
}

// ── Splice (hermes `_apply_replacements`) ────────────────────────────────

/**
 * Shape ONE region's replacement — the per-region body of hermes'
 * `_apply_replacements`: unicode-preserving opcodes first (unicode_normalized
 * match), then reindent. `oldText` undefined (exact match) keeps the bytes.
 */
export function shapeReplacement(
	region: string,
	newText: string,
	opts: { oldText?: string; unicodePlan?: UnicodePlan } = {},
): string {
	let adjusted = newText;
	if (opts.oldText !== undefined) {
		if (opts.unicodePlan !== undefined) {
			// Each occurrence may use different typographic characters even
			// though all normalize to the same oldText.
			adjusted = preserveUnicodeInReplacement(region, adjusted, opts.unicodePlan);
		}
		adjusted = reindentReplacement(opts.oldText, adjusted, region);
	}
	return adjusted;
}

/**
 * Splice newText over each span (end-to-start so offsets stay valid);
 * `oldText` non-undefined (non-exact match) re-indents it per region, and
 * `unicodePlan` (unicode_normalized match) keeps each region's typography.
 */
export function applyReplacements(
	content: string,
	spans: Span[],
	newText: string,
	opts: { oldText?: string; unicodePlan?: UnicodePlan } = {},
): string {
	let result = content;
	for (const { start, end } of [...spans].sort((a, b) => a.start - b.start).reverse()) {
		const region = content.slice(start, end);
		const adjusted = shapeReplacement(region, newText, opts);
		result = result.slice(0, start) + adjusted + result.slice(end);
	}
	return result;
}

// ── Opcode source: verbatim port of difflib.SequenceMatcher ─────────────

export type OpcodeTag = "equal" | "replace" | "delete" | "insert";
/** difflib opcode shape: `[tag, aStart, aEnd, bStart, bEnd]`. */
export type Opcode = [OpcodeTag, number, number, number, number];

/** One `Match(a, b, size)` triple from difflib's get_matching_blocks. */
interface MatchBlock {
	a: number;
	b: number;
	size: number;
}

/**
 * `difflib.SequenceMatcher(None, a, b).get_opcodes()`, ported verbatim from
 * CPython's Lib/difflib.py (3.12): `__chain_b` (autojunk included),
 * `find_longest_match`, `get_matching_blocks` (LIFO queue + adjacent-block
 * collapse), `get_opcodes`. `isjunk` is None at every hermes call site, so
 * the junk-extension loops are no-ops and are omitted.
 *
 * Elements are UTF-16 units — the same basis as the span maps, so opcode
 * indices align with `buildOrigToNormMap` (astral characters pass through as
 * opaque units; the golden corpus is BMP-only). NOTE: deliberately NOT the
 * `diff`-package stand-in used for similarity ratios — the opcode SCRIPT
 * must match SequenceMatcher's, not merely approximate it (differential fuzz
 * showed jsdiff's greedy prefix/suffix script produces different — and
 * text-changing — opcodes on adversarial inputs).
 *
 * difflib is element-agnostic, and so is this port: pass LISTS to match on
 * whole elements instead of UTF-16 units — `difflib.unified_diff` feeds it
 * line lists (the V4A delete/update diffs, `src/v4a.ts`), and autojunk's
 * popular-element purge then applies per line, exactly as in CPython.
 */
export class SequenceMatcher {
	/** The A sequence — UTF-16 units for string input, whole lines for line input. */
	readonly a: string | readonly string[];
	private b: string | readonly string[];
	/** b element -> ascending indices in b (popular elements purged). */
	private b2j: Map<string, number[]>;

	constructor(a: string | readonly string[], b: string | readonly string[], autojunk = true) {
		this.a = a;
		this.b = b;
		// __chain_b: isjunk is None -> only the popular-element purge applies.
		const b2j = new Map<string, number[]>();
		for (let i = 0; i < b.length; i++) {
			const elt = b[i];
			const indices = b2j.get(elt);
			if (indices) indices.push(i);
			else b2j.set(elt, [i]);
		}
		const n = b.length;
		if (autojunk && n >= 200) {
			const ntest = Math.floor(n / 100) + 1;
			for (const [elt, idxs] of b2j) {
				if (idxs.length > ntest) b2j.delete(elt);
			}
		}
		this.b2j = b2j;
	}

	/** CPython find_longest_match over a[alo:ahi] x b[blo:bhi]. */
	private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): MatchBlock {
		const { a, b, b2j } = this;
		let besti = alo;
		let bestj = blo;
		let bestsize = 0;
		// j2len[j] = length of the longest match ending with a[i-1] and b[j].
		let j2len = new Map<number, number>();
		for (let i = alo; i < ahi; i++) {
			const newj2len = new Map<number, number>();
			const indices = b2j.get(a[i]);
			if (indices) {
				for (const j of indices) {
					if (j < blo) continue;
					if (j >= bhi) break;
					const k = (j2len.get(j - 1) ?? 0) + 1;
					newj2len.set(j, k);
					// Strict `>` keeps difflib's tie-break: earliest i, then
					// earliest j among maximal blocks.
					if (k > bestsize) {
						besti = i - k + 1;
						bestj = j - k + 1;
						bestsize = k;
					}
				}
			}
			j2len = newj2len;
		}
		// Extend the best by non-junk elements on each end (isjunk None -> the
		// junk-sucking loops that follow in CPython never fire).
		while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
			besti--;
			bestj--;
			bestsize++;
		}
		while (
			besti + bestsize < ahi &&
			bestj + bestsize < bhi &&
			a[besti + bestsize] === b[bestj + bestsize]
		) {
			bestsize++;
		}
		return { a: besti, b: bestj, size: bestsize };
	}

	/** CPython get_matching_blocks: sorted, adjacent-collapsed, dummy sentinel
	 * last. Public because difflib's is. */
	getMatchingBlocks(): MatchBlock[] {
		const la = this.a.length;
		const lb = this.b.length;
		const queue: [number, number, number, number][] = [[0, la, 0, lb]];
		const blocks: MatchBlock[] = [];
		while (queue.length > 0) {
			const [alo, ahi, blo, bhi] = queue.pop()!;
			const match = this.findLongestMatch(alo, ahi, blo, bhi);
			if (match.size > 0) {
				blocks.push(match);
				if (alo < match.a && blo < match.b) queue.push([alo, match.a, blo, match.b]);
				if (match.a + match.size < ahi && match.b + match.size < bhi) {
					queue.push([match.a + match.size, ahi, match.b + match.size, bhi]);
				}
			}
		}
		blocks.sort((x, y) => x.a - y.a || x.b - y.b);

		// Collapse adjacent equal blocks (CPython's non_adjacent pass).
		const nonAdjacent: MatchBlock[] = [];
		let i1 = 0;
		let j1 = 0;
		let k1 = 0;
		for (const block of blocks) {
			if (i1 + k1 === block.a && j1 + k1 === block.b) {
				k1 += block.size;
			} else {
				if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
				i1 = block.a;
				j1 = block.b;
				k1 = block.size;
			}
		}
		if (k1 > 0) nonAdjacent.push({ a: i1, b: j1, size: k1 });
		nonAdjacent.push({ a: la, b: lb, size: 0 });
		return nonAdjacent;
	}

	getOpcodes(): Opcode[] {
		const answer: Opcode[] = [];
		let i = 0;
		let j = 0;
		for (const { a: ai, b: bj, size } of this.getMatchingBlocks()) {
			let tag: OpcodeTag | "" = "";
			if (i < ai && j < bj) tag = "replace";
			else if (i < ai) tag = "delete";
			else if (j < bj) tag = "insert";
			if (tag) answer.push([tag, i, ai, j, bj]);
			i = ai + size;
			j = bj + size;
			if (size > 0) answer.push(["equal", ai, i, bj, j]);
		}
		return answer;
	}

	/** CPython get_grouped_opcodes(n): isolate change clusters by trimming the
	 * leading/trailing equal runs to n elements and splitting on equal runs
	 * longer than 2n. This is what difflib.unified_diff iterates (the V4A
	 * delete/update diffs) — identical output, golden-checked against CPython. */
	getGroupedOpcodes(n = 3): Opcode[][] {
		const codes = this.getOpcodes();
		if (codes.length === 0) codes.push(["equal", 0, 1, 0, 1]);
		// Fixup leading and trailing groups if they show no changes.
		const first = codes[0];
		if (first[0] === "equal") {
			codes[0] = ["equal", Math.max(first[1], first[2] - n), first[2], Math.max(first[3], first[4] - n), first[4]];
		}
		const last = codes[codes.length - 1];
		if (last[0] === "equal") {
			codes[codes.length - 1] = ["equal", last[1], Math.min(last[2], last[1] + n), last[3], Math.min(last[4], last[3] + n)];
		}
		const nn = n + n;
		const groups: Opcode[][] = [];
		let group: Opcode[] = [];
		for (const [tag, i1, i2, j1, j2] of codes) {
			// End the current group and start a new one whenever there is a
			// large range with no changes.
			if (tag === "equal" && i2 - i1 > nn) {
				group.push(["equal", i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
				groups.push(group);
				group = [["equal", Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2]];
			} else {
				group.push([tag, i1, i2, j1, j2]);
			}
		}
		if (group.length > 0 && !(group.length === 1 && group[0][0] === "equal")) groups.push(group);
		return groups;
	}
}
