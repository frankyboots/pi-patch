# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

**pi-patch** is a [pi](https://github.com/earendil-works/pi) extension that registers a
**`patch`** tool — a drop-in alternative to the built-in `edit` tool with hermes-style
tolerant matching, teaching errors, and a model-facing diff. It runs **alongside** `edit`,
never instead of it, so the two matching engines can be A/B tested in one session.

The design source of truth is [docs/EDIT-TOOL-ANALYSIS.md](docs/EDIT-TOOL-ANALYSIS.md)
(hermes `patch` vs pi `edit`); §9 contains the tiered build plan. Read it before changing
matching behavior or error formats — the README's comparison table summarizes the intent.

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

## Layout

```
src/index.ts     extension entry — registers `patch` + TUI renderers
src/tool.ts      tool definition: pi edit-tool skeleton + chain + teaching errors
src/chain.ts     ordered strategy chain (matches on LF-normalized content, returns spans)
src/shaping.ts   reindentReplacement — port of hermes `_reindent_replacement`
src/errors.ts    teaching error builders (did-you-mean, whitespace viz, recovery text)
src/diff-utils.ts  display diff + unified patch (pi-compatible formats)
src/render.ts    TUI call/result renderers with live preview (uses OUR engine)
src/text.ts      LF/BOM/CRLF helpers, line index
test/patch.test.ts  single vitest file covering chain, shaping, diff, and tool behavior
```

## Architecture & invariants

These behaviors are deliberate — preserve them unless the task says otherwise:

- **Strategy chain order**: `exact → line_trimmed → indentation_flexible → trimmed_boundary`.
  Matching runs on LF-normalized content and reports spans into that normalized content;
  the tool layer maps spans back to the original file bytes.
- **Uniqueness is per strategy**, counted in that strategy's space (this fixes pi's
  false-ambiguity regression where two regions differing only by smart quotes flag as
  ambiguous). Don't "simplify" this into a single global uniqueness check.
- **All-or-nothing multi-edit**: all `edits[]` match against the same file snapshot, with
  overlap detection; nothing is written unless every edit matches.
- **Already-applied no-op is success-shaped** ("do not re-send this patch"), with a
  conservative guard: `newText` ≥ 8 non-blank chars present exactly and `oldText` gone.
  Keep it conservative — it must never mask a real partial application.
- **Errors teach**: no-match errors include did-you-mean sections with whitespace
  visualization (`file has: ····→code`); ambiguity errors list up to 5 `L<line>: snippet`
  locations. Error text is model-facing API — changes to it are behavior changes.
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
