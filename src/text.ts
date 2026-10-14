/**
 * Text normalization and line-indexing helpers.
 *
 * Mirrors the file-handling behavior of pi's built-in edit tool (LF
 * pre-normalization, BOM stripping, CRLF detection/restoration) so `patch`
 * stays byte-compatible with `edit` on the same files.
 */
import * as Diff from "diff";

/**
 * difflib SequenceMatcher-style ratio (2*matched / (len(a)+len(b))) via char
 * diff opcodes — the score behind the "did you mean" section ranking
 * (hermes uses SequenceMatcher(None, a, b).ratio()).
 */
export function similarity(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) return 1;
	if (a.length === 0 || b.length === 0) return 0;
	let matched = 0;
	for (const part of Diff.diffChars(a, b)) {
		if (!part.added && !part.removed) matched += part.value.length;
	}
	return (2 * matched) / (a.length + b.length);
}

export function splitBom(text: string): { bom: string; text: string } {
	if (text.charCodeAt(0) === 0xfeff) {
		return { bom: text.slice(0, 1), text: text.slice(1) };
	}
	return { bom: "", text };
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	if (ending === "\n") return text;
	return text.replace(/\n/g, "\r\n");
}

/**
 * Indexed view of LF-normalized content: line texts plus byte offsets, so
 * match spans can be mapped back to line numbers for error messages.
 */
export interface LineIndex {
	/** lines[i] is line i+1 without its newline; the final element is "" when content ends with \n */
	lines: string[];
	/** starts[i] is the byte offset of line i's first character */
	starts: number[];
	/** True when the content ends with a newline (a trailing "" line element) */
	endsWithNewline: boolean;
	/** Exclusive end offset of line i, excluding its newline */
	lineEnd(i: number): number;
}

export function buildLineIndex(content: string): LineIndex {
	const lines = content.split("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	return {
		lines,
		starts,
		endsWithNewline: content.length > 0 && content.endsWith("\n"),
		lineEnd(i: number) {
			return i + 1 < lines.length ? starts[i + 1] - 1 : content.length;
		},
	};
}

/** 1-based line number containing the given byte offset. */
export function lineAt(index: LineIndex, offset: number): number {
	let lo = 0;
	let hi = index.starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (index.starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

export function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + 1);
	}
	return count;
}
