# Milestone 04 rehearsal evidence

**Promotion is on hold.** The local rehearsal combines open drafts.
Select a merged candidate and confirm the release, runtime, Board, QA, and
operating owners in the release plan before candidate qualification. The
previous published source release is v0.0.4. [Release plan #222](https://github.com/groktopus/proprio/issues/222) · [v0.0.4 qualification](v0.0.4-qualification.md)

## Scope and evidence

On November 24, 2026, all 40 draft heads matched GitHub and composed without
conflicts on main `6e6ebf51cb0cf214375523171f80f19d14da073f`. The unpublished
rehearsal revision is `463b9b6b278be8abeadeb8f89a1737641685af7d`. The last
composition changed only release documentation and scripts from the preceding
40-draft tree. The pull requests record the exact heads and test scope for the
individual results below. [Milestone 04](https://github.com/groktopus/proprio/milestone/5)

- **Parent liveness, diagnosis, and restart.** PostgreSQL tests interrupted a
  claimed diagnostic wake and checked recovery after controller restart. A
  reassignment case checked stale-write denial and continued work on another
  eligible parent. Chromium checked investigation and readback after reload.
  [Liveness #306](https://github.com/groktopus/proprio/pull/306) · [Investigation #325](https://github.com/groktopus/proprio/pull/325) · [Restart #329](https://github.com/groktopus/proprio/pull/329) · [Reassignment #330](https://github.com/groktopus/proprio/pull/330)
- **Native Case handoff and completion recovery.** Embedded PostgreSQL and a
  scripted Codex app-server exercised the opt-in transfer, stale decision
  denial, and authorized acceptance. Native finalization tests exercised
  corrected scope and withdrawal. Chromium displayed completion evidence and
  retained an earlier accepted recovery revision after a newer acceptance.
  [Native handoff #342](https://github.com/groktopus/proprio/pull/342) · [Completion history #335](https://github.com/groktopus/proprio/pull/335) · [Scope correction #345](https://github.com/groktopus/proprio/pull/345) · [Recovery history #355](https://github.com/groktopus/proprio/pull/355)
- **Bound signoff and shared spend.** PostgreSQL tests exercised an edit racing
  with signoff, concurrent sibling reservations, reparenting, overlapping
  limits, and unknown usage. Board tests covered exact review targets and
  access to task-tree budget controls.
  [Signoff #324](https://github.com/groktopus/proprio/pull/324) · [Review #328](https://github.com/groktopus/proprio/pull/328) · [Reservations #327](https://github.com/groktopus/proprio/pull/327) · [Budget controls #334](https://github.com/groktopus/proprio/pull/334) · [Retry and admission #338](https://github.com/groktopus/proprio/pull/338)
- **Mixed-runner handoff and uncertain effects.** Chromium exercised the
  legacy process adapter to native Rust Runner with a scripted Codex
  app-server, then back to a legacy verifier. Restart and revocation tests
  checked retained dispatch and restored authority. A separate native
  uncertainty case counted one external effect in a synthetic fixture and
  observed the hold after restart.
  [Mixed handoff #319](https://github.com/groktopus/proprio/pull/319) · [Restart #323](https://github.com/groktopus/proprio/pull/323) · [Authority #332](https://github.com/groktopus/proprio/pull/332) · [Uncertain effect #341](https://github.com/groktopus/proprio/pull/341)
- **Context compaction.** The explicit paired Codex case is discoverable.
  Deterministic fixtures check retention, dropped requirements, superseded
  instructions, and premature action. The provider-backed Codex pair remains
  pending separate authorization and a configured credential. ACPX Claude
  requires its own qualification.
  [Codex experiment #321](https://github.com/groktopus/proprio/pull/321)

The 38-draft composition `c9dcc4730de8f7429749f12e45088738da8b0e14`
passed 4,429 selected tests with one skip, 13 additional Runner contract
tests, layered server and UI typechecks, and OpenAPI verification. The next
composition `b57a8c358f9a83a8c0802d2535a73487cabd0eef` passed 17 catalog and
native Case tests after the catalog repair. The 40-draft rehearsal passed
both history scenarios in Chromium with embedded PostgreSQL. It also
passed OpenAPI verification and all 17 tests of the source publication
script with local fixtures.
[Catalog repair #350](https://github.com/groktopus/proprio/pull/350) · [Browser evidence #355](https://github.com/groktopus/proprio/pull/355)

## Recovery and remaining gates

- Local embedded PostgreSQL rehearsal applied migrations 0507–0509 to a
  seeded database. An existing pending handoff kept its owner and wake.
  The old schema client could still read the seeded row. Reapplying the
  migrations had no effect. The deployment gate rejected migration 0507
  without staging evidence. Staging must verify the managed upgrade and
  restore or roll-forward on the selected candidate, with elapsed time and
  observed data loss recorded. [Migration #310](https://github.com/groktopus/proprio/pull/310) · [Release checklist](../doc/RELEASE-CHECKLIST.md)
- Standard Runner verification is blocked by a stale report-lock proof.
  The main lockfile has no accepted provenance for that proof and the
  trusted refresh workflow is absent. An existing Dependabot PR covers
  105 updates and has failing checks. [Lockfile policy](https://github.com/groktopus/proprio/blob/6e6ebf51cb0cf214375523171f80f19d14da073f/.github/scripts/lockfile-trust.mjs) · [Dependabot #249](https://github.com/groktopus/proprio/pull/249)
- After the stack lands, qualify the exact candidate in Linux source CI.
  Keep the signed-off scope limited to tested runner and model combinations.
  For the opt-in pilot, record the operator, observation window, task
  ownership, wake and effect counts, spend holds, and recovery verification
  before promotion. [Source release runbook](../doc/RELEASING.md) · [Release plan #222](https://github.com/groktopus/proprio/issues/222)
