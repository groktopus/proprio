# Milestone 05 qualification handoff

[Release plan #223](https://github.com/groktopus/proprio/issues/223) covers one
authenticated self-hosted deployment, one runner, and a synthetic managed
connector. The goal is to follow each managed action from task and approval
through the effective policy and runtime to its observed effect.

The implementation and fixture PRs are submitted in the [review order](#review-order).
Release promotion remains on hold. The release plan still needs named owners,
the trusted SDK lock refresh, a candidate from main, and rehearsal and sign-off
on the selected deployment image.

## Milestone coverage

| Issue | Evidence from the submitted PRs | Work for the selected candidate |
| --- | --- | --- |
| [#205](https://github.com/groktopus/proprio/issues/205) Governance evidence | The operator guide maps audit sources, join keys, access, retention, and gaps. [Guide](https://github.com/groktopus/proprio/pull/351) | Record the effective deployment, runner, tools, model, and data destinations. Have the reviewer follow one synthetic task through the documented views. |
| [#103](https://github.com/groktopus/proprio/issues/103) Commentary defaults | The opt-in and adapter fixtures covered native and legacy discovery and writes, with earlier records still accessible. [Adapter prerequisite](https://github.com/groktopus/proprio/pull/373) [Operator opt-in](https://github.com/groktopus/proprio/pull/352) | Verify the configured default and opt-in on the selected runner. Record any legacy adapter behavior outside the release profile. |
| [#150](https://github.com/groktopus/proprio/issues/150) Restore and deletion | Isolated PostgreSQL and MinIO fixtures verified manifest replay before startup, deletion of local bytes and active ciphertext, a durable tombstone, and access to unrelated evidence. Both Compose layouts reached the reconciliation command with cached images. [Restore results](https://github.com/groktopus/proprio/pull/361#issuecomment-7146200058) | Repeat the non-empty deletion replay on the selected image. Check object-version retention, pre-start denial, and cleanup evidence in the chosen topology. |
| [#206](https://github.com/groktopus/proprio/issues/206) Independent audit export | Fixtures delivered 10,037 events beyond the CSV cap, resumed at the saved cursor, revalidated private visibility, and reconciled a rotated source epoch after restore. An overlapping collection caught a late commit. [Archive restore](https://github.com/groktopus/proprio/pull/369#issuecomment-7147751483) [Overlap](https://github.com/groktopus/proprio/pull/376) | Repeat the export across pages and an interruption. Verify durable archive/checkpoint storage, watermark recovery, restricted rows, and conspicuous gaps. |
| [#207](https://github.com/groktopus/proprio/issues/207) Historical policy and runtime | Authenticated fixtures retained the old rule fingerprint after policy edit and identified the admitted fallback model and pinned skill version after update. They exercised private-task and skill visibility. [Policy](https://github.com/groktopus/proprio/pull/363) [Runtime](https://github.com/groktopus/proprio/pull/358) | Refresh the trusted SDK lock, then verify both PRs' SDK checks and repeat the historical lookup with the selected runtime. |
| [#208](https://github.com/groktopus/proprio/issues/208) Independent authority | A separate authenticated operator activated and revoked a scoped rule, and product audit evidence correlated the requester, reviewer, and effective calls. [Authority fixture](https://github.com/groktopus/proprio/pull/357) | Name the operator and reviewer. Verify request, activation, and revocation under the documented restriction posture. |
| [#209](https://github.com/groktopus/proprio/issues/209) Reconstruction | The real controller processes and independent target produced nine audit events and effects of one for approval, zero for denial, and one for interruption. Readback succeeded after restarting the authenticated controller. [Reconstruction](https://github.com/groktopus/proprio/pull/407) | Repeat on the selected deployment. Record an independent target review and reconcile ambiguity before any retry. |

## Exact qualification evidence

- **Hosted Linux recovery.** All five cases passed on
  `f69b90d6044ab0a874212e0670f532dbbd036479` against
  `166175cc093a569eed60b59f6df70f6c10c43290`. They covered managed update and
  rollback, fresh-target restore, active-run migration, interruption/restart
  diagnostics, and browser task readback. Active-run migration recorded zero
  observed data loss and a recovery time of 580,302 ms.
  [Hosted run](https://github.com/groktopus/proprio/actions/runs/45579778025)
  [Retained report](https://github.com/groktopus/proprio/actions/runs/45579778025/artifacts/15007273531)
- **Authenticated reconstruction.** The focused test and layered server
  typecheck passed on PR head `3c2b0b78` and on composition
  `31b5a8fbf368bb880ee1b36170bdf6baf1c348de`. The composition used Node
  24.22.1, one ordinary PostgreSQL connection, the local process adapter
  without a model account, and a separate loopback MCP target. The owner and
  reviewer signed in over HTTP. The reviewer fetched the audit export from a
  different controller process after restart. The dependency-diagnosis crash
  regression passed alongside it. A separate Luna review found no issue on
  the PR head. Droid stopped at its provider usage limit.
  [PR](https://github.com/groktopus/proprio/pull/407)
  [Combined source](https://github.com/groktopus/proprio/commit/31b5a8fbf368bb880ee1b36170bdf6baf1c348de)
- **Observed outcome.** The completed export held nine events. The approval
  had four audit phases and one target effect. The denial had two phases and
  zero effects. The interrupted response had three phases, one durable effect,
  and an open dispatch intent. The fixture verified the export count and
  watermark against the creation receipt and sent no retry.
  [Retained-evidence fixture](https://github.com/groktopus/proprio/pull/406)
- **Gateway gaps.** The full gateway test file passed 125 cases and failed
  three GitHub connection/catalog cases on the hosted source revision. The
  same three failed on its baseline. Core's GitHub definition exposes
  `mcp-key`, so schema projection rejects a persisted `managed` GitHub
  method before reaching the target. The exercised connector is synthetic
  local MCP. Provider-native calls and other connectors need separate
  qualification. [Test source](https://github.com/groktopus/proprio/commit/f69b90d6044ab0a874212e0670f532dbbd036479)

The frozen snapshot checks membership, permissions, and watermark at read time.
Its checksum cannot detect events absent before the snapshot was created.
Record the capture window and producer coverage alongside the independent
archive checkpoint. Account for late commits beyond the collection lookback.
[Capture boundary](https://github.com/groktopus/proprio/pull/359)
[Export contract](https://github.com/groktopus/proprio/pull/360)

The [verification history](https://github.com/groktopus/proprio/blob/ac3463b1ad609ade678e3a6ce6982922a964dc9a/doc/plans/2026-11-24-milestone-05-qualification.md)
retains earlier source revisions, disposable identifiers, and detailed checks.

## Candidate and sign-off

1. Confirm named release, governance, runtime/data, deployment, and independent
   review owners in [the release plan](https://github.com/groktopus/proprio/issues/223).
2. Land the approved PRs in dependency order. Record the selected main SHA,
   commit range or changelog, image digest, target date, deployment profile,
   runner/model/connector, evidence visibility, and retention settings.
3. Run the required CI typecheck, build, and tests on the exact candidate.
   Rehearse each check in the milestone table on the selected deployment.
   Retain the artifact and observation window, and record the known-good
   revision and recovery outcome.
4. During the agreed observation window, review evidence backlog, missing
   provenance, authority decisions, and reconciliation outcomes. Publish the
   coverage and its limits in the operator notes.
5. Record engineering/QA, operating owner, documentation, governance, and
   independent target review. The operating owner records remaining risks.
   The release maintainer records the go/no-go and links the shipped output
   and observation result before closing the plan.

## Lock and provenance hold

The reporting lock and SDK public-input checks reject `main` at
`2363fe6fb68ece06e6dc4207e93be8b9c7646cc0`. The committed lock SHA-256 is
`535010469947806e6b8f0edff97bd211ca96b573dccd81dd08556e3f7b43b337`. The same
lock bytes remain on `c4592c7fc6e3720df77766905a2045e08c25218d`. The report
policy lists
`f54797a4c415df7a40ec6550479a903cb33ba4225921eefcbe7e7d5fb7e7dc8e`
for both input and output. The last root lock change is the app lint dependency
update at `7d7c3621`, which pins `oxlint@1.94.0` and its platform packages.
[Dependency change](https://github.com/groktopus/proprio/pull/125)

The repository's trusted writer check ran against that exact main revision.
It found no merged Dependabot PR for the root lock bytes. The regular refresh
requires a reviewed base or a verified Dependabot lock. A workflow
registration by itself leaves the current lock unrecognized. GitHub also
showed no active refresh workflow, protected refresh environment or refresh
branch at this revision.

The release maintainer must arrange an approved trusted lock recovery with the
repository owner. Provide the authorized workflow, protected environment and
installed lockfile bot. Record the reviewed base or verified writer and rerun
the frozen reporting check. After that refresh lands, resync public input pins
and run the SDK checks for #358 and #363 on the exact candidate.
[Runner operations](../../tests/runner-e2e/OPERATIONS.md#hosted-report-dependencies)

## Hold, recovery and resume

Hold expansion for missing decision, dispatch, or required terminal evidence,
an authority mismatch, evidence exposure, an unresolved target effect, a
source-epoch mismatch, or stale lock identity. Pause affected writes or exports. Preserve
permissible evidence and the independent archive/checkpoint. Reconcile the
target effect and deletion obligations before retry or resume. Rehearse the
compatible restore or roll-forward and verify it at the resumed revision.

## Review order

1. Review the governance coverage and the adapter prerequisite for commentary,
   then review operator opt-in and the adapter follow-ups. [#351](https://github.com/groktopus/proprio/pull/351) [#373](https://github.com/groktopus/proprio/pull/373) [#352](https://github.com/groktopus/proprio/pull/352) [#388](https://github.com/groktopus/proprio/pull/388) [#389](https://github.com/groktopus/proprio/pull/389) [#390](https://github.com/groktopus/proprio/pull/390) [#391](https://github.com/groktopus/proprio/pull/391)
2. Review older-restore deletion, the audit design and the run-visibility guard.
   These PRs target `main`. [#361](https://github.com/groktopus/proprio/pull/361) [#353](https://github.com/groktopus/proprio/pull/353) [#354](https://github.com/groktopus/proprio/pull/354)
3. Review initial capture, then checkpointed export. [#359](https://github.com/groktopus/proprio/pull/359) → [#360](https://github.com/groktopus/proprio/pull/360)
4. From checkpointed export, review the two dependent branches in their listed order.
   - Older-restore archive, snapshot visibility, orphan privacy, overlapping collection, page access records, capacity limits, invalidation, expiry and quota recovery. [#369](https://github.com/groktopus/proprio/pull/369) → [#374](https://github.com/groktopus/proprio/pull/374) → [#375](https://github.com/groktopus/proprio/pull/375) → [#376](https://github.com/groktopus/proprio/pull/376) → [#378](https://github.com/groktopus/proprio/pull/378) → [#379](https://github.com/groktopus/proprio/pull/379) → [#380](https://github.com/groktopus/proprio/pull/380) → [#381](https://github.com/groktopus/proprio/pull/381) → [#382](https://github.com/groktopus/proprio/pull/382) → [#383](https://github.com/groktopus/proprio/pull/383) → [#384](https://github.com/groktopus/proprio/pull/384) → [#385](https://github.com/groktopus/proprio/pull/385) → [#386](https://github.com/groktopus/proprio/pull/386) → [#387](https://github.com/groktopus/proprio/pull/387). Review [#392](https://github.com/groktopus/proprio/pull/392) after #386. Review [#396](https://github.com/groktopus/proprio/pull/396) and [#397](https://github.com/groktopus/proprio/pull/397) after #387.
   - Approval resolution, direct dispatch, approved dispatch and historical policy. [#362](https://github.com/groktopus/proprio/pull/362) → [#366](https://github.com/groktopus/proprio/pull/366) → [#370](https://github.com/groktopus/proprio/pull/370) → [#363](https://github.com/groktopus/proprio/pull/363). Review [#400](https://github.com/groktopus/proprio/pull/400) after #366. Review [#398](https://github.com/groktopus/proprio/pull/398) → [#399](https://github.com/groktopus/proprio/pull/399) after #370. Review [#402](https://github.com/groktopus/proprio/pull/402) and [#403](https://github.com/groktopus/proprio/pull/403) after #399. Review [#404](https://github.com/groktopus/proprio/pull/404) and [#405](https://github.com/groktopus/proprio/pull/405) after #403.
5. Review runtime provenance and independent authority before qualifying
   end-to-end reconstruction. Runtime provenance and the reconstruction fixture
   both target historical policy. Independent authority targets `main`. Review
   the retained evidence and production controller restart follow-ups after
   the reconstruction fixture.
   [#358](https://github.com/groktopus/proprio/pull/358) [#357](https://github.com/groktopus/proprio/pull/357) [#368](https://github.com/groktopus/proprio/pull/368) [#406](https://github.com/groktopus/proprio/pull/406) [#407](https://github.com/groktopus/proprio/pull/407)
6. Review the one-connection task and wake changes before repeating the
   stress reconstruction on the selected source. Task creation and wake delivery
   target `main`. Deferred promotion follows wake delivery. The independent
   [#401](https://github.com/groktopus/proprio/pull/401) fixture correction also targets `main`.
   [#393](https://github.com/groktopus/proprio/pull/393) [#394](https://github.com/groktopus/proprio/pull/394) [#395](https://github.com/groktopus/proprio/pull/395)

Four child heads predate updates to their parents. Local merges found no
conflict for #360 with #359, #391 with #389, and #402 and #403 with #399.
After a base PR lands, check the child comparison when retargeting it to
main and rerun its required checks.

### Landing the two audit branches

A local merge rehearsal used all 49 published heads and main at
`c4592c7fc6e3720df77766905a2045e08c25218d`. Landing the archive branch first
conflicted with direct dispatch in the migration journal, snapshot, and
export code. Landing the approval and dispatch branch first moved the first
conflict to the page receipt migration in #378.

Use the integration changes below as references when rebasing each PR on
its new base. The recorded resolutions span both branches. Carry only the
changes needed for each PR, preserve already-landed migrations, and rerun
the migration and audit tests after retargeting.

| PR | Integration reference |
| --- | --- |
| #378 Page access receipts | [Page receipt migration after direct dispatch](https://github.com/groktopus/proprio/commit/3c162006646e1bcc342ac797e425a11894ffc761) |
| #380 Snapshot storage | [Bounded storage with minimized pages](https://github.com/groktopus/proprio/commit/a37f56b57690477ab193b312d283a4a848aec17f) |
| #381 Invalidation | [Invalidation after dispatch and page receipts](https://github.com/groktopus/proprio/commit/3567104a60e7de303976c8cced4ba95a154a1e6c) |
| #384 Page access serialization | [Protected transitions, including #385](https://github.com/groktopus/proprio/commit/1550223299c12acd2daf9dbc512c83ff12c91a2f) |
| #386 Retirement | [Terminal snapshot cleanup](https://github.com/groktopus/proprio/commit/3d64f8c4510018e1ab8fd636a9cb2f4350eaecc7) |

With those resolutions, the rehearsal produced tree
`0fe714f851e9e9950ee50a0383b190891c08b993`, identical to the tested
composition `31b5a8fb`. The rehearsal used local merge commits. Each
PR still needs review and CI on its actual landing base.
[Tested composition](https://github.com/groktopus/proprio/commit/31b5a8fbf368bb880ee1b36170bdf6baf1c348de)

### Hosted smoke for PRs targeting main

The required `smoke` check passed on each of the ten heads below. The
linked Ubuntu 24.04 runs checked out those exact heads and passed the
board build, server and UI typechecks, and stability tests. The workflow
also passed the durable-work qualification for #373, #354, #359, #394,
and #401, and the board accessibility suite for #373. After a stack
moves to `main`, verify the required checks for the new comparison and
rerun release qualification on the selected candidate.

| PR | Tested head | Hosted run |
| --- | --- | --- |
| #351 | `3477a629` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45486097821) |
| #373 | `40aa561e` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45557419079) |
| #361 | `f5e0509c` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45500836578) |
| #353 | `ac9e405c` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45508306314) |
| #354 | `89387dfa` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45549671170) |
| #359 | `4d09625d` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45513462419) |
| #357 | `b7f1d5e0` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45498517535) |
| #393 | `cb46372e` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45563175648) |
| #394 | `f47472b3` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45563179883) |
| #401 | `e793dced` | [Stability smoke](https://github.com/groktopus/proprio/actions/runs/45568551197) |
