/**
 * TUI renderers for `patch`.
 *
 * Mirrors the built-in edit renderer's component lifecycle (header box with
 * state-colored background, async diff preview, result diff), but computes
 * the preview with OUR chain via computePatchDiff — the built-in renderer is
 * hard-wired to core's computeEditsDiff and would show "could not find"
 * errors for edits this tool lands fine (analysis §8 ⚠). Diff body coloring
 * is reimplemented with public theme keys instead of importing pi-internal
 * components.
 */
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { computePatchDiff } from "./tool.js";

type PatchPreview = { diff: string; firstChangedLine?: number } | { error: string };

type PatchCallRenderComponent = Box & {
	preview?: PatchPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

export interface PatchRenderState {
	callComponent?: PatchCallRenderComponent;
}

interface RenderContext {
	args: PatchToolRenderArgs;
	state: PatchRenderState;
	lastComponent?: unknown;
	cwd: string;
	outputPad: number;
	argsComplete: boolean;
	isError: boolean;
	invalidate: () => void;
}

interface PatchToolRenderArgs {
	path?: unknown;
	edits?: unknown;
	oldText?: unknown;
	newText?: unknown;
}

function getRenderablePreviewInput(args: PatchToolRenderArgs | undefined): { path: string; edits: { oldText: string; newText: string }[] } | null {
	if (!args || typeof args.path !== "string") return null;
	const path = args.path;
	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => {
			const e = edit as Record<string, unknown> | null;
			return !!e && typeof e.oldText === "string" && typeof e.newText === "string";
		})
	) {
		return { path, edits: args.edits as { oldText: string; newText: string }[] };
	}
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}
	return null;
}

function getCallComponent(state: PatchRenderState, lastComponent: unknown): PatchCallRenderComponent {
	if (lastComponent instanceof Box) return lastComponent as PatchCallRenderComponent;
	if (state.callComponent) return state.callComponent;
	const component = Object.assign(new Box(1, 1, (text) => text), {
		preview: undefined as PatchPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
	state.callComponent = component;
	return component;
}

function formatCall(args: PatchToolRenderArgs, theme: Theme): string {
	const path = typeof args.path === "string" ? args.path : "";
	return `${theme.fg("toolTitle", theme.bold("patch"))} ${theme.fg("accent", path)}`;
}

/** Colored diff body using public theme keys (context/removed/added). */
function renderDiffBody(diffText: string, theme: Theme): string {
	return diffText
		.split("\n")
		.map((line) => {
			const display = line.replace(/\t/g, "   ");
			if (display.startsWith("+")) return theme.fg("toolDiffAdded", display);
			if (display.startsWith("-")) return theme.fg("toolDiffRemoved", display);
			return theme.fg("toolDiffContext", display);
		})
		.join("\n");
}

function headerBg(preview: PatchPreview | undefined, settledError: boolean, theme: Theme): (text: string) => string {
	if (preview) {
		return "error" in preview
			? (text) => theme.bg("toolErrorBg", text)
			: (text) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) return (text) => theme.bg("toolErrorBg", text);
	return (text) => theme.bg("toolPendingBg", text);
}

function buildCallComponent(
	component: PatchCallRenderComponent,
	args: PatchToolRenderArgs,
	theme: Theme,
	outputPad: number,
): PatchCallRenderComponent {
	component.setBgFn(headerBg(component.preview, component.settledError ?? false, theme));
	component.setPaddingX(outputPad);
	component.clear();
	component.addChild(new Text(formatCall(args, theme), 0, 0));
	if (!component.preview) return component;
	component.addChild(new Spacer(1));
	const body =
		"error" in component.preview
			? theme.fg("error", component.preview.error)
			: renderDiffBody(component.preview.diff, theme);
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setPreview(component: PatchCallRenderComponent, preview: PatchPreview, argsKey: string): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview ? current.error !== preview.error : "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

function resultErrorText(result: { content?: { type: string; text?: string }[] }): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

export const patchRenderers = {
	renderCall(args: PatchToolRenderArgs, theme: Theme, context: RenderContext) {
		const component = getCallComponent(context.state, context.lastComponent);
		const previewInput = getRenderablePreviewInput(args);
		const argsKey = previewInput
			? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
			: undefined;
		if (component.previewArgsKey !== argsKey) {
			component.preview = undefined;
			component.previewArgsKey = argsKey;
			component.previewPending = false;
			component.settledError = false;
		}
		if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
			component.previewPending = true;
			const requestKey = argsKey as string; // previewInput implies argsKey
			void computePatchDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
				if (component.previewArgsKey === requestKey) {
					setPreview(component, preview, requestKey);
					context.invalidate();
				}
			});
		}
		return buildCallComponent(component, args, theme, context.outputPad);
	},
	renderResult(
		result: { content?: { type: string; text?: string }[]; details?: { diff?: string; firstChangedLine?: number } },
		_options: unknown,
		theme: Theme,
		context: RenderContext & { args: PatchToolRenderArgs },
	) {
		const callComponent = context.state.callComponent;
		const previewInput = getRenderablePreviewInput(context.args);
		const argsKey = previewInput
			? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
			: undefined;
		const resultDiff = !context.isError ? result.details?.diff : undefined;
		let changed = false;
		if (callComponent) {
			if (typeof resultDiff === "string") {
				changed =
					setPreview(callComponent, { diff: resultDiff, firstChangedLine: result.details?.firstChangedLine }, argsKey ?? "") ||
					changed;
			}
			if (callComponent.settledError !== context.isError) {
				callComponent.settledError = context.isError;
				changed = true;
			}
			if (changed) {
				buildCallComponent(callComponent, context.args, theme, context.outputPad);
			}
		}
		let output: string | undefined;
		if (context.isError) {
			const errorText = resultErrorText(result);
			const previewError = callComponent?.preview && "error" in callComponent.preview ? callComponent.preview.error : undefined;
			if (errorText && errorText !== previewError) {
				output = theme.fg("error", errorText);
			}
		} else {
			const previewDiff = callComponent?.preview && !("error" in callComponent.preview) ? callComponent.preview.diff : undefined;
			if (resultDiff && resultDiff !== previewDiff) {
				output = renderDiffBody(resultDiff, theme);
			}
		}
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		component.clear();
		if (!output) return component;
		component.addChild(new Spacer(1));
		component.addChild(new Text(output, context.outputPad, 0));
		return component;
	},
};
