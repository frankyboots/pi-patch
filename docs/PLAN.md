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

Implemented so far:

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
- [x] Tier 1 #2: `replace_all` ported as-is — `replaceAll` per edit under the
      transitional surface (flat `replace_all` coercion included): every match
      of the winning strategy is spliced in `_apply_replacements` order with
      per-region reindent, ambiguity stays per-strategy, similarity strategies
      refuse the mass-overwrite with hermes' error text, and the ambiguity
      error now offers the flag. The hermes `TestReplaceAll` corpus is ported;
      the per-edit flag stands in for the flat schema one until Tier 2 #5
      reschemas.
- [x] Tier 1 #4: replacement shaping completed (`src/shaping.ts`), wire-for-wire
      with hermes' orchestrator tail: `_maybe_unescape_new_string` (conditional
      `\t`/`\r` unescape over the matched regions — all strategies including
      exact, per TestEscapeNormalizedNewString/issue #33733; `\n` excluded),
      `_unicode_edit_plan` + `_preserve_unicode_in_replacement` (unicode_normalized
      matches apply only the old→new opcodes onto each region's ORIGINAL text, so
      the file's em-dashes/smart quotes survive; per-region so replace_all keeps
      each occurrence's own typography), `_reindent_replacement` completed (first
      MEANINGFUL line anchoring, ` \t`-only strip, shallower lines anchor to the
      file base), and `_apply_replacements` (end-to-start splice, per-region
      shaping via `shapeReplacement`). The opcode plan is computed by a verbatim
      port of `difflib.SequenceMatcher` (`SequenceMatcher` class, CPython 3.12
      reference: `__chain_b` autojunk, `find_longest_match` tie-breaks,
      `get_matching_blocks` collapse, `get_opcodes`) — differential fuzz (2 seeds
      × 4000 preserve + 2000 unescape cases vs the real hermes module) showed
      the `diff`-package stand-in
      produces different edit scripts whose splice output differs; ratios keep
      the blessed stand-in, opcodes must match SequenceMatcher exactly. The
      TestUnicodeNormalized, TestUnicodeSpaceAndMinusNormalized, TestReplaceAll
      unicode, and TestEscapeNormalizedNewString corpora are ported.
- [x] Tier 1 #3: escape-drift guards ported (`src/escape-drift.ts` —
      `_detect_escape_drift` + `_detect_newline_literal_drift` +
      `_detect_backslash_doubling` verbatim) and wired where hermes runs them:
      inside the orchestrator, between a non-exact strategy win and the
      splice. `runChain` takes the replacement text and refuses with a
      `escape_drift` failure when oldText/newText carry serialization
      artifacts the matched region lacks (literal `\n` for a real line
      break, spurious `\'`/`\"`, doubled backslash runs), so execute() and
      the TUI preview can never diverge on what gets written. Detection is
      structured; texts are built in `errors.ts` from the JSON-probed hermes
      messages (repr formatting included), modulo pi tool names (ledger #10) —
      the param names became verbatim with Tier 2 #5. The
      `TestEscapeDriftGuard` and `TestNewlineLiteralDrift` corpora are
      ported. Spans voted on are the post-non-overlap-filter set (ledger #12
      consequence): only regions that will actually be written may veto.
- [x] Tier 2 #5: the surface **is** hermes' — `path` + `old_string` + `new_string` +
      optional `replace_all`, exactly one replacement per call (§6 item 1). The
      transitional `edits[]` schema is retired: a call that still sends it is
      refused with a teaching error rather than partially applied (ledger #14),
      while a *single-entry* `edits[]`, pi's param spellings
      (`oldText`/`newText`/`replaceAll`, camelCase, `file_path`) and string
      booleans are still flattened by `preparePatchArguments` — the
      `schema_sanitizer` analog (ledger #8), now idempotent and re-run inside
      `execute()` so the gates can't be skipped by an SDK/preview caller.
      hermes' handler gates run in hermes' order (`path required` →
      `old_string and new_string required` → empty/whitespace-only/identical →
      unknown mode), `''` deletes the matched text; the unadvertised
      `mode`/`patch` params are accepted from any model (at the time of landing
      answered "not available in this build" — V4A went live with Tier 3
      #9/#10). Prompt
      contribution, TUI renderer (preview runs the same normalized call) and the
      whole test corpus moved with it; the replace-mode error texts are now
      byte-exact Appendix B modulo pi tool names (ledger #10) — that closes most
      of Tier 2 #7, the rest rides on #6 and Tier 3.
- [x] Tier 2 #6: failure counter + escalation (`src/failure-tracker.ts` —
      hermes `_patch_failure_tracker`/`_record_patch_failure`/
      `_reset_patch_failures` verbatim, including the 64-path cap with oldest
      eviction; keyed by resolved path alone since pi has no task registry,
      ledger #4). Only plain no-match errors count (hermes' "Could not find"
      substring gate keeps ambiguity/escape-drift/replace_all refusals out),
      recording is replace-mode-only by construction (validateCall refuses
      every other mode; V4A misses must keep bypassing it when Tier 3 lands),
      success — including the already-applied no-op, which flows through
      hermes' success branch — resets the per-path streak, failure #3+ injects
      the "stop retrying" escalation verbatim (`{path!r}` repr included,
      `write_file`→`write` per ledger #10), and below the threshold the
      generic `_hint` attaches whenever the error carries no "Did you mean"
      snippet. Hints ride inside the message text (ledger #6). The TUI preview
      deliberately never touches the tracker — only execute() counts.
      *Complete since Tier 3 #9/#10:* the patch-mode texts (`patch content
      required`, the traversal veto, the validation/apply wrappers) are
      byte-exact too.

- [x] Tier 3 #8: `patch_parser.py` ported verbatim (`src/v4a.ts`). `parseV4APatch`
      (markers column-0-anchored so content that merely mentions the format can't
      truncate a patch; CRLF-tolerant; empty-path / UPDATE-without-hunks /
      MOVE-destination parse errors accumulate into one `Parse error: …`), then the
      two-phase apply (`applyV4AOperations`): validate EVERYTHING first against a
      simulation overlay (Move-then-Update, Delete-then-Add, Add-after-Delete), and
      only then write — a validation failure modifies nothing, an apply-phase
      failure carries the "run `git diff`" note. Update hunks go through the shared
      `fuzzyFindAndReplace` — hermes' `fuzzy_find_and_replace` orchestrator entry,
      now in `chain.ts` so BOTH surfaces call it (replace mode's
      `applyReplacement` delegates to it too) — with the ±500/+2000 context-hint
      window retry for validate/apply races, addition-only hint insertion
      (`_insert_addition_only`), and the already-applied skip mirroring
      validation's on both phases. Delete/Move emit real `difflib.unified_diff`
      output: `get_grouped_opcodes` + `_format_range_unified` ported onto the (now
      element-agnostic) `SequenceMatcher`, golden-checked against CPython
      (hunk grouping, range formatting, trailing-newline handling); differential
      fuzz re-run after the generalization (2 seeds × 500, char- and line-level
      opcodes + grouped opcodes) — clean modulo the documented UTF-16-unit basis
      (astral char-level cases skipped; line elements are code-point-agnostic).
      The `test_patch_parser.py` corpus is ported (parse ops, boundary markers,
      validation atomicity, Add-onto-existing guard, delete diffs incl. the
      `# Deleted:` fallback, duck-typed two-arg write compat + the
      one-call/no-silent-retry contracts, move-then-update, CRLF bodies, BOM
      round trip, LSP diagnostics propagation) plus race-defense tests for the
      window retry and the already-applied mirror. Two faithful adaptations:
      hermes' `inspect.signature` probe for `write_file`'s `pre_content`
      capability became an interface contract (`V4AFileOps.writeFile` always
      receives it — extra args are inert for implementations that ignore them,
      so the single-write/no-retry contracts hold by construction), and moving
      the identical-strings gate inside `fuzzy_find_and_replace` FIXED a latent
      replace-mode deviation: an identical old/new re-send whose text is already
      present (≥ 8 non-blank chars) now returns hermes' success-shaped no-op
      (hermes `_no_match_result` ordering) instead of the teaching error. The
      handler switch-over landed with #9/#10 (ledger #15 rewritten: V4A is live).

- [x] Tier 3 #9: schema layering live. `src/gate.ts` ports hermes
      `_is_openai_family_main` (provider allowlist {openai, openai-chat,
      openai-codex, azure-openai, codex}; slug-after-first-slash prefixes
      {gpt-, gpt., chatgpt, codex, o1, o3, o4, o5}; the `"openai/" in model`
      substring rule; fail-closed on empty identity), fed by the live
      `ctx.model` with the ledger-#9 `PI_PROVIDER`/`PI_MODEL` env fallback.
      Pi has no `dynamic_schema_overrides`, so the layer rides **tool
      re-registration** on `session_start`/`model_select`/`turn_start`: when the
      gate flips on, `patch` re-registers with hermes' layered schema (`mode`
      first, `patch` last, `mode` the only REQUIRED param — descriptions
      verbatim incl. the dual-mode swap-in and the one extra V4A guideline,
      ledger #13 applied to BOTH variants); off-family sessions keep the exact
      base schema and pay zero V4A tokens. The handler accepts both shapes from
      any model regardless of what was advertised (replay compat):
      `validateCall` dispatches exclusively on `mode` in hermes' gate order —
      `Unknown mode:` → (`patch`: `patch content required`) →
      (`replace`: `path required` → `old_string and new_string required` →
      empty/whitespace-only/identical) — and a stray `patch` param on a
      complete replace call still lands the edit.
      Edit-format prompt steering landed alongside (ledger #17):
      `src/edit-guidance.ts` ports hermes `_EDIT_FORMAT_GUIDANCE` /
      `_model_family` (agent/coding_context.py), the SECOND and independent
      V4A teaching mechanism — a one-line guideline keyed on model-id
      substrings (gpt/codex → V4A for ALL edits; known off-family coders →
      replace-first naming `mode='patch'` for genuinely multi-file work;
      unknown → neutral). It rides the same re-registration, so `applyGate`
      now watches (gate, model id) and a steered family supersedes our
      bespoke V4A guideline.

- [x] Tier 3 #10: tool-layer plumbing live (`src/v4a-fs.ts` + the `executeV4ACall`
      tail of `tool.ts`). Header support functions ported from `patch_tool`:
      `_collect_v4a_header_paths` (single + Move headers, content-write vs
      entry split, hermes' `'..'`-traversal veto text via `pyRepr`) with
      hermes' component-based `has_traversal_component` (matches PATH
      components, not substrings), and `_rewrite_v4a_patch_paths_for_host`
      (Update/Add → resolved, Delete/Move → entry path). Locking replaces
      hermes' `ExitStack` of `lock_path`s with nested `withFileMutationQueue`
      over the sorted, de-duplicated resolved paths (deadlock-free by
      construction, ledger #3's mechanism). `createHostV4AFileOps` implements
      the duck-typed `V4AFileOps` against the real FS — synchronous
      read/write, NOT-FOUND answers for absent paths, binary refusal (NUL in
      first 8 KB) in place of hermes' binary-document gate (ledger #4's
      boundary), and BOM/CRLF fidelity on every write (ledger #2). Success
      reports hermes' dict fields in pi text shape: `files_modified` (absolute,
      Move = BOTH endpoints) + `files_created`/`files_deleted` + `resolved_path`
      when single, then the unified diff. V4A misses bypass the failure tracker
      ("V4A misses are rare"), any success resets the touched paths' streaks.

## Build plan (exact-port tiers)

Tiers are ordered by dependency, not by value: the strategy chain (Tier 1) is the matching
core for BOTH modes — V4A Update hunks go through it too (§2.1) — so it stays first even
though V4A is now in scope.

### Tier 1 — replace-mode matching core (the load-bearing port)

- [x] 1. Complete the chain to hermes' 9 strategies: add `whitespace_normalized`,
      `escape_normalized`, `unicode_normalized`, `block_anchor`, `context_aware`, with the
      span-mapping helpers ported verbatim from `fuzzy_match.py` (reference order:
      Appendix A). Uniqueness stays per-strategy, counted in that strategy's space (§3.1).
- [x] 2. `replace_all`, ported as-is: ambiguity counted per-strategy; similarity strategies
      refuse it. (`replaceAll` per edit + flat coercion under the transitional
      surface; hermes' `TestReplaceAll` corpus ported; see ledger #12 for the
      self-overlap guard.)
- [x] 3. Escape-drift guards on every non-exact match (newline-literal, quote-suspect,
      backslash-doubling) before anything is written.
- [x] 4. Replacement shaping completion: `_reindent_replacement` (completed to hermes
      verbatim), unicode-preserving opcode application, conditional `\t`/`\r` unescape
      of `new_string` (exact included). Opcodes come from a verbatim
      `difflib.SequenceMatcher` port (see the Tier 1 #4 status entry — the
      diff-package stand-in is ratio-only).

### Tier 2 — replace-mode surface & recovery parity

- [x] 5. Switch the tool surface to hermes' schema: `path`, `old_string`, `new_string`,
      `replace_all` — one replacement per call (§6 item 1). Keep argument normalization as
      the `schema_sanitizer` analog (ledger #8). Update the prompt contribution, renderers,
      and tests to match. (`preparePatchArguments` flattens single-entry `edits[]` and pi
      spellings, refuses nothing; `validateCall` owns every gate. Multi-entry `edits[]` →
      ledger #14, unadvertised `mode`/`patch` → ledger #15.)
- [x] 6. Failure counter + escalation (session-scoped): per-path consecutive-miss count,
      failure-#3 "stop retrying" hint, reset on success, and the generic below-threshold
      `_hint` whenever no richer "did you mean" snippet is attached (§4).
- [x] 7. Error-text fidelity: Appendix B texts verbatim, modulo tool-name mapping
      (ledger #10). *Replace mode is complete:* all texts (ambiguity +
      locations, replace_all refusal, no-match + hint + whitespace diagnosis,
      already-applied, escape-drift, empty/whitespace-only/identical, the arg
      gates, `Unknown mode:`, plus #6's escalation and generic `_hint`) are
      byte-exact and asserted verbatim in `test/patch.test.ts`; the patch-mode
      parse/validation texts landed with Tier 3 #8/#9/#10 — the ledger is now
      text-complete.

### Tier 3 — V4A patch mode

- [x] 8. Port `patch_parser.py` verbatim: parse → validate → apply; Update hunks through the
      shared chain with the context-hint window retry (−500/+2000 chars); addition-only hint
      insertion; already-applied skip mirroring validation's. (`src/v4a.ts`; the shared
      `fuzzy_find_and_replace` entry lives in `chain.ts` and both surfaces call it;
      `get_grouped_opcodes`/`_format_range_unified` on `shaping.ts`'s SequenceMatcher,
      now element-agnostic. Handler wiring is #9/#10.)
- [x] 9. Schema layering: base schema replace-only; `mode`+`patch` params and the dual-mode
      description layered only when the OpenAI-family gate passes (`PI_PROVIDER`/`PI_MODEL`,
      fail-closed); handler accepts both shapes from any model; `mode` defaults to `replace`.
      (`src/gate.ts` + re-registration, see Tier 3 #9 status entry.)
- [x] 10. Tool-layer plumbing: `..`-traversal rejection in patch headers, sorted per-path
      mutation queueing over all touched files, absolute `files_modified` (+ `resolved_path`
      when single) in the result. (`src/v4a-fs.ts` + `executeV4ACall`, see Tier 3 #10.)

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
| `SequenceMatcher` equivalent | — | Split verdict: `difflib.ratio` (`2·M/T`) is computable from `Diff.diffChars` opcodes (stand-in, blessed for the similarity thresholds — re-validated against the same fixtures), but `get_opcodes()` needed a verbatim CPython port (Tier 1 #4): the greedy jsdiff script is a different edit script, and the unicode-preserving splice writes different text under it |
| Escape-drift guards | ~120 | Low — pure string logic |
| Recovery UX (hints, locations, escalation) | ~150 + failure/read trackers | Low-Medium; trackers are session-scoped state in an extension (fine), pi has no built-in persistence for these |
| Already-applied detection | ~15 | Trivial |
| Reindent + unicode-preserving replacement | ~110 | Moderate — most intricate correctness code in the file |
| Post-write verification | ~30 | Trivial |
| Staleness/read tracking | optional | Medium — hermes' version spans 2 modules + cross-agent registry; a thin read-time vs edit-time check suffices, but compare a version tuple (ino+size+ctime, optionally mtime_ns), not bare mtime — editors/copy tools can preserve mtime |

Under the exact-port goal the replace-mode surface is **one replacement per call** (hermes
semantics) with `replace_all` ported as-is (per-strategy ambiguity counting; similarity
strategies refuse it). The `edits[]` multi-edit schema is retired from `patch`
(§6 item 1, landed in Tier 2 #5); the built-in `edit` tool remains for callers that want it,
and V4A's multi-hunk/multi-file behavior subsumes the batch use case.

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
| 8 | Argument normalization kept (`preparePatchArguments` coercion shim, re-run idempotently inside `execute()`) | platform bonus | analog of hermes' coercion layer (`schema_sanitizer.py`); maps pi/`edit` param spellings and a single-entry `edits[]` onto hermes' flat schema, never invents a replacement; re-running it keeps the gates unreachable from an SDK or preview caller |
| 9 | Model-family gate reads `PI_PROVIDER`/`PI_MODEL` instead of hermes' auxiliary client | environment-forced | same fail-closed semantics (§7, §2.1) |
| 10 | Hint texts name pi's tools (`read`, `grep`, `write`) instead of hermes' (`read_file`, `search_files`, `write_file`) | cosmetic | point the model at tools that exist in this environment |
| 11 | Read/staleness tracking scoped to the pi session, not a cross-agent registry | environment-forced | single-agent process; the version-tuple comparison itself is still ported (Tier 4 #12) |
| 12 | `replace_all` de-duplicates self-overlapping line-window spans (leftmost-greedy, str.replace semantics) instead of splicing them | deliberate improvement | hermes' window rungs can emit overlapping spans under `replace_all` and its reverse-order splice then corrupts the file (e.g. ` a\na` over `a\na\na` → `R`); hermes itself fixed exactly this for `_strategy_exact` ("aligns with str.replace") — the same non-overlap invariant is enforced for every strategy |
| 13 | Base description omits hermes' "Auto-runs syntax checks after editing." promise | environment-forced | pi exposes no lint harness (row #5); advertising it would teach the model to wait for diagnostics that never arrive. The rest of hermes' base description is verbatim |
| 14 | `edits[]` is not a `patch` parameter: a call carrying it (single entry → flattened, several → refused with a teaching error) | deliberate | the transitional multi-edit surface is retired by #5; silently applying the first of several requested replacements would report work that never happened, so the refusal teaches the flat shape and says "do not re-send this call unchanged" |
| 15 | V4A is advertised only when the OpenAI-family gate passes; off-family sessions see the replace-only schema | deliberate (matches hermes) | hermes layers `mode`/`patch` + the dual-mode description via `dynamic_schema_overrides` only for OpenAI-family main models (fail-closed, §2.1/§7) — off-family sessions never pay the V4A SCHEMA tokens. Off-family ≠ V4A-illiterate, though: hermes still TEACHES the dialect to known coder families via its edit-format prompt steering, a separate mechanism keyed on model-id needles (row #17). The **handler** still accepts both shapes from any model (replay compat), dispatches exclusively on `mode` in hermes' gate order, and answers `patch content required` / `Unknown mode:` verbatim; a stray `patch` param on a complete replace call is ignored, exactly like hermes' exclusive mode dispatch |
| 16 | The schema layer rides tool **re-registration** (`session_start`/`model_select`/`turn_start` → `registerTool`), not hermes' per-request `dynamic_schema_overrides` | environment-forced | pi fixes `parameters` at registration; re-registering swaps the live definition when the gate flips. `turn_start` is the belt-and-braces tick for model changes that emit no event. If pi grows dynamic overrides, `applyGate` collapses to them |
| 17 | Edit-format prompt steering (`src/edit-guidance.ts`) ports hermes' `_EDIT_FORMAT_GUIDANCE` needle table, keyed on model-id substrings INDEPENDENT of the schema gate; the replace-family line names `mode='patch'` (V4A) even when the advertised schema omits the param, and a steered family supersedes our bespoke V4A guideline (which survives only for unknown families with the layer advertised) | deliberate (matches hermes) | hermes' coding prompt teaches V4A to off-family coder models for genuinely multi-file edits (agent/coding_context.py) — off-family hermes agents emit V4A despite the replace-only schema and the handler accepts those calls by design; observed in practice and verified against the checkout 2026-10. Guideline texts verbatim modulo ledger #10 tool names (`write_file`→`write`) |
