/**
 * V4A tool-layer plumbing — port of hermes `patch_tool`'s patch-mode support
 * layer (tools/file_tools.py, docs/PLAN.md Tier 3 #10):
 *
 * - `collectV4AHeaderPaths` — every path named in patch HEADERS (patch content
 *   is more attacker-influenceable than `path=`), with `..`-traversal vetoed
 *   before anything is resolved or locked.
 * - `rewriteV4APatchPathsForHost` — headers rewritten to the resolved host
 *   paths so the applier patches the SAME files the tool queued and reports.
 * - `withSortedMutationQueue` — hermes' sorted, deduplicated lock order
 *   (deadlock avoidance for overlapping concurrent patches) over pi's
 *   `withFileMutationQueue` (ledger #3).
 * - `createHostV4AFileOps` — the real `V4AFileOps` the parser was duck-typed
 *   against: exact-byte host reads/writes with pi's file fidelity (BOM and
 *   CRLF captured on read, restored on write — ledger #2), delete, and move.
 *
 * hermes' `_write_precheck_error` policy gates (sensitive-path denylist,
 * binary-DOCUMENT guard, approval/mirror guards) stay out of scope (ledger #4);
 * pi handles workspace policy outside tools. The read path keeps hermes'
 * read_file_raw CONTRACT that validation leans on — absent → `notFound` (the
 * only answer that frees an Add/Move target), failed read → error with
 * `notFound` false — and refuses binary files with a failed read rather than
 * handing UTF-8-mangled content to text hunks (node's decode is lossy where
 * hermes uses surrogateescape; a text V4A hunk on a binary is a corruption
 * either way).
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { detectLineEnding, normalizeToLF, restoreLineEndings, splitBom } from "./text.js";
import { pyRepr } from "./errors.js";
import type { RawReadResult, V4AFileOps, V4AWriteResult } from "./v4a.js";

// hermes `_V4A_SINGLE_HEADER_RE` / `_V4A_MOVE_HEADER_RE` (mirrors
// patch_parser's leniency: `***Update File:` parses, so it must match here
// too). Factories: /g regexes carry lastIndex between calls.
const singleHeaderRe = () => /^(\*\*\*\s*(Update|Add|Delete)\s+File:\s*)(.+)$/gm;
const moveHeaderRe = () => /^(\*\*\*\s*Move\s+File:\s*)(.+?)\s*->\s*(.+)$/gm;

/** hermes `path_security.has_traversal_component`: a literal `..` PATH
 * COMPONENT (not a substring — `a..b` is fine), on either separator. */
export function hasTraversalComponent(pathStr: string): boolean {
	return pathStr.split(/[/\\]/).includes("..");
}

/** hermes `_collect_v4a_header_paths`: (all, content-write, entry) header
 * paths, or hermes' refusal text when any header carries `..` traversal.
 * Update/Add write text (content paths); Delete and Move act on the directory
 * entry, and Move vetoes BOTH endpoints. */
export function collectV4AHeaderPaths(
	patch: string,
): { all: string[]; contentWrite: string[]; entry: string[] } | string {
	const headers: { raw: string; writesText: boolean }[] = [];
	for (const m of patch.matchAll(singleHeaderRe())) headers.push({ raw: m[3], writesText: m[2] === "Update" || m[2] === "Add" });
	for (const m of patch.matchAll(moveHeaderRe())) {
		headers.push({ raw: m[2], writesText: false });
		headers.push({ raw: m[3], writesText: false });
	}
	const all: string[] = [];
	const contentWrite: string[] = [];
	const entry: string[] = [];
	for (const { raw, writesText } of headers) {
		const v4aPath = raw.trim();
		if (hasTraversalComponent(v4aPath)) {
			return (
				`V4A patch header contains '..' traversal: ${pyRepr(v4aPath)}. ` +
				"Use the agent's cwd-relative path (no '..') or an absolute " +
				"path in '*** Update File:' / '*** Add File:' / " +
				"'*** Delete File:' / '*** Move File:' headers."
			);
		}
		all.push(v4aPath);
		(writesText ? contentWrite : entry).push(v4aPath);
	}
	return { all, contentWrite, entry };
}

/** Header paths for the TUI header line (no traversal veto here — the handler
 * refuses); "a, b", capped so a huge patch stays one line. */
export function describeV4AHeaderPaths(patch: string, max = 3): string {
	const collected = collectV4AHeaderPaths(patch);
	if (typeof collected === "string") return "";
	const shown = collected.all.slice(0, max).join(", ");
	const extra = collected.all.length - max;
	return extra > 0 ? `${shown}, +${extra} more` : shown;
}

/**
 * hermes `_rewrite_v4a_patch_paths_for_host` (host backends only — pi always
 * patches the host): every header path becomes the resolved path the tool
 * already queued, so the applier can't re-resolve a relative header against a
 * different cwd. Delete and Move act on the directory ENTRY, never a target.
 */
export function rewriteV4APatchPathsForHost(
	patch: string,
	pathToResolved: ReadonlyMap<string, string>,
	pathToEntry: ReadonlyMap<string, string>,
): string {
	const res = (raw: string, entry = false): string => {
		const trimmed = raw.trim();
		return (entry ? pathToEntry.get(trimmed) : pathToResolved.get(trimmed)) ?? raw;
	};
	const rewritten = patch.replace(singleHeaderRe(), (whole, prefix: string, op: string, raw: string) =>
		`${prefix}${res(raw, op === "Delete")}`,
	);
	return rewritten.replace(
		moveHeaderRe(),
		(_whole, prefix: string, src: string, dst: string) => `${prefix}${res(src, true)} -> ${res(dst, true)}`,
	);
}

/**
 * hermes' `ExitStack` over `lock_path` in sorted, deduplicated order: every
 * caller locks the same order, so overlapping multi-file patches can't
 * deadlock. pi's analog nests `withFileMutationQueue` per resolved path
 * (ledger #3).
 */
export function withSortedMutationQueue<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
	const sorted = [...new Set(paths)].sort();
	const open = (i: number): Promise<T> => (i === sorted.length ? fn() : withFileMutationQueue(sorted[i], () => open(i + 1)));
	return open(0);
}

/** hermes `_detect_binary` stand-in: a NUL byte in the leading sample. */
function looksBinary(buffer: Buffer): boolean {
	return buffer.subarray(0, 8192).includes(0);
}

/**
 * The real host `V4AFileOps` (hermes' `file_ops` the parser is duck-typed
 * against). Per-path file fidelity (BOM + line ending) is captured on read and
 * restored on write, mirroring replace mode: hermes' write_file re-probes disk
 * for its BOM/ending restoration; we keep what the matching read saw, taken
 * inside the mutation queue, so the probe and the write cannot disagree.
 */
export function createHostV4AFileOps(): V4AFileOps {
	const fileStates = new Map<string, { bom: string; ending: "\r\n" | "\n" }>();
	const errText = (e: unknown): string =>
		e instanceof Error && "code" in e ? `Error code: ${String((e as { code: unknown }).code)}` : String(e);
	return {
		readFileRaw(path: string): RawReadResult {
			let buffer: Buffer;
			try {
				buffer = readFileSync(path);
			} catch (e) {
				// Only ENOENT reports the path ABSENT (the answer that frees an
				// Add/Move target); any other failure must keep notFound false so
				// validation answers "could not confirm the path is free".
				if ((e as { code?: string }).code === "ENOENT") {
					return { content: null, error: `File not found: ${path}`, notFound: true };
				}
				return { content: null, error: errText(e) };
			}
			if (looksBinary(buffer)) return { content: null, error: "binary file — V4A hunks only patch text" };
			const raw = buffer.toString("utf-8");
			const { bom, text } = splitBom(raw);
			const ending = detectLineEnding(text);
			fileStates.set(path, { bom, ending });
			// Match on LF-normalized content (ledger #2); write restores the ending.
			return { content: normalizeToLF(text), error: null };
		},
		writeFile(path: string, content: string): V4AWriteResult {
			try {
				const state = fileStates.get(path);
				writeFileSync(path, (state?.bom ?? "") + restoreLineEndings(content, state?.ending ?? "\n"), "utf-8");
				return {};
			} catch (e) {
				return { error: errText(e) };
			}
		},
		deleteFile(path: string): { error?: string } {
			try {
				unlinkSync(path);
				return {};
			} catch (e) {
				return { error: errText(e) };
			}
		},
		moveFile(src: string, dst: string): { error?: string } {
			try {
				renameSync(src, dst);
				return {};
			} catch (e) {
				return { error: errText(e) };
			}
		},
	};
}
