# Milestone 04 rehearsal evidence

**Promotion remains on hold.** At this rehearsal checkpoint, 44 of 45 scoped
PRs are merged on main `78e52bcfe7c7c9351983fae7f36f19e18e4a5973`.
Rehearsal record #356 is the final integration PR. The previous published
source prerelease is v0.0.4 at
`9a280c0c8d0ab67e945f6ed3cbac94e916a3a85c`. @magnus919 is the sole human
maintainer. Integration, independent QA, operations, documentation review, and
release engineering agents own the milestone sign-offs under their authorized
scope. [Release plan #222](https://github.com/groktopus/proprio/issues/222) ·
[v0.0.4 qualification](v0.0.4-qualification.md) ·
[Published source prerelease](https://github.com/groktopus/proprio/releases/tag/v0.0.4)

## Scope and evidence

On November 24, 2026, 44 draft heads composed on main
`6e6ebf51cb0cf214375523171f80f19d14da073f` for the local rehearsal
`b089265c8dc80fcdf179b4e12b4a78c42ebc1dfc`. The linked pull requests
identify the source revisions and test scope for their results.
Release engineering will select the final candidate from integrated main after
#356 lands. [Milestone 04](https://github.com/groktopus/proprio/milestone/5)

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
  The local and hosted controller restart tests checked accept,
  clarification, and decline receipts, the audit API, and the persisted Case
  events. The fixture uses a guarded loader and seeded agents.
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
  after restart and the retry delay. Both #323 journeys delivered the
  handoff in the earlier hosted attempt, then timed out at the five-second
  Board Done assertion. The passing rerun kept the assertion, waited up to 30
  seconds, and retained navigation and route evidence.
  [Mixed handoff #319](https://github.com/groktopus/proprio/pull/319) · [Restart #323](https://github.com/groktopus/proprio/pull/323) · [Authority #332](https://github.com/groktopus/proprio/pull/332) · [Uncertain effect #341](https://github.com/groktopus/proprio/pull/341) · [Earlier hosted attempt](https://github.com/groktopus/proprio/actions/runs/45896922526) · [Passing rerun](https://github.com/groktopus/proprio/actions/runs/45898216252)
- **Context compaction.** The separately authorized live Codex subscription
  campaign on the repaired #321 revision completed seven runs. Its 15/15
  behavior checks passed. The launcher reported two missing capture files,
  `final-state.png` and `snapshots/api-state.json`, so the original package
  status is incomplete. The capture-only code follow-up passed a full
  credential-free offline package run with seven synthetic runs and 15 behavior
  checks.
  The live evidence covers the repaired Codex subscription revision.
  ACPX Claude qualification remains pending.
  [Codex experiment #321](https://github.com/groktopus/proprio/pull/321) ·
  [Live and offline evidence](https://github.com/groktopus/proprio/pull/321#issuecomment-7207223985)

Hosted Linux qualification tested #365 at
`a6a88f3f89c4db8e322b92e51274d25958bf1076` and #372 at
`ea689f796f9becb1238f24defe8323bf840f8bbc` from previous release v0.0.1 at
`49611a24b54166eda41cde8a26706592cc394034`. Each artifact records five
passing outcomes, including managed update and rollback, native restore to a
fresh target, and active-run migration recovery.
[Exact #365 Linux artifact](https://github.com/groktopus/proprio/actions/runs/45941147752/artifacts/15174531363) ·
[Exact #372 Linux artifact](https://github.com/groktopus/proprio/actions/runs/45952055385/artifacts/15178188065)

#367 passed hosted Chromium on its exact PR revision. #372 passed the hosted
budget case, all 13 affected tests locally, and server typecheck. Both PRs
passed protected smoke and CodeQL before merge.
[Exhausted diagnosis #367](https://github.com/groktopus/proprio/pull/367) ·
[Budget resolution #372](https://github.com/groktopus/proprio/pull/372#issuecomment-7211566080)

The local integration rehearsals recorded these results.
`c9dcc4730de8f7429749f12e45088738da8b0e14` passed 4,429 selected tests with
one skip, 13 additional Runner contract tests, layered server and UI
typechecks, and OpenAPI verification. The next composition
`b57a8c358f9a83a8c0802d2535a73487cabd0eef` passed 17 catalog and native Case
tests after the catalog repair. The 40-draft rehearsal
`463b9b6b278be8abeadeb8f89a1737641685af7d` passed both history scenarios in
Chromium with embedded PostgreSQL, OpenAPI verification, and all 17 tests of
the source publication script with local fixtures. Records for these exact
compositions remain local. The linked PRs provide their own scoped evidence.
[Catalog repair #350](https://github.com/groktopus/proprio/pull/350) · [Browser evidence #355](https://github.com/groktopus/proprio/pull/355)

## Recovery and remaining gates

- A local embedded PostgreSQL migration rehearsal used composed source
  `6799cb4b8deb7f08ca94f4b9693d6804717ba485` and a database at the pre-migration
  main baseline `9a280c0c8d0ab67e945f6ed3cbac94e916a3a85c`. It applied 0507–0509
  to seeded data, preserved a pending handoff's owner and wake, and reapplied
  the migrations as a no-op. Migration 0507 requires staging evidence because
  it adds unique indexes and validated checks to existing tables. Migrations
  0508 and 0509 add nullable columns. The operating agent still needs to record
  the staging upgrade, exercised restore or roll-forward, elapsed time, and
  observed data loss. [#310 rehearsal verification](https://github.com/groktopus/proprio/pull/310) · [Migration compatibility review](https://github.com/groktopus/proprio/pull/310#issuecomment-7158763079) · [Release checklist](../doc/RELEASE-CHECKLIST.md)
- #409's infrastructure draft passed its focused workflow and trust-policy
  tests, protected smoke, and CodeQL. Four repository-artifact tests still fail
  because the stored proof digest differs from the root lockfile. The signed
  refresh must clear those failures. Organization-side App activation is queued. [Runner report writer #409](https://github.com/groktopus/proprio/pull/409#issuecomment-7208010648)
- Qualify the exact selected main candidate in Linux source CI after integration
  is complete. Keep the signed-off scope limited to tested runner and model
  combinations. Final-source qualification, staging migration recovery, and
  the bounded opt-in pilot remain pending. Before promotion, record the
  operator, observation window, task ownership, wake and effect
  counts, spend holds, and recovery verification. [Source release runbook](../doc/RELEASING.md) · [Release plan #222](https://github.com/groktopus/proprio/issues/222)
