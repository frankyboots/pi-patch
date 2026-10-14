# Historical baseline — `edit` vs `patch`, mined from pi session transcripts

**What this is.** Observational evidence for the retirement decision (PLAN Tier 4 #13 /
the "remove `edit`" step), produced *before* any new instrumentation exists. pi writes
every session to `~/.pi/agent/sessions/`, so every past `edit` and `patch` call — with its
arguments, its `isError` outcome, the model that made it, and its neighbours in the
transcript — is already on disk. `scripts/session_baseline.py` pairs each `toolCall` with
its `toolResult` and reports the rates below.

```bash
python3 scripts/session_baseline.py --project pi-patch        # headline report
python3 scripts/session_baseline.py --project pi-patch --failures patch   # verbatim failures
python3 scripts/session_baseline.py --json                    # per-call records
```

## Corpus

| | |
|---|---|
| sessions scanned | 30 files, 20 with edit-engine calls |
| window | 2026-10-13 23:49 → 2026-10-14 16:30 UTC (~17 h of dogfooding) |
| edit-engine calls | 342 total → **306 real** (edit 118, patch 188) after excluding 36 calls against `/tmp` scratch files |
| models | `Qwen3.8-Flash-Next`, `hf:zai-org/GLM-5.3-Flash`, `Qwen/Qwen3.8-27B-NVFP4`, `Qwen/Qwen3.8-Flash-Next` |

Excluded by default: *harness* traffic (calls on `/tmp/*` — the agent deliberately sending
bad anchors while developing the engine: 36 calls, 14 failed, 7 per engine). Including it
would widen the gap rather than flatter the port (edit 22/129 = 17.1 % vs patch 16/213 =
7.5 %), but it mixes deliberate negative tests into real work. `--include-harness` adds it
back.

## Headline — failed calls

| tool | calls | failed | rate |
|---|---|---|---|
| `edit` (pi built-in) | 118 | 15 | **12.7 %** |
| `patch` (this port) | 188 | 9 | **4.8 %** |

2.6× fewer failed calls; absolute gap **7.9 pp** (95 % CI 1.2–14.7 pp), one-tailed Fisher
exact **p ≈ 0.012**. Across every project on this machine (edit volume from other repos,
back to 2026-09-22): 17/135 = 12.6 % vs 9/188 = 4.8 %, p ≈ 0.010.

The vibe is real, and it survives every confound we can control for after the fact:

| cut | `edit` | `patch` | one-tailed p |
|---|---|---|---|
| headline (pi-patch, real work) | 15/118 = 12.7 % | 9/188 = 4.8 % | 0.012 |
| all projects | 17/135 = 12.6 % | 9/188 = 4.8 % | 0.010 |
| **same model** — `Qwen3.8-Flash-Next` | 7/26 = 26.9 % | 8/123 = 6.5 % | 0.005 |
| **same model** — `GLM-5.3-Flash` | 8/87 = 9.2 % | 0/42 = 0.0 % | 0.038 |
| **same work shape** — single anchor only (`edit/single` vs `patch/replace`) | 5/43 = 11.6 % | 7/166 = 4.2 % | 0.074 |
| **same sessions** — the 8 sessions that used both engines | 8/63 = 12.7 % | 9/126 = 7.1 % | 0.16 |
| patch's 15 already-applied no-ops counted as *neutral* instead of success | 12.7 % | 9/173 = 5.2 % | — |

Within-model cuts are the strongest: the model confound (which model was even available
that hour) disappears, and both models independently prefer the port.

## Cost of a failure — wasted work, not just failed calls

| | `edit` | `patch` |
|---|---|---|
| calls per landed edit (wasted calls) | 0.16 | **0.08** |
| abandoned targets (a file touched, never edited successfully) | 12 / 108 attempts = 11.1 % | **3 / 110 = 2.7 %** |
| recovery after a failure | same-tool 11, other-tool 4 | same-tool 8, other-tool 1 |
| next call after a failure used the *other* engine | 0 (`edit`→`patch`) | 1 (`patch`→`edit`) |

Failure *mix* tells the mechanism: 14 of `edit`'s 15 failures are "Could not find the exact
text" / "Could not find edits[i]" — the exact-match miss the 9-strategy chain exists to
absorb. `patch`'s 9: 5 no-match, 2 ambiguous, 1 argument gate, and 1 harness-side schema
refusal of a V4A call (the gate-closed friction of ledger #15/#16, not a matching failure).

## Two checks that could have killed the result

- **Censoring (the selection-bias leak).** AGENTS.md tells agents to fall back to `edit`
  when `patch` fails, which would hide `patch`'s failures. In the whole corpus that leak is
  **one call** (`patch`→`edit`), and zero `edit`→`patch`. The gap is not manufactured by the
  routing rule.
- **Over-tolerance (the risk of a looser engine).** A permissive chain can land the *wrong*
  region and still report success, so a lower failure rate could be bought with correctness.
  Proxy: a successful call immediately followed by a near-identical anchor on the same file.
  `patch`: 3 of 179 successes (1.7 %), `edit`: 0. All 3 eyeballed (`--failures` shows texts;
  these were `renderCall(args` → `renderCall(rawArgs`, a DOGFOOD table row, a test-line
  rewrite) are legitimate iterative refinement, not mis-lands. No verification or staleness
  errors appear anywhere in the corpus.

## Caveats — read these before quoting the numbers

1. **Observational, not controlled.** The agent chooses the tool, so the arms are different
   work. AGENTS.md makes `patch` the default, which if anything handed `patch` the harder
   calls — but the repo also *documents* `patch` heavily, so the port had a scaffolding
   advantage `edit` did not. Only a randomized-by-session A/B (PLAN) settles it.
2. **Small and short.** 306 real calls in ~17 h, one project, 4 models. The CI is ±7 pp;
   the single-anchor cut is directional (p = 0.074), and the within-session cut is not
   significant (p = 0.16).
3. **Capability asymmetry.** pi's `edit` takes an `edits[]` array: 75 of its 118 calls were
   multi-hunk (13.3 % fail) vs 43 single-anchor (11.6 %). `patch` is one replacement per
   call (V4A covers batching). The single-anchor row is the closest apples-to-apples.
4. **`isError` is the oracle.** It measures "did the engine land what the model asked for",
   not "was it the region the user wanted". Hence the wrong-landing proxy above.
5. **Dogfooding bias.** The corpus is largely sessions *developing* the extension, where the
   agent is told to prefer `patch` and to log its failures.
6. **Re-sent edits count as failures for `edit`.** It has no already-applied detection, so a
   duplicate call answers "Could not find edits[0]" and costs a turn; the port answers the
   same call with the already-applied no-op ("do not re-send this patch"). One such
   double-send happened while writing this document.

## What this buys the plan

- Enough signal to justify **retiring `edit`** (single declared engine + operator kill
  switch): the direction is consistent across models, projects, work shapes and
  within-session pools, and the one metric that must stay at zero (wrong landings /
  corruption) shows no damage.
- It does **not** replace Tier 4 #13. Post-removal there is no counterfactual, so the
  JSONL telemetry is what turns "corruption is still zero and the no-match rate hasn't
  drifted" into something we can actually see. This document is the pre-instrumentation
  snapshot to compare against: 4.8 % failed calls, 0.08 wasted calls per landed edit,
  2.7 % abandoned targets, 1.7 % wrong-landing proxy.
