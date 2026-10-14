/**
 * Edit-format prompt steering — port of hermes' `_EDIT_FORMAT_GUIDANCE` and
 * `_model_family` (agent/coding_context.py), the SECOND, independent V4A
 * teaching mechanism. The schema gate (`gate.ts`) only decides what the
 * tool SCHEMA advertises; hermes separately injects a one-line edit-format
 * guideline into the coding prompt keyed on MODEL-ID SUBSTRINGS, not on the
 * gate: GPT/Codex are steered to V4A for ALL edits, the other known coder
 * families (claude/gemini/deepseek/qwen/…) get replace-first steering that
 * still EXPLICITLY names `mode='patch'` (V4A) for genuinely multi-file
 * edits, and unknown families get nothing (neutral). This is why off-family
 * hermes agents emit V4A all the time despite the replace-only schema: the
 * dialect rides their system prompt and the handler accepts it from any
 * model by design (deviations ledger #17).
 *
 * The needle lists are verbatim; the guideline texts are verbatim modulo
 * ledger #10's tool-name mapping (`write_file` → `write`) and the leading
 * prompt bullet (pi renders guidelines as list items itself).
 */
import type { ModelIdentity } from "./gate.js";

/** hermes' edit-format families; iteration order is the lookup order
 * (hermes' dict: "patch" needles win before "replace" needles). */
export type EditFormatFamily = "patch" | "replace";

/** hermes `_EDIT_FORMAT_GUIDANCE`, verbatim needles, ledger-#10-mapped texts. */
const EDIT_FORMAT_GUIDANCE: Record<EditFormatFamily, { needles: readonly string[]; guideline: string }> = {
	patch: {
		needles: ["gpt", "codex"],
		guideline:
			"Edit format: author new files with `write`; for edits to existing code use `patch` with " +
			"mode='patch' (V4A diff) — including single-file edits. It's the edit format you handle most reliably.",
	},
	replace: {
		needles: [
			"claude",
			"sonnet",
			"opus",
			"haiku",
			"gemini",
			"gemma",
			"deepseek",
			"qwen",
			"kimi",
			"glm",
			"grok",
			"hermes",
			"llama",
			"mistral",
			"devstral",
			"minimax",
		],
		guideline:
			"Edit format: author new files with `write`; for edits to existing code prefer `patch` in " +
			"mode='replace' — match a unique snippet and swap it. Reach for mode='patch' (V4A) only when " +
			"an edit genuinely spans several files at once.",
	},
};

/**
 * hermes `_model_family`, verbatim: lowercase substring match against the
 * needle lists in family order; empty/unknown ids are neutral (no steering).
 */
export function editFormatFamily(modelId: string | undefined | null): EditFormatFamily | null {
	const lowered = (modelId ?? "").toLowerCase();
	if (!lowered) return null;
	for (const family of Object.keys(EDIT_FORMAT_GUIDANCE) as EditFormatFamily[]) {
		if (EDIT_FORMAT_GUIDANCE[family].needles.some((needle) => lowered.includes(needle))) return family;
	}
	return null;
}

/** The one-line guideline for a model id, or null when the family is unknown
 * (hermes: "unknown families get nothing" — the neutral wording applies). */
export function editFormatGuideline(modelId: string | undefined | null): string | null {
	const family = editFormatFamily(modelId);
	return family ? EDIT_FORMAT_GUIDANCE[family].guideline : null;
}

/**
 * The model id the steering keys on. Mirrors `shouldAdvertiseV4A`'s shape
 * exactly (ledger #9): prefer the live session model, fall back to
 * `PI_MODEL` when no model info is available.
 */
export function guidanceModelId(model?: ModelIdentity, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return model ? model.id : env.PI_MODEL;
}
