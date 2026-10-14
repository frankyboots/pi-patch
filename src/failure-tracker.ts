/**
 * Session-scoped consecutive-failure tracker — port of hermes'
 * `_patch_failure_tracker` (tools/file_tools_read_tracking.py). hermes
 * escalates its no-match recovery when the model keeps failing the SAME file:
 * a per-(task_id, resolved_path) consecutive-miss count, failure #3 injects
 * the "stop retrying" escalation hint (analysis §4), and every successful
 * patch — including the already-applied no-op, which flows through hermes'
 * success branch — resets the count. pi has no task registry to key state on
 * (deviations ledger #4), so the tracker is keyed by resolved path alone and
 * lives for the session; the 64-path cap with oldest eviction is ported
 * verbatim.
 *
 * hermes counts replace-mode misses only ("V4A misses are rare",
 * file_tools.py:1022) — when the V4A patch mode lands (Tier 3), its errors
 * must NOT be recorded here.
 */

/** hermes `_PATCH_FAILURE_PATHS_CAP`: bound accretion regardless of session length. */
const PATHS_CAP = 64;

/** Consecutive no-match failures per resolved path; insertion order = age, for the cap's eviction. */
const tracker = new Map<string, number>();

/** hermes `_evict_oldest` (dict branch): pop entries until within *cap*, oldest by insertion order. */
function evictOldest(cap: number): void {
	while (tracker.size > cap) {
		const oldest = tracker.keys().next();
		if (oldest.done) break;
		tracker.delete(oldest.value);
	}
}

/** hermes `_record_patch_failure`: increment and return the consecutive-failure count for this path. */
export function recordPatchFailure(resolvedPath: string): number {
	if (!tracker.has(resolvedPath)) evictOldest(PATHS_CAP - 1);
	const count = (tracker.get(resolvedPath) ?? 0) + 1;
	// Setting an existing key keeps its original insertion position, like the
	// Python dict hermes relies on for the eviction order.
	tracker.set(resolvedPath, count);
	return count;
}

/** hermes `_reset_patch_failures`: clear consecutive-failure counts for the given paths. */
export function resetPatchFailures(resolvedPaths: readonly string[]): void {
	if (resolvedPaths.length === 0) return;
	for (const resolvedPath of resolvedPaths) tracker.delete(resolvedPath);
}

/** Session teardown / test reset — hermes' task-cleanup clear (file_tools.py:392). */
export function clearPatchFailures(): void {
	tracker.clear();
}
