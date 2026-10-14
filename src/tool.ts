/**
 * The `patch` tool definition: pi's edit-tool skeleton (multi-edit per call,
 * all-or-nothing, overlap detection, LF pre-normalization + BOM/CRLF handling,
 * mutation queue, argument normalization, constrained sampling) with the
 * hermes-style strategy chain and teaching errors wired into the matching
 * core. Registered under a separate name so it runs alongside `edit`, never
 * instead of it (analysis §8–9).
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
import { reindentReplacement } from "./shaping.js";
import { generateDiffString, generateUnifiedPatch } from "./diff-utils.js";
import {
	alreadyAppliedMessage,
	ambiguityErrorMessage,
	emptyOldTextError,
	identicalTextsError,
	noMatchErrorMessage,
	overlapErrorMessage,
} from "./errors.js";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Text to find in the file. Must be unique in the original file and must not overlap with any other edits[].oldText in the same call. Matching tolerates minor whitespace, indentation, and margin differences, but copy the text from the current file content as closely as you can.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
}, {});

const patchSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
}, {});

export type PatchToolInput = { path: string; edits: { oldText: string; newText: string }[] };

export interface PatchToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/** Non-blank length threshold for the already-applied no-op guard (analysis §9 Tier 1 #3). */
const ALREADY_APPLIED_MIN_CHARS = 8;

export const patchToolSystemPromptContribution = {
	snippet: "Make precise file edits with whitespace-tolerant text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use patch for precise changes; oldText is matched with whitespace/indentation tolerance and must be unique in the file",
		"When changing multiple separate locations in one file, use one patch call with multiple entries in edits[] instead of multiple patch calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
		"If a patch fails, the error lists the closest matching sections — fix oldText from those sections instead of re-reading the whole file or retrying unchanged",
	],
};

interface Edit {
	oldText: string;
	newText: string;
}

function isSingleEditInput(value: unknown): value is Edit {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
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
		edits.push({ oldText: args.oldText, newText: args.newText });
		delete args.oldText;
		delete args.newText;
		args.edits = edits;
	}
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
		const result = runChain(normalizedContent, edits[i].oldText);
		if (result.ok) {
			matches[i] = result.match;
		} else {
			failures.push({ index: i, failure: result.failure });
		}
	}

	if (failures.length > 0) {
		const ambiguous = failures.find((f) => f.failure.kind === "ambiguous");
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
		} else {
			const first = missedIndexes[0];
			msg = noMatchErrorMessage(path, first + 1, normalizedContent, edits[first].oldText);
		}
		const others = failures.length - 1;
		if (others > 0) {
			msg += `\n\n${others} other edit(s) in this call also failed to match; nothing was written.`;
		}
		if (appliedIndexes.length > 0 && (ambiguous || missedIndexes.length > 0)) {
			msg += `\n\nNote: edit ${appliedIndexes.map((i) => `#${i}`).join(", ")} appear${appliedIndexes.length === 1 ? "s" : ""} to be already applied — drop it from the call and re-send the rest.`;
		}
		return { ok: false, errorMessage: msg };
	}

	// Overlap detection across all matched spans (pi semantics: matched against
	// the same original content, all-or-nothing).
	const ordered = matches
		.map((m, i) => ({ m: m as ChainMatch, i }))
		.sort((a, b) => a.m.start - b.m.start);
	for (let k = 1; k < ordered.length; k++) {
		const prev = ordered[k - 1];
		const cur = ordered[k];
		if (cur.m.start < prev.m.end) {
			const a = { index: prev.i + 1, ...spanLines(index, prev.m.start, prev.m.end) };
			const b = { index: cur.i + 1, ...spanLines(index, cur.m.start, cur.m.end) };
			return { ok: false, errorMessage: overlapErrorMessage(path, a, b) };
		}
	}

	// Splice in reverse order; shape non-exact replacements onto the file's indent.
	const replacements = ordered
		.slice()
		.reverse()
		.map(({ m, i }) => {
			const matchedText = normalizedContent.slice(m.start, m.end);
			const newText = m.exact
				? edits[i].newText
				: reindentReplacement(edits[i].oldText, edits[i].newText, matchedText);
			return { start: m.start, end: m.end, newText };
		});
	let newContent = normalizedContent;
	for (const r of replacements) {
		newContent = newContent.slice(0, r.start) + r.newText + newContent.slice(r.end);
	}
	return { ok: true, result: { newContent } };
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
			"Edit a single file by replacing a unique region of text. Matching tolerates minor whitespace, indentation, and escape drift, so small differences between oldText and the file will not break the edit — but always copy oldText from the current file content as closely as you can. Every edits[].oldText must match a unique, non-overlapping region. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Failed matches return the closest matching sections so you can correct oldText without re-reading blindly.",
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
							text: `Successfully replaced ${edits.length} block(s) in ${path}.\n\n${patch}`,
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
