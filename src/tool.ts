/**
 * The `patch` tool definition — an exact port of hermes' `patch` tool
 * (docs/EDIT-TOOL-ANALYSIS.md). The argument surface is transitional: pi's
 * multi-edit `edits[]` schema (all-or-nothing, overlap detection, LF
 * pre-normalization + BOM/CRLF handling, mutation queue, argument
 * normalization, constrained sampling) until the reschema to hermes'
 * single-replacement surface (`old_string`/`new_string`/`replace_all`,
 * PLAN.md Tier 2 #5) and the V4A `mode:"patch"` mode (Tier 3) land.
 * The matching core already follows hermes: strategy chain + teaching
 * errors. Registered under a separate name so it runs alongside `edit`,
 * never instead of it (deviations ledger #1).
 */
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { Type } from "typebox";
import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	buildLineIndex,
	detectLineEnding,
	lineAt,
	normalizeToLF,
	restoreLineEndings,
	splitBom,
	type LineIndex,
} from "./text.js";
import { runChain, type ChainFailure, type ChainMatch, type MatchLocation } from "./chain.js";
import type { Span } from "./span-map.js";
import { reindentReplacement } from "./shaping.js";
import { generateDiffString, generateUnifiedPatch } from "./diff-utils.js";
import {
	alreadyAppliedMessage,
	ambiguityErrorMessage,
	emptyOldTextError,
	escapeDriftErrorMessage,
	identicalTextsError,
	noMatchErrorMessage,
	overlapErrorMessage,
	replaceAllRefusalMessage,
} from "./errors.js";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Text to find in the file. Must be unique in the original file and must not overlap with any other edits[].oldText in the same call. Matching tolerates minor whitespace, indentation, and margin differences, but copy the text from the current file content as closely as you can.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
	replaceAll: Type.Optional(
		Type.Boolean({
			description:
				"Replace every non-overlapping occurrence of oldText instead of requiring a unique match. Only use when every occurrence should change. Refused when the match is only approximate (similarity strategies) — provide the precise text (whitespace included) instead.",
		}),
	),
}, {});

const patchSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
}, {});

export type PatchToolInput = {
	path: string;
	edits: { oldText: string; newText: string; replaceAll?: boolean }[];
};

export interface PatchToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/** Non-blank length threshold for the already-applied no-op guard (conservative by design — see docs/PLAN.md status snapshot). */
const ALREADY_APPLIED_MIN_CHARS = 8;

export const patchToolSystemPromptContribution = {
	snippet: "Make precise file edits with whitespace-tolerant text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use patch for precise changes; oldText is matched with whitespace/indentation tolerance and must be unique in the file",
		"When changing multiple separate locations in one file, use one patch call with multiple entries in edits[] instead of multiple patch calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		"Set replaceAll on an edit only when every occurrence of oldText should change; approximate (similarity) matches refuse replaceAll — provide the precise text (whitespace included) instead.",
		"If a patch fails, the error lists the closest matching sections — fix oldText from those sections instead of re-reading the whole file or retrying unchanged",
	],
};

interface Edit {
	oldText: string;
	newText: string;
	/** hermes replace_all: replace every occurrence of oldText (Tier 1 #2) */
	replaceAll?: boolean;
}

function isSingleEditInput(value: unknown): value is Edit {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** hermes' schema spells it `replace_all`; models also send booleans as strings.
 * Accept both spellings and both value encodings (pi-style coercion, ledger #8). */
function coerceReplaceAll(value: unknown): boolean | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

/** Normalize the per-edit flag: hermes' snake_case `replace_all` → `replaceAll`,
 * string booleans → booleans. Unrecognized values pass through untouched so
 * schema validation reports them loudly. */
function normalizeEditEntries(edits: unknown): unknown {
	if (!Array.isArray(edits)) return edits;
	return edits.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
		const e = entry as Record<string, unknown>;
		const coerced = coerceReplaceAll(e.replaceAll ?? e.replace_all);
		if (coerced === undefined && !("replace_all" in e)) return entry;
		const { replace_all: _legacy, ...rest } = e;
		return coerced === undefined ? rest : { ...rest, replaceAll: coerced };
	});
}

/**
 * Same argument normalization as pi's built-in edit tool: some models send
 * edits as a JSON string, a single edit object, or legacy flat oldText/newText.
 */
export function prepareEditArguments(input: unknown): PatchToolInput {
	if (!input || typeof input !== "object") return input as PatchToolInput;
	const args = { ...(input as Record<string, unknown>) };
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {
			// Leave as-is; validation will report it.
		}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		const edits = Array.isArray(args.edits) ? [...(args.edits as unknown[])] : [];
		// Legacy flat surface: a call-level flag rides along (hermes' own schema
		// is flat — one replacement per call, replace_all next to the strings).
		const flatAll = coerceReplaceAll(args.replaceAll ?? args.replace_all);
		edits.push(
			flatAll === undefined
				? { oldText: args.oldText, newText: args.newText }
				: { oldText: args.oldText, newText: args.newText, replaceAll: flatAll },
		);
		delete args.oldText;
		delete args.newText;
		delete args.replaceAll;
		delete args.replace_all;
		args.edits = edits;
	}
	args.edits = normalizeEditEntries(args.edits);
	return args as unknown as PatchToolInput;
}

function resolveToCwd(filePath: string, cwd: string): string {
	if (filePath.startsWith("~")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		if (home) return nodePath.resolve(home, filePath.slice(1));
	}
	return nodePath.isAbsolute(filePath) ? nodePath.normalize(filePath) : nodePath.resolve(cwd, filePath);
}

function validateEdits(edits: Edit[]): void {
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
			throw new Error(`Edit #${i + 1} is invalid. edits[] entries need string oldText and newText.`);
		}
		if (edit.oldText.trim().length === 0) {
			throw new Error(emptyOldTextError(i + 1));
		}
		if (edit.oldText === edit.newText) {
			throw new Error(identicalTextsError(i + 1));
		}
	}
}

function looksAlreadyApplied(edit: Edit, content: string): boolean {
	const nonBlank = edit.newText.replace(/\s/g, "");
	if (nonBlank.length < ALREADY_APPLIED_MIN_CHARS) return false;
	return content.includes(edit.newText) && !content.includes(edit.oldText);
}

function spanLines(index: LineIndex, start: number, end: number): { startLine: number; endLine: number } {
	return { startLine: lineAt(index, start), endLine: lineAt(index, Math.max(start, end - 1)) };
}

interface AppliedPatch {
	newContent: string;
	/** Total matched spans spliced (replaceAll occurrences included) */
	replacements: number;
}

/**
 * Pure core shared by execute() and the TUI preview: validate, match every
 * edit against the same snapshot via the chain, check overlaps, splice with
 * replacement shaping. Returns the teaching error message on any failure.
 */
function applyPatchEdits(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): { ok: true; result: AppliedPatch } | { ok: false; errorMessage: string } {
	validateEdits(edits);
	const index = buildLineIndex(normalizedContent);

	const matches: (ChainMatch | null)[] = new Array(edits.length).fill(null);
	const failures: { index: number; failure: ChainFailure }[] = [];
	for (let i = 0; i < edits.length; i++) {
		const result = runChain(normalizedContent, edits[i].oldText, {
			replaceAll: edits[i].replaceAll === true,
			// Arms the escape-drift guards on non-exact matches (Tier 1 #3)
			newText: edits[i].newText,
		});
		if (result.ok) {
			matches[i] = result.match;
		} else {
			failures.push({ index: i, failure: result.failure });
		}
	}

	if (failures.length > 0) {
		const ambiguous = failures.find((f) => f.failure.kind === "ambiguous");
		const drifted = failures.find((f) => f.failure.kind === "escape_drift");
		const appliedIndexes: number[] = [];
		const missedIndexes: number[] = [];
		for (const f of failures) {
			if (f.failure.kind === "no_match" && looksAlreadyApplied(edits[f.index], normalizedContent)) {
				appliedIndexes.push(f.index + 1);
			} else if (f.failure.kind === "no_match") {
				missedIndexes.push(f.index);
			}
		}
		// Whole call already applied → success-shaped no-op (kills the #1 loop).
		if (!ambiguous && missedIndexes.length === 0 && appliedIndexes.length === edits.length) {
			return { ok: false, errorMessage: `__ALREADY_APPLIED__${alreadyAppliedMessage(path, appliedIndexes)}` };
		}
		const refusal = failures.find((f) => f.failure.kind === "replace_all_similarity");
		let msg: string;
		if (ambiguous) {
			const failure = ambiguous.failure as Extract<ChainFailure, { kind: "ambiguous" }>;
			msg = ambiguityErrorMessage(
				path,
				ambiguous.index + 1,
				failure.strategy,
				failure.count,
				failure.locations as MatchLocation[],
			);
		} else if (drifted) {
			// Drift is an intentional block (hermes: no match hint on top of it)
			const failure = drifted.failure as Extract<ChainFailure, { kind: "escape_drift" }>;
			msg = escapeDriftErrorMessage(path, drifted.index + 1, failure.drift);
		} else if (refusal) {
			const failure = refusal.failure as Extract<ChainFailure, { kind: "replace_all_similarity" }>;
			msg = replaceAllRefusalMessage(path, refusal.index + 1, failure.strategy, failure.count);
		} else {
			const first = missedIndexes[0];
			msg = noMatchErrorMessage(path, first + 1, normalizedContent, edits[first].oldText);
		}
		const others = failures.length - 1;
		if (others > 0) {
			// Failed to match OR was refused by a drift guard — either way it
			// did not apply.
			msg += `\n\n${others} other edit(s) in this call also failed to apply; nothing was written.`;
		}
		if (appliedIndexes.length > 0 && (ambiguous || missedIndexes.length > 0)) {
			msg += `\n\nNote: edit ${appliedIndexes.map((i) => `#${i}`).join(", ")} appear${appliedIndexes.length === 1 ? "s" : ""} to be already applied — drop it from the call and re-send the rest.`;
		}
		return { ok: false, errorMessage: msg };
	}

	// Flatten every edit's matched spans — one per edit, or every occurrence of
	// a replaceAll edit — matched against the same original content,
	// all-or-nothing (pi semantics). Spans within one edit never overlap: the
	// chain enforces str.replace's leftmost-greedy invariant (ledger #12).
	const spans: { span: Span; editIndex: number; exact: boolean }[] = [];
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		if (!m) continue;
		for (const span of m.spans) spans.push({ span, editIndex: i, exact: m.exact });
	}
	const ordered = [...spans].sort((a, b) => a.span.start - b.span.start);
	for (let k = 1; k < ordered.length; k++) {
		const prev = ordered[k - 1];
		const cur = ordered[k];
		if (cur.span.start < prev.span.end) {
			const a = { index: prev.editIndex + 1, ...spanLines(index, prev.span.start, prev.span.end) };
			const b = { index: cur.editIndex + 1, ...spanLines(index, cur.span.start, cur.span.end) };
			return { ok: false, errorMessage: overlapErrorMessage(path, a, b) };
		}
	}

	// Splice in reverse order; shape non-exact replacements onto EACH region's
	// indent — occurrences of one replaceAll edit can sit at different depths.
	const replacements = ordered
		.slice()
		.reverse()
		.map(({ span, editIndex, exact }) => {
			const edit = edits[editIndex];
			const matchedText = normalizedContent.slice(span.start, span.end);
			const newText = exact
				? edit.newText
				: reindentReplacement(edit.oldText, edit.newText, matchedText);
			return { start: span.start, end: span.end, newText };
		});
	let newContent = normalizedContent;
	for (const r of replacements) {
		newContent = newContent.slice(0, r.start) + r.newText + newContent.slice(r.end);
	}
	return { ok: true, result: { newContent, replacements: replacements.length } };
}

const defaultEditOperations = {
	readFile: (path: string) => fsReadFile(path),
	writeFile: (path: string, content: string) => fsWriteFile(path, content, "utf-8"),
	access: (path: string) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export function createPatchToolDefinition(cwd: string): ToolDefinition<typeof patchSchema, PatchToolDetails | undefined> {
	const ops = defaultEditOperations;
	return {
		name: "patch",
		label: "patch",
		description:
			"Edit a single file by replacing a unique region of text. Matching tolerates minor whitespace, indentation, and escape drift, so small differences between oldText and the file will not break the edit — but always copy oldText from the current file content as closely as you can. Every edits[].oldText must match a unique, non-overlapping region; set replaceAll on an edit to replace every occurrence of oldText instead (refused when the match is only approximate). If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Failed matches return the closest matching sections so you can correct oldText without re-reading blindly.",
		promptSnippet: patchToolSystemPromptContribution.snippet,
		promptGuidelines: [...patchToolSystemPromptContribution.guidelines],
		parameters: patchSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const { path, edits } = input as PatchToolInput;
			if (!Array.isArray(edits) || edits.length === 0) {
				throw new Error("Patch tool input is invalid. edits must contain at least one replacement.");
			}
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			return withFileMutationQueue(absolutePath, async () => {
				const throwIfAborted = () => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();
				try {
					await ops.access(absolutePath);
				} catch (error) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${(error as { code: string }).code}` : String(error);
					throw new Error(`Could not patch file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM and pre-normalize to LF before matching (pi's stronger
				// approach — every strategy works on CRLF files; endings restored on write).
				const { bom, text: content } = splitBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);

				const applied = applyPatchEdits(normalizedContent, edits as Edit[], path);
				if (!applied.ok) {
					const message = applied.errorMessage;
					if (message.startsWith("__ALREADY_APPLIED__")) {
						// Success-shaped no-op: do not write, do not error.
						return {
							content: [{ type: "text", text: message.slice("__ALREADY_APPLIED__".length) }],
							details: undefined,
						};
					}
					throw new Error(message);
				}
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(applied.result.newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(normalizedContent, applied.result.newContent);
				const patch = generateUnifiedPatch(path, normalizedContent, applied.result.newContent);
				return {
					content: [
						{
							type: "text",
							// Model-facing diff (analysis §4: pi's diff never reaches the
							// model — a free self-check loop for weak models).
							text: `Successfully replaced ${applied.result.replacements} block(s) in ${path}.\n\n${patch}`,
						},
					],
					details: {
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
					},
				};
			});
		},
	};
}

/**
 * Compute the diff a patch would produce without applying it.
 * Used for preview rendering in the TUI; runs the same chain as execute().
 */
export async function computePatchDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<{ diff: string; firstChangedLine?: number } | { error: string }> {
	try {
		if (!Array.isArray(edits) || edits.length === 0) {
			return { error: "edits must contain at least one replacement." };
		}
		const absolutePath = resolveToCwd(path, cwd);
		const raw = await fsReadFile(absolutePath, "utf-8");
		const { text: content } = splitBom(raw);
		const normalizedContent = normalizeToLF(content);
		const applied = applyPatchEdits(normalizedContent, edits, path);
		if (!applied.ok) {
			const message = applied.errorMessage;
			return {
				error: message.startsWith("__ALREADY_APPLIED__")
					? message.slice("__ALREADY_APPLIED__".length)
					: message,
			};
		}
		const diffResult = generateDiffString(normalizedContent, applied.result.newContent);
		return { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
