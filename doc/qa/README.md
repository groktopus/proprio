# Critical-journey QA reports

The [first report](critical-journey-baseline.md) covers the seven days ending
2026-11-24 UTC. The [Critical-journey QA workflow](../../.github/workflows/critical-journey-qa.yml)
runs weekly on Monday at 08:17 UTC from `main`. It publishes its summary and
a Markdown artifact on the Actions run. To reproduce the first window with a
GitHub CLI login that can read this repository and its Actions evidence:

```sh
node scripts/ci/critical-journey-qa.mjs 2026-11-24
```

## Measures

- **Time to green** measures wall time from creation of the earliest Stability
  smoke run for the final PR head to completion of its first executed passing
  required check. The denominator is PRs merged during the seven-day UTC
  window with a passing smoke result on that head. Missing evidence, cancelled
  attempts, infrastructure dispositions recorded by GitHub, and other
  nonpassing attempts get separate counts. An unclassified failure stays in
  the other nonpassing count.
- **Retry-confirmed flake rate** is passed-after-retry case executions divided
  by executed case observations in retained workspace regression profiles.
  Skips and profiles without an end event are excluded. The overlapping
  focused CLI/health baseline is excluded to avoid double counting. Reports
  show unknown when test profiles are unavailable. A passed retry is not a
  permanent failure. A whole-job rerun alone does not identify a flaky case.
- **Escapes** are entries in the [reviewed defect register](critical-journey-defects.json)
  whose issue was opened in the window after the affected baseline merged.
  Each entry links the issue, recorded baseline, and regression decision.
  This count is a lower bound. An unclassified issue is unknown coverage.

File-path rules in the report command assign PRs and test cases to install
and update, backup and restore, and execution recovery. A cross-cutting
change can appear in more than one journey. Browser, live-provider, and
non-Linux runs sit outside this cohort. Review historical runs in the
linked evidence before comparing their gates to today's workflow.

The [repository owner](../../.github/CODEOWNERS) triages repeated flakes at
the next weekly review date printed in the report. Reproduce the exact case,
record the result in the relevant issue, and keep the retry visible until the
underlying failure is resolved. Add escaped defects to the register after
verifying their source baseline and deciding what regression coverage to add.
