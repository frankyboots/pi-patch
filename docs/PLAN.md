# PLAN — pi-patch build state

**Role of this file:** the living plan used to keep state during development — what is done,
what is next, the validation bar, and the deviations ledger recording every intentional
difference from hermes. Update it as work lands. The factual reference — why hermes' `patch`
is shaped the way it is, and how pi's `edit` differs — lives in
[EDIT-TOOL-ANALYSIS.md](EDIT-TOOL-ANALYSIS.md); `§n` references below point there.

**Goal:** pi-patch is an **exact port of the hermes `patch` tool** — same dual-mode surface
(replace + V4A patch), same 9-strategy chain, same recovery UX and error texts — adapted to
pi only where the platform forces a difference. Every deviation from hermes behavior must
carry a row in the deviations ledger below with its rationale; "pi already has something
similar" is not a reason to skip a hermes behavior.

---

## Status snapshot

Implemented so far (against the transitional `edits[]` surface; these survive the Tier 2 #5
reschema):

- [x] Chain (partial): `exact`, `line_trimmed`, `indentation_flexible`, `trimmed_boundary`
- [x] Teaching errors: ambiguity locations, did-you-mean sections, whitespace visualization,
      empty/identical validation with "do not re-send"
- [x] Already-applied no-op (conservative: `newText` ≥ 8 chars present exactly, `oldText` gone)
- [x] Model-facing unified diff + `details` diff for the TUI
- [x] Own preview renderer (computes the preview with **our** engine, not core's `computeEditsDiff`)
- [x] Reindent replacement shaping
- [x] Argument normalization
- [x] Tier 1 #1: chain complete — all 9 strategies wired in hermes' order
      (`src/chain.ts`; span-mapping helpers ported verbatim in `src/span-map.ts`,
      differentially tested via the generated golden corpus
      `scripts/generate_span_map_golden.py` → `test/golden/span-map.json`).
      The applicable `test_fuzzy_match.py` cases are ported to
      `test/patch.test.ts` and their chain-level outputs (strategy, count,
      spliced result) differentially validated against the real
      `fuzzy_find_and_replace`; the remaining corpus cases are owned by the
      steps that provide what they exercise — #2 (`replace_all`), #3
      (escape-drift guards), #4 (unicode-preserving replacement,
      `\t`/`\r` unescape). Similarity ratios use the `diff`-package opcode
      stand-in for `SequenceMatcher` (PLAN.md complexity table).

## Build plan (exact-port tiers)

Tiers are ordered by dependency, not by value: the strategy chain (Tier 1) is the matching
core for BOTH modes — V4A Update hunks go through it too (§2.1) — so it stays first even
though V4A is now in scope.

### Tier 1 — replace-mode matching core (the load-bearing port)

- [x] 1. Complete the chain to hermes' 9 strategies: add `whitespace_normalized`,
      `escape_normalized`, `unicode_normalized`, `block_anchor`, `context_aware`, with the
      span-mapping helpers ported verbatim from `fuzzy_match.py` (reference order:
      Appendix A). Uniqueness stays per-strategy, counted in that strategy's space (§3.1).
- [ ] 2. `replace_all`, ported as-is: ambiguity counted per-strategy; similarity strategies
      refuse it.
- [ ] 3. Escape-drift guards on every non-exact match (newline-literal, quote-suspect,
      backslash-doubling) before anything is written.
- [ ] 4. Replacement shaping completion: `_reindent_replacement` (done), unicode-preserving
      opcode application, conditional `\t`/`\r` unescape of `new_string`.

### Tier 2 — replace-mode surface & recovery parity

- [ ] 5. Switch the tool surface to hermes' schema: `path`, `old_string`, `new_string`,
      `replace_all` — one replacement per call (§6 item 1). Keep argument normalization as
      the `schema_sanitizer` analog (ledger #8). Update the prompt contribution, renderers,
      and tests to match.
- [ ] 6. Failure counter + escalation (session-scoped): per-path consecutive-miss count,
      failure-#3 "stop retrying" hint, reset on success, and the generic below-threshold
      `_hint` whenever no richer "did you mean" snippet is attached (§4).
- [ ] 7. Error-text fidelity: Appendix B texts verbatim, modulo tool-name mapping
      (ledger #10).

### Tier 3 — V4A patch mode

- [ ] 8. Port `patch_parser.py` verbatim: parse → validate → apply; Update hunks through the
      shared chain with the context-hint window retry (−500/+2000 chars); addition-only hint
      insertion; already-applied skip mirroring validation's.
- [ ] 9. Schema layering: base schema replace-only; `mode`+`patch` params and the dual-mode
      description layered only when the OpenAI-family gate passes (`PI_PROVIDER`/`PI_MODEL`,
      fail-closed); handler accepts both shapes from any model; `mode` defaults to `replace`.
- [ ] 10. Tool-layer plumbing: `..`-traversal rejection in patch headers, sorted per-path
      mutation queueing over all touched files, absolute `files_modified` (+ `resolved_path`
      when single) in the result.

### Tier 4 — operational parity

- [ ] 11. Post-write verification re-read.
- [ ] 12. Read-time version capture (`(dev, ino, size, mtime_ns, ctime_ns)` tuple, not bare
      mtime) → staleness warning at edit time.
- [ ] 13. Strategy telemetry (JSONL) driving threshold tuning on our traffic.
- [ ] 14. Lint/LSP delta in the result — blocked in pi today (ledger #5); revisit if pi
      grows a public harness.

**Kept from pi** (each a row in the deviations ledger below): LF pre-normalization +
BOM/CRLF handling, `withFileMutationQueue`, constrained sampling, renderer integration,
argument normalization. Everything else follows hermes.

## Validation plan

- Port hermes' corpora to vitest: `test_fuzzy_match.py` (57 cases), `test_patch_parser.py`,
  `test_patch_v4a_gate.py`, `test_patch_already_applied.py`,
  `test_patch_multimatch_locations.py` — they encode years of regression history; a green
  corpus is the port's acceptance bar.
- Add a differential fixture: every case where pi's built-in `edit` returns `found:false` is
  enumerated and asserted as matched by the chain (or intentionally still rejected, e.g.
  escape-drift).
- A/B on small local models (pi's llama.cpp provider path): metrics = edit success per call,
  retries per landed edit, turns per successful edit session, corruption incidents (must
  remain zero).

## Complexity & risk (implementation guidance)

| Item | LOC (hermes, py) | Port risk |
|---|---|---|
| Strategy chain core | ~450 (`fuzzy_match.py` incl. span mapping) | Moderate — the span-mapping helpers (`_map_normalized_positions`, `_build_orig_to_norm_map`) are subtle; port with tests, don't reimplement from the table |
| V4A parser + appliers | ~450 (`patch_parser.py`) | Moderate — format parsing, validation pass, hint-window retry; port verbatim with `tests/tools/test_patch_parser.py` as acceptance |
| `SequenceMatcher` equivalent | — | No new dependency needed: pi's `edit-diff.js` already imports the `diff` npm package, and `difflib.ratio` (`2·M/T`) is computable from `Diff.diffChars` opcodes (`M` = total matched length). Similarity thresholds must still be re-validated against the same fixtures |
| Escape-drift guards | ~120 | Low — pure string logic |
| Recovery UX (hints, locations, escalation) | ~150 + failure/read trackers | Low-Medium; trackers are session-scoped state in an extension (fine), pi has no built-in persistence for these |
| Already-applied detection | ~15 | Trivial |
| Reindent + unicode-preserving replacement | ~110 | Moderate — most intricate correctness code in the file |
| Post-write verification | ~30 | Trivial |
| Staleness/read tracking | optional | Medium — hermes' version spans 2 modules + cross-agent registry; a thin read-time vs edit-time check suffices, but compare a version tuple (ino+size+ctime, optionally mtime_ns), not bare mtime — editors/copy tools can preserve mtime |

Under the exact-port goal the replace-mode surface is **one replacement per call** (hermes
semantics) with `replace_all` ported as-is (per-strategy ambiguity counting; similarity
strategies refuse it). The current `edits[]` multi-edit schema is retired from `patch`
(§6 item 1); the built-in `edit` tool remains for callers that want it, and V4A's
multi-hunk/multi-file behavior subsumes the batch use case.

---

## Deviations ledger (the exact-port contract)

Every place pi-patch deviates from hermes' `patch` behavior lives here. A deviation without a
row is a bug; a row without a rationale is a decision nobody made. "Environment-forced" rows
are settled unless pi's platform changes; "deliberate" rows can be revisited if hermes changes
first.

| # | Deviation | Kind | Rationale |
|---|---|---|---|
| 1 | Tool registered as `patch` alongside the built-in `edit` (not replacing it) | deliberate | this project's reason to exist: A/B the two engines in one session; hermes has no built-in twin to preserve |
| 2 | LF pre-normalization before matching; hermes matches raw bytes (CRLF included) | deliberate improvement | models emit bare-LF anchors; hermes loses strategies 1/3/4/6 on CRLF files; we match everywhere and restore endings on write (§3.3). Consequence: a literal-`\r` anchor (strategy 5) loses its target byte after normalization and on CRLF files falls through to the similarity rungs instead |
| 3 | `withFileMutationQueue` instead of hermes' `FileStateRegistry` locks | environment-forced | pi's public plumbing; same per-path serialization guarantee |
| 4 | No `task_id`/`cross_profile` and none of `_write_precheck_error`'s gates (sensitive-path denylist, binary-document guard, protected-instruction guard, approval gate, mirror guard) | environment-forced | pi handles approval and workspace policy outside tools; there is no task registry to key state on. Revisit only if pi grows an equivalent policy layer |
| 5 | No lint/LSP diagnostics in the result | environment-forced (today) | pi has no public lint/LSP harness; Tier 4 #14 tracks it |
| 6 | `_hint`/`_warning` delivered inside message text (pi results are text content + `isError`), not as JSON envelope fields | environment-forced | hermes' result is a JSON string; pi's is tool-result content. Hint texts preserved verbatim within that constraint |
| 7 | Constrained sampling kept (`strict: "prefer"`) | platform bonus | orthogonal to tool semantics; hermes compensates via `schema_sanitizer.py` |
| 8 | Argument normalization kept (`prepareEditArguments`-style coercion) | platform bonus | analog of hermes' coercion layer; harmless under strict sampling |
| 9 | Model-family gate reads `PI_PROVIDER`/`PI_MODEL` instead of hermes' auxiliary client | environment-forced | same fail-closed semantics (§7, §2.1) |
| 10 | Hint texts name pi's tools (`read`, `grep`, `write`) instead of hermes' (`read_file`, `search_files`, `write_file`) | cosmetic | point the model at tools that exist in this environment |
| 11 | Read/staleness tracking scoped to the pi session, not a cross-agent registry | environment-forced | single-agent process; the version-tuple comparison itself is still ported (Tier 4 #12) |
