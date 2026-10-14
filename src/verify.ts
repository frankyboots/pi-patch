/**
 * Post-write verification — port of hermes' two write-persistence gates
 * (docs/EDIT-TOOL-ANALYSIS.md §4 "Write persistence", PLAN.md Tier 4 #11):
 *
 * - `verifyWrittenHash` — hermes `_verify_written_hash` (the gate inside
 *   `write_file`, which EVERY hermes patch write rides — replace mode AND V4A
 *   Add/Update through `file_ops.write_file`): compares the on-disk sha256 to
 *   the intended bytes. A mismatch is a hard error; a read-back that cannot be
 *   taken (hermes' missing/failing `sha256sum`) answers "unverified" and lets
 *   the successful write stand — verification must never break a good write.
 * - `verifyPatchPersisted` — hermes `_verify_patch_persisted` (replace mode
 *   only, after `write_file`): re-reads the exact bytes, strips the BOM and
 *   normalizes line endings on BOTH sides (Windows text-mode writes turn our
 *   LF into CRLF; we restore endings ourselves, but the comparison stays
 *   ending-agnostic), and compares against the intended content.
 *
 * Both catch silent persistence failures (FS oddities, races, truncated
 * writes) that would otherwise be reported as successful patches. They run
 * INSIDE the mutation queue, like hermes' re-read under `lock_path`, so a
 * concurrent writer can't fake a mismatch. Error texts are hermes' verbatim
 * (they name no tools, so ledger #10 does not touch them); the char counts
 * are code-point counts, matching Python's `len` (ledger #18).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeToLF, splitBom } from "./text.js";

/** Exact-byte reader seam — hermes mocks its shell transport to test these
 * gates; tests inject a lying/failing reader here instead. Defaults to a
 * synchronous `readFileSync`. */
export type ExactByteReader = (path: string) => Buffer;

const readExact: ExactByteReader = (path) => readFileSync(path);

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

/** Python `len()` counts code points, not UTF-16 units. */
function charLength(text: string): number {
	let n = 0;
	for (const _ of text) n++;
	return n;
}

/**
 * hermes `_verify_written_hash`: `(error | null)` — null means the write is
 * verified OR the hash could not be taken (hermes' `verified=None` path: the
 * hash binary failed, yet the write still stands). `intendedBytes` are the
 * exact bytes handed to the write, BOM and line endings included.
 */
export function verifyWrittenHash(
	path: string,
	intendedBytes: Buffer,
	read: ExactByteReader = readExact,
): string | null {
	let disk: Buffer;
	try {
		disk = read(path);
	} catch {
		return null; // hash could not be taken — hermes returns (None, None)
	}
	if (sha256(disk) !== sha256(intendedBytes)) {
		return (
			`Post-write verification failed for ${path}: on-disk content hash differs from the intended write. ` +
			"The write did not persist correctly — re-read the file and retry."
		);
	}
	return null;
}

/**
 * hermes `_verify_patch_persisted`: re-read the file and confirm the intended
 * content landed, comparing BOM-less, LF-normalized text on both sides.
 * `intended` is the post-splice content (BOM-less; hermes passes the
 * file-ending-normalized string, but both sides are LF-normalized before the
 * comparison and the counts, so passing LF-normalized content is equivalent).
 * Returns hermes' error text, or null when the write persisted correctly.
 */
export function verifyPatchPersisted(
	path: string,
	intended: string,
	read: ExactByteReader = readExact,
): string | null {
	let buffer: Buffer;
	try {
		buffer = read(path);
	} catch {
		return `Post-write verification failed: could not re-read ${path}`;
	}
	const { text } = splitBom(buffer.toString("utf-8"));
	const onDisk = normalizeToLF(text);
	const want = normalizeToLF(intended);
	if (onDisk !== want) {
		return (
			`Post-write verification failed for ${path}: on-disk content differs from intended write ` +
			`(wrote ${charLength(want)} chars, read back ${charLength(onDisk)} chars after normalizing line endings). ` +
			"The patch did not persist. Re-read the file and try again."
		);
	}
	return null;
}
