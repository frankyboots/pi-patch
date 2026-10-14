/**
 * Diff generation for `patch`, mirroring the output formats of pi's built-in
 * edit tool (its renderers and HTML exports parse the display-diff line
 * format `+N text` / `-N text` / ` N text`) so the TUI stays consistent.
 */
import * as Diff from "diff";

export interface DiffStringResult {
	diff: string;
	firstChangedLine: number | undefined;
}

/** Generate a standard unified patch (same options as pi's edit tool). */
export function generateUnifiedPatch(
	path: string,
	oldContent: string,
	newContent: string,
	contextLines = 4,
): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

interface Row {
	/** "+", "-", or " " (context) */
	marker: "+" | "-" | " ";
	text: string;
	oldNum: number | undefined;
	newNum: number | undefined;
}

/**
 * Display-oriented diff with line numbers, ±N context lines around changes,
 * and `…` elision rows. Returns the first changed line number in the new file.
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): DiffStringResult {
	const rows = buildRows(oldContent, newContent);
	const show = selectVisible(rows, contextLines);
	const width = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
	const out: string[] = [];
	let firstChangedLine: number | undefined;
	let prevHidden = false;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (!show[i]) {
			if (!prevHidden && out.length > 0 && i < rows.length - 1) {
				out.push(`${" ".repeat(width + 2)}…`);
			}
			prevHidden = true;
			continue;
		}
		prevHidden = false;
		const num = row.marker === "-" ? row.oldNum : row.newNum;
		if (row.marker !== " " && firstChangedLine === undefined && row.newNum !== undefined) {
			firstChangedLine = row.newNum;
		}
		const numText = num === undefined ? "" : String(num).padStart(width, " ");
		out.push(`${row.marker}${numText} ${row.text}`);
	}
	return { diff: out.join("\n"), firstChangedLine };
}

function buildRows(oldContent: string, newContent: string): Row[] {
	const parts = Diff.diffLines(oldContent, newContent);
	const rows: Row[] = [];
	let oldNum = 1;
	let newNum = 1;
	for (const part of parts) {
		const lines = part.value.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		for (const text of lines) {
			if (part.added) {
				rows.push({ marker: "+", text, oldNum: undefined, newNum: newNum++ });
			} else if (part.removed) {
				rows.push({ marker: "-", text, oldNum: oldNum++, newNum: undefined });
			} else {
				rows.push({ marker: " ", text, oldNum: oldNum++, newNum: newNum++ });
			}
		}
	}
	return rows;
}

/** A context row is visible when within `contextLines` of a change row. */
function selectVisible(rows: Row[], contextLines: number): boolean[] {
	const show = rows.map((r) => r.marker !== " ");
	let sinceChange = contextLines + 1;
	for (let i = 0; i < rows.length; i++) {
		if (rows[i].marker !== " ") {
			sinceChange = 0;
		} else if (sinceChange < contextLines) {
			sinceChange++;
			show[i] = true;
		} else {
			sinceChange++;
		}
	}
	// Backward pass: context rows shortly before a change.
	let untilChange = contextLines + 1;
	for (let i = rows.length - 1; i >= 0; i--) {
		if (rows[i].marker !== " ") {
			untilChange = 0;
		} else if (untilChange < contextLines) {
			untilChange++;
			show[i] = true;
		} else {
			untilChange++;
		}
	}
	return show;
}
