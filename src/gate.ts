/**
 * OpenAI-family gate — port of hermes `_is_openai_family_main`
 * (tools/file_tools.py), the provider-allowlist + model-slug heuristic that
 * decides whether the V4A layer (`mode` + `patch` params, dual-mode
 * description) rides on the advertised schema (docs/PLAN.md Tier 3 #9,
 * analysis §2.1).
 *
 * hermes reads the live main provider/model through its auxiliary client; the
 * pi analog is the session API (`ctx.model.provider` / `ctx.model.id` in
 * event handlers — verified at implementation time, analysis §7), with
 * `PI_PROVIDER`/`PI_MODEL` as the environment fallback (deviations ledger #9).
 * Provider-family-coarse on purpose (no per-model training-diet table to go
 * stale): direct OpenAI providers always qualify; on aggregators
 * (openrouter/azure/...) the MODEL slug decides. Fail-closed to the universal
 * replace-only schema whenever the family cannot be established.
 */

/** hermes `_is_openai_family_main` provider allowlist. */
const OPENAI_FAMILY_PROVIDERS = new Set(["openai", "openai-chat", "openai-codex", "azure-openai", "codex"]);

/** Aggregator-slug prefixes identifying the OpenAI/codex family (the population
 * trained on the V4A apply_patch dialect). */
const OPENAI_FAMILY_SLUG_PREFIXES = ["gpt-", "gpt.", "chatgpt", "codex", "o1", "o3", "o4", "o5"];

/** hermes `_is_openai_family_main`, verbatim, over an explicit (provider,
 * model) pair: missing/empty input fails closed. */
export function isOpenaiFamilyMain(provider: string | undefined, model: string | undefined): boolean {
	const prov = (provider ?? "").trim().toLowerCase();
	const mdl = (model ?? "").trim().toLowerCase();
	if (OPENAI_FAMILY_PROVIDERS.has(prov)) return true;
	// Aggregators: the model slug carries the family. Python `model.split("/", 1)[-1]`
	// keeps everything AFTER the first slash ("openai/gpt-5" → "gpt-5").
	const slash = mdl.indexOf("/");
	const slug = slash === -1 ? mdl : mdl.slice(slash + 1);
	if (OPENAI_FAMILY_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))) return true;
	return mdl.includes("openai/");
}

/** The identifying slice of a live pi model (`ctx.model`), duck-typed so the
 * gate stays testable without the SDK runtime. */
export interface ModelIdentity {
	provider?: string;
	id?: string;
}

/**
 * What the schema layering asks: does the current model get the dual-mode
 * schema? Prefers the live session model; falls back to the
 * `PI_PROVIDER`/`PI_MODEL` environment pair (ledger #9) when no model info is
 * available; fails closed to the replace-only base schema in every other case.
 */
export function shouldAdvertiseV4A(model?: ModelIdentity, env: NodeJS.ProcessEnv = process.env): boolean {
	if (model) return isOpenaiFamilyMain(model.provider, model.id);
	return isOpenaiFamilyMain(env.PI_PROVIDER, env.PI_MODEL);
}
