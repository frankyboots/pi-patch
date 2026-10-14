/**
 * pi-patch — a pi extension registering a `patch` tool: an exact port of
 * hermes' `patch` tool, alongside the built-in `edit` tool (never instead of
 * it, so devs can A/B the two matching engines in one session without
 * hindering abilities; deviations ledger #1).
 *
 * Schema layering (Tier 3 #9, pi's analog of hermes'
 * `dynamic_schema_overrides`): the tool registers with hermes' base
 * replace-only `PATCH_SCHEMA` at load, and the V4A layer (`mode` + `patch`
 * params, dual-mode description) is swapped in — via re-registration, which
 * refreshes the live tool list — exactly when the OpenAI-family gate
 * (`gate.ts`) passes for the session model. hermes re-evaluates its override
 * on every schema build and on compaction's tool refresh; pi evaluates at
 * `session_start` and on every `model_select`, which covers the same set of
 * transitions (model switches and resume-into-different-model), plus a
 * `turn_start` re-check so a mid-session model change through a path that
 * emits no event is still caught before the next request.
 *
 * Load in development:
 *   pi --extension /path/to/pi-patch/src/index.ts
 *
 * Or install project-wide: link/copy this directory into
 * ~/.pi/agent/extensions/pi-patch (pi loads directories with an index.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shouldAdvertiseV4A, type ModelIdentity } from "./gate.js";
import { createPatchToolDefinition } from "./tool.js";
import { patchRenderers } from "./render.js";

export default function piPatchExtension(pi: ExtensionAPI) {
	const register = (advertiseV4A: boolean) =>
		pi.registerTool({
			...createPatchToolDefinition(process.cwd(), { advertiseV4A }),
			...patchRenderers,
		});

	// Load-time registration is the base schema: the live model is not yet
	// known, and the gate fails closed (hermes' unlayered PATCH_SCHEMA is the
	// universal surface; V4A is the OpenAI-family dialect).
	register(false);

	let advertisingV4A = false;
	const applyGate = (model?: ModelIdentity) => {
		const want = shouldAdvertiseV4A(model);
		if (want === advertisingV4A) return;
		advertisingV4A = want;
		register(want);
	};

	pi.on("session_start", (_event, ctx) => applyGate(ctx.model));
	pi.on("model_select", (event) => applyGate(event.model));
	// Cheap belt-and-braces re-check before each turn (hermes re-evaluates per
	// schema build; the identity compare makes this a no-op when nothing moved).
	pi.on("turn_start", (_event, ctx) => applyGate(ctx.model));
}
