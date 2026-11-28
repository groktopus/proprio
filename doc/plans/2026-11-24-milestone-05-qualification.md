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
| [#150](https://github.com/groktopus/proprio/issues/150) Restore and deletion | Isolated PostgreSQL and MinIO fixtures verified manifest replay before startup, deletion of local bytes and active ciphertext, a durable tombstone, and access to unrelated evidence. Both Compose layouts reached the reconciliation command with cached images and empty manifests. [Restore results](https://github.com/groktopus/proprio/pull/361#issuecomment-7146200058) | Replay a non-empty manifest on the selected image before users or runners resume. Verify that deleted evidence cannot be read or republished, unrelated evidence stays readable, and object cleanup or expiry and version retention are observable. |
| [#206](https://github.com/groktopus/proprio/issues/206) Independent audit export | Fixtures delivered 10,037 events beyond the CSV cap, resumed at the saved cursor, revalidated private visibility, and reconciled a rotated source epoch after restore. An overlapping collection caught a late commit. [Archive restore](https://github.com/groktopus/proprio/pull/369#issuecomment-7147751483) [Overlap](https://github.com/groktopus/proprio/pull/376) | Repeat multi-page export and interruption with independent archive/checkpoint storage. Restore an older database, verify that the rotated epoch rejects the saved checkpoint, and reconcile from the new epoch. Preserve permissible archive bytes and exclude expired or restricted records. Verify watermark recovery and conspicuous gaps. |
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
  After main added the former-owner regression in #330, reconstruction and
  both controller-restart cases passed on the updated composition.
  [Tested source](https://github.com/groktopus/proprio/commit/57f1cb8b98c9d577f4fb4215eb618dd945b46b6e)
- **Observed outcome.** The completed export held nine events. The approval
  had four audit phases and one target effect. The denial had two phases and
  zero effects. The interrupted response had three phases, one durable effect,
  and an open dispatch intent. The fixture verified the export count and
  watermark against the creation receipt and sent no retry.
  [Production controller observation](#production-controller-observation)
- **Gateway gaps.** The full gateway test file passed 125 cases and failed
  three GitHub connection/catalog cases on the hosted source revision. The
  same three failed on its baseline. Core's GitHub definition exposes
  `mcp-key`, so schema projection rejects a persisted `managed` GitHub
  method before reaching the target. The exercised connector is synthetic
  local MCP. Provider-native calls and other connectors need separate
  qualification. [Test source](https://github.com/groktopus/proprio/commit/f69b90d6044ab0a874212e0670f532dbbd036479)

The server revalidates membership and permissions when reading a page.
Persist each page's membership for the export before advancing its cursor.
After the final page reports completion, count the distinct persisted event
IDs and compute SHA-256 over their compact UTF-8 JSON array in ascending ID
order. Compare both values with the creation receipt before marking the
export complete. Pause and reconcile on a mismatch. The checksum covers
the frozen export membership.
Record the capture window and producer coverage alongside the independent
archive checkpoint. Account for late commits beyond the collection lookback.
[Capture boundary](https://github.com/groktopus/proprio/pull/359)
[Export contract](https://github.com/groktopus/proprio/pull/360)

The [verification history](https://github.com/groktopus/proprio/blob/ac3463b1ad609ade678e3a6ce6982922a964dc9a/doc/plans/2026-11-24-milestone-05-qualification.md)
retains earlier source revisions, disposable identifiers, and detailed checks.

### Production controller observation

The retained local JSON for composition `31b5a8fb` recorded the following
disposable IDs. The controller changed from PID `1764267` to `1764961`.
The completed export was `bdad1e90-50b3-45ff-99af-8057abb9b3dc`, with
nine events and watermark
`1498dd3d719aa960a07db0a49db4b900135eafe1d9be65dd67cf2f13b9a29166`.
The table reproduces the case correlations from that report. The JSON was
retained locally.

| Case | Task ID | Run ID | Invocation ID | Action request ID |
| --- | --- | --- | --- | --- |
| Approved | `4bb248a4-bea6-495f-96c9-d79279715170` | `fa0a3787-b0c8-42a0-a15b-8d6671c99973` | `0499714f-c2d2-4762-a1c5-2cdf2b11b622` | `421982a1-e25c-4753-b4b4-77fdd2623d69` |
| Denied | `8a015125-c5e4-4979-a3cf-e37fc90b89c0` | `f3f76bd1-843e-471c-a715-07db583fa474` | `13476a01-fb37-4f6b-95b8-d28b367ecc50` | `aa290db3-7a3b-4a35-b14a-ad9899a6d17f` |
| Interrupted | `cf8e0824-c378-4c3c-805e-7358db144dd5` | `904d5617-8bf9-4848-b0c5-2cddc0933b80` | `d704d468-1cee-4582-917a-f4136a787581` | `15470378-0f7c-43bb-96f1-97146511f38f` |

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
lock bytes remain on `5963d46a4067a3b448dd49845d01c233393ff105`. The report
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

For the current unrecognized lock, the release maintainer asks the repository
owner to approve a recovery review of the exact committed dependency change.
The maintainer-reviewed update in #204 shows what to record. Review the
manifest and lock diff and verify a frozen install. Keep the current writer
checks in effect. If the owner restores the authorized refresh workflow,
provide a reviewed base or a verified Dependabot merge for the workflow to
refresh. The present lock has neither. Have the authorized writer record the
input, correction, and output in the proof and sync the SDK public-input
registry to the committed output hash.

Rerun the frozen reporting check and SDK input verification on the recovery
revision. After that update lands, resync public inputs for #358 and #363 and
run their SDK checks again on the exact candidate.
[Maintainer-reviewed precedent](https://github.com/groktopus/proprio/pull/204)
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
