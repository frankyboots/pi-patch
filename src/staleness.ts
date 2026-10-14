/**
 * Read-time version stamps + edit-time staleness warnings — the ported half of
 * hermes' read tracking (Tier 4 #12): `_file_metadata`, `_update_read_timestamp`,
 * `_read_mtime_drifted` and `_check_file_staleness`
 * (tools/file_tools_read_tracking.py), joined at hermes' `_edit_warnings` call
 * site in `patch_tool`.
 *
 * hermes stamps a file when the agent reads it, refreshes the stamp after its
 * own writes (a write is an implicit read of the current content), and at edit
 * time WARNS — never blocks; `patch` warns only, analysis §2 — when the file on
 * disk differs from the stamp: it moved under the model since it last saw it
 * (external editor, `git checkout`, a sibling agent). hermes keys that stamp on
 * `os.path.getmtime` (`_update_read_timestamp`/`_read_mtime_drifted`); we carry
 * hermes' own `_file_metadata` 5-tuple `(dev, ino, size, mtime_ns, ctime_ns)`
 * instead (plan Tier 4 #12, ledger #19): editors and copy tools can preserve
 * mtime while replacing the bytes, ctime cannot be backdated, and dev/ino catch
 * a new file moved over the path.
 *
 * pi adaptations (deviations ledger #11/#19/#20): the tracker is session-scoped
 * and keyed by resolved path alone — there is no task registry and no
 * cross-agent `FileStateRegistry` to name a sibling — and the read stamps are
 * fed from OUTSIDE this module: the extension
 * watches `tool_result` events for the built-in `read` (a read) and
 * `edit`/`write` (a write is an implicit read), while `patch` stamps its own
 * writes where hermes' `_note_edited` does. `search_files` never stamped in
 * hermes, so `grep`/`find` do not stamp here.
 */
import { statSync } from "node:fs";
import { staleFileWarning } from "./errors.js";

/** hermes `_file_metadata`'s tuple: `(st_dev, st_ino, st_size, st_mtime_ns, st_ctime_ns)`. */
export type FileVersion = readonly [dev: bigint, ino: bigint, size: bigint, mtimeNs: bigint, ctimeNs: bigint];

/** hermes `_READ_TIMESTAMPS_CAP`: bound accretion regardless of session length.
 * Exported so the corpus can assert the bound without monkeypatching. */
export const READ_STAMPS_CAP = 1000;

/** Version per resolved path; insertion order = age, for the cap's eviction. */
const readStamps = new Map<string, FileVersion>();

/** hermes `_evict_oldest` (dict branch): pop entries until within *cap*, oldest by insertion order. */
function evictOldest(cap: number): void {
	while (readStamps.size > cap) {
		const oldest = readStamps.keys().next();
		if (oldest.done) break;
		readStamps.delete(oldest.value);
	}
}

/** hermes `_file_metadata`: the version tuple, or null when the path cannot be stat'ed. */
export function fileVersion(resolvedPath: string): FileVersion | null {
	try {
		const st = statSync(resolvedPath, { bigint: true });
		return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs];
	} catch {
		return null;
	}
}

function sameVersion(a: FileVersion, b: FileVersion): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
}

function stamp(resolvedPath: string): void {
	const version = fileVersion(resolvedPath);
	// hermes records nothing when the stat fails (a read of a missing file is
	// not a stamp; a deleted file is the next write's problem).
	if (version === null) return;
	readStamps.set(resolvedPath, version);
	evictOldest(READ_STAMPS_CAP);
}

/**
 * hermes' read stamp (`read_file`'s `read_timestamps[resolved] = now`, and the
 * same write in `_update_read_timestamp`): the model has now seen THIS version.
 * Takes the RESOLVED path, like hermes' tracker keys.
 */
export function noteRead(resolvedPath: string): void {
	stamp(resolvedPath);
}

/** hermes `_note_edited`/`file_state.note_write`: a successful write is an
 * implicit read of the current content, so consecutive edits by the same agent
 * never trip a false staleness warning. */
export function noteWrite(resolvedPath: string): void {
	stamp(resolvedPath);
}

/**
 * hermes `_read_mtime_drifted`, on the version tuple instead of a bare mtime
 * (see the header). False when never read, unchanged, or unstattable — an
 * untracked file is never stale, so first-touch edits stay quiet.
 */
export function drifted(resolvedPath: string): boolean {
	const stamp_ = readStamps.get(resolvedPath);
	if (stamp_ === undefined) return false;
	const current = fileVersion(resolvedPath);
	if (current === null) return false;
	return !sameVersion(stamp_, current);
}

/**
 * hermes `_check_file_staleness`: the warn-only staleness notice for one path.
 * `displayPath` is the model's own spelling (hermes echoes the raw arg, not the
 * resolved path); `resolvedPath` is the tracker key.
 */
export function stalenessWarning(displayPath: string, resolvedPath: string): string | undefined {
	return drifted(resolvedPath) ? staleFileWarning(displayPath) : undefined;
}

/**
 * hermes `_edit_warnings`' staleness source, over every path one call touches
 * (the replace surface contributes one, a V4A patch every header path). The
 * cross-agent registry and workspace-divergence sources are not ported
 * (deviations ledger #11/#19); callers join the result with `" | "`, exactly
 * like hermes' `" | ".join(stale_warnings)`.
 */
export function stalenessWarnings(
	paths: readonly (readonly [displayPath: string, resolvedPath: string])[],
): string[] {
	const warnings: string[] = [];
	for (const [displayPath, resolvedPath] of paths) {
		const warning = stalenessWarning(displayPath, resolvedPath);
		if (warning) warnings.push(warning);
	}
	return warnings;
}

/** Which stamp (if any) a finished tool result should leave behind. */
export type ToolResultStamp = { kind: "read" | "write"; path: string };

/** Tools whose SUCCESSFUL result means the session has seen the file's current
 * content: pi's `read` is hermes' `read_file`; pi's `edit`/`write` are writes,
 * which hermes stamps too (a write is an implicit read). `patch` is absent on
 * purpose — its own execute stamps every path it touched, including the V4A
 * header paths the result's `input` does not carry. */
const STAMPED_TOOLS: Record<string, "read" | "write"> = { read: "read", edit: "write", write: "write" };

/**
 * Map a `tool_result` event to the stamp it should leave (deviations ledger
 * #19: hermes stamps inside `read_file`; pi's read tool is core's, so the stamp
 * rides the result event). Failed calls stamp nothing — hermes' tracker only
 * records content that was actually seen, and `patch` writes stamp themselves.
 */
export function stampForToolResult(event: {
	toolName: string;
	isError: boolean;
	input?: Record<string, unknown>;
}): ToolResultStamp | undefined {
	const kind = STAMPED_TOOLS[event.toolName];
	if (!kind || event.isError) return undefined;
	const path = event.input?.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	return { kind, path };
}

/** Session teardown / test reset. */
export function clearReadStamps(): void {
	readStamps.clear();
}

/** Test seam: number of tracked paths (hermes asserts its caps the same way,
 * by monkeypatching the cap; ours is fixed, so tests count instead). */
export function readStampCount(): number {
	return readStamps.size;
}
