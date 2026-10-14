/**
 * Teaching errors — the real differentiator (analysis §4). Under the
 * single-replacement surface (PLAN.md Tier 2 #5) the param names are hermes'
 * own (`old_string`/`new_string`/`replace_all`), so these texts are hermes'
 * Appendix B strings verbatim: the only mapping left is the tool names the
 * hints point at (deviations ledger #10 — `read_file`→`read`,
 * `search_files`→`grep`, `write_file`→`write`), because a hint that names a
 * tool which does not exist in this environment teaches nothing.
 *
 * `findClosestLines`/`formatNoMatchHint`/`visualizeWhitespace` are ports of
 * hermes `fuzzy_match.py`'s "Did you mean?" diagnostics, including the gating
 * rule (only plain no-match errors get a hint — ambiguous, escape-drift and
 * identical-strings failures already explain themselves).
 */
import { similarity } from "./text.js";
import type { EscapeDrift } from "./escape-drift.js";

/** hermes `IDENTICAL_STRINGS_ERROR`. */
export const IDENTICAL_STRINGS_ERROR =
	"No edit was applied because old_string and new_string are identical. " +
	"Provide the existing text to replace in old_string and the changed " +
	"replacement text in new_string.";

export function identicalStringsError(): string {
	return IDENTICAL_STRINGS_ERROR;
}

/** hermes' empty-`old_string` text — a terse "cannot be empty" leaves the model
 * re-sending the identical call until the loop detector kills the run
 * (upstream report: cline/cline#13970 — Kimi K3 looped on `old_text: null`). */
export function emptyOldStringError(): string {
	return (
		"old_string is empty — nothing to match. Set old_string to the exact " +
		"existing text the replacement should replace (read the file first if " +
		"unsure). To create a new file or fully rewrite one, use write instead. " +
		"Do not re-send this call unchanged."
	);
}

/** Whitespace-only anchors match trivially and mass-replace or ambiguity-error;
 * never meaningful (hermes). */
export function whitespaceOnlyOldStringError(): string {
	return (
		"old_string is only whitespace — provide non-blank text to match. Set it " +
		"to the exact existing text the replacement should replace (read the file " +
		"first if unsure). Do not re-send this call unchanged."
	);
}

/** hermes `_format_match_locations`: the chain already capped the location list
 * (`MAX_LOCATIONS` = 5), so the "+N more" row is computed from the total count. */
export function ambiguityErrorMessage(
	count: number,
	locations: { line: number; snippet: string }[],
): string {
	const rows = locations.map((l) => `  L${l.line}: ${l.snippet}`);
	const extra = count - locations.length;
	if (extra > 0) rows.push(`  ... and ${extra} more`);
	return (
		`Found ${count} matches for old_string. Provide more context to make it ` +
		`unique, or use replace_all=True. Matches:\n${rows.join("\n")}`
	);
}

/** hermes refuses replace_all when only a similarity strategy can match —
 * approximate blocks must never be mass-overwritten (Appendix B verbatim). */
export function replaceAllRefusalMessage(count: number, strategy: string): string {
	return (
		`Found ${count} approximate matches via the '${strategy}' strategy; ` +
		`replace_all only applies to exact matches. Provide the precise text ` +
		`(whitespace included) so an exact/line-trimmed match can be made.`
	);
}

/** Python repr for the sequences quoted in drift messages (hermes embeds
 * `{suspect!r}`): backslashes double, and the delimiter is picked so the
 * quote character itself needs no escaping. */
function pyRepr(s: string): string {
	let quote = "'";
	let body = s.replaceAll("\\", "\\\\");
	if (s.includes("'") && !s.includes('"')) {
		quote = '"';
	} else if (s.includes("'")) {
		body = body.replaceAll("'", "\\'");
	}
	return quote + body + quote;
}

/** Escape-drift refusals (hermes `_detect_*_drift`, verbatim modulo the
 * `read_file` → `read` tool-name mapping). Drift errors are intentional
 * blocks: `formatNoMatchHint` deliberately stays silent on top of them. */
export function escapeDriftErrorMessage(drift: EscapeDrift): string {
	switch (drift.kind) {
		case "quote_suspect":
			return (
				`Escape-drift detected: old_string and new_string contain ` +
				`the literal sequence ${pyRepr(drift.suspect)} but the matched region of ` +
				`the file does not. This is almost always a tool-call ` +
				`serialization artifact where an apostrophe or quote got ` +
				`prefixed with a spurious backslash. Re-read the file with ` +
				`read and pass old_string/new_string without ` +
				`backslash-escaping ${pyRepr(drift.plain)} characters.`
			);
		case "newline_literal":
			return (
				"Escape-drift detected: old_string contains more literal " +
				"'\\n' sequences than the matched region of the file, which " +
				"has real line breaks there instead. This is almost always a " +
				"tool-call serialization artifact where a line break got escaped " +
				"one extra time; new_string would write it as backslash + n. " +
				"Re-read the file with read and pass old_string/new_string " +
				"with actual line breaks, keeping only the '\\n' sequences " +
				"that appear literally in the file."
			);
		case "backslash_doubling":
			return (
				"Escape-drift detected: every backslash run in old_string is exactly " +
				"twice as long as in the matched region of the file (e.g. the file " +
				// hermes backticks these examples instead of using repr
				"has `\\\\` where old_string has `\\\\\\\\`). The tool-call arguments " +
				"were JSON-escaped one extra time; applying new_string verbatim would " +
				"double every backslash in the file. Re-read the file with read " +
				"and resend old_string/new_string with the backslash counts exactly " +
				"as they appear in the file."
			);
	}
}

/** Python `str.splitlines()` restricted to the line boundaries that survive
 * LF pre-normalization (deviations ledger #2): `\r\n`/`\r`/`\n`, trailing
 * separator dropped the way Python drops its trailing empty field. */
function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\r|\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** hermes `_visualize_whitespace` — render the LEADING whitespace run visibly
 * (→ = tab, · = space); the rest of the line is shown as-is. */
export function visualizeWhitespace(line: string): string {
	const stripped = line.replace(/^[ \t]+/, "");
	const prefix = line.slice(0, line.length - stripped.length);
	return prefix.replaceAll("\t", "→").replaceAll(" ", "·") + stripped;
}

/**
 * hermes `find_closest_lines`: numbered snippets of the lines most similar to
 * `old_string`'s anchor line, or "" when nothing resembles it above 0.3.
 * Tie-breaking is Python-stable (equal scores keep file order).
 */
export function findClosestLines(
	oldString: string,
	content: string,
	options: { contextLines?: number; maxResults?: number } = {},
): string {
	const contextLines = options.contextLines ?? 2;
	const maxResults = options.maxResults ?? 3;
	if (!oldString || !content) return "";
	const oldLines = splitLines(oldString);
	const contentLines = splitLines(content);
	if (oldLines.length === 0 || contentLines.length === 0) return "";

	const anchor = oldLines[0].trim() || (oldLines.find((l) => l.trim())?.trim() ?? "");
	if (!anchor) return "";

	const scored = contentLines
		.map((line, i) => ({ score: similarity(anchor, line.trim()), i }))
		.filter((entry) => contentLines[entry.i].trim() !== "");
	scored.sort((a, b) => b.score - a.score);
	const top = scored.filter((entry) => entry.score > 0.3).slice(0, maxResults);
	if (top.length === 0) return "";

	const parts: string[] = [];
	const seenRanges = new Set<string>();
	for (const { i: lineIdx } of top) {
		const start = Math.max(0, lineIdx - contextLines);
		const end = Math.min(contentLines.length, lineIdx + oldLines.length + contextLines);
		const key = `${start}:${end}`;
		if (seenRanges.has(key)) continue;
		seenRanges.add(key);
		const rows: string[] = [];
		for (let j = start; j < end; j++) rows.push(`${String(j + 1).padStart(4)}| ${contentLines[j]}`);
		parts.push(rows.join("\n"));
	}
	let result = parts.join("\n---\n");

	// Whitespace-shaped miss: best line equals the anchor once stripped. Show
	// both with visible leading whitespace so the model copies the file's.
	const bestLine = contentLines[top[0].i];
	if (bestLine.trim() === anchor && bestLine !== oldLines[0]) {
		result +=
			"\n\nWhitespace difference detected (→ = tab, · = space):\n" +
			`  file has: ${visualizeWhitespace(bestLine)}\n` +
			`  you sent: ${visualizeWhitespace(oldLines[0])}\n` +
			"Use the exact whitespace shown in 'file has'.";
	}
	return result;
}

/**
 * hermes `format_no_match_hint`: append the "Did you mean…" snippet to plain
 * no-match errors only. Ambiguous / escape-drift / identical errors also carry
 * zero matches, but a hint on top of them would mislead.
 */
export function formatNoMatchHint(
	error: string | undefined,
	matchCount: number,
	oldString: string,
	content: string,
): string {
	if (matchCount !== 0 || !error || !error.startsWith("Could not find")) return "";
	const hint = findClosestLines(oldString, content);
	return hint ? "\n\nDid you mean one of these sections?\n" + hint : "";
}

/** hermes `fuzzy_find_and_replace`'s terminal no-match text plus the hint. */
export function noMatchErrorMessage(content: string, oldString: string): string {
	const error = "Could not find a match for old_string in the file";
	return `${error}${formatNoMatchHint(error, 0, oldString, content)}`;
}

/** hermes `_no_match_result`'s success-shaped no-op — the most common
 * production failure is a re-send of an edit that already landed. */
export function alreadyAppliedMessage(path: string): string {
	return (
		`File already contains the target text — the edit appears to be already ` +
		`applied to ${path}. No write performed; do not re-send this patch.`
	);
}

/** hermes `patch_tool` argument gates (verbatim `tool_error` texts). */
export function missingPathError(): string {
	return "path required";
}

export function missingReplacementError(): string {
	return "old_string and new_string required";
}

/** hermes `Unknown mode: {mode}` — V4A (Tier 3) is not advertised by the base
 * schema, so this only fires on a stray unadvertised `mode` value. */
export function unknownModeError(mode: unknown): string {
	return `Unknown mode: ${String(mode)}`;
}

/** V4A patch mode lands in Tier 3; the handler refuses it instead of silently
 * falling back to replace mode (deviations ledger #15). */
export function patchModeUnavailableError(): string {
	return (
		"mode='patch' (V4A multi-file patch) is not available in this build of patch. " +
		"Apply one replacement with path + old_string + new_string instead, or use " +
		"write for a whole-file rewrite."
	);
}

/** The transitional `edits[]` surface is retired (Tier 2 #5). Models trained on
 * pi's built-in `edit` still emit it, so refuse with instructions instead of
 * silently applying one of the several replacements. */
export function multiEditRefusalError(count: number): string {
	return (
		`patch has no edits[] parameter: it applies exactly one replacement per call, and this ` +
		`call sent ${count}. Pass path, old_string and new_string directly (old_string is the ` +
		`existing text, new_string the changed text) and send one patch call per change. ` +
		`Do not re-send this call unchanged.`
	);
}
