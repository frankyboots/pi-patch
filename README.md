# pi-patch

A [pi](https://github.com/earendil-works/pi) extension that registers a **`patch`** tool — an
**exact port of the hermes `patch` tool** (dual-mode: fuzzy replace + V4A `apply_patch`),
with tolerant 9-strategy matching, teaching errors, and a model-facing diff. It runs
**alongside** the built-in `edit` (never instead of it), so you can A/B the two matching
engines in the same session without hindering abilities.

Background and the full analysis: [docs/EDIT-TOOL-ANALYSIS.md](docs/EDIT-TOOL-ANALYSIS.md).
Build plan, current status, and the deviations ledger: [docs/PLAN.md](docs/PLAN.md).

## Why

Small local models fail `edit` in predictable ways: stripped indentation, margin whitespace churn,
double-escaped JSON drift — and pi's terse "must match exactly" verdicts send them into
re-read/retry spirals. hermes' `patch` converts those same failures into successes (ordered
tolerance chain) or informed second attempts (errors that show the closest sections, the match
locations, and the whitespace diff). This extension ports that tool — exactly, including its
dual-mode surface — onto pi.

## What `patch` does differently from `edit`

| | `edit` (built-in) | `patch` (this extension) |
|---|---|---|
| Matching | exact `indexOf`, one fuzzy fallback, hard stop | ordered chain, hermes' 9 strategies (implemented; PLAN.md Tier 1) |
| Call shape | `edits[]` batch, all-or-nothing | hermes' flat surface: `path` + `old_string` + `new_string` + `replace_all`, **one replacement per call** |
| Uniqueness | counted in normalized space (can false-flag ambiguity) | counted **per strategy**, in that strategy's space |
| Not-found error | "must match exactly" | `Did you mean one of these sections?` + numbered snippets, whitespace visualization (`file has: ····→code`) |
| Ambiguous error | "Found N occurrences" | `Found N matches` + up to 5 `L<line>: snippet` locations |
| Already applied | error-shaped | **success-shaped no-op** ("do not re-send this patch") |
| Diff | UI only | also in model-facing content (self-check loop) |
| Fuzzy replacement | rewrites from normalized base | reindents onto the file's indent; unicode matches keep the file's typographic characters; conditional `\t`/`\r` unescape (exact included) |
| Schema text | "must match exactly" | "tolerates minor whitespace/indentation drift" (per the analysis, the promise matters) |

Kept from pi (each a row in the PLAN.md deviations ledger): LF pre-normalization + BOM/CRLF
handling, `withFileMutationQueue`, constrained sampling, renderer integration, argument
normalization. `patch` speaks hermes' single-replacement surface
(`old_string`/`new_string`/`replace_all`, Tier 2 #5): one replacement per call, with
multi-hunk/multi-file work on the V4A patch mode (Tier 3, live): `mode: "patch"` + a V4A
patch body applies Update/Add/Delete/Move hunks across files, atomically (validate-then-write).
The V4A schema is **advertised only behind hermes' OpenAI-family gate** (provider/model
heuristics, `PI_PROVIDER`/`PI_MODEL` fallback, fail-closed); the handler accepts both call
shapes from any model, so session replays keep working (ledger #15/#16). V4A *teaching* is
separate, like hermes': a model-id needle table (`src/edit-guidance.ts`, hermes
`_EDIT_FORMAT_GUIDANCE`) steers known coder families — GPT/Codex toward V4A for everything,
others toward replace with V4A for genuinely multi-file work — regardless of the gate
(ledger #17).
Models trained on `edit` are still understood — `preparePatchArguments` maps
`oldText`/`newText`/`replaceAll`/`file_path` and a single-entry `edits[]` onto hermes' names —
but a call asking for several replacements is refused, never half-applied (ledger #14). The
built-in `edit` keeps multi-edit batching available.

## Install

```bash
npm install          # dev deps for tests/typecheck
```

**In this project, agents get `patch` by default**: on this box `pi` loads `src/index.ts`
for every session via a global packages entry in `~/.pi/agent/settings.json` (a
machine-local install pointing at this repo). A project-level `.pi/extensions` loader is
deliberately **not** committed: registering the tool from both a global and a project
extension makes pi report a `Tool "patch" conflicts with …` error at startup.

Run directly from anywhere else in development:

```bash
pi --extension /path/to/pi-patch/src/index.ts
```

Or install per user: link/copy this directory into `~/.pi/agent/extensions/pi-patch`
(pi loads directories containing an `index.ts`; runtime deps beyond node builtins are
aliased by pi itself).

## Try it

Give the model the same edit both ways:

- `edit` a line but with the indentation you *remembered* (wrong) → terse failure.
- `patch` the same wrong-indentation `old_string` → matches (line-trimmed tolerance), the
  replacement is re-indented onto the file's style, and the model sees the diff.
- `patch` a genuinely absent text → the error shows the closest sections so the next
  attempt is informed, not blind.
- `patch` an edit that already landed → success-shaped no-op; no turn burned.
- `patch` with `mode: "patch"` → a V4A multi-file patch (Update/Add/Delete/Move) applied
  in one call — advertised on OpenAI-family models, accepted from any model.

## Status

**[docs/PLAN.md](docs/PLAN.md) is the single source for plan state** — the exact-port tier
checklist, validation bar, and the deviations ledger that records every intentional difference
from hermes. Update it as work lands.

Short version: the port is feature-complete through Tier 3. Done: the full 9-strategy chain
(`exact` through `context_aware`, in hermes' order), the escape-drift guards, replacement
shaping (reindent, unicode-preserving opcodes, conditional `\t`/`\r` unescape), hermes'
`replace_all`, hermes' flat surface with hermes' argument gates (Tier 2 #5), teaching errors
byte-exact to Appendix B modulo pi tool names, the already-applied no-op, the model-facing
unified diff + own preview renderer, argument normalization, the failure counter + escalation
(Tier 2 #6), the V4A parser/applier (`src/v4a.ts`, Tier 3 #8 — parse → validate → apply,
Update hunks through the shared chain), the OpenAI-family schema layering (`src/gate.ts`,
Tier 3 #9 — base schema stays replace-only; the `mode`/`patch` layer re-registers when the
gate passes), and the V4A tool-layer plumbing (`src/v4a-fs.ts`, Tier 3 #10 — header traversal
veto, sorted mutation queueing, absolute `files_modified`), plus operational parity:
post-write verification (`src/verify.ts`, Tier 4 #11 — hermes' sha256 re-hash +
full re-read persistence gates) and read-time version stamps with edit-time
staleness warnings (`src/staleness.ts`, Tier 4 #12 — hermes' `_edit_warnings`
gate, warn-only, fed from pi's `tool_result` events). Remaining: strategy
telemetry (Tier 4 #13).

## Development

```bash
npm test         # vitest corpus (chain, shaping, diff, tool behaviors)
npm run typecheck
```

Layout:

```
src/index.ts      extension entry — gate-aware `patch` registration + TUI renderers
src/tool.ts       tool definition: hermes' dual-mode surface, arg gates, shaping orchestrator
src/gate.ts       OpenAI-family gate (hermes _is_openai_family_main) deciding V4A advertising
src/edit-guidance.ts edit-format prompt steering (hermes _EDIT_FORMAT_GUIDANCE) keyed on
                  model-id needles, independent of the gate (ledger #17)
src/chain.ts      ordered strategy chain (spans into LF-normalized content)
src/shaping.ts    replacement shaping: conditional \t/\r unescape, unicode-preserving
                  opcodes (verbatim difflib.SequenceMatcher port), reindent, splice
src/v4a.ts        V4A patch parser/applier — parse → validate → apply (hermes patch_parser)
src/v4a-fs.ts     V4A host layer — header collection/rewrite, traversal veto, sorted mutation
                  queueing, real-FS V4AFileOps with BOM/CRLF fidelity
src/errors.ts     teaching error builders (did-you-mean, whitespace viz)
src/failure-tracker.ts  per-path consecutive-miss counter + escalation (hermes tracker)
src/diff-utils.ts display diff + unified patch (pi-compatible formats)
src/verify.ts     post-write persistence gates (hermes sha256 re-hash + re-read, ledger #18)
src/staleness.ts  read-time version stamps + edit-time staleness warnings (hermes
                  _file_metadata/_update_read_timestamp/_check_file_staleness, ledger #19/#20)
src/render.ts     TUI call/result renderers with live preview via our engine
src/text.ts       LF/BOM/CRLF helpers, line index
src/span-map.ts   span-mapping helpers ported verbatim from hermes fuzzy_match.py
```
