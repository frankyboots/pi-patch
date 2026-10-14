# Edit Tool Analysis: Hermes `patch` vs Pi `edit`

**Date:** 2026-02-14
**Question:** Why do small local models reliably succeed with hermes' edit tool but struggle with pi's? Can we build the same tool for pi?

**Sources examined:**

| | Path |
|---|---|
| pi edit tool | `pi-coding-agent/dist/core/tools/edit.js`, `edit-diff.js` (v1.2.0) |
| pi extension API | `dist/core/agent-session.js` (`_refreshToolRegistry`), `docs/extensions.md`, `dist/index.d.ts` |
| hermes edit tool | `~/.hermes/hermes-agent/tools/file_tools.py` (`patch_tool`, `PATCH_SCHEMA`) |
| hermes matching engine | `tools/fuzzy_match.py` (663 lines), `tools/file_operations.py` (`patch_replace`) |
| hermes support infra | `tools/file_state.py`, `tools/file_tools_read_tracking.py`, `tests/tools/test_fuzzy_match.py` |

---

## 1. Executive summary

The two tools share the same user-visible concept ("find unique text, replace it") but implement it at completely different maturity levels:

- **pi's `edit`** is a **2-strategy** matcher: exact `indexOf`, then one fuzzy fallback (NFKC + trailing-whitespace + smart-quote/dash normalization), then a hard stop. Failure errors are terse and give the model nothing to recover with.
- **hermes' `patch`** is a **9-strategy ordered chain** wrapped in a recovery system: teaching errors with line-numbered "did you mean" snippets, whitespace visualization, double-escape (JSON drift) detection, already-applied no-op detection, retry-loop escalation, re-indentation of replacements, and post-write verification. The model also receives the unified diff of what it just did.

The gap is not "fuzzy matching" as a buzzword — it is that hermes treats **every failure mode of LLM-generated edit arguments as a first-class case** with a tailored response, while pi treats anything short of near-exact input as user error. Small models produce exactly the argument shapes hermes handles (stripped indentation, collapsed whitespace, double-escaped strings, re-sent edits); hermes converts those into successes or informed second attempts. That is the whole difference.

**Port verdict: fully feasible.** pi's extension API allows an extension to register a tool named `edit` that replaces the built-in (extension tools overwrite built-ins by name in `_refreshToolRegistry` — the override `set` is at `agent-session.js:2894`), including its model-facing description, prompt guidelines, and renderer. `withFileMutationQueue` and `createEditToolDefinition` are public exports. Recommended approach: keep pi's multi-edit/overlap/CRLF/BOM/mutation-queue skeleton, port hermes' strategy chain + recovery UX into the matching core. Details and a tiered plan in §8–9.

---

## 2. Tool surface comparison

| Aspect | pi `edit` | hermes `patch` |
|---|---|---|
| Arguments | `path`, `edits[] {oldText, newText}` | `path`, `old_string`, `new_string`, `replace_all` |
| Edits per call | **Multiple** disjoint edits, all matched against the original file, overlap detected | **One** replacement per call (multi-file/multi-hunk via a separate V4A `apply_patch` mode shown only to OpenAI-family models) |
| `replace_all` | ❌ (uniqueness required per edit) | ✅ (restricted to exact/whitespace-tolerant strategies) |
| Malformed-arg recovery | `prepareEditArguments`: JSON-string `edits`, single-object, legacy flat `oldText/newText` | `schema_sanitizer.py` coercion layer |
| Constrained sampling | ✅ strict-prefer JSON schema | ❌ |
| Schema text to model | "Edit a single file using **exact text replacement**… oldText must match a **unique, non-overlapping region**" | "Uses **fuzzy matching (9 strategies)** so minor whitespace/indentation differences won't break it" |
| Result to model | `"Successfully replaced N block(s) in <path>"` — diff goes to UI-only `details` | JSON: `success`, **unified diff**, `files_modified`, `resolved_path`, `lint`, `lsp_diagnostics`, plus `_warning`/`_hint` fields |
| Concurrency | `withFileMutationQueue` per path | Sorted per-path file locks + cross-agent `FileStateRegistry` (read stamps, last-writer tracking) |
| Stale-read detection | ❌ | ✅ warn (read-stamp drift since read — compared as a version tuple `(dev, ino, size, mtime_ns, ctime_ns)`, because editors/copy tools can preserve mtime — windowed `read_coverage` tracking, sibling-agent writes via the cross-agent `FileStateRegistry`) |
| Read-before-write gate | ❌ | `write_file` refuses unread/stale files; `patch` warns only |

Scope note on that last row: "`patch` warns only" refers to the *read-staleness* gate. `patch_tool` still runs hard pre-write safety gates via `_write_precheck_error` (`file_tools.py:769`): sensitive-path denylist, binary-document write guard, protected-instruction-file guard, approval-required gate, and the cross-profile mirror guard. For the pi port these are out of scope (pi handles approval outside the tool), but "no guards" would be the wrong takeaway.

Note the schema texts: pi's description *demands exactness*, hermes' *promises tolerance*. This matters more than it seems — a weak model reading "must match exactly" makes brittle attempts and gets terse rejections; hermes' schema invites the attempt and the implementation backs it up.

---

## 3. The matching pipeline

### 3.1 pi: exact match, one fuzzy fallback, hard stop

`edit-diff.js → applyEditsToNormalizedContent`:

1. LF-normalize both file and `oldText`; strip BOM.
2. `content.indexOf(oldText)` — exact hit wins.
3. Else: `normalizeForFuzzyMatch()` on both sides — NFKC, **trimEnd per line only**, smart quotes → ASCII, dash family → `-`, special spaces → ` `, NFKC — then `indexOf` again in normalized space.
4. Must be unique (`countOccurrences === 1`), edits must not overlap.
5. Anything else → throw.

What pi **cannot** match:

- Leading-indentation differences (`trimEnd` only — a model that strips or shifts indent fails; *this is the single most common small-model failure*)
- Internal whitespace drift (runs of spaces/tabs collapsed, e.g. alignment churn)
- Literal `\n`/`\t` escape artifacts in the arguments
- Leading-whitespace-only differences on the first/last anchor line
- Typographic drift beyond its Unicode map (no NFKC-equivalent mapping back; NBSP etc. covered, but em-dash → `--` expansions are not mapped back to original positions)

When pi's fuzzy path *does* hit, it rewrites the touched lines from the **normalized** base (`applyReplacementsPreservingUnchangedLines`), which silently ASCII-fies smart quotes/dashes and drops trailing whitespace on those lines. Untouched lines keep original bytes.

**A pi quirk not to carry over:** occurrence counting happens in fuzzy-normalized space even when the match was exact — `countOccurrences` normalizes both sides unconditionally, and if *any* edit in a multi-edit call goes fuzzy, *all* edits are re-matched against the fully normalized base. Two regions differing only by smart quotes or trailing whitespace can therefore make a byte-unique `oldText` report "Found 2 occurrences" (false ambiguity). Hermes counts per-strategy — the exact strategy counts exact occurrences — so it cannot produce this false positive. Port rule: count occurrences in the space of the strategy that matched.

### 3.2 hermes: ordered 9-strategy chain (`fuzzy_match.py`)

Each strategy returns spans into the **original** content; the chain stops at the first strategy that yields ≥1 match:

| # | Strategy | Failure mode it rescues |
|---|---|---|
| 1 | `exact` | — (baseline, `replace` semantics) |
| 2 | `line_trimmed` — strip both ends of every line | margin whitespace churn |
| 3 | `whitespace_normalized` — collapse space/tab runs to one space, with exact span mapping back (boundary-space absorption rule) | alignment/spacing drift |
| 4 | `indentation_flexible` — ignore leading indentation entirely | **the classic small-model error**: dropped/shifted indent |
| 5 | `escape_normalized` — literal `\n` `\t` `\r` in the pattern treated as control chars | double-JSON-escaped tool calls |
| 6 | `trimmed_boundary` — strip first/last line only | anchor lines with decorative whitespace |
| 7 | `unicode_normalized` — typographic map (smart quotes, em/en dash, ellipsis, NBSP, minus, space-separator family) + positions mapped back through an orig↔norm index | model "cleans up" typography when copying |
| 8 | `block_anchor` — first+last lines anchor exactly (normalized), middle scored by `SequenceMatcher` ≥ 0.50 (unique candidate) / 0.70 (multiple) | partially-misremembered middle lines |
| 9 | `context_aware` — every non-blank line ≥ 0.80 similarity, first/last anchors | heavily drifted blocks |

Design properties worth copying verbatim:

- **Ordered, fail-fast per strategy**: if a permissive strategy matches *multiple* locations, hermes errors immediately with the location list rather than escalating further. Precision degrades in a controlled direction; it never silently picks the wrong region.
- **`replace_all` is refused for similarity strategies** (`block_anchor`, `context_aware`) — approximate matching is never fanned out across a file.
- **Uniqueness is per-strategy**, same as pi's, but the ambiguity error *shows the matches* (§4).
- **Non-exact matches trigger escape-drift guards** before anything is written (§4).
- The chain is **unit-tested** (57 tests in `tests/tools/test_fuzzy_match.py`) and **instrumented** — `note_edit_match(strategy, miss)` telemetry records which strategy lands in production, so the chain is evidence-tuned, not speculative. The git history shows years of hardening commits (escape-drift newline doubling, Unicode-preservation off-by-ones, per-region opcodes…).

### 3.3 Replacement shaping (only hermes has this)

A fuzzy match means the file region ≠ `old_string` byte-for-byte, so naively splicing `new_string` corrupts style:

- `_reindent_replacement` — re-anchors `new_string`'s base indent onto the file's actual indent, preserving relative nesting (so an unindented model replacement lands correctly inside a nested block).
- `_preserve_unicode_in_replacement` — under strategy 7, the old→new diff is applied as opcodes so each occurrence keeps **its own** typographic characters (a file with em-dashes doesn't get ASCII-fied; each `replace_all` occurrence is handled independently).
- `_maybe_unescape_new_string` — literal `\t`/`\r` converted to real control chars *only when the matched region already contains the real char* (so `sep = "\t"` in source code is left alone; `\n` is deliberately never rewritten to protect string literals).
- CRLF files: hermes detects the file's ending and normalizes the *substituted region* to it — but it matches against raw CRLF content, so bare-LF `old_string`s fail strategies 1/3/4/6 and land via `line_trimmed` (its `strip()` eats `\r`) or the similarity strategies. pi pre-normalizes the file to LF before matching, so *every* strategy works on CRLF files and endings are restored on write. pi's approach is stronger, not equivalent — keep it.
- BOM: hermes strips it too (`patch_replace`, `file_operations.py:1616`), so pi's BOM handling is parity, not an edge — pi's real edge is the CRLF pre-normalization above.

---

## 4. Error reporting & recovery UX — the real differentiator

This is where the tools diverge most, and it's why small models "cruise" on hermes. Every hermes failure is a *teaching moment with data*; pi's are verdicts without evidence.

| Situation | pi's model sees | hermes' model sees |
|---|---|---|
| `old_string` not found | `Could not find the exact text in X. The old text must match exactly including all whitespace and newlines.` | `Could not find match…` **+ "Did you mean one of these sections?"** — the 3 most similar regions as numbered snippets (±2 context lines, line numbers), and if it's a whitespace-shaped miss: `file has: ····→code` vs `you sent: →····code` with "Use the exact whitespace shown in 'file has'." |
| Ambiguous (N matches) | `Found N occurrences… provide more context to make it unique.` | Same refusal, **plus up to 5 `L<line>: <snippet>` rows** naming exactly where the matches are |
| Empty / whitespace-only / identical old & new | (`oldText must not be empty`) | Actionable recovery text (the empty case cites the Kimi cline#13970 loop), "Do not re-send this call unchanged." |
| Edit already applied | `No changes made to X…` (error) | **Success-shaped no-op**: "the edit appears to be already applied… No write performed; do not re-send this patch." — kills the #1 small-model loop without burning a turn |
| Double-escaped arguments (JSON drift) | Not detected — the *corrupted* strings get written into the file | **Escape-drift guard** blocks the write and explains: literal `\n` standing in for real newlines, spurious `\'`/`\"`, every backslash run exactly doubled ("arguments were JSON-escaped one extra time; re-read the file and resend with backslash counts as they appear") |
| Repeated failures on the same file | Nothing — the model is free to loop | Per-path failure counter; **failure #3 injects**: "Stop retrying with variations of the same old_string. (1) re-read fresh, (2) longer unique anchor, (3) write_file the whole region." |
| File changed since model read it | Silent — edit applies against current bytes | `_warning`: "file was modified since you last read it (external edit or concurrent agent)…" |
| Write persistence | Trusted | **Post-write verification**: re-reads the file and confirms intended bytes landed; errors otherwise |
| Syntax breakage | Not checked | Lint delta (only *new* errors introduced) + LSP diagnostics returned in the result |

The failure counter is a small state machine, and both halves matter for the port: **success resets it** (`_reset_patch_failures`, `file_tools.py:1020`), so escalation tracks consecutive misses per path; and **below the threshold** a generic `_hint` ("old_string not found. Use read_file to verify the current content, or search_files to locate the text.") is attached whenever the error doesn't already carry a "Did you mean" snippet (`file_tools.py:1035-1040`).

Two structural asymmetries amplify the table:

1. **pi throws; hermes returns structured JSON with `_hint`/`_warning`.** pi's throw → error result is fine for surfacing, but there is no channel for rich, multi-part recovery guidance, and nothing persists between calls (no counters, no already-applied state).
2. **pi's diff never reaches the model.** `AgentToolResult.details` is UI-only (`pi-agent-core/dist/types.d.ts:373`); the model sees only the success sentence. Hermes' model sees the unified diff of its own edit — a free self-check loop ("that hunk is not what I meant → fix immediately"). For weak models that can't hold the file in their head, this is significant.

---

## 5. Why hermes wins with small models — synthesis

Small models fail at edits in *predictable, enumerable* ways. hermes' design is essentially a taxonomy of those failures with a response for each:

1. **Argument drift** (indent, whitespace, escapes, typography) → strategies 2–7 turn it into a correct match, and replacement shaping (§3.3) keeps the result stylistically correct instead of writing mangled text.
2. **Vague memory of file content** → strategies 8–9 land the intended block; if they can't, "did you mean" snippets rebuild the model's context in one round trip.
3. **Serialization artifacts** (the model can't even express the right bytes) → drift guards catch it *before* corruption and explain exactly how to fix the call.
4. **Loop-prone behavior** (repeat identical calls, re-apply landed edits) → already-applied no-op + failure escalation + explicit "do not re-send" wording break the loop.
5. **No feedback channel** → diff + lint + diagnostics in the result let the model verify without re-reading.

pi, by contrast, has one tolerance layer and then assigns blame ("must match exactly"). Each failed pi edit costs the model a re-read (often of a large file), a re-emit of a large `oldText`, and another chance to fail — a spiral weak models don't escape. hermes either succeeds (strategies), or fails *informatively* (hints), or fails *terminally* (escalation) — all three outcomes are cheap for a weak model.

---

## 6. Where pi is genuinely better

Fair assessment — a port should keep these:

1. **Multi-edit per call with overlap detection.** One round trip for N disjoint changes; hermes' replace mode is one edit per call (its multi-hunk answer, V4A `apply_patch`, is deliberately hidden from non-OpenAI models because it cost ~148 tok/call of schema).
2. **Constrained sampling** (`strict: "prefer"`) on the JSON schema — structurally prevents malformed calls hermes has to sanitize.
3. **Simplicity = predictability.** A single fuzzy fallback has a near-zero false-positive surface. A 9-strategy chain *can* match the wrong region; hermes manages the risk (similarity thresholds tuned from observed mis-matches — the code comment notes 0.10/0.30 thresholds "matched unrelated blocks"), drift guards, and post-write verification, but the risk is real and must be ported with the mitigations, not just the strategies.
4. **BOM/CRLF/LF handling and mutation queue** are solid; reuse them. (Hermes strips BOM in `patch_replace` too, so BOM is parity; pi's actual edge is pre-normalizing CRLF before matching — see §3.3.)
5. **UI rendering integration** (`editRenderers`, details.diff) — keep, while ALSO putting the diff in model-facing content.

---

## 7. Complexity & risk ledger (for the port decision)

| Item | LOC (hermes, py) | Port risk |
|---|---|---|
| Strategy chain core | ~450 (`fuzzy_match.py` incl. span mapping) | Moderate — the span-mapping helpers (`_map_normalized_positions`, `_build_orig_to_norm_map`) are subtle; port with tests, don't reimplement from the table |
| `SequenceMatcher` equivalent | — | No new dependency needed: pi's `edit-diff.js` already imports the `diff` npm package, and `difflib.ratio` (`2·M/T`) is computable from `Diff.diffChars` opcodes (`M` = total matched length). Similarity thresholds must still be re-validated against the same fixtures |
| Escape-drift guards | ~120 | Low — pure string logic |
| Recovery UX (hints, locations, escalation) | ~150 + failure/read trackers | Low-Medium; trackers are session-scoped state in an extension (fine), pi has no built-in persistence for these |
| Already-applied detection | ~15 | Trivial |
| Reindent + unicode-preserving replacement | ~110 | Moderate — most intricate correctness code in the file |
| Post-write verification | ~30 | Trivial |
| Staleness/read tracking | optional | Medium — hermes' version spans 2 modules + cross-agent registry; a thin read-time vs edit-time check suffices, but compare a version tuple (ino+size+ctime, optionally mtime_ns), not bare mtime — editors/copy tools can preserve mtime |

Also plan for pi-specific integration: the chain must run **per edit within `edits[]`, all matched against the same original content** (pi semantics), all-or-nothing, preserving pi's overlap check. `replace_all` does not exist in pi's schema — decide whether to add it (hermes' exact-only restriction makes it safe) or leave it out.

---

## 8. Port feasibility for pi — confirmed

Verified mechanisms:

- **Name override:** `_refreshToolRegistry` (`agent-session.js:2840`; the override `set` is at `:2894`) seeds the registry with built-ins, then `for (const tool of wrappedExtensionTools) toolRegistry.set(tool.name, tool);` — an extension tool named `edit` **replaces** the built-in, and its `promptSnippet`/`promptGuidelines` replace the built-in contributions in the system prompt (the prompt snippet/guideline maps are rebuilt from the same overridden registry, `agent-session.js:2865-2882`).
- **Public API:** `createEditToolDefinition`, `withFileMutationQueue`, `EditOperations` are all exported from `@earendil-works/pi-coding-agent` (`dist/index.d.ts`), so the extension can reuse pi's file plumbing and mutation queue rather than reinventing it.
- **Error channel:** throwing from `execute()` produces a failed tool result with the message; returning `isError: true` keeps data flowable. Either supports the teaching-error texts.
- **Renderer:** `pi.registerToolRenderer((toolName, next) => ...)` chooses renderers for any tool, including not-yet-registered ones; `next()` returns what the remaining resolvers, then the registered tool, would use (`docs/extensions.md:193`).
- **⚠ The TUI preview is hard-wired to the old engine — the port must replace it.** The built-in `editRenderers.renderCall` computes the live preview by calling core's `computeEditsDiff` **directly** (`dist/core/tools/renderers/edit.js:128`), which runs the *built-in* matcher. Reusing the built-in renderer wholesale (the tempting `next() ?? mine`) means previews say "Could not find the exact text…" for edits the new tool would happily land. The extension needs its own `renderCall` that mirrors the built-in component (header, success/error background, diff body) but computes the preview with the new engine — while still populating `details.diff`/`details.firstChangedLine`, because `renderResult` reads exactly those fields.
- **Structured result channel (optional):** `ToolDefinition.outputSchema`/`structuredContent` exists; `structuredContent` is not sent to the model (codemode scripts receive it), so it's a clean channel for a machine-readable lint/diagnostics payload without JSON-in-text.
- **Telemetry:** a `tool_result` handler or in-tool counter writing to a JSONL file reproduces hermes' `note_edit_match` loop.

So: an extension `pi-patch` (fitting this project's name) can ship a drop-in `edit` replacement with zero pi core changes. If it proves itself, upstreaming into `edit-diff.js` is the endgame — the architecture maps cleanly (insert the strategy chain where `fuzzyFindText` currently returns `found:false`).

---

## 9. Recommended build plan

**Tier 1 — biggest win per line, low risk (do first):**
1. Strategy chain entries 2, 4, 6 (`line_trimmed`, `indentation_flexible`, `trimmed_boundary`) — pure line-array comparisons, no span algebra, covers the dominant small-model failure (indent).
2. Teaching errors: ambiguity errors with `L<line>: snippet` locations; no-match error with closest-sections "did you mean" + whitespace visualization.
3. Already-applied no-op (success-shaped), with hermes' conservative guard: fire only when `new_string` (≥ 8 non-blank chars) is present exactly and `old_string` is gone.
4. Put the unified diff into model-facing `content` (keep `details` for the UI).
5. Old_string validation: empty/whitespace-only/identical → actionable text with "do not re-send unchanged".
6. Own preview renderer: mirror the built-in edit `renderCall` but compute the preview with the new engine (the built-in one is hard-wired to core's `computeEditsDiff`, §8); keep `details.diff`/`firstChangedLine` populated for `renderResult`.

**Tier 2 — full hermes parity:**
6. Strategies 3, 5, 7 (`whitespace_normalized`, `escape_normalized`, `unicode_normalized`) with the span-mapping helpers ported from hermes verbatim. Count ambiguity per-strategy, in that strategy's space (pi's normalize-then-count causes false ambiguity, §3.1).
7. Escape-drift guards (newline-literal, quote-suspect, backslash-doubling) before applying any non-exact match.
8. Replacement shaping: `_reindent_replacement` + unicode-preserving opcodes.
9. Strategies 8–9 (similarity) with hermes' 0.50/0.70/0.80 thresholds and `replace_all` exclusion (if `replace_all` is added).
10. Per-path failure counter + escalation hint (extension-session state), including both halves of hermes' state machine: reset-on-success, and the generic below-threshold `_hint` when no richer snippet is attached (§4).

**Tier 3 — operational polish:**
11. Post-write verification re-read.
12. Read-time version capture (ino+size+ctime, not bare mtime) → staleness warning at edit time.
13. Strategy telemetry (JSONL) to drive threshold tuning on *our* traffic.
14. Optional: V4A `mode:"patch"` behind a model-family check, only if OpenAI-family usage justifies the schema tokens.

**Keep from pi:** `edits[]` multi-edit + overlap detection (run the chain per edit against the same snapshot, all-or-nothing), `prepareEditArguments` normalization, LF pre-normalization + BOM/CRLF handling, `withFileMutationQueue`, constrained sampling. The renderer needs a port-specific variant (Tier 1 #6), not a reuse. Adapt hermes' hint texts to pi's tool names: `write_file` → `write`, `read_file` → `read`, `search_files` → `grep`/`find`.

**Validation plan:**
- Port hermes' `tests/tools/test_fuzzy_match.py` corpus (57 cases) to vitest — it encodes years of regression history; passing it is the port's acceptance bar.
- Add a differential fixture: every case where pi's current tool returns `found:false` should be enumerated and asserted as matched by the new chain (or intentionally still rejected, e.g. escape-drift).
- A/B on small local models (pi's llama.cpp provider path): metrics = edit success per call, retries per landed edit, turns per successful edit session, corruption incidents (should remain zero).
- Ship behind the extension first; promote into core `edit-diff.js` after the metrics agree.

---

## 10. Appendix A — hermes strategy chain, reference ordering

```
exact → line_trimmed → whitespace_normalized → indentation_flexible
      → escape_normalized → trimmed_boundary → unicode_normalized
      → block_anchor → context_aware
```
- First strategy with ≥1 match wins; >1 match (and no `replace_all`) → ambiguous error with locations (no fall-through).
- Similarity strategies (8–9) refuse `replace_all`.
- Non-exact match ⇒ drift guards ⇒ unescape `\t`/`\r` conditionally ⇒ reindent / preserve unicode ⇒ splice.
- Telemetry records the landing strategy; misses recorded as `ambiguous | no_match`.

## Appendix B — key error-message catalog (hermes, abridged)

- *Ambiguous:* "Found N matches for old_string. Provide more context to make it unique, or use replace_all=True. Matches:\n  L42: def foo(…)\n  L107: …"
- *No match:* "…\n\nDid you mean one of these sections?\n 412| def apply_v4a(…)\n---\n 418| …\n\nWhitespace difference detected (→ = tab, · = space):\n  file has: ····→return x\n  you sent: →····return x\nUse the exact whitespace shown in 'file has'."
- *Newline drift:* "Escape-drift detected: old_string contains more literal '\\n' sequences than the matched region… almost always a tool-call serialization artifact… Re-read the file and pass old_string/new_string with actual line breaks…"
- *Backslash doubling:* "…every backslash run in old_string is exactly twice as long as in the matched region… arguments were JSON-escaped one extra time…"
- *Escalation:* "This is failure #3 patching 'x.py'. Stop retrying with variations of the same old_string. Either (1) re-read the file fresh…, (2) use a longer / more unique old_string…, or (3) use write_file…"
- *Already applied:* "File already contains the target text — the edit appears to be already applied… No write performed; do not re-send this patch."
