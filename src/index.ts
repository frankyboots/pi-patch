/**
 * pi-patch — a pi extension registering a `patch` tool alongside the built-in
 * `edit` tool (never instead of it, so devs can A/B the two matching engines
 * in one session without hindering abilities).
 *
 * Load in development:
 *   pi --extension /path/to/pi-patch/src/index.ts
 *
 * Or install project-wide: link/copy this directory into
 * ~/.pi/agent/extensions/pi-patch (pi loads directories with an index.ts).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPatchToolDefinition } from "./tool.js";
import { patchRenderers } from "./render.js";

export default function piPatchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		...createPatchToolDefinition(process.cwd()),
		...patchRenderers,
	});
}
