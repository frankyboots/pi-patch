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
| Uniqueness | counted in normalized space (can false-flag ambiguity) | counted **per strategy**, in that strategy's space |
| Not-found error | "must match exactly" | `Did you mean one of these sections?` + numbered snippets, whitespace visualization (`file has: ····→code`) |
| Ambiguous error | "Found N occurrences" | `Found N matches` + up to 5 `L<line>: snippet` locations |
| Already applied | error-shaped | **success-shaped no-op** ("do not re-send this patch") |
| Diff | UI only | also in model-facing content (self-check loop) |
| Fuzzy replacement | rewrites from normalized base | reindents onto the file's indent; unicode matches keep the file's typographic characters; conditional `\t`/`\r` unescape (exact included) |
| Schema text | "must match exactly" | "tolerates minor whitespace/indentation drift" (per the analysis, the promise matters) |

Kept from pi (each a row in the PLAN.md deviations ledger): LF pre-normalization + BOM/CRLF
handling, `withFileMutationQueue`, constrained sampling, renderer integration, argument
normalization. The current `edits[]` multi-edit schema is **transitional** — the plan (PLAN.md
Tier 2 #5) switches `patch` to hermes' single-replacement surface
(`old_string`/`new_string`/`replace_all`), with multi-hunk/multi-file work moving to the V4A
patch mode (Tier 3), exactly as in hermes; the built-in `edit` keeps multi-edit available.

## Install

```bash
npm install          # dev deps for tests/typecheck
```

**In this project, agents get `patch` by default**: `.pi/extensions/pi-patch.ts` loads the
extension (from `src/`) for every pi session started here. pi asks for **project trust once**
(`.pi/extensions` triggers it); after that the tool is just there — the system prompt carries
the `patch` guidelines next to `edit`'s.

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
- `patch` the same wrong-indentation `oldText` → matches (line-trimmed tolerance), the
  replacement is re-indented onto the file's style, and the model sees the diff.
- `patch` a genuinely absent text → the error shows the closest sections so the next
  attempt is informed, not blind.
- `patch` an edit that already landed → success-shaped no-op; no turn burned.

## Status

**[docs/PLAN.md](docs/PLAN.md) is the single source for plan state** — the exact-port tier
checklist, validation bar, and the deviations ledger that records every intentional difference
from hermes. Update it as work lands.

Short version: done so far is the full 9-strategy chain (`exact` through `context_aware`, in
hermes' order), teaching errors (did-you-mean sections, whitespace visualization, ambiguity
locations), the already-applied no-op, the model-facing unified diff + own preview renderer,
reindent shaping, hermes' `replace_all` (per-edit `replaceAll` under the transitional
surface), and argument normalization. Remaining: escape-drift guards
+ unicode-preserving replacement (Tier 1), the schema switch to hermes' single-replacement
surface and failure escalation (Tier 2), the V4A `mode:"patch"` port (Tier 3), and
operational parity — post-write verification, staleness tracking, strategy telemetry (Tier 4).

## Development

```bash
npm test         # vitest corpus (chain, shaping, diff, tool behaviors)
npm run typecheck
```

Layout:

```
src/index.ts     extension entry — registers `patch` + renderers
src/tool.ts      tool definition: pi edit skeleton + chain + teaching errors
src/chain.ts     ordered strategy chain (spans into LF-normalized content)
src/shaping.ts   replacement shaping: conditional \t/\r unescape, unicode-preserving
                 opcodes (verbatim difflib.SequenceMatcher port), reindent, splice
src/errors.ts    teaching error builders (did-you-mean, whitespace viz)
src/diff-utils.ts display diff + unified patch (pi-compatible formats)
src/render.ts    TUI call/result renderers with live preview via our engine
src/text.ts      LF/BOM/CRLF helpers, line index
```
