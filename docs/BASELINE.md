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
python3 scripts/aggregate_baseline.py desktop.json server.json trading.json   # merge per-machine dumps
```

## Corpus

| | |
|---|---|
| sessions scanned | 30 files, 20 with edit-engine calls |
| window | 2026-10-13 23:49 → 2026-10-14 16:30 UTC (~17 h of dogfooding) |
| edit-engine calls | 342 total → **306 real** (edit 118, patch 188) after excluding 36 calls against `/tmp` scratch files |
| models | `Qwen3.8-Flash-Next`, `hf:zai-org/GLM-5.3-Flash`, `Qwen/Qwen3.8-27B-NVFP4`, `Qwen/Qwen3.8-Flash-Next` |

> Everything above the [Multi-machine aggregate](#multi-machine-aggregate-2026-10-17)
> section is the **single-box snapshot** taken while the port was being built (one machine,
> ~17 h). The aggregate widens the same methodology to three machines and ~3 months.

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

## Multi-machine aggregate (2026-10-17)

`session_baseline.py` only sees the box it runs on, so it was run on each machine
(`--json > <box>.json`) and the dumps were merged. `scripts/aggregate_baseline.py` re-runs
the whole report on the merged corpus (with an extra *by machine* cut) and adds the
stratified statistics, because on this corpus the two arms barely share a box:

```bash
python3 scripts/aggregate_baseline.py desktop.json server.json trading.json             # report
python3 scripts/aggregate_baseline.py desktop.json server.json trading.json --markdown  # tables only
```

### Corpus

| machine | sessions | edit-engine calls | real (non-harness) | edit | patch | window |
|---|---|---|---|---|---|---|
| desktop (this repo + side projects) | 49 | 377 | 340 | 154 | 223 | 2026-09-21 .. 2026-10-17 |
| server (inference/ops repos) | 260 | 743 | 732 | 743 | 0 | 2026-07-18 .. 2026-10-17 |
| trading (agent box, `my-tasty-agent`) | 35 | 81 | 81 | 0 | 81 | 2026-10-15 .. 2026-10-17 |

### Failed calls (real work)

| machine | edit calls | edit fail | edit % | patch calls | patch fail | patch % | one-tailed p |
|---|---|---|---|---|---|---|---|
| desktop | 143 | 18 | 12.6 | 197 | 9 | 4.6 | 0.0065 |
| server | 732 | 67 | 9.2 | 0 | 0 | n/a | single-arm |
| trading | 0 | 0 | n/a | 81 | 2 | 2.5 | single-arm |
| **pooled (all machines)** | **875** | **85** | **9.7** | **278** | **11** | **4.0** | **0.0010** |

Cochran–Mantel–Haenszel across the three machines: **p = 0.013**, pooled Mantel–Haenszel
odds ratio (edit vs patch) = **2.76**. Counting patch's 15 already-applied no-ops as
*neutral* instead of success still gives 11/263 = 4.2 %; including harness traffic gives
edit 103/897 = 11.5 % vs patch 19/304 = 6.2 % (pooled p = 0.0047, CMH p = 0.015).

What the extra machines buy:

- **`edit`'s rate replicates off the dev box.** Server never ran `patch` and is a different
  kind of work — GLM-5.2 and Qwen3.6 driving inference/ops repos over three months — and
  lands at **9.2 %** (67/732) against desktop's 12.6 %, with the same failure mix
  (47 of 67 are "could not find"). The 12.6 % headline was not an artifact of this repo.
- **`patch`'s rate replicates off the dev repo.** Outside `pi-patch`/`pi-patch-dev` the port
  is **1/51 = 2.0 %** (trading's `my-tasty-agent` plus a stray `.pi` config edit), and the
  single failure is a `file_error`, not a matching miss — zero no-match failures on 51
  calls of ordinary non-dogfood work.
- **Model-matched cut still holds.** `Qwen3.8-27B-NVFP4`: edit 2/19 = 10.5 % vs patch
  3/103 = 2.9 % (the patch calls are almost all on trading, so it is a *cross-machine*
  within-model comparison — directional, not clean).
- **Work shape.** Merged: `edit/single` 46/614 = 7.5 %, `edit/edits[]` 39/261 = 14.9 %
  (multi-hunk is where `edit` is weakest), `patch/replace` 9/256 = 3.5 %, and the 19
  transitional `edits[]`-spelling calls 0 fail. Only 3 real V4A calls survive harness
  filtering (1 landed); both failures are argument/gate friction (ledger #15/#16), not a
  hunk miss — V4A remains unmeasured, not measured-bad.
  How models actually batch is worth its own line: on desktop 65 of 197 `patch` calls (33 %)
  were back-to-back single-replacement calls with no other tool between them, spanning 16
  runs across 2–5 files; 64 of the 65 landed, and each target landed exactly once. Faced with
  multi-file work the models reach for parallel `patch` singles, not V4A. That is a fine
  outcome — but it means V4A's ergonomics stay untested, and one of the two runs that hit a
  different target each time is the same file erroring twice, which is `patch` teaching the
  model rather than the model flailing.
- **The machine is nearly an instrument for the arm.** Only desktop has both engines (10 of
  its 28 edit sessions used both); server contributed no patch call and trading no edit
  call. That is why the CMH cut — not the pooled Fisher — is the number to lean on, and why
  desktop alone (12.6 % vs 4.6 %, p = 0.0065) remains the cleanest arm-vs-arm contrast.

### Attempt anatomy per machine

| machine | tool | attempts | landed | abandoned | abandon % | calls/attempt | max streak |
|---|---|---|---|---|---|---|---|
| desktop | edit | 128 | 115 | 13 | 10.2 | 1.11 | 3 |
| desktop | patch | 116 | 114 | 2 | 1.7 | 1.71 | 7 |
| server | edit | 587 | 545 | 42 | 7.2 | 1.25 | 7 |
| trading | patch | 50 | 48 | 2 | 4.0 | 1.62 | 8 |

### Quality proxies, merged corpus

| tool | successful calls | wrong-landing proxy | proxy % | abandoned attempts | drift/verify/staleness errors | censored to other engine |
|---|---|---|---|---|---|---|
| edit | 790 | 28 | 3.5 | 55/715 | 0 | 0 |
| patch | 267 | 5 | 1.9 | 4/166 | 0 | 1 |

Across 1 153 real edit-engine calls and three machines: **no** escape-drift, write-verify or
staleness errors anywhere, and the over-tolerance proxy is *lower* for `patch` than for
`edit`. Censoring is a policy-era artifact: the snapshot's single `patch`→`edit` leak came
from an AGENTS.md rule that let a session defect to `edit`, the 833 added calls leaked
nothing in either direction, and the rule is gone now that `edit` is withdrawn. Neither of
the two ways to fake this result shows up.

## Caveats — read these before quoting the numbers

1. **Observational, not controlled.** The agent chooses the tool, so the arms are different
   work. AGENTS.md makes `patch` the default, which if anything handed `patch` the harder
   calls — but the repo also *documents* `patch` heavily, so the port had a scaffolding
   advantage `edit` did not. Only a randomized-by-session A/B (PLAN) settles it.
2. **Small and short.** The snapshot is 306 real calls in ~17 h, one project, 4 models; the
   CI is ±7 pp, the single-anchor cut is directional (p = 0.074) and the within-session cut
   is not significant (p = 0.16). The aggregate is 3.8× bigger (1 153 real calls, 3 machines,
   ~3 months) but does **not** fix the separation problem: 875 of its edit calls and 197 of
   its patch calls come from boxes where the other engine never ran.
3. **Capability asymmetry.** pi's `edit` takes an `edits[]` array: 75 of its 118 calls were
   multi-hunk (13.3 % fail) vs 43 single-anchor (11.6 %). `patch` is one replacement per
   call (V4A covers batching). The single-anchor row is the closest apples-to-apples —
   merged, that is `edit/single` 7.5 % vs `patch/replace` 3.5 %.
4. **`isError` is the oracle.** It measures "did the engine land what the model asked for",
   not "was it the region the user wanted". Hence the wrong-landing proxy above.
5. **Dogfooding bias.** The corpus is largely sessions *developing* the extension, where the
   agent is told to prefer `patch` and to log its failures. Server (732 edit calls driving
   inference/ops repos) is not that population and reproduces `edit`'s rate; `patch`'s
   evidence from ordinary work is still only 51 calls.
6. **Re-sent edits count as failures for `edit`.** It has no already-applied detection, so a
   duplicate call answers "Could not find edits[0]" and costs a turn; the port answers the
   same call with the already-applied no-op ("do not re-send this patch"). One such
   double-send happened while writing this document.
7. **V4A is unmeasured, not measured.** Three non-harness V4A calls survive harness filtering
   across the whole aggregate (1 landed; the 2 failures are argument/gate friction, not hunk
   misses). The engine is differentially tested against hermes, and models reaching for
   multi-file work batch parallel `patch` singles instead of using it — so the claim this
   corpus supports is "replace mode is safe and better", never "V4A works in production".

## What this supports

- The **withdrawal of `edit`** (already shipped as the default) happened to be a clean
  natural experiment, and the result supports it: the direction is consistent across
  models, projects, work shapes and within-session pools, and the one metric that must stay
  at zero (wrong landings / corruption) shows no damage. State it as *supports*, not
  *proves* — n = 1 153 real calls, the arms barely share a machine (so the CMH cut, not the
  pooled Fisher, is the honest summary), and the agent chose the tool.
- V4A is not covered by any of this: 3 non-harness calls in 3 months (caveat 7).
- It does **not** replace Tier 4 #13, and that item is no longer about justifying the
  withdrawal — it is about accumulating a large corpus of ordinary daily work and tuning the
  chain's thresholds on it. Post-withdrawal there is no counterfactual, so the JSONL
  telemetry is what turns "corruption is still zero and the no-match rate hasn't drifted"
  into something we can actually see. This document is the pre-instrumentation snapshot to
  compare against: 4.8 % failed calls (4.0 % across the three machines), 0.08
  wasted calls per landed edit, 2.7 % abandoned targets, 1.7 % wrong-landing proxy.
