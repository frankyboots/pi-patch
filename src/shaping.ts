/**
 * Replacement shaping for fuzzy matches (port plan §3.3 / Tier 2 #8, first
 * slice): when the match was not exact, the file region differs from oldText,
 * and splicing newText verbatim can corrupt style. Re-anchors newText's base
 * indent onto the file's actual indent while preserving relative nesting, so
 * an unindented model replacement lands correctly inside a nested block.
 *
 * Simplified port of hermes' `_reindent_replacement` (first-line anchoring
 * with per-line prefix swap). Unicode-preserving opcodes come later (Tier 2).
 */
function firstLine(text: string): string {
	const idx = text.indexOf("\n");
	return idx === -1 ? text : text.slice(0, idx);
}

function leadingWhitespace(line: string): string {
	return line.match(/^[ \t\f\v]*/)?.[0] ?? "";
}

export function reindentReplacement(oldText: string, newText: string, matchedText: string): string {
	const patIndent = leadingWhitespace(firstLine(oldText));
	const fileIndent = leadingWhitespace(firstLine(matchedText));
	if (patIndent === fileIndent) return newText;
	return newText
		.split("\n")
		.map((line) => {
			if (line.trim() === "") return line;
			if (line.startsWith(patIndent)) return fileIndent + line.slice(patIndent.length);
			return line;
		})
		.join("\n");
}
