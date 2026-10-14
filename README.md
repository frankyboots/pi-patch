# pi-patch

A [pi](https://github.com/earendil-works/pi) extension that registers a **`patch`** tool — a drop-in
alternative to the built-in `edit` tool with hermes-style tolerant matching, teaching errors, and a
model-facing diff. It runs **alongside** `edit` (never instead of it), so you can A/B the two
matching engines in the same session without hindering abilities.

Background and the full analysis: [docs/EDIT-TOOL-ANALYSIS.md](docs/EDIT-TOOL-ANALYSIS.md).

## Why

Small local models fail `edit` in predictable ways: stripped indentation, margin whitespace churn,
double-escaped JSON drift — and pi's terse "must match exactly" verdicts send them into
re-read/retry spirals. hermes' `patch` converts those same failures into successes (ordered
tolerance chain) or informed second attempts (errors that show the closest sections, the match
locations, and the whitespace diff). This extension ports that design onto pi's edit-tool skeleton.

## What `patch` does differently from `edit`

| | `edit` (built-in) | `patch` (this extension) |
|---|---|---|
| Matching | exact `indexOf`, one fuzzy fallback, hard stop | ordered chain: `exact → line_trimmed → indentation_flexible → trimmed_boundary` |
| Uniqueness | counted in normalized space (can false-flag ambiguity) | counted **per strategy**, in that strategy's space |
| Not-found error | "must match exactly" | `Did you mean one of these sections?` + numbered snippets, whitespace visualization (`file has: ····→code`) |
| Ambiguous error | "Found N occurrences" | `Found N matches` + up to 5 `L<line>: snippet` locations |
| Already applied | error-shaped | **success-shaped no-op** ("do not re-send this patch") |
| Diff | UI only | also in model-facing content (self-check loop) |
| Fuzzy replacement | rewrites from normalized base | reindents the replacement onto the file's indent, file bytes kept |
| Schema text | "must match exactly" | "tolerates minor whitespace/indentation drift" (per the analysis, the promise matters) |

Kept from pi's edit tool: multi-edit per call (all-or-nothing, matched against the same snapshot),
overlap detection, LF pre-normalization + BOM/CRLF handling, `withFileMutationQueue`, argument
normalization (JSON-string edits / single object / legacy flat args), constrained sampling.

## Install

```bash
npm install          # dev deps for tests/typecheck
```

Run directly in development:

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

## Status vs the plan (docs/EDIT-TOOL-ANALYSIS.md §9)

- [x] Tier 1: strategies `exact`, `line_trimmed`, `indentation_flexible`, `trimmed_boundary`
- [x] Teaching errors: ambiguity locations, did-you-mean sections, whitespace visualization,
      empty/identical validation with "do not re-send"
- [x] Already-applied no-op (conservative: `newText` ≥ 8 chars present exactly, `oldText` gone)
- [x] Model-facing unified diff + `details` diff for the TUI
- [x] Own preview renderer (computes the preview with **our** engine, not core's `computeEditsDiff`)
- [ ] Tier 2: `whitespace_normalized`, `escape_normalized`, `unicode_normalized` (+ span mapping),
      escape-drift guards, unicode-preserving replacement opcodes, per-path failure escalation
- [ ] Tier 3: post-write verification re-read, staleness tracking, strategy telemetry (JSONL)

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
src/shaping.ts   reindent-replacement (port of hermes _reindent_replacement)
src/errors.ts    teaching error builders (did-you-mean, whitespace viz)
src/diff-utils.ts display diff + unified patch (pi-compatible formats)
src/render.ts    TUI call/result renderers with live preview via our engine
src/text.ts      LF/BOM/CRLF helpers, line index
```
