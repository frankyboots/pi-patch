/**
 * The `patch` tool definition — an exact port of hermes' `patch` tool
 * (docs/EDIT-TOOL-ANALYSIS.md §2, §2.1, §6 item 1). Dual-mode like hermes:
 * `replace` (default) is the single-replacement surface — `path` +
 * `old_string` + `new_string` + `replace_all`, one replacement per call — and
 * `mode: "patch"` applies V4A multi-file patches through the tool-layer
 * plumbing in `v4a-fs.ts`. The base advertised schema is replace-only
 * (hermes' `PATCH_SCHEMA`); the V4A layer (`mode` + `patch` params,
 * dual-mode description) is layered on only when the OpenAI-family gate
 * passes (`gate.ts`, Tier 3 #9, ledger #9) — the HANDLER accepts both shapes
 * from any model regardless, mode defaulting to `replace` (replay compat).
 * The V4A *prompt steering* is a separate mechanism (hermes'
 * `_EDIT_FORMAT_GUIDANCE`, `edit-guidance.ts`): a model-id needle table keys a
 * one-line guideline INDEPENDENT of the schema gate, so known off-family coder
 * models are still taught V4A for multi-file work (ledger #17).
 * The matching core is hermes' too: the 9-strategy chain, the escape-drift
 * guards, the orchestrator tail (conditional `\t`/`\r` unescape,
 * unicode-preserving opcodes, reindent, splice), the teaching errors, and the
 * session-scoped failure-escalation tracker that turns repeated misses on one
 * file into a "stop retrying" hint (Tier 2 #6; replace mode only — V4A misses
 * bypass the tracker, hermes file_tools.py:1022).
 *
 * Before an edit lands, hermes' `_edit_warnings` staleness gate runs over every
 * path the call touches (`staleness.ts`, Tier 4 #12): when the file's version
 * changed since the session last read it, hermes' "Warning: … modified since you
 * last read it …" text rides the result — warn-only, exactly like hermes' `patch`
 * (only its `write_file` refuses) — and the write still proceeds.
 *
 * Kept from pi (deviations ledger #2/#3/#7/#8): LF pre-normalization with
 * BOM/CRLF restoration, `withFileMutationQueue`, constrained sampling, and the
 * argument-normalization shim that stands in for hermes' `schema_sanitizer.py`.
 * Registered under a separate name so it runs alongside `edit`, never instead
 * of it (ledger #1).
 */
import { constants, readFileSync } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { Type } from "typebox";
import { withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { detectLineEnding, normalizeToLF, restoreLineEndings, splitBom } from "./text.js";
import { recordPatchFailure, resetPatchFailures } from "./failure-tracker.js";
import { noteWrite, stalenessWarnings } from "./staleness.js";
import { editFormatGuideline } from "./edit-guidance.js";
import { fuzzyFindAndReplace, isAlreadyApplied, type StrategyName } from "./chain.js";
import { generateDiffString, generateUnifiedPatch } from "./diff-utils.js";
import { applyV4APatch, parseV4APatch } from "./v4a.js";
import { verifyPatchPersisted, verifyWrittenHash } from "./verify.js";
import { collectV4AHeaderPaths, createHostV4AFileOps, rewriteV4APatchPathsForHost, withSortedMutationQueue } from "./v4a-fs.js";
import {
	alreadyAppliedMessage,
	failureEscalationHint,
	formatNoMatchHint,
	genericNoMatchHint,
	missingPathError,
	missingReplacementError,
	multiEditRefusalError,
	patchContentRequiredError,
	unknownModeError,
} from "./errors.js";

/**
 * hermes `PATCH_SCHEMA` (base, replace-only). The V4A layer (`mode` + `patch`
 * params, dual-mode description) is layered on by
 * `createPatchToolDefinition(cwd, { advertiseV4A: true })` behind the
 * OpenAI-family gate; the handler still *accepts* those params from any model,
 * the schema just doesn't advertise them off-family — exactly hermes'
 * posture. `replace_all` carries no `default` keyword: pi's
 * constrained-sampling JSON schema is stricter than hermes' free-form dict, and
 * the description states the default instead.
 */
const patchSchema = Type.Object(
	{
		path: Type.String({ description: "File path to edit." }),
		old_string: Type.String({
			description:
				"Exact text to find and replace. Must be unique in the file unless replace_all=true. Include surrounding context lines to ensure uniqueness.",
		}),
		new_string: Type.String({
			description: "Changed replacement text; it must differ from old_string. Pass empty string '' to delete the matched text.",
		}),
		replace_all: Type.Optional(
			Type.Boolean({
				description: "Replace all occurrences instead of requiring a unique match (default: false)",
			}),
		),
	},
	{},
);

/** hermes `_PATCH_V4A_PARAMS["mode"]` — enum + description verbatim; no
 * `default` keyword (same constrained-sampling rationale as replace_all), and
 * the handler defaults an omitted mode to `replace` like hermes. */
const v4aModeParam = Type.Union([Type.Literal("replace"), Type.Literal("patch")], {
	description:
		"Edit mode. 'replace' (default): requires path + old_string + new_string. 'patch': requires patch content only.",
});

/** hermes `_PATCH_V4A_PARAMS["patch"]` — description verbatim. */
const v4aPatchParam = Type.Optional(
	Type.String({
		description:
			"REQUIRED when mode='patch'. V4A format patch content. Format:\n*** Begin Patch\n*** Update File: path/to/file\n@@ context hint @@\n context line\n-removed line\n+added line\n*** End Patch",
	}),
);

/** hermes `_patch_schema_overrides` composed parameters: `mode` first, base
 * properties next (all optional — the replace gates stay handler-side),
 * `patch` last; `mode` is the only required param (hermes' layered
 * `required` list). Descriptions repeat the base schema's verbatim because
 * `Type.Optional` mutates its argument (a shared instance would leak
 * optionality into the base schema). */
const patchSchemaV4A = Type.Object(
	{
		mode: v4aModeParam,
		path: Type.Optional(Type.String({ description: "File path to edit." })),
		old_string: Type.Optional(
			Type.String({
				description:
					"Exact text to find and replace. Must be unique in the file unless replace_all=true. Include surrounding context lines to ensure uniqueness.",
			}),
		),
		new_string: Type.Optional(
			Type.String({
				description: "Changed replacement text; it must differ from old_string. Pass empty string '' to delete the matched text.",
			}),
		),
		replace_all: Type.Optional(
			Type.Boolean({
				description: "Replace all occurrences instead of requiring a unique match (default: false)",
			}),
		),
		patch: v4aPatchParam,
	},
	{},
);

export type PatchToolInput = {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
	/** hermes' dual-mode params — accepted from any model, even when the
	 * advertised schema omits them (replay compat, Tier 3 #9). */
	mode?: unknown;
	patch?: unknown;
	/** Retired transitional surface — kept in the type only so the handler can
	 * recognize and refuse it (see `multiEditRefusalError`). */
	edits?: unknown;
};

/** One validated replacement, in the tool's internal naming (the chain and the
 * shaping helpers take `oldText`/`newText` positionally). */
export interface Replacement {
	oldString: string;
	newString: string;
	replaceAll: boolean;
}

export interface PatchToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

export const patchToolSystemPromptContribution = {
	snippet: "Find a unique region of text in one file and replace it, with fuzzy (9-strategy) matching",
	guidelines: [
		"Use patch for precise changes instead of sed/awk: old_string must be unique in the file, matching is whitespace/indentation tolerant",
		"patch applies exactly one replacement per call (path + old_string + new_string); send one call per change",
		"Copy old_string from the current file content; pass new_string as the changed text, or '' to delete the matched text",
		"Set replace_all only when every occurrence should change; approximate (similarity) matches refuse replace_all — provide the precise text (whitespace included) instead",
		"Keep old_string as small as possible while still unique. Do not pad with large unchanged regions.",
		"If a patch fails, the error lists the closest matching sections — fix old_string from those sections instead of re-reading the whole file or retrying unchanged",
	],
};

function coerceBoolean(value: unknown): boolean | undefined {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

/** hermes' schema spells the params `old_string`/`new_string`/`replace_all`;
 * models trained on pi's `edit` spell them `oldText`/`newText`/`replaceAll`
 * (or camelCase, or send `edits[]`). Accept the drift, never invent a
 * replacement: unrecognizable shapes are left for the handler to refuse. */
const OLD_STRING_KEYS = ["old_string", "oldString", "old_text", "oldText"] as const;
const NEW_STRING_KEYS = ["new_string", "newString", "new_text", "newText"] as const;
const PATH_KEYS = ["path", "file_path", "filePath"] as const;

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** `edits` as sent by a model: a real array, a JSON string, or a lone object. */
function parseEdits(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed;
			if (parsed && typeof parsed === "object") return [parsed];
		} catch {
			// Leave as-is; the handler reports it.
		}
		return undefined;
	}
	if (value && typeof value === "object") return [value];
	return undefined;
}

/** Coerce one flat record of replacement params to hermes' own spelling. */
function normalizeReplacementKeys(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	const path = pickString(out, PATH_KEYS);
	const oldString = pickString(out, OLD_STRING_KEYS);
	const newString = pickString(out, NEW_STRING_KEYS);
	for (const key of [...PATH_KEYS, ...OLD_STRING_KEYS, ...NEW_STRING_KEYS]) delete out[key];
	if (path !== undefined) out.path = path;
	if (oldString !== undefined) out.old_string = oldString;
	if (newString !== undefined) out.new_string = newString;

	const replaceAll = coerceBoolean(out.replace_all ?? out.replaceAll);
	delete out.replaceAll;
	if (replaceAll !== undefined) out.replace_all = replaceAll;
	else delete out.replace_all; // junk value: treat as "not set" (mass overwrite needs an explicit true)

	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Argument normalization — pi's analog of hermes' `schema_sanitizer.py`
 * coercion layer (ledger #8). Maps param-name drift onto hermes' flat schema,
 * flattens a **single** `edits[]` entry, and leaves anything ambiguous (several
 * `edits[]` entries) intact for `validateCall` to refuse rather than silently
 * applying one of the requested replacements.
 */
export function preparePatchArguments(input: unknown): PatchToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as PatchToolInput;
	const raw: Record<string, unknown> = { ...(input as Record<string, unknown>) };
	const edits = raw.edits === undefined ? undefined : parseEdits(raw.edits);
	// A single edits[] entry (models trained on pi's `edit`) is the same call in
	// a different shape: merge it up. Multi-entry arrays stay put so the handler
	// can refuse instead of guessing which replacement was meant; unparseable
	// junk is dropped so the ordinary missing-param error wins.
	const single = edits?.length === 1 && isRecord(edits[0]) ? edits[0] : undefined;
	const args = normalizeReplacementKeys(single ? { ...raw, ...single } : raw);
	if (single) delete args.edits;
	else if (raw.edits !== undefined && !edits) delete args.edits;
	return args as unknown as PatchToolInput;
}

/** A call that passed the hermes handler gates, ready to dispatch. */
export type ValidatedCall =
	| { mode: "replace"; path: string; replacement: Replacement }
	| { mode: "patch"; patch: string };

/** hermes' mode/arg gates (`patch_tool`'s if/elif chain), in hermes' order:
 * the mode dispatch is exclusive, so an unknown `mode` answers before the
 * replace-mode gates, and replace mode ignores a stray `patch` param. A model
 * that dropped `mode` but sent V4A-looking content defaults to replace mode
 * like hermes — the V4A path is entered by `mode: "patch"`, never by guessing
 * from a stray param. */
function validateCall(input: PatchToolInput): ValidatedCall {
	const mode = typeof input.mode === "string" ? input.mode : undefined;
	if (mode !== undefined && mode !== "replace" && mode !== "patch") throw new Error(unknownModeError(mode));

	if (mode === "patch") {
		// hermes: `if not patch: return tool_error("patch content required")`.
		// The traversal gate and application then live in the execute path,
		// after header collection and before any lock is taken.
		if (typeof input.patch !== "string" || input.patch.length === 0) throw new Error(patchContentRequiredError());
		return { mode: "patch", patch: input.patch };
	}

	const edits = parseEdits(input.edits);
	if (edits && edits.length > 0) throw new Error(multiEditRefusalError(edits.length));

	if (typeof input.path !== "string" || input.path.length === 0) throw new Error(missingPathError());
	if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
		throw new Error(missingReplacementError());
	}
	return {
		mode: "replace",
		path: input.path,
		replacement: {
			oldString: input.old_string,
			newString: input.new_string,
			// Conservative by design: only an explicit true (or "true", coerced
			// upstream) may fan a replacement out over the whole file.
			replaceAll: input.replace_all === true,
		},
	};
}

export function resolveToCwd(filePath: string, cwd: string): string {
	if (filePath.startsWith("~")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		if (home) return nodePath.join(home, filePath.slice(1));
	}
	return nodePath.isAbsolute(filePath) ? nodePath.normalize(filePath) : nodePath.resolve(cwd, filePath);
}

export type ReplacementOutcome =
	| { ok: true; newContent: string; replacements: number; strategy: StrategyName }
	/** `alreadyApplied` results are success-shaped: no write, no error. */
	| { ok: false; alreadyApplied?: boolean; errorMessage: string };

/**
 * hermes `file_tool`'s no-match escalation (file_tools.py:1025-1042), layered
 * onto a failed replace call. Only plain no-match errors participate — the
 * "Could not find" substring gate keeps ambiguity, escape-drift and
 * replace_all refusals out (they explain themselves; hermes counts the same
 * set). Recording is replace-mode-only by construction: V4A calls dispatch
 * around this entirely (hermes counts replace misses only — "V4A misses
 * are rare", file_tools.py:1022). Failure #3 and beyond escalates
 * to the "stop retrying" hint; below the threshold a generic `_hint` attaches
 * whenever the error carries no richer "Did you mean" snippet. Per ledger #6
 * the hint rides inside the message text (pi results have no JSON envelope).
 *
 * `trackerKey` is the RESOLVED path (hermes records per resolved path) while
 * `displayPath` stays the model's own spelling (hermes echoes the raw arg).
 */
function attachNoMatchEscalation(errorMessage: string, trackerKey: string, displayPath: string): string {
	if (!errorMessage.includes("Could not find")) return errorMessage;
	const failureCount = recordPatchFailure(trackerKey);
	if (failureCount >= 3) return `${errorMessage}\n\n${failureEscalationHint(failureCount, displayPath)}`;
	if (!errorMessage.includes("Did you mean one of these sections?")) {
		return `${errorMessage}\n\n${genericNoMatchHint()}`;
	}
	return errorMessage;
}

/**
 * hermes attaches the pre-edit staleness warnings as a `_warning` field on the
 * result dict — error or success, both carry it. pi results have no JSON
 * envelope (deviations ledger #6), so the texts append to the message, joined
 * exactly like hermes' `" | ".join(stale_warnings)`.
 */
function appendStalenessWarning(message: string, warnings: readonly string[]): string {
	return warnings.length === 0 ? message : `${message}\n\n${warnings.join(" | ")}`;
}

/**
 * Pure core shared by execute() and the TUI preview: validate, run the chain,
 * then shape and splice — hermes' `fuzzy_find_and_replace` and its
 * orchestrator tail in one pass over LF-normalized content. Error shaping
 * follows hermes `patch_replace`/`_no_match_result`: the already-applied
 * no-op gates EVERY orchestrator error (the single most common production
 * failure is a re-send of an edit that already landed), then the "did you
 * mean" hint attaches to plain no-match errors only (`formatNoMatchHint`'s
 * own gate).
 */
export function applyReplacement(
	content: string,
	replacement: Replacement,
	path: string,
): ReplacementOutcome {
	const { oldString, newString, replaceAll } = replacement;
	const { newContent, count, strategy, error } = fuzzyFindAndReplace(content, oldString, newString, replaceAll);
	if (error) {
		if (isAlreadyApplied(content, oldString, newString)) {
			return { ok: false, alreadyApplied: true, errorMessage: alreadyAppliedMessage(path) };
		}
		return { ok: false, errorMessage: error + formatNoMatchHint(error, 0, oldString, content) };
	}
	return { ok: true, newContent, replacements: count, strategy: strategy as StrategyName };
}

const defaultEditOperations = {
	readFile: (path: string) => fsReadFile(path),
	writeFile: (path: string, content: string) => fsWriteFile(path, content, "utf-8"),
	access: (path: string) => fsAccess(path, constants.R_OK | constants.W_OK),
	/** Exact-byte re-read for post-write verification (Tier 4 #11). */
	readExact: (path: string) => readFileSync(path),
};

/** Host file-operation seam — the analog of hermes' mockable shell transport:
 * tests inject lying/failing operations to exercise the post-write
 * persistence gates without corrupting a real filesystem. */
export type EditOperations = Partial<typeof defaultEditOperations>;

/** hermes `PATCH_SCHEMA["description"]` verbatim — EXCEPT the "Auto-runs
 * syntax checks after editing." clause, dropped rather than kept (deviations
 * ledger #13): pi exposes no lint harness, so promising it would teach the
 * model to wait for diagnostics that never arrive. */
const patchDescriptionBase =
	"Targeted find-and-replace edits in files. Use this instead of sed/awk in terminal. " +
	"Uses fuzzy matching (9 strategies) so minor whitespace/indentation differences won't break it. " +
	"Returns a unified diff. Finds a unique string and replaces it.";

/** hermes `_PATCH_V4A_DESCRIPTION` verbatim, modulo the same syntax-check
 * clause removal (ledger #13 covers both variants; hermes' override text
 * carries the clause, ours must not). */
const patchDescriptionV4A =
	"Targeted find-and-replace edits in files. Use this instead of sed/awk in terminal. " +
	"Uses fuzzy matching (9 strategies) so minor whitespace/indentation differences won't break it. " +
	"Returns a unified diff.\n\n" +
	"REPLACE MODE (mode='replace', default): find a unique string and replace it. " +
	"REQUIRED PARAMETERS: mode, path, old_string, new_string.\n" +
	"PATCH MODE (mode='patch'): apply V4A multi-file patches for bulk changes. " +
	"REQUIRED PARAMETERS: mode, patch.";

/** Our bespoke V4A guideline (format sketch included). Hermes has no analog:
 * its prompt steering (`edit-guidance.ts`) covers known families, and for
 * unknown families the schema override itself is the teaching surface. So
 * this line rides the V4A SCHEMA layer only when steering is absent (unknown
 * family); a steered family's guideline supersedes it (ledger #17). */
const v4aGuideline =
	'For bulk multi-file or multi-hunk edits use mode="patch" with a V4A patch (*** Begin Patch / *** Update File: <path> / @@ context / -removed +added lines / *** End Patch)';

/**
 * hermes `patch_tool`'s patch-mode body, in hermes' order: collect every path
 * named in patch HEADERS (patch content is more attacker-influenceable than
 * `path=`, and `..` traversal is vetoed before anything is resolved or
 * locked), resolve each against the session cwd, REWRITE the headers to the
 * resolved paths so the applier patches exactly the files being queued and
 * reported, then take pi's mutation queues in hermes' sorted, deduplicated
 * order (deadlock avoidance for overlapping concurrent patches).
 * V4A misses bypass the failure-escalation tracker entirely (hermes
 * file_tools.py "V4A misses are rare"): no counting, no generic hint, no
 * escalation — just the hermes error text. Success resets the per-path
 * counters and reports absolute files_modified (Delete/Move report the ENTRY
 * path, like hermes' `_paths_to_check`).
 */
async function executeV4ACall(patchArg: string, cwd: string, throwIfAborted: () => void) {
	const collected = collectV4AHeaderPaths(patchArg);
	if (typeof collected === "string") throw new Error(collected);
	const pathToResolved = new Map(collected.all.map((raw) => [raw, resolveToCwd(raw, cwd)]));
	const pathToEntry = new Map(collected.entry.map((raw) => [raw, resolveToCwd(raw, cwd)]));
	const hostPatch = rewriteV4APatchPathsForHost(patchArg, pathToResolved, pathToEntry);
	const lockedPaths = [...new Set([...pathToResolved.values(), ...pathToEntry.values()])].sort();
	throwIfAborted();
	return withSortedMutationQueue(lockedPaths, async () => {
		throwIfAborted();
		// hermes `_edit_warnings` runs INSIDE the path locks, before the edit, and
		// its `_warning` rides the result whether the patch lands or fails. Every
		// header path participates (hermes checks `_paths_to_check`, Delete and
		// Move endpoints included) and the texts join with hermes' `" | "`.
		const warnings = stalenessWarnings(collected.all.map((raw) => [raw, pathToResolved.get(raw) ?? raw] as const));
		const result = applyV4APatch(hostPatch, createHostV4AFileOps());
		throwIfAborted();
		if (result.error) throw new Error(appendStalenessWarning(result.error, warnings));
		resetPatchFailures([...pathToResolved.values()]);
		// hermes `_note_edited`: a successful write is an implicit read of the
		// current content, so the session's next edit of these files is not
		// stale. Paths that no longer exist (Delete, Move source) keep their
		// PREVIOUS stamp — hermes' `getmtime` fails there too, so nothing is
		// refreshed (and an unstattable path never warns anyway).
		for (const resolved of pathToResolved.values()) noteWrite(resolved);
		// hermes reads a V4A patch only up to the FIRST `*** End Patch`
		// (`parse_v4a_patch` breaks there — its own tests pin that later blocks are
		// parsed nowhere), while this payload reports hermes' `_paths_to_check`: every
		// path the HEADERS name. A patch mistakenly closed with one End Patch per file
		// therefore wrote one file and listed all of them, which is how silent
		// truncation reads as success. Keep hermes' payload and say what was skipped
		// (deviations ledger #21).
		const applied = new Set<string>();
		for (const op of parseV4APatch(hostPatch).operations) {
			applied.add(op.filePath);
			if (op.newPath) applied.add(op.newPath);
		}
		const skipped = [...new Set(collected.all.map((raw) => pathToResolved.get(raw) ?? raw))].filter(
			(resolved) => !applied.has(resolved),
		);
		const filesModified = collected.all.map((raw) => pathToEntry.get(raw) ?? pathToResolved.get(raw) ?? raw);
		const summary = ["Successfully applied V4A patch.", "", `files_modified: ${filesModified.join(", ")}`];
		if (result.filesCreated.length > 0) summary.push(`files_created: ${result.filesCreated.join(", ")}`);
		if (result.filesDeleted.length > 0) summary.push(`files_deleted: ${result.filesDeleted.join(", ")}`);
		if (skipped.length > 0) {
			summary.push(
				`note: ${skipped.length} header path${skipped.length === 1 ? " was" : "s were"} NOT touched — no ` +
					`operation in the parsed patch named ${skipped.join(", ")}. A V4A patch ends at the FIRST ` +
					`"*** End Patch"; put one at the very end of the patch (not one per file) and re-send the ` +
					`skipped blocks.`,
			);
		}
		if (filesModified.length === 1) summary.push(`resolved_path: ${filesModified[0]}`);
		return {
			content: [
				{ type: "text" as const, text: appendStalenessWarning(summary.join("\n"), warnings) },
				...(result.diff ? [{ type: "text" as const, text: result.diff }] : []),
			],
			details: { diff: result.diff, patch: result.diff } satisfies PatchToolDetails,
		};
	});
}

export function createPatchToolDefinition(
	cwd: string,
	options: { advertiseV4A?: boolean; modelId?: string; operations?: EditOperations } = {},
	// The advertised schema is one of two concrete TypeBox objects (hermes'
	// base `PATCH_SCHEMA` / the V4A-layered override); the union keeps the
	// renderers' argument types checkable for both. The handler re-normalizes
	// and gates every call regardless (`prepareArguments` + `validateCall`).
): ToolDefinition<typeof patchSchema | typeof patchSchemaV4A, PatchToolDetails | undefined> {
	const advertiseV4A = options.advertiseV4A === true;
	// Hermes steers the edit format from the prompt, keyed on model-id needles
	// and independent of the schema gate (ledger #17): the steering line names
	// `mode='patch'` even when the advertised schema omits the params, and it
	// supersedes our generic v4aGuideline when the family is known.
	const steering = editFormatGuideline(options.modelId);
	const ops = { ...defaultEditOperations, ...options.operations };
	return {
		name: "patch",
		label: "patch",
		description: advertiseV4A ? patchDescriptionV4A : patchDescriptionBase,
		promptSnippet: patchToolSystemPromptContribution.snippet,
		promptGuidelines: [
			...patchToolSystemPromptContribution.guidelines,
			...(steering ? [steering] : advertiseV4A ? [v4aGuideline] : []),
		],
		parameters: advertiseV4A ? patchSchemaV4A : patchSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		prepareArguments: preparePatchArguments,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			// Re-run the (idempotent) normalization: pi's harness calls
			// prepareArguments first, but SDK and preview callers may hand over raw
			// model arguments, and the gates must not be skippable.
			const call = validateCall(preparePatchArguments(input) as PatchToolInput);
			const throwIfAborted = () => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};
			throwIfAborted();
			if (call.mode === "patch") return executeV4ACall(call.patch, ctx?.cwd || cwd, throwIfAborted);
			const { path, replacement } = call;
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted();
				// hermes `_edit_warnings` runs INSIDE the path lock, before the edit,
				// and its `_warning` rides the result whether the patch lands or
				// fails (Tier 4 #12). Warn only — hermes' `patch` never blocks on
				// read-stamp drift; `patch` also never re-stamps on failure.
				const warnings = stalenessWarnings([[path, absolutePath]]);
				try {
					await ops.access(absolutePath);
				} catch (error) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${(error as { code: string }).code}` : String(error);
					throw new Error(appendStalenessWarning(`Could not patch file: ${path}. ${errorMessage}.`, warnings));
				}
				throwIfAborted();
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM and pre-normalize to LF before matching (pi's stronger
				// approach — every strategy works on CRLF files; endings restored on
				// write). hermes matches raw bytes and loses rungs 1/3/4/6 on CRLF.
				const { bom, text: content } = splitBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);

				const applied = applyReplacement(normalizedContent, replacement, path);
				if (!applied.ok) {
					if (applied.alreadyApplied) {
						// Success-shaped no-op: do not write, do not error — this is the
						// single biggest small-model loop-breaker (analysis §4). hermes
						// flows this result through its success branch, so it also
						// clears the consecutive-miss count (file_tools.py:1020).
						resetPatchFailures([absolutePath]);
						return {
							content: [{ type: "text", text: appendStalenessWarning(applied.errorMessage, warnings) }],
							details: undefined,
						};
					}
					throw new Error(
						appendStalenessWarning(attachNoMatchEscalation(applied.errorMessage, absolutePath, path), warnings),
					);
				}
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(applied.newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				// Post-write verification (Tier 4 #11), both hermes gates in
				// patch_replace's order and under the mutation queue: the sha256
				// gate that lives in hermes' write_file — whose failure
				// patch_replace wraps like every other write_file error — then
				// the full `_verify_patch_persisted` re-read. A verification
				// failure carries no "Could not find", so it never counts toward
				// the failure tracker (hermes counts it neither), and throwing
				// before the reset keeps the per-path miss streak intact.
				const hashError = verifyWrittenHash(absolutePath, Buffer.from(finalContent, "utf-8"), ops.readExact);
				if (hashError) throw new Error(appendStalenessWarning(`Failed to write changes: ${hashError}`, warnings));
				const persistError = verifyPatchPersisted(absolutePath, applied.newContent, ops.readExact);
				if (persistError) throw new Error(appendStalenessWarning(persistError, warnings));
				throwIfAborted();
				// Success resets the per-path consecutive-miss count so a future
				// miss starts a fresh count (hermes `_reset_patch_failures`), and
				// refreshes the read stamp (hermes `_note_edited`): our own write is
				// an implicit read of the current content, so the next edit here is
				// not "modified since you last read it".
				resetPatchFailures([absolutePath]);
				noteWrite(absolutePath);

				const diffResult = generateDiffString(normalizedContent, applied.newContent);
				const patch = generateUnifiedPatch(path, normalizedContent, applied.newContent);
				return {
					content: [
						{
							type: "text",
							// Model-facing diff (analysis §4: pi's diff never reaches the
							// model — a free self-check loop for weak models), plus
							// hermes' absolute-path reporting (`files_modified` +
							// `resolved_path` are in every patch_tool success payload).
							text: appendStalenessWarning(
								`Successfully replaced ${applied.replacements} block(s) in ${path}.\n\n` +
									`files_modified: ${absolutePath}\nresolved_path: ${absolutePath}\n\n${patch}`,
								warnings,
							),
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
 * Compute the diff a patch would produce without applying it — the TUI preview.
 * Runs the same chain and shaping as execute(), so the preview can never
 * diverge from what gets written.
 *
 * Outcomes mirror execute()'s settlement: a real diff, an `error` (a miss or
 * gate that execute() would throw on), or a `note` for the already-applied
 * no-op — which execute() settles SUCCESS-shaped, so the preview must not
 * report it as an error (docs/DOGFOOD.md: the header painted toolErrorBg on a
 * call that succeeded).
 */
export async function computePatchDiff(
	path: string,
	replacement: Replacement,
	cwd: string,
): Promise<{ diff: string; firstChangedLine?: number } | { note: string } | { error: string }> {
	try {
		const absolutePath = resolveToCwd(path, cwd);
		const raw = await fsReadFile(absolutePath, "utf-8");
		const { text: content } = splitBom(raw);
		const normalizedContent = normalizeToLF(content);
		const applied = applyReplacement(normalizedContent, replacement, path);
		if (!applied.ok) {
			// The already-applied guard is a success-shaped no-op in execute();
			// surface it as a note so the preview header paints as success too.
			if (applied.alreadyApplied) return { note: applied.errorMessage };
			return { error: applied.errorMessage };
		}
		const diffResult = generateDiffString(normalizedContent, applied.newContent);
		return { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
