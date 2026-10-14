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
 * The same re-registration also carries the edit-format prompt steering
 * (`edit-guidance.ts`, hermes `_EDIT_FORMAT_GUIDANCE`): that guideline is
 * keyed on model-id needles INDEPENDENT of the schema gate (ledger #17), so
 * the identity compare watches (gate, model id) — a family change without a
 * gate flip still refreshes the live guidelines.
 *
 * Read-time version capture (Tier 4 #12) is the other job of the load-time
 * wiring: a `tool_result` handler stamps the version of every file the session
 * reads (`read`) or writes (`edit`/`write`), which is what lets `patch` warn —
 * with hermes' `_edit_warnings` text — when a file changed under the model
 * since it last saw it (deviations ledger #19).
 *
 * Load in development:
 *   pi --extension /path/to/pi-patch/src/index.ts
 *
 * Or install project-wide: link/copy this directory into
 * ~/.pi/agent/extensions/pi-patch (pi loads directories with an index.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shouldAdvertiseV4A, type ModelIdentity } from "./gate.js";
import { guidanceModelId } from "./edit-guidance.js";
import { createPatchToolDefinition, resolveToCwd } from "./tool.js";
import { noteRead, noteWrite, stampForToolResult } from "./staleness.js";
import { patchRenderers } from "./render.js";

export default function piPatchExtension(pi: ExtensionAPI) {
	const register = (state: { advertiseV4A: boolean; modelId?: string }) =>
		pi.registerTool({
			...createPatchToolDefinition(process.cwd(), state),
			...patchRenderers,
		});

	// Load-time registration is the base schema: the live model is not yet
	// known, and the gate fails closed (hermes' unlayered PATCH_SCHEMA is the
	// universal surface; V4A is the OpenAI-family dialect).
	register({ advertiseV4A: false });

	let advertised: { advertiseV4A: boolean; modelId?: string } = { advertiseV4A: false, modelId: undefined };
	const applyGate = (model?: ModelIdentity) => {
		const want = { advertiseV4A: shouldAdvertiseV4A(model), modelId: guidanceModelId(model) };
		if (want.advertiseV4A === advertised.advertiseV4A && want.modelId === advertised.modelId) return;
		advertised = want;
		register(want);
	};

	pi.on("session_start", (_event, ctx) => applyGate(ctx.model));
	pi.on("model_select", (event) => applyGate(event.model));
	// Cheap belt-and-braces re-check before each turn (hermes re-evaluates per
	// schema build; the identity compare makes this a no-op when nothing moved).
	pi.on("turn_start", (_event, ctx) => applyGate(ctx.model));

	// Read-time version capture (Tier 4 #12). hermes stamps `read_file` targets
	// from inside read_file itself; pi's read tool is core's, so the stamp rides
	// the tool_result event instead (deviations ledger #19): a successful `read`
	// records the file's current version, a successful `edit`/`write` refreshes it
	// (hermes: a write is an implicit read). `patch` stamps its own writes where
	// hermes' `_note_edited` does, and `grep`/`find` stamp nothing because
	// hermes' `search_files` never stamped either.
	pi.on("tool_result", (event, ctx) => {
		const stamp = stampForToolResult(event);
		if (!stamp) return;
		const resolved = resolveToCwd(stamp.path, ctx.cwd || process.cwd());
		if (stamp.kind === "read") noteRead(resolved);
		else noteWrite(resolved);
	});
}
