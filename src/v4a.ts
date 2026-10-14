/**
 * V4A patch parser/applier — verbatim port of hermes `tools/patch_parser.py`
 * (docs/PLAN.md Tier 3 #8). `*** Begin Patch`/`*** End Patch` wrap ops:
 * `*** Update File: p` + hunks (`@@ hint @@`, ` ctx`, `-old`, `+new`);
 * `*** Add File: n` + `+` lines; `*** Delete File: o`; `*** Move File: a -> b`.
 *
 * Application is two-phase (hermes `apply_v4a_operations`): validate EVERY
 * operation first (a dry run whose overlay simulates inter-op state — a Move
 * creating the path a later Update targets, an Add after a Delete), and only
 * then write. A validation failure modifies nothing; an apply-phase failure
 * (validate/apply race) reports that state may be inconsistent.
 *
 * UPDATE hunks go through the shared strategy chain via `fuzzyFindAndReplace`
 * (hermes `fuzzy_find_and_replace`), including the context-hint window retry
 * (−500/+2000 chars) and the already-applied skip that mirrors validation's.
 * Error texts are hermes' verbatim (analysis Appendix B): the parser's own
 * strings here plus the chain texts routed through `errors.ts`.
 *
 * File access is duck-typed (`V4AFileOps`, hermes' `file_ops`): the parser
 * never touches the filesystem itself, so tests drive it with in-memory fakes
 * and the tool layer (Tier 3 #10) supplies the real implementation. One
 * environment-forced adaptation: hermes probes `write_file`'s signature for a
 * `pre_content` capability (`inspect.signature`); our interface fixes the
 * capability, so `preContent` is always passed — extra arguments are inert for
 * implementations that ignore them, and the single-write / no-silent-retry
 * contracts hermes' probe protects hold by construction.
 */
import { countOccurrences } from "./text.js";
import { fuzzyFindAndReplace, isAlreadyApplied } from "./chain.js";
import { formatNoMatchHint, pyRepr } from "./errors.js";
import { SequenceMatcher } from "./shaping.js";

export type OperationType = "add" | "update" | "delete" | "move";

export interface HunkLine {
	prefix: " " | "-" | "+";
	content: string;
}

export interface Hunk {
	contextHint: string | null;
	lines: HunkLine[];
}

export interface PatchOperation {
	operation: OperationType;
	filePath: string;
	/** MOVE only */
	newPath: string | null;
	hunks: Hunk[];
}

// Markers must occupy the whole line at column 0 so content lines that merely
// mention the format ("+*** End Patch") can't truncate or reset the patch.
// (Python `.` == any char except \n; `[^\n]` is the exact JS equivalent.)
const BEGIN_MARKER = /^\*\*\*\s*Begin\s+Patch\s*$/;
const END_MARKER = /^\*\*\*\s*End\s+Patch\s*$/;
const OP_MARKERS: readonly { kind: OperationType; rx: RegExp }[] = [
	{ kind: "update", rx: /^\*\*\*\s*Update\s+File:\s*([^\n]+)/ },
	{ kind: "add", rx: /^\*\*\*\s*Add\s+File:\s*([^\n]+)/ },
	{ kind: "delete", rx: /^\*\*\*\s*Delete\s+File:\s*([^\n]+)/ },
	{ kind: "move", rx: /^\*\*\*\s*Move\s+File:\s*([^\n]+?)\s*->\s*([^\n]+)/ },
];
const HINT_RE = /^@@\s*([^\n]+?)\s*@@/;

export interface V4AParseResult {
	operations: PatchOperation[];
	/** `"Parse error: …"` when the patch is malformed (with `operations: []`); otherwise unset. */
	error?: string;
}

/** -> operations (empty patch = [], no error) or `([], "Parse error: …")`. */
export function parseV4APatch(patchContent: string): V4AParseResult {
	// Tolerate CRLF: a stray `\r` would land in every HunkLine.content and defeat the markers.
	const lines = patchContent.split("\n").map((ln) => (ln.endsWith("\r") ? ln.slice(0, -1) : ln));
	let startIdx = -1; // parse from the top when no Begin marker is present
	let endIdx = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (BEGIN_MARKER.test(lines[i])) startIdx = i;
		else if (END_MARKER.test(lines[i])) {
			endIdx = i;
			break;
		}
	}
	const operations: PatchOperation[] = [];
	let currentOp: PatchOperation | null = null;
	let currentHunk: Hunk | null = null;

	const flushHunk = (): void => {
		if (currentOp && currentHunk && currentHunk.lines.length > 0) currentOp.hunks.push(currentHunk);
	};
	const flush = (): void => {
		if (currentOp) {
			flushHunk();
			operations.push(currentOp);
		}
	};

	for (let i = startIdx + 1; i < endIdx; i++) {
		const line = lines[i];
		const opMatch = matchOpMarker(line);
		if (opMatch) {
			flush();
			currentOp = {
				operation: opMatch.kind,
				filePath: opMatch.path.trim(),
				newPath: opMatch.kind === "move" ? opMatch.newPath!.trim() : null,
				hunks: [],
			};
			// UPDATE hunks start lazily ('@@' or first hunk line); ADD collects all '+' lines
			// into one hunk; DELETE/MOVE are complete.
			currentHunk = opMatch.kind === "add" ? { contextHint: null, lines: [] } : null;
			if (opMatch.kind === "delete" || opMatch.kind === "move") {
				operations.push(currentOp);
				currentOp = null;
			}
		} else if (line.startsWith("@@")) {
			if (currentOp) {
				flushHunk();
				const hintMatch = HINT_RE.exec(line);
				currentHunk = { contextHint: hintMatch ? hintMatch[1] : null, lines: [] };
			}
		} else if (currentOp && line) {
			if (currentHunk === null) currentHunk = { contextHint: null, lines: [] };
			if (line[0] === "+" || line[0] === "-" || line[0] === " ") {
				currentHunk.lines.push({ prefix: line[0], content: line.slice(1) });
			} else if (line[0] !== "\\") {
				// "\ No newline at end of file" marker is skipped
				currentHunk.lines.push({ prefix: " ", content: line }); // implicit context line
			}
		}
	}
	flush();
	const parseErrors: string[] = [];
	for (const op of operations) {
		if (!op.filePath) parseErrors.push("Operation with empty file path");
		if (op.operation === "update" && op.hunks.length === 0) parseErrors.push(`UPDATE ${pyRepr(op.filePath)}: no hunks found`);
		if (op.operation === "move" && !op.newPath) {
			parseErrors.push(`MOVE ${pyRepr(op.filePath)}: missing destination path (expected 'src -> dst')`);
		}
	}
	return parseErrors.length > 0 ? { operations: [], error: "Parse error: " + parseErrors.join("; ") } : { operations };
}

function matchOpMarker(line: string): { kind: OperationType; path: string; newPath?: string } | null {
	for (const { kind, rx } of OP_MARKERS) {
		const m = rx.exec(line);
		if (m) return kind === "move" ? { kind, path: m[1], newPath: m[2] } : { kind, path: m[1] };
	}
	return null;
}

/** hermes `read_file_raw`'s result: full content (BOM-stripped) or an error.
 * `notFound` distinguishes "the path is absent" from "the read FAILED" — the
 * Add/Move free-path checks trust only the former. */
export interface RawReadResult {
	content: string | null;
	error: string | null;
	/** True when the read failed because the path does not exist. */
	notFound?: boolean;
}

/** hermes `WriteResult` subset the parser consumes. `lspDiagnostics`/`lint`
 * propagate to the PatchResult when the underlying write produces them (pi has
 * no lint/LSP harness today — deviations ledger #5 — so the real file ops
 * leave them unset, but the propagation stays ported and test-covered). */
export interface V4AWriteResult {
	error?: string | null;
	lspDiagnostics?: string | null;
	lint?: Record<string, unknown> | null;
}

/** hermes' duck-typed `file_ops` surface (synchronous, as in hermes).
 * `writeFile` always receives `preContent` — the content the caller matched
 * against — so an implementation can skip a redundant re-read inside the
 * write (hermes `_write_file_accepts_pre_content`'s optimization; see the
 * module docstring for the capability-probe adaptation). */
export interface V4AFileOps {
	readFileRaw(path: string): RawReadResult;
	writeFile(path: string, content: string, preContent?: string): V4AWriteResult;
	deleteFile(path: string): { error?: string | null };
	moveFile(src: string, dst: string): { error?: string | null };
}

/** hermes `PatchResult` (file_operations_common.py:60) — the V4A outcome.
 * `lint` is keyed by path; `error` is the aggregate validation/apply text. */
export interface PatchResult {
	success: boolean;
	diff: string;
	filesModified: string[];
	filesCreated: string[];
	filesDeleted: string[];
	lint: Record<string, Record<string, unknown>> | null;
	lspDiagnostics: string | null;
	error: string | null;
}

/** hermes `_split_hunk`: `(search_lines, replace_lines)` — context+removed vs context+added. */
function splitHunk(hunk: Hunk): [string[], string[]] {
	return [
		hunk.lines.filter((l) => l.prefix !== "+").map((l) => l.content),
		hunk.lines.filter((l) => l.prefix !== "-").map((l) => l.content),
	];
}

function linesEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** hermes `_no_match_hint`: best-effort 'Did you mean...' suffix; never lets a
 * hint failure mask the real error. */
function noMatchHint(error: string | null | undefined, searchPattern: string, content: string): string {
	try {
		return formatNoMatchHint(error ?? undefined, 0, searchPattern, content);
	} catch {
		return "";
	}
}

/** hermes `_hint_ambiguity`: (occurrences, error) for an addition-only hunk's
 * context hint; `ambiguous` is "" when unique. Occurrence counting advances one
 * char per hit (overlaps count — hermes `_count_occurrences`; hints are never
 * empty, where the shared helper's empty-needle shortcut would differ). */
function hintAmbiguity(content: string, hint: string, tail = ""): { occurrences: number; ambiguous: string } {
	const occurrences = countOccurrences(content, hint);
	return {
		occurrences,
		ambiguous: occurrences > 1 ? `context hint '${hint}' is ambiguous (${occurrences} occurrences)${tail}` : "",
	};
}

/** hermes `_validate_operations`: dry-run every operation -> error strings
 * (empty = safe). UPDATE hunks are simulated in order so later hunks see
 * post-earlier-hunk content, exactly as apply will. */
function validateOperations(operations: PatchOperation[], fileOps: V4AFileOps): string[] {
	const errors: string[] = [];
	let realChangeCount = 0;
	// Overlay so inter-op state validates (a MOVE creating the path a later UPDATE targets).
	const pendingContent = new Map<string, string>();
	const removedPaths = new Set<string>();

	const read = (path: string): { content: string | null; error: string | null } => {
		if (pendingContent.has(path)) return { content: pendingContent.get(path) ?? null, error: null };
		if (removedPaths.has(path)) return { content: null, error: "file not found" };
		const r = fileOps.readFileRaw(path);
		return r.error ? { content: null, error: r.error } : { content: r.content, error: null };
	};

	const occupied = (path: string): string | null => {
		// Why an Add target or Move destination is not free, or null. Only a read that reports
		// the path absent (`notFound`) frees it: a read that FAILED (no byte transport, a
		// directory, an unreadable file) says nothing about what is there, and taking it as free
		// writes over the file the check exists to protect.
		if (pendingContent.has(path)) return "exists";
		if (removedPaths.has(path)) return null;
		const r = fileOps.readFileRaw(path);
		if (!r.error) return "exists";
		return r.notFound ? null : `could not confirm the path is free — ${r.error}`;
	};

	const validateUpdate = (op: PatchOperation): void => {
		const readResult = read(op.filePath);
		if (readResult.error) {
			errors.push(`${op.filePath}: ${readResult.error}`);
			return;
		}
		let simulated: string = readResult.content ?? "";
		for (const [idx, hunk] of op.hunks.entries()) {
			const hunkIndex = idx + 1;
			const [searchLines, replaceLines] = splitHunk(hunk);
			if (linesEqual(searchLines, replaceLines)) {
				// Context-only anchor hunks (models emit these between changes) are inert; identical
				// -/+ lines are skipped by apply as a no-op — neither may fail validation.
				if (hunk.lines.some((l) => l.prefix === "-" || l.prefix === "+")) realChangeCount++;
				continue;
			}
			realChangeCount++;
			if (searchLines.length === 0) {
				// addition-only: the context hint must be unique
				if (hunk.contextHint) {
					const { occurrences, ambiguous } = hintAmbiguity(simulated, hunk.contextHint);
					if (occurrences === 0) {
						errors.push(`${op.filePath}: addition-only hunk context hint '${hunk.contextHint}' not found`);
					} else if (ambiguous) {
						errors.push(`${op.filePath}: addition-only hunk ${ambiguous}`);
					}
				}
				continue;
			}
			const searchPattern = searchLines.join("\n");
			const replacement = replaceLines.join("\n");
			const fr = fuzzyFindAndReplace(simulated, searchPattern, replacement, false);
			if (fr.count > 0) {
				simulated = fr.newContent;
			} else if (!isAlreadyApplied(simulated, searchPattern, replacement)) {
				// Already-applied hunks are no-ops (apply performs the same skip).
				const label = hunk.contextHint ? `'${hunk.contextHint}'` : "(no hint)";
				errors.push(
					`${op.filePath}: hunk ${hunkIndex} ${label} not found`
						+ (fr.error ? ` — ${fr.error}` : "")
						+ noMatchHint(fr.error, searchPattern, simulated),
				);
			}
		}
		pendingContent.set(op.filePath, simulated);
	};

	const remove = (path: string): void => {
		removedPaths.add(path);
		pendingContent.delete(path);
	};

	for (const op of operations) {
		if (op.operation === "update") {
			validateUpdate(op);
			continue;
		}
		realChangeCount++;
		if (op.operation === "delete") {
			if (read(op.filePath).error) errors.push(`${op.filePath}: file not found for deletion`);
			else remove(op.filePath);
		} else if (op.operation === "move") {
			if (!op.newPath) {
				errors.push(`${op.filePath}: MOVE operation missing destination path`);
				continue;
			}
			const { content: srcContent, error: srcErr } = read(op.filePath);
			if (srcErr) errors.push(`${op.filePath}: source file not found for move`);
			const dstTaken = occupied(op.newPath);
			if (dstTaken === "exists") errors.push(`${op.newPath}: destination already exists — move would overwrite`);
			else if (dstTaken) errors.push(`${op.newPath}: ${dstTaken}`);
			else if (!srcErr) {
				// only a cleanly-validated move updates the overlay
				pendingContent.set(op.newPath, srcContent ?? "");
				remove(op.filePath);
			}
		} else {
			// An Add must create a NEW file. If the target already exists, write_file
			// would clobber it with only the patch's '+' lines and report success,
			// silently destroying the original contents (models frequently confuse Add
			// with Update). Reject it here so the two-phase contract holds, mirroring
			// the MOVE destination guard. Overlay-aware: an Add after a Delete of the
			// same path in this patch stays legal, and the added content enters the
			// overlay so later hunks against it validate.
			const addTaken = occupied(op.filePath);
			if (addTaken === "exists") errors.push(`${op.filePath}: file already exists — use Update File, not Add File`);
			else if (addTaken) errors.push(`${op.filePath}: ${addTaken}`);
			else {
				removedPaths.delete(op.filePath);
				pendingContent.set(
					op.filePath,
					op.hunks.flatMap((h) => h.lines).filter((l) => l.prefix === "+").map((l) => l.content).join("\n"),
				);
			}
		}
	}
	if (errors.length === 0 && realChangeCount === 0) {
		errors.push("Patch contains no changes (only context lines were provided)");
	}
	return errors;
}

// Every apply handler returns success with a diff payload, or a failure payload.
type ApplyOutcome =
	| { ok: true; payload: string; lsp: string | null; lint: Record<string, unknown> | null }
	| { ok: false; threw: boolean; payload: string };

function fail(error: string): ApplyOutcome {
	return { ok: false, threw: false, payload: error };
}

/** Outcome of a write: its error, else success with LSP/lint propagated from the write result. */
function written(result: V4AWriteResult, diff: string): ApplyOutcome {
	if (result.error) return fail(result.error);
	return { ok: true, payload: diff, lsp: result.lspDiagnostics ?? null, lint: result.lint ?? null };
}

/** Python `str.splitlines(keepends=True)` restricted to the line boundary that
 * survives LF pre-normalization (deviations ledger #2): trailing separator
 * dropped, every kept line keeps its "\n". */
function splitLinesKeepEnds(text: string): string[] {
	if (text.length === 0) return [];
	const parts = text.split("\n");
	const last = parts.pop() as string;
	const lines = parts.map((l) => l + "\n");
	if (last.length > 0) lines.push(last);
	return lines;
}

/** CPython difflib `_format_range_unified` (start/stop are 0-based). */
function formatRangeUnified(start: number, stop: number): string {
	const beginning = start + 1;
	const length = stop - start;
	if (length === 1) return String(beginning);
	if (length === 0) return `${beginning - 1},0`;
	return `${beginning},${length}`;
}

/** hermes `_unified_diff`: unified diff `a/{path}` -> `b/{path}` (`new === null`
 * = deletion, `/dev/null`), i.e. Python `difflib.unified_diff(a_lines, b_lines,
 * fromfile=…, tofile=…, n=3)` — ported on our SequenceMatcher (shaping.ts) over
 * LINES, so hunk grouping, range formatting and trailing-newline handling match
 * CPython byte for byte (golden-checked). */
function unifiedDiff(path: string, oldContent: string, newContent: string | null): string {
	const toFile = newContent === null ? "/dev/null" : `b/${path}`;
	const a = splitLinesKeepEnds(oldContent);
	const b = splitLinesKeepEnds(newContent ?? "");
	const groups = new SequenceMatcher(a, b).getGroupedOpcodes(3);
	if (groups.length === 0) return "";
	const pieces: string[] = [`--- a/${path}\n`, `+++ ${toFile}\n`];
	for (const group of groups) {
		const first = group[0];
		const last = group[group.length - 1];
		pieces.push(`@@ -${formatRangeUnified(first[1], last[2])} +${formatRangeUnified(first[3], last[4])} @@\n`);
		for (const [tag, i1, i2, j1, j2] of group) {
			if (tag === "equal") {
				for (const line of a.slice(i1, i2)) pieces.push(" " + line);
				continue;
			}
			if (tag === "replace" || tag === "delete") {
				for (const line of a.slice(i1, i2)) pieces.push("-" + line);
			}
			if (tag === "replace" || tag === "insert") {
				for (const line of b.slice(j1, j2)) pieces.push("+" + line);
			}
		}
	}
	return pieces.join("");
}

/** hermes `_apply_add`: create a file from the hunks' '+' lines. Fails closed
 * when the target already exists: validation confirmed the path was free (or
 * freed by an earlier DELETE in this patch, which has already applied by now),
 * so an existing file here is a validate/apply race — never clobber. */
function applyAdd(op: PatchOperation, fileOps: V4AFileOps): ApplyOutcome {
	const readBack = fileOps.readFileRaw(op.filePath);
	if (!readBack.error) return fail(`${op.filePath}: file already exists — use Update File, not Add File`);
	if (!readBack.notFound) {
		// The read FAILED; it did not report an absent path. Treating that as "the path is free"
		// writes the Add payload over whatever is actually there.
		return fail(`${op.filePath}: could not confirm the path is free — ${readBack.error}`);
	}
	const contentLines = op.hunks.flatMap((h) => h.lines).filter((l) => l.prefix === "+").map((l) => l.content);
	const result = fileOps.writeFile(op.filePath, contentLines.join("\n"));
	const diff = `--- /dev/null\n+++ b/${op.filePath}\n` + contentLines.map((line) => `+${line}`).join("\n");
	return written(result, diff);
}

/** hermes `_apply_delete`: delete a file, producing a real unified diff of the removed content. */
function applyDelete(op: PatchOperation, fileOps: V4AFileOps): ApplyOutcome {
	const readResult = fileOps.readFileRaw(op.filePath); // re-read guards validate/apply races
	if (readResult.error) return fail(`Cannot delete ${op.filePath}: file not found`);
	const result = fileOps.deleteFile(op.filePath);
	const diff = unifiedDiff(op.filePath, readResult.content ?? "", null) || `# Deleted: ${op.filePath}`;
	return result.error ? fail(result.error) : { ok: true, payload: diff, lsp: null, lint: null };
}

/** hermes `_apply_move`: move, re-checking the destination first — validation's
 * answer is stale once earlier ops of this patch have applied, and `mv`
 * replaces whatever is there. */
function applyMove(op: PatchOperation, fileOps: V4AFileOps): ApplyOutcome {
	const newPath = op.newPath;
	if (newPath === null) return fail(`${op.filePath}: MOVE operation missing destination path`);
	const dst = fileOps.readFileRaw(newPath);
	if (!dst.error) return fail(`${newPath}: destination already exists — move would overwrite`);
	if (!dst.notFound) return fail(`${newPath}: could not confirm the destination is free — ${dst.error}`);
	const result = fileOps.moveFile(op.filePath, newPath);
	return result.error
		? fail(result.error)
		: { ok: true, payload: `# Moved: ${op.filePath} -> ${newPath}`, lsp: null, lint: null };
}

/** hermes `_insert_addition_only`: place an addition-only hunk after its context
 * hint (or at EOF). Returns the new content, or an error. */
function insertAdditionOnly(newContent: string, hunk: Hunk, insertText: string): { content: string; error?: string } {
	if (hunk.contextHint) {
		const { occurrences, ambiguous } = hintAmbiguity(newContent, hunk.contextHint, " — provide a more unique hint");
		if (ambiguous) return { content: newContent, error: `Addition-only hunk: ${ambiguous}` };
		if (occurrences === 1) {
			const eol = newContent.indexOf("\n", newContent.indexOf(hunk.contextHint));
			if (eol === -1) return { content: newContent + "\n" + insertText };
			return { content: newContent.slice(0, eol + 1) + insertText + "\n" + newContent.slice(eol + 1) };
		}
	}
	// No hint / hint not found — append at end as a safe fallback.
	return { content: newContent.replace(/\n+$/, "") + "\n" + insertText + "\n" };
}

/** hermes `_apply_update`: apply each hunk via fuzzy replace, then write once. */
function applyUpdate(op: PatchOperation, fileOps: V4AFileOps): ApplyOutcome {
	const readResult = fileOps.readFileRaw(op.filePath); // raw: no line numbers / truncation
	if (readResult.error) return fail(`Cannot read file: ${readResult.error}`);
	const currentContent = readResult.content ?? "";
	let newContent = currentContent;
	for (const hunk of op.hunks) {
		const [searchLines, replaceLines] = splitHunk(hunk);
		if (searchLines.length > 0 && linesEqual(searchLines, replaceLines)) continue;
		const searchPattern = searchLines.join("\n");
		const replacement = replaceLines.join("\n");
		if (searchLines.length === 0) {
			const inserted = insertAdditionOnly(newContent, hunk, replacement);
			if (inserted.error) return fail(inserted.error);
			newContent = inserted.content;
			continue;
		}
		const fr = fuzzyFindAndReplace(newContent, searchPattern, replacement, false);
		newContent = fr.newContent;
		if (!(fr.error && fr.count === 0)) continue;
		// Retry inside a window around the context hint, if any.
		const hintPos = hunk.contextHint ? newContent.indexOf(hunk.contextHint) : -1;
		let error: string | null = fr.error;
		if (hintPos !== -1) {
			const windowStart = Math.max(0, hintPos - 500);
			const windowEnd = Math.min(newContent.length, hintPos + 2000);
			const windowFr = fuzzyFindAndReplace(newContent.slice(windowStart, windowEnd), searchPattern, replacement, false);
			if (windowFr.count > 0) {
				newContent = newContent.slice(0, windowStart) + windowFr.newContent + newContent.slice(windowEnd);
				error = null;
			}
		}
		if (error) {
			// Mirror validation's already-applied skip, else the two phases disagree and fail here.
			if (isAlreadyApplied(newContent, searchPattern, replacement)) continue;
			const hint = noMatchHint(error, searchPattern, newContent);
			return fail(`Could not apply hunk: ${error}` + hint);
		}
	}
	// preContent = the content we matched against, so the write can skip a
	// redundant re-read (hermes `_write_file_accepts_pre_content`; see the
	// module docstring for the capability-probe adaptation).
	const writeResult = fileOps.writeFile(op.filePath, newContent, currentContent);
	return written(writeResult, unifiedDiff(op.filePath, currentContent, newContent));
}

// operation -> (handler, verb for error text, files_* bucket)
const APPLY_DISPATCH: Record<OperationType, { handler: (op: PatchOperation, fileOps: V4AFileOps) => ApplyOutcome; verb: string; bucket: "created" | "deleted" | "modified" }> = {
	add: { handler: applyAdd, verb: "add", bucket: "created" },
	delete: { handler: applyDelete, verb: "delete", bucket: "deleted" },
	move: { handler: applyMove, verb: "move", bucket: "modified" },
	update: { handler: applyUpdate, verb: "update", bucket: "modified" },
};

function bullets(errors: string[]): string {
	return errors.map((e) => `  • ${e}`).join("\n");
}

/** hermes `apply_v4a_operations`: two-phase — validate everything, then apply
 * (atomic on validation failure). A phase-2 failure (validate/apply race)
 * carries a `git diff` note since state may be inconsistent. */
export function applyV4AOperations(operations: PatchOperation[], fileOps: V4AFileOps): PatchResult {
	const validationErrors = validateOperations(operations, fileOps);
	if (validationErrors.length > 0) {
		return {
			success: false,
			diff: "",
			filesModified: [],
			filesCreated: [],
			filesDeleted: [],
			lint: null,
			lspDiagnostics: null,
			error: "Patch validation failed (no files were modified):\n" + bullets(validationErrors),
		};
	}
	const files: Record<"created" | "deleted" | "modified", string[]> = { created: [], deleted: [], modified: [] };
	const allDiffs: string[] = [];
	const errors: string[] = [];
	// V4A bypasses write_file's WriteResult plumbing: LSP diagnostics and lint propagate per file.
	const lspBlocks: string[] = [];
	const lintResults: Record<string, Record<string, unknown>> = {};
	for (const op of operations) {
		const { handler, verb, bucket } = APPLY_DISPATCH[op.operation];
		let outcome: ApplyOutcome;
		try {
			outcome = handler(op, fileOps);
		} catch (e) {
			outcome = { ok: false, threw: true, payload: e instanceof Error ? e.message : String(e) };
		}
		if (!outcome.ok) {
			errors.push(`${outcome.threw ? "Error processing" : `Failed to ${verb}`} ${op.filePath}: ${outcome.payload}`);
			continue;
		}
		// Each LSP block carries its own <diagnostics file="..."> header; joining keeps attribution.
		files[bucket].push(op.operation === "move" ? `${op.filePath} -> ${op.newPath}` : op.filePath);
		allDiffs.push(outcome.payload);
		if (outcome.lsp) lspBlocks.push(outcome.lsp);
		if (outcome.lint) lintResults[op.filePath] = outcome.lint;
	}
	return {
		success: errors.length === 0,
		error:
			errors.length > 0
				? "Apply phase failed (state may be inconsistent — run `git diff` to assess):\n" + bullets(errors)
				: null,
		diff: allDiffs.join("\n"),
		filesModified: files.modified,
		filesCreated: files.created,
		filesDeleted: files.deleted,
		lint: Object.keys(lintResults).length > 0 ? lintResults : null,
		lspDiagnostics: lspBlocks.length > 0 ? lspBlocks.join("\n\n") : null,
	};
}

/** hermes `FileOperations.patch_v4a` (file_operations.py:1645): parse, then
 * apply — the entry point the tool handler calls once Tier 3 #9/#10 wire it. */
export function applyV4APatch(patchContent: string, fileOps: V4AFileOps): PatchResult {
	const { operations, error } = parseV4APatch(patchContent);
	if (error) {
		return {
			success: false,
			diff: "",
			filesModified: [],
			filesCreated: [],
			filesDeleted: [],
			lint: null,
			lspDiagnostics: null,
			error: `Failed to parse patch: ${error}`,
		};
	}
	return applyV4AOperations(operations, fileOps);
}
