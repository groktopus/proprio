# Milestone 04 rehearsal evidence

**Promotion remains on hold.** The integration tracker records 43/45 scoped
PRs merged. Main is `0ebc5c6d81ae36de6312453e13691ce976f4212f`; #372 is the
published successor with hosted qualification underway, followed by this final
documentation-only record in #356. The published source release is v0.0.4, but
no Milestone 04 candidate has been selected or qualified. Candidate selection,
release sign-off, staging recovery, and a bounded pilot remain pending. The
release plan assigns agent sign-offs; @magnus919 is the sole human maintainer.
It defines no recurring human approval gate.
[Release plan #222](https://github.com/groktopus/proprio/issues/222) ·
[v0.0.4 qualification](v0.0.4-qualification.md)

## Scope and evidence

The current main revision is `0ebc5c6d81ae36de6312453e13691ce976f4212f`.
The final rehearsal-record change is scoped to this file and its PR head, which
also carries #372's budget-resolution test on top of main. That PR's exact
hosted qualification is still underway. Neither this PR head nor current main
is a selected or qualified release candidate. The pull requests below identify
the narrower source revisions and test scope for their results. [Milestone 04](https://github.com/groktopus/proprio/milestone/5)

- **Parent liveness, diagnosis, and restart.** PostgreSQL tests interrupted a
  claimed diagnostic wake and checked recovery after controller restart. A
  reassignment case checked stale-write denial and continued work on another
  eligible parent. The controller fixture counted one actual process invocation
  after recovery with the retained assignee and zero by the former assignee
  after reassignment. Chromium checked a completed investigation and an
  exhausted receipt after reload. The exhausted browser case uses seeded
  state to exercise the production read paths.
  [Liveness #306](https://github.com/groktopus/proprio/pull/306) · [Investigation #325](https://github.com/groktopus/proprio/pull/325) · [Restart #329](https://github.com/groktopus/proprio/pull/329) · [Reassignment #330](https://github.com/groktopus/proprio/pull/330) · [Effect count #365](https://github.com/groktopus/proprio/pull/365) · [Exhausted diagnosis #367](https://github.com/groktopus/proprio/pull/367)
- **Native Case handoff and completion recovery.** Embedded PostgreSQL and a
  scripted Codex app-server exercised the opt-in transfer, stale decision
  denial, and authorized acceptance. Native finalization tests exercised
  corrected scope and withdrawal. Chromium displayed completion evidence and
  retained an earlier accepted recovery revision after a newer acceptance.
  Two runs of the controller restart test compared the full accept,
  clarification, and decline receipts and checked the task's Case audit
  events after restart. The fixture uses a static loader and seeded agents
  to keep the receipt checks independent of model calls and onboarding.
  [Native handoff #342](https://github.com/groktopus/proprio/pull/342) · [Completion history #335](https://github.com/groktopus/proprio/pull/335) · [Scope correction #345](https://github.com/groktopus/proprio/pull/345) · [Recovery history #355](https://github.com/groktopus/proprio/pull/355) · [Decision restart #364](https://github.com/groktopus/proprio/pull/364)
- **Bound signoff and shared spend.** PostgreSQL tests exercised an edit racing
  with signoff, concurrent sibling reservations, reparenting, overlapping
  limits, and unknown usage. The operator API identified the hard stop from
  settled spend. It recorded the board operator who raised the shared limit,
  then the previously blocked sibling reserved successfully. Board tests
  covered exact review targets and access to task-tree budget controls.
  [Signoff #324](https://github.com/groktopus/proprio/pull/324) · [Review #328](https://github.com/groktopus/proprio/pull/328) · [Reservations #327](https://github.com/groktopus/proprio/pull/327) · [Budget controls #334](https://github.com/groktopus/proprio/pull/334) · [Retry and admission #338](https://github.com/groktopus/proprio/pull/338) · [Budget resolution #372](https://github.com/groktopus/proprio/pull/372)
- **Mixed-runner handoff and uncertain effects.** Chromium exercised the
  legacy process adapter to native Rust Runner with a scripted Codex
  app-server, then back to a legacy verifier. Restart and revocation tests
  checked retained dispatch and restored authority. All three variants
  passed on the rehearsal tree after the static fixture loader and Task
  Detail render fixes. A separate native uncertainty case counted one
  synthetic external effect and verified the hold and effect count again
  after restart and the retry delay.
  [Mixed handoff #319](https://github.com/groktopus/proprio/pull/319) · [Restart #323](https://github.com/groktopus/proprio/pull/323) · [Authority #332](https://github.com/groktopus/proprio/pull/332) · [Uncertain effect #341](https://github.com/groktopus/proprio/pull/341)
- **Context compaction.** The separately authorized live Codex subscription
  campaign on the repaired #321 revision completed seven runs. Its 15/15
  behavior checks passed, while the launcher reported missing capture files
  (`final-state.png` and `snapshots/api-state.json`); this live run is not a
  complete packaged-evidence pass. The later capture-only fix was verified in a
  full credential-free offline package run with seven synthetic runs and all
  15 behavior checks. Keep the live behavioral result and offline packaging
  result distinct. Neither establishes a live campaign on the final integrated
  source. ACPX Claude requires its own trial.
  [Codex experiment #321](https://github.com/groktopus/proprio/pull/321) ·
  [Live and offline evidence](https://github.com/groktopus/proprio/pull/321#issuecomment-7207223985)

The full-integration rehearsals recorded selected tests, typechecks, and browser
journeys on their respective composed revisions. Those results support the
listed PR scopes; they do not qualify the exact current main revision. #367's
exhausted-diagnosis browser path passed its hosted Chromium check and protected
smoke on its exact PR revision. #372's budget-resolution test passed the exact local selector, the full affected
test file, and Server typecheck. Its hosted qualification is underway; do not
count it as merged or as hosted-qualified yet. [Exhausted diagnosis #367](https://github.com/groktopus/proprio/pull/367) · [Budget resolution #372](https://github.com/groktopus/proprio/pull/372)

The 38-draft composition `c9dcc4730de8f7429749f12e45088738da8b0e14`
passed 4,429 selected tests with one skip, 13 additional Runner contract
tests, layered server and UI typechecks, and OpenAPI verification. The next
composition `b57a8c358f9a83a8c0802d2535a73487cabd0eef` passed 17 catalog and
native Case tests after the catalog repair. The 40-draft rehearsal
`463b9b6b278be8abeadeb8f89a1737641685af7d` passed
both history scenarios in Chromium with embedded PostgreSQL. It also
passed OpenAPI verification and all 17 tests of the source publication
script with local fixtures.
[Catalog repair #350](https://github.com/groktopus/proprio/pull/350) · [Browser evidence #355](https://github.com/groktopus/proprio/pull/355)

## Recovery and remaining gates

- Local embedded PostgreSQL rehearsal applied migrations 0507–0509 to seeded
  data: an existing pending handoff retained its owner and wake, the prior
  schema client read the seeded row, and reapplication was idempotent. This is
  local evidence only. Staging still needs the managed migration 0507 upgrade
  and an exercised restore or roll-forward, with elapsed time and observed data
  loss recorded. [Migration #310](https://github.com/groktopus/proprio/pull/310) · [Release checklist](../doc/RELEASE-CHECKLIST.md)
- #409's infrastructure draft has green focused tests, protected smoke, and
  CodeQL. The signed Runner report proof and organization-side App activation
  are still pending; activation remains queued by the user's choice. Do not
  treat the draft checks as proof that the trusted refresh path is active or
  that the final source is qualified. [Runner report writer #409](https://github.com/groktopus/proprio/pull/409#issuecomment-7208010648)
- Qualify the exact selected main candidate in Linux source CI after integration
  is complete. Keep the signed-off scope limited to tested runner and model
  combinations. The exact integrated-source qualification, staging migration
  recovery, and bounded opt-in pilot have not been completed. Before promotion,
  record the operator, observation window, task ownership, wake and effect
  counts, spend holds, and recovery verification. [Source release runbook](../doc/RELEASING.md) · [Release plan #222](https://github.com/groktopus/proprio/issues/222)
