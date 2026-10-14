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
is the single source of truth.

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
src/index.ts     extension entry — registers `patch` + TUI renderers
src/tool.ts      tool definition (transitional edits[] surface) + chain + teaching errors
src/chain.ts     ordered strategy chain (matches on LF-normalized content, returns spans)
src/shaping.ts   reindentReplacement — port of hermes `_reindent_replacement`
src/errors.ts    teaching error builders (did-you-mean, whitespace viz, recovery text)
src/diff-utils.ts  display diff + unified patch (pi-compatible formats)
src/render.ts    TUI call/result renderers with live preview (uses OUR engine)
src/text.ts      LF/BOM/CRLF helpers, line index
src/span-map.ts  span-mapping helpers ported verbatim from hermes `fuzzy_match.py`
test/patch.test.ts  single vitest file covering chain, shaping, diff, and tool behavior
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
  trimmed_boundary → unicode_normalized → block_anchor → context_aware`. The first four are
  implemented; add the missing five in hermes' order — never reorder or "simplify" the chain.
  Matching runs on LF-normalized content (ledger #2: a deliberate improvement over hermes'
  raw-byte matching) and reports spans into that normalized content; the tool layer maps
  spans back to the original file bytes.
- **Uniqueness is per strategy**, counted in that strategy's space (this fixes pi's
  false-ambiguity regression where two regions differing only by smart quotes flag as
  ambiguous — and matches hermes). Don't "simplify" this into a single global uniqueness check.
- **Tool surface is transitional**: `patch` currently exposes pi's `edits[]` multi-edit
  schema (all-or-nothing against one snapshot, overlap detection). The exact-port target is
  hermes' single-replacement surface — `old_string`/`new_string`/`replace_all`, one
  replacement per call, multi-hunk/multi-file work moving to the V4A patch mode (PLAN.md
  Tier 2 #5 / Tier 3). Until that reschema lands, keep the multi-edit semantics intact
  and don't build new features that assume it.
- **V4A patch mode is in scope, not optional**: `patch` must grow `mode:"patch"` with
  hermes' schema layering (advertised to OpenAI-family models only, fail-closed; accepted
  from any model) — analysis §2.1, PLAN.md Tier 3.
- **Already-applied no-op is success-shaped** ("do not re-send this patch"), with a
  conservative guard: `newText` ≥ 8 non-blank chars present exactly and `oldText` gone.
  Keep it conservative — it must never mask a real partial application.
- **Errors teach**: no-match errors include did-you-mean sections with whitespace
  visualization (`file has: ····→code`); ambiguity errors list up to 5 `L<line>: snippet`
  locations. Target hermes' texts verbatim (analysis Appendix B), modulo pi tool names
  (ledger #10). Error text is model-facing API — changes to it are behavior changes.
- **Replacement shaping**: for tolerant (non-exact) matches, the replacement is re-indented
  onto the file's indent style; for exact matches, replacement bytes are kept verbatim.
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
