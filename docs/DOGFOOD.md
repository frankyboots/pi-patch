# DOGFOOD log — bugs found while using `patch` as the daily driver

Agent-facing record of `patch` misbehavior observed during real sessions in this repo
(see the dogfooding policy in [AGENTS.md](../AGENTS.md)). This is **not** the deviations
ledger — that one ([PLAN.md](PLAN.md)) records intentional departures from hermes; this one
records places where `patch` did something we consider a *bug*.

One row per bug, newest last. Log even if you had to switch to `edit` to finish — the log
is how these become chain fixes and regression tests.

| Date | Context | Attempted | Result (verbatim error / wrong output) | Expected | Status |
| ---- | ------- | --------- | -------------------------------------- | -------- | ------ |

When a bug is fixed: distill it into a regression test in `test/patch.test.ts` named after
the failure mode, then set the row's status to `fixed (<PR or commit>)`.
