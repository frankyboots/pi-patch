/**
 * Teaching errors — the real differentiator (analysis §4; target texts are
 * Appendix B verbatim, modulo pi tool names per deviations ledger #10).
 *
 * Every failure is a teaching moment with data: ambiguity errors name the
 * match locations, no-match errors show the closest sections ("did you
 * mean") and visualize whitespace drift, validation errors tell the model
 * not to re-send unchanged. Error texts reference pi's tool names
 * (read/grep/find), not hermes' (read_file/search_files).
 */
import { buildLineIndex, similarity } from "./text.js";

const SNIPPET_MAX = 80;
const MAX_SUGGESTIONS = 3;
const MIN_SUGGESTION_SCORE = 0.3;
const MAX_SUGGESTION_SCAN_CHARS = 500_000;
const MAX_SUGGESTION_PATTERN_LINES = 300;

export function formatWhitespace(line: string): string {
	return line.replace(/ /g, "·").replace(/\t/g, "→");
}

function truncate(s: string, max = SNIPPET_MAX): string {
	const trimmed = s.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function ambiguityErrorMessage(
	path: string,
	editIndex: number,
	strategy: string,
	count: number,
	locations: { line: number; snippet: string }[],
): string {
	const rows = locations.map((l) => `  L${l.line}: ${l.snippet}`).join("\n");
	return [
		`Found ${count} matches for the old text of edit #${editIndex} in ${path} (matched with ${strategy} tolerance).`,
		`Provide more surrounding context to make it unique. Matches:`,
		rows,
	].join("\n");
}

/** Best window of pattern-sized content regions by similarity, for suggestions. */
interface SuggestionWindow {
	i: number;
	n: number;
	score: number;
}

function findSuggestionWindows(content: string, oldText: string): SuggestionWindow[] {
	if (content.length > MAX_SUGGESTION_SCAN_CHARS) return [];
	const patternLines = oldText.replace(/\n$/, "").split("\n");
	if (patternLines.length > MAX_SUGGESTION_PATTERN_LINES) return [];
	const index = buildLineIndex(content);
	const coreCount = index.endsWithNewline ? index.lines.length - 1 : index.lines.length;
	const n = patternLines.length;
	if (n === 0 || coreCount === 0) return [];
	const patternText = patternLines.join("\n");
	const scored: SuggestionWindow[] = [];
	for (let i = 0; i + n <= coreCount; i++) {
		const windowText = index.lines.slice(i, i + n).join("\n");
		const score = similarity(patternText, windowText);
		if (score >= MIN_SUGGESTION_SCORE) scored.push({ i, n, score });
	}
	scored.sort((a, b) => b.score - a.score);
	// Greedy non-overlapping top-k.
	const chosen: SuggestionWindow[] = [];
	for (const w of scored) {
		if (chosen.length >= MAX_SUGGESTIONS) break;
		if (chosen.some((c) => w.i < c.i + c.n && c.i < w.i + w.n)) continue;
		chosen.push(w);
	}
	return chosen;
}

function whitespaceVisualization(
	index: ReturnType<typeof buildLineIndex>,
	window: SuggestionWindow,
	oldText: string,
): string | undefined {
	const patternLines = oldText.replace(/\n$/, "").split("\n");
	const collapse = (s: string) => s.replace(/\s+/g, "");
	for (let k = 0; k < Math.min(window.n, patternLines.length); k++) {
		const fileLine = index.lines[window.i + k];
		const sentLine = patternLines[k];
		if (fileLine === sentLine) continue;
		if (collapse(fileLine) === "" || collapse(fileLine) !== collapse(sentLine)) continue;
		return [
			`Whitespace difference detected (→ = tab, · = space):`,
			`  file has: ${formatWhitespace(fileLine)}`,
			`  you sent: ${formatWhitespace(sentLine)}`,
			`Use the exact whitespace shown in 'file has'.`,
		].join("\n");
	}
	return undefined;
}

export function noMatchErrorMessage(path: string, editIndex: number, content: string, oldText: string): string {
	let msg = `Could not find the old text of edit #${editIndex} in ${path} — not exactly, and not with whitespace/indentation tolerance.`;
	const windows = findSuggestionWindows(content, oldText);
	if (windows.length === 0) {
		return `${msg}\n\nUse read to verify the current content, or grep/find to locate the text. Do not re-send this call unchanged.`;
	}
	const index = buildLineIndex(content);
	const best = windows[0];
	const shown = Math.min(best.n, 6);
	const rows: string[] = [];
	for (let k = 0; k < shown; k++) {
		rows.push(` L${best.i + k + 1}| ${truncate(index.lines[best.i + k])}`);
	}
	if (shown < best.n) rows.push(`     …`);
	msg += `\n\nDid you mean one of these sections?\n${rows.join("\n")}`;
	const viz = whitespaceVisualization(index, best, oldText);
	if (viz) msg += `\n\n${viz}`;
	msg += `\n\nRe-read the file and copy oldText from the current content, matching its exact indentation and whitespace. Do not re-send this call unchanged.`;
	return msg;
}

export function emptyOldTextError(editIndex: number): string {
	return `oldText of edit #${editIndex} is empty or whitespace-only. Provide the exact text to replace, copied from the file. Do not re-send this call unchanged.`;
}

export function identicalTextsError(editIndex: number): string {
	return `oldText and newText of edit #${editIndex} are identical — this patch would change nothing. Adjust the replacement or drop the edit. Do not re-send this call unchanged.`;
}

export function alreadyAppliedMessage(path: string, editIndexes: number[]): string {
	const list = editIndexes.map((i) => `#${i}`).join(", ");
	const verb = editIndexes.length === 1 ? "appears" : "appear";
	return `File already contains the target text — edit ${list} ${verb} to be already applied. No changes made to ${path}; do not re-send this patch.`;
}

export function overlapErrorMessage(
	path: string,
	a: { index: number; startLine: number; endLine: number },
	b: { index: number; startLine: number; endLine: number },
): string {
	return `Edits #${a.index} and #${b.index} target overlapping regions in ${path} (L${a.startLine}-L${a.endLine} and L${b.startLine}-L${b.endLine}). Merge them into a single edit; each edits[].oldText is matched against the original file, not after earlier edits are applied.`;
}

export { similarity };
