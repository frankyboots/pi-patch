# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

**pi-patch** is a [pi](https://github.com/earendil-works/pi) extension that registers a
**`patch`** tool — an **exact port of the hermes `patch` tool**: same dual-mode surface
(`replace` + V4A `apply_patch`, analysis §2.1), same 9-strategy tolerant matching chain,
same teaching errors, same model-facing diff. It runs **alongside** the built-in `edit`,
never instead of it, so the two engines can be A/B tested in one session (deviations
ledger #1).

The factual reference is [docs/EDIT-TOOL-ANALYSIS.md](docs/EDIT-TOOL-ANALYSIS.md)
(hermes `patch` vs pi `edit` — what each tool does and why). [docs/PLAN.md](docs/PLAN.md) is
the living plan used to keep state during development: the exact-port build tiers, the
validation bar, and the **deviations ledger** — every place we intentionally differ from
hermes must have a row there. Read both before changing matching behavior or error formats —
the README's comparison table summarizes the intent.

**This repo dogfoods the extension**: `.pi/extensions/pi-patch.ts` loads it for every pi
session started here, so agents have `patch` available by default (alongside `edit`).
That loader is a thin re-export of `src/index.ts` — never put implementation there; `src/`
is the single source of truth. Agents are expected to actually *use* it — see the
dogfooding policy below.

## Dogfooding policy — `patch` is the daily driver

Both `patch` and `edit` stay operational at all times (that coexistence is the point —
deviations ledger #1). When working in this repo, treat **`patch` as your default tool for
file edits** and `edit` as the fallback:

- **Reach for `edit` only when you must finish work that `patch` can't do** — e.g. a
  suspected tool bug — multi-hunk/multi-file edits go through `mode:"patch"` (V4A)
  when it is advertised. Switching is always allowed; never let a `patch` failure
  block the task.
- **If `patch` fails or misbehaves — wrong match, wrong shaping, spurious ambiguity,
  unhelpful error, render glitch — log it** in [docs/DOGFOOD.md](docs/DOGFOOD.md): what you
  attempted, the error or wrong result verbatim, expected vs actual, and the strategy you
  expected to match. Then carry on with whatever tool completes the job.
- **Diagnose before you log.** A miss is usually *your* context, not the engine: after a
  session compaction, the file copy in your head may be a summary of what you meant to write,
  not what is on disk — re-read the target (or trust the `file has: …` lines in the error)
  before filing a `patch` bug.
- **Fixed dogfood bugs become regression tests** in `test/patch.test.ts`, named after the
  failure mode (see Testing notes).

## Commands

```bash
npm install          # install dev deps (vitest, typescript, pi SDK stubs)
npm test             # vitest run — full corpus
npm run typecheck    # tsc --noEmit
npx vitest run -t "reindent"   # single test by name
```

Run both `npm test` and `npm run typecheck` before declaring work done. There is no build
step — pi runs the TypeScript source directly.

Ported matching code is differentially tested against the real hermes implementation: when
touching span-mapping or strategy logic, regenerate the golden corpus
(`python3 scripts/generate_span_map_golden.py > test/golden/span-map.json`) and make the
golden suite green; `GOLDEN_SEED=<n>` re-validates on fresh fuzz beyond the committed
corpus. The corpus is BMP-only — Python code-point indices must equal JS UTF-16 unit
indices for the recorded spans to be comparable (astral pass-through has a dedicated unit
test).

## Layout

```
src/index.ts     extension entry — gate-aware `patch` registration + TUI renderers
                 (re-registers the tool when the OpenAI-family gate flips)
src/tool.ts      tool definition (hermes' dual-mode surface) + arg gates + shaping orchestrator
src/gate.ts      OpenAI-family gate — port of hermes `_is_openai_family_main` + the
                 PI_PROVIDER/PI_MODEL fallback; decides whether V4A is ADVERTISED
                 (the handler accepts both shapes from any model regardless)
src/edit-guidance.ts  edit-format prompt steering — port of hermes
                 `_EDIT_FORMAT_GUIDANCE`/`_model_family` needle table (ledger #17); keys
                 the V4A guideline on model-id substrings INDEPENDENT of the gate, so
                 known off-family coder models are still taught V4A for multi-file work
src/chain.ts     ordered strategy chain (matches on LF-normalized content, returns spans)
src/escape-drift.ts  escape-drift guards — port of hermes `_detect_escape_drift` (blocks
                 the write when args carry serialization artifacts the file lacks)
src/shaping.ts   replacement shaping — conditional \t/\r unescape, unicode-preserving
                 opcodes (verbatim difflib.SequenceMatcher port), reindent, splice
                 (ports of hermes' orchestrator-tail shaping helpers)
src/errors.ts    teaching error builders (did-you-mean, whitespace viz, recovery text)
src/failure-tracker.ts  session-scoped consecutive-failure counter + escalation — port of
                 hermes `_patch_failure_tracker` (Tier 2 #6); keyed by resolved path
                 (ledger #4), 64-path cap, replace-mode misses only
src/diff-utils.ts  display diff + unified patch (pi-compatible formats)
src/verify.ts   post-write persistence gates — ports of hermes `_verify_written_hash`
                 (sha256 re-hash, verified=None when unhashable) + `_verify_patch_persisted`
                 (exact-byte re-read, BOM/CRLF-tolerant compare) (Tier 4 #11, ledger #18)
src/v4a.ts       V4A patch parser/applier — port of hermes `patch_parser.py` (parse →
                 validate → apply, Tier 3 #8); duck-typed `V4AFileOps` so tests run
                 in-memory
src/v4a-fs.ts    V4A host layer (Tier 3 #10) — header path collection + `'..'`-traversal
                 veto, header rewriting to resolved paths, nested `withFileMutationQueue`
                 over sorted-deduped lock paths, real-FS `V4AFileOps` (BOM/CRLF fidelity,
                 binary refusal)
src/render.ts    TUI call/result renderers with live preview (uses OUR engine)
src/text.ts      LF/BOM/CRLF helpers, line index
src/span-map.ts  span-mapping helpers ported verbatim from hermes `fuzzy_match.py`
test/patch.test.ts  single vitest file covering chain, shaping, V4A, errors, and tool behavior
test/golden/     generated golden corpus — reference outputs from the hermes
                 implementation (do not hand-edit; see scripts/ to regenerate)
scripts/         generate_span_map_golden.py — regenerates test/golden against
                 ~/.hermes/hermes-agent (override checkout with HERMES_HOME,
                 fuzz seed with GOLDEN_SEED); requires python3 but tests don't
```

## Architecture & invariants

These behaviors are deliberate — preserve them unless the task says otherwise. The goal is
fidelity to hermes `patch` (analysis §1): when pi-patch and hermes disagree, either match
hermes or add a row to PLAN.md's deviations ledger.

- **Strategy chain order follows hermes (analysis Appendix A)**:
  `exact → line_trimmed → whitespace_normalized → indentation_flexible → escape_normalized →
  trimmed_boundary → unicode_normalized → block_anchor → context_aware`. All nine are
  implemented and differentially tested — never reorder or "simplify" the chain.
  Matching runs on LF-normalized content (ledger #2: a deliberate improvement over hermes'
  raw-byte matching) and reports spans into that normalized content; the tool layer maps
  spans back to the original file bytes.
- **Uniqueness is per strategy**, counted in that strategy's space (this fixes pi's
  false-ambiguity regression where two regions differing only by smart quotes flag as
  ambiguous — and matches hermes). Don't "simplify" this into a single global uniqueness check.
- **Tool surface is hermes' single-replacement surface** (Tier 2 #5): `path` +
  `old_string` + `new_string` + optional `replace_all`, **exactly one replacement per
  call**, hermes' gates in hermes' order: `Unknown mode:` → `patch content required`
  (patch mode) → multi-entry `edits[]` refusal → `path required` →
  `old_string and new_string required` at validation; the empty/whitespace-only/identical
  gates are enforced at replace execution (chain entry).
  `new_string: ""` deletes the matched text. The transitional `edits[]` schema is retired:
  `preparePatchArguments` (ledger #8) still flattens a *single-entry* `edits[]` and maps pi's
  `oldText`/`newText`/`replaceAll`/`file_path` spellings onto hermes' names, but a multi-entry
  call is refused with a teaching error rather than half-applied (ledger #14). Don't add
  features that assume batching — multi-hunk/multi-file work belongs to V4A (Tier 3).
  (`replace_all` landed as Tier 1 #2 with hermes' semantics: every match of the winning
  strategy splices, similarity strategies refuse it; see ledger #12 for the self-overlap
  guard hermes lacks.)
- **V4A patch mode is live behind hermes' gate** (Tier 3 #9/#10): the base schema stays
  replace-only; the `mode`/`patch` params and the dual-mode description are layered onto
  the SCHEMA only when `src/gate.ts` says the main model is OpenAI-family (fail-closed;
  `PI_PROVIDER`/`PI_MODEL` env fallback when there is no live model info — ledger #9).
  V4A *teaching* is a second, independent surface (hermes `_EDIT_FORMAT_GUIDANCE`,
  `src/edit-guidance.ts`, ledger #17): a model-id needle table keys a steering guideline
  regardless of the gate, so known off-family coder models are still taught V4A for
  genuinely multi-file work (a steered family supersedes our generic V4A guideline).
  Gate-closed harnesses validate tool calls against the base schema — a V4A call from
  such a session must also carry an (ignored, per hermes' exclusive mode dispatch)
  `old_string`/`new_string` pair to satisfy the harness-side schema check.
  Pi has no `dynamic_schema_overrides`, so the layer rides **tool re-registration** on
  `session_start`/`model_select`/`turn_start` (ledger #16). The handler accepts both call
  shapes from any model regardless of what was advertised (replay compat) and dispatches
  exclusively on `mode` in hermes' gate order (`Unknown mode:` → `patch content required` →
  the replace gates); a stray `patch` param on a complete replace call is ignored, like
  hermes' exclusive dispatch. Execute-path order for `mode:"patch"`: collect header paths +
  traversal veto → resolve → rewrite headers to absolute paths → sorted-deduped nested
  `withFileMutationQueue` → `applyV4APatch` (two-phase validate-then-write, Update hunks
  riding the shared chain via `fuzzyFindAndReplace`) → reset the failure tracker for the
  touched paths → report absolute `files_modified` (+ `resolved_path` when single). V4A
  misses bypass the failure tracker (hermes: "V4A misses are rare") — never wire them in.
- **Already-applied no-op is success-shaped** ("do not re-send this patch"), with a
  conservative guard: `new_string` ≥ 8 non-blank chars present exactly and `old_string` gone.
  Keep it conservative — it must never mask a real partial application.
- **Errors teach**: no-match errors include did-you-mean sections with whitespace
  visualization (`file has: ····→code`); ambiguity errors list up to 5 `L<line>: snippet`
  locations. Target hermes' texts verbatim (analysis Appendix B), modulo pi tool names
  (ledger #10). Error text is model-facing API — changes to it are behavior changes.
- **Repeated misses escalate** (Tier 2 #6, `src/failure-tracker.ts`): plain "Could not
  find" replace-mode misses increment a per-resolved-path consecutive count; failure #3
  appends hermes' "stop retrying" hint (below the threshold a generic hint attaches only
  when the error carries no "Did you mean" section). Any successful patch — including the
  already-applied no-op — resets the path. Ambiguity, escape-drift and identical-strings
  errors never count (they explain themselves); post-write verification failures
  neither count nor reset (no "Could not find" — hermes counts them neither);
  V4A misses bypass the tracker entirely.
  Keyed by resolved path alone, session-scoped (ledger #4); 64-path cap ported verbatim.
- **Post-write verification gates every write** (Tier 4 #11, `src/verify.ts`,
  ledger #18): after the write and still inside the mutation queue, replace mode
  runs hermes' two gates in order — `verifyWrittenHash` (its failure wrapped as
  `Failed to write changes: …`, exactly how hermes' `patch_replace` wraps
  write_file errors) then `verifyPatchPersisted` (verbatim error); V4A Add/Update
  writes ride the hash gate inside the host `writeFile` (hermes' `file_ops.write_file`
  analog), surfaced verbatim through `patch_parser`'s apply wrapper. A read-back
  that cannot be taken is hermes' `verified=None`: the write stands, unverified —
  verification must never break a good write. Test seams: `operations`
  (incl. `readExact`) on `createPatchToolDefinition`, `HostFs` on
  `createHostV4AFileOps` — the analog of hermes' mockable shell transport.
- **Replacement shaping** (`src/shaping.ts`, hermes orchestrator tail): every match gets
  the conditional `\t`/`\r` unescape over its matched regions (exact included — issue
  #33733; `\n` never rewritten); tolerant matches then re-indent onto the file's indent
  style, and `unicode_normalized` matches apply only the old→new opcodes so each region's
  original typographic characters survive. Opcode plans come from the verbatim
  `difflib.SequenceMatcher` port — never swap in the `diff`-package opcodes (different
  edit script → different written text).
- **File fidelity**: pre-normalize LF, restore BOM and CRLF on write; writes go through
  `withFileMutationQueue`. The schema strings intentionally promise tolerance ("tolerates
  minor whitespace/indentation drift") — keep that promise in the implementation.
- **Renderers use our engine** (`generateDiffString`/`generateUnifiedPatch`), not core's
  `computeEditsDiff`, so the preview always reflects what `patch` actually matched.

## Code conventions

- TypeScript strict, ES2022, ESM. Imports of relative files use explicit `.js` extensions.
- Tabs for indentation; keep files JSDoc-commented at the top with a one-paragraph purpose.
- No runtime deps beyond `diff` (and node builtins); pi SDK types come from
  `@earendil-works/pi-coding-agent`. Node >= 20.
- Public behavior changes get tests in `test/patch.test.ts` (match strategy selection,
  shaping, error payloads, and real-file round trips are all covered there — follow suit).

## Testing notes

- Tool tests execute against real temp files (see `describe("tool: execute against real files")`)
  — cover BOM/CRLF preservation and the no-write-on-failure path when touching the tool layer.
- When fixing a matching bug, add a regression test named after the failure mode
  (e.g. `"...survives the pi false-ambiguity regression..."`).
