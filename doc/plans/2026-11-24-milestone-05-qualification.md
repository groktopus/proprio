# Milestone 05 qualification handoff

This handoff records local evidence and the remaining gates for [release plan #223](https://github.com/groktopus/proprio/issues/223). The milestone outcome is an independent reconstruction of a consequential managed action from task and approval through effective policy/runtime to the observed effect, including interruption.

## Candidate record

- Candidate SHA and commit range are pending.
- The qualification owner and deployment are pending.
- Independent review and governance sign-off are pending.
- The target date and observation window are pending.
- Record the configuration, runner, synthetic connector, visibility and retention settings for the selected candidate.

Check each merge and its exact head before selecting a qualification candidate.

## Evidence and qualification still required

Focused Node 24 tests used isolated PostgreSQL. The reconstruction test exercised the authenticated controller with a process adapter and synthetic MCP target. Nine focused tests passed on the local composition `5787f3033f74171744bc5a82abf6a083e7c1ca3a`. They covered reconstruction, historical policy, approved and direct dispatch, atomic capture and approval, checkpointed export beyond the CSV cap, older restore, and private-task/runtime visibility. This composition includes the reviewed policy change from #363 and the reconstruction change from #368. The fixture observed one approved effect, zero denied effects, and an interrupted response with an effect visible in the synthetic target ledger. Repeat the applicable checks through the same entry points on the integrated candidate. Record commands, revision, environment, results and links. Required candidate CI typecheck, tests and build must pass. Record the evidence separately for each runner, connector and recovery mode covered by the release. [Reconstruction](https://github.com/groktopus/proprio/pull/368)

The trace restore rehearsal also passed on Node 24.22.1 with an isolated PostgreSQL instance and loopback MinIO `RELEASE.2025-09-07T16-13-09Z`. The test restored a database row with its old local trace filename, created its migrated object journal, and applied the deletion manifest through the CLI. It verified removal of the local bytes and active ciphertext, a durable database tombstone, and rejection by the object journal. The deployment's object-version retention and candidate restore still require verification. [Restore rehearsal](https://github.com/groktopus/proprio/pull/361#issuecomment-7145834381)

Both Compose layouts reached the reconciliation CLI before application startup. The quickstart test also verified that a missing cluster fails without initialization and an existing embedded PostgreSQL cluster listens on loopback and shuts down. The Compose tests used cached runtime images, the PR source, and empty manifests. Repeat the restore with the selected image and deployment configuration. [Compose evidence](https://github.com/groktopus/proprio/pull/361#issuecomment-7146200058)

Both layouts select the same production Docker stage. Source inspection
confirmed that it carries the reconciliation script and the server's `tsx`
loader under `/app`. The selected-image restore remains a deployment check.
[Dockerfile](../../Dockerfile) [Compose app build](../../docker/docker-compose.app.yml)

The export freezes the IDs and checksum of visible records in the declared capture window. It detects a missing or newly restricted member when it reads a page. The checksum cannot detect an event that was absent before the snapshot. Initial capture covers decisions recorded by the managed gateway policy transaction. Read-only virtual tool discovery is outside that capture path. The approval and dispatch slices add evidence for the documented remote MCP route. Record the deployed producer coverage alongside each archive checkpoint. [Capture boundary](https://github.com/groktopus/proprio/pull/359) [Export contract](https://github.com/groktopus/proprio/pull/360)

- The connected MCP rollback fixture verified that an audit insert failure rolls back the invocation, approval request and rate charge before any provider send. A retry commits one rate charge and one event. The delegated test-call and legacy-plugin paths retain separate rate-accounting behavior. [Gateway rollback](https://github.com/groktopus/proprio/pull/359#issuecomment-7147343987)
- All 16 audit route tests passed on `ebac201b` with disposable PostgreSQL and Node 24.22.1. They exercised 10,037 events, a persisted resume cursor, source epoch rotation, exact archive bytes after an older restore, and loss of visibility on a different page. The API checked all snapshot members before returning page data, count and watermark. [Restore contract](https://github.com/groktopus/proprio/pull/369#issuecomment-7147751483) [Snapshot visibility](https://github.com/groktopus/proprio/pull/374#issuecomment-7147698734)
- A focused export test verified that an orphaned event with a surviving private task cannot reveal its presence through a conflict response. The existing missing-binding fixture still reported incomplete delivery for an eligible event. [Private binding](https://github.com/groktopus/proprio/pull/375)
- All 18 audit route tests passed on `6e15a034` with `DATABASE_POOL_MAX=1`. A transaction committed after its first export froze. A fresh overlapping snapshot recovered its event, and stable event identity allowed deduplication across a source epoch change. The procedure saves membership before advancing its cursor and records any interval clipped by capture or retention. Delays beyond the lookback require separate reconciliation. [Overlapping export](https://github.com/groktopus/proprio/pull/376)
- Three tests on `2b75d9b0` applied the combined migration and checked a task-bound write, a read-only call and the public export projection. The gateway persisted the provider correlation ID before dispatch, committed receipt before completion, and blocked a repeat mutation across a changed run and idempotency key. [Direct dispatch](https://github.com/groktopus/proprio/pull/366#issuecomment-7147826662)
- Five tests and the layered server typecheck passed on `5bd23631`. The approval route and authenticated `tools/call` recorded and settled the approved action under the active claim. A same-agent direct retry with identical arguments, a replacement run, and a new key could not send again after an unresolved approved action. An expired elicitation round and a thrown transport error also preserved the unresolved intent. [Approved dispatch](https://github.com/groktopus/proprio/pull/370)
- On `9ac8fffe`, an independent reviewer matched the exported policy decision, human approval and open dispatch intent for the interrupted action after server recreation. The `complete` field on a page signals that delivery reached the end of the frozen snapshot. The target ledger establishes the actual effect of the interrupted action. [Reconstruction](https://github.com/groktopus/proprio/pull/368)

The audit stack composition `b8be6b6f3cb1e1151651abef0f882448a7ec2546` passed
14 focused tests on Linux with Node 24.22.1. It combined the reviewed
reconstruction, independent authority, historical policy, direct and approved
calls, retention and export privacy branches. The fixture used isolated
PostgreSQL and a process adapter against a local synthetic MCP target. It
captured historical policy in the transaction that writes the rate charge and
managed admission record.

The disposable composition `7198e55415fe96baf5bea8ea543013153cc57df2`
included all 20 published PR heads at the time of verification. It passed 70
server and recovery checks, seven adapter checks and 12 transcript checks. The
server typecheck and OpenAPI consistency check also passed. The server tests
used Node 24.22.1, isolated PostgreSQL and a loopback MinIO store to verify
commentary, managed audit, independent authority, reconstruction and
older-backup deletion together.
After the overlapping-export review changes, all 18 audit route tests passed
again on composition `e575e1894a9e32e32fa75747b9b946c7aa87751e` with a
single-connection default pool. [Reviewed export fixture](https://github.com/groktopus/proprio/pull/376#issuecomment-7150562031)

The owner-only conversation fix on #375 and #376 also passed all 116 tests
in disposable composition `2660e594aafcd8b190e3c51fc47174aae16155b9` on
Node 24.22.1 and isolated PostgreSQL. The checks covered authorization, audit
export, reconstruction and OpenAPI. Layered server typechecking passed.
[Owner-only visibility](https://github.com/groktopus/proprio/pull/375)

The page access PR records the authorized operator, export ID and released
page metadata without exposing counts in company activity. Its route tests
cover replay, interrupted delivery, receipt write failure and retention across
snapshot expiry. All 22 export route tests passed with a single database
connection. The server and database typechecks and migration compatibility
check passed. [Page access records](https://github.com/groktopus/proprio/pull/378)
The page-access and direct-dispatch branches both generated migration 0509.
Land the dispatch migration first and regenerate the page access migration on
the integrated base. Disposable composition
`7e151da898b42629f3ba7b04919e5c28a55324e2` regenerated it as 0510. Its
migration compatibility check and all 23 audit export and reconstruction tests
passed. [Direct dispatch](https://github.com/groktopus/proprio/pull/366)

The export capacity PR bounds full-snapshot visibility checks and uses a
dedicated connection. All 24 route tests passed with a one-connection ordinary
pool. A held PostgreSQL lock exercised export backpressure, a real statement
timeout, continued ordinary request service and successful same-page retry.
[Export capacity](https://github.com/groktopus/proprio/pull/379)

After receipt review, exact heads `334d78a7` and `ff7ebb3b` verified
database role isolation, bodyless HEAD responses and safe receipt-write
failures. The latter passed all 25 export route tests with one ordinary
connection. Composed revision `3c162006646e1bcc342ac797e425a11894ffc761`
against main `c1dc2a08` applied the protected receipt migration after dispatch
and passed 82 export, reconstruction and OpenAPI tests with the default pool.
[Reviewed page access](https://github.com/groktopus/proprio/pull/378)

Capacity review added one queue entry per company, a fail-fast dedicated
connection budget and a lease deadline. The exact head `85e65029` passed 57
database admission, audit route and error-handler tests with one ordinary
connection. Disposable composition `a104203e1822a51598d37d668d2a3090f83de867`
against main `885ae5fb` passed 82 export, reconstruction and OpenAPI tests
with the default pool. Generated OpenAPI and migration compatibility checks
passed. [Reviewed capacity](https://github.com/groktopus/proprio/pull/379)

The retained snapshot PR limits companies to 128 active snapshots and keeps
full membership in PostgreSQL during page reads. The quota regression
reproduced the last-slot race before the fix. All 26 exact route tests passed
with one ordinary connection. Disposable composition
`a37f56b57690477ab193b312d283a4a848aec17f` against main `885ae5fb` passed
83 export, reconstruction and OpenAPI tests, including the minimized page
projection. [Snapshot storage](https://github.com/groktopus/proprio/pull/380)

The invalidation PR commits the snapshot conflict and removes its membership
when revalidation finds a missing or hidden event. The old cursor remains
invalid after access returns. All 26 exact route tests passed with one
ordinary connection. Composition `3567104a60e7de303976c8cced4ba95a154a1e6c`
regenerated invalidation as migration 0511 after dispatch and protected
receipts. It passed 83 export, reconstruction and OpenAPI tests and migration
compatibility. [Snapshot invalidation](https://github.com/groktopus/proprio/pull/381)

Expired snapshots retain owner-scoped markers for 24 hours after expiry.
Cleanup removes the expired membership. The exact head `0364d8a3` passed 27
audit route tests with one ordinary connection. The older-restore fixture
verified that retained markers still respect source epoch rotation. Composed
revision `d1285c0cd78bde3e9764a34c12599b3b6e56cac5` passed 84 export,
reconstruction and OpenAPI tests. [Expiry markers](https://github.com/groktopus/proprio/pull/382)

The quota recovery PR caps each operator at 32 active snapshots within the
company quota, and retires memberships outside the current epoch or retention
window. The old checkpoints retain their recovery response. All 30 exact
export route tests passed, including an authenticated POST that lost a
serialization race and returned a retryable error without persisting a
snapshot or creation receipt. Composed revision
`dc97146fe5b26fded66825e8335ee8b21106d9f7` against main `19b4a032` passed 87
export, reconstruction and OpenAPI tests. [Quota recovery](https://github.com/groktopus/proprio/pull/383)

Hosted stability and durable-work qualification passed for adapter head
`40aa561ef4a65d4bef7a925a20ec2901c3f6338b`. The retained report records that
source revision, baseline `49611a24b54166eda41cde8a26706592cc394034`, and five
recovery cases. [Hosted adapter qualification](https://github.com/groktopus/proprio/actions/runs/45535156471)


The updated commentary heads, `40aa561e` and `58c3bce3`, were included in
disposable composition `c20523ab28c40b3ea8777e9abac9ea04a7f76708`.
All 112 tests passed across commentary delivery, durable receipt recovery,
audit export, reconstruction and OpenAPI using Node 24.22.1 and isolated
PostgreSQL. A broader native authority run identified a baseline test fixture
that tried to insert a cross-company parent link. The fixture repair exercises
the runner with a valid separate-company hierarchy. The existing migration
suite covers rejection of cross-company parent links. The 48 native authority
tests and two migration tests passed together after review.
[Adapter cleanup](https://github.com/groktopus/proprio/pull/373)
[Commentary opt-in](https://github.com/groktopus/proprio/pull/352)
[Continuation fixture repair](https://github.com/groktopus/proprio/pull/377)

Disposable composition `d06aa5539146b225f7444ffe0c0c453afef91198`
included current `main`, the milestone stack, and the two open test fixture
repairs. All 230 tests passed across adapter utilities, native authority,
commentary and receipt recovery on Node 24.22.1 with isolated PostgreSQL.
The snapshot-order fixture repair has since merged in `885ae5fb`. [Snapshot order fixture repair](https://github.com/groktopus/proprio/pull/349)

GitHub's Linux source qualification passed for reconstruction PR head
`9ac8fffe7fed9114b04ded567802a6381790b0f8` with baseline `6e6ebf51`. It covered
locked install, source and Runner builds, managed update and rollback, a fresh
synthetic task, fresh-target PostgreSQL restore, and interruption recovery. The
run retained its durable-work acceptance report. [Hosted qualification](https://github.com/groktopus/proprio/actions/runs/45517565083)

Fifteen focused tests passed for the historical and runtime provenance stack
at `45866c87`. The authenticated decision route returned the original policy
revision, the admitted Codex fallback model and the pinned skill version after
the skill was updated. The fixture also checked private task and skill visibility
and malformed admission evidence. [Native provenance](https://github.com/groktopus/proprio/pull/358)

Hosted Linux source qualification also passed on native provenance head
`45866c87abda6e485053db6d4e8fa008f7367f56` against baseline `6e6ebf51`. The
retained report records both revisions and five recovery cases. The trusted
SDK report-lock refresh remains a separate release gate.
[Hosted qualification](https://github.com/groktopus/proprio/actions/runs/45529687898)

The release decision depends on the following checks.

1. Record candidate SHA, commit range/changelog, configuration, runner, connector, evidence visibility and retention settings. Confirm historical policy attribution, authority changes/revocation, and company/private-task permissions.
2. Exercise multi-page export, interrupted delivery, watermark recovery, deletion and older restore. Confirm permitted evidence remains available, excluded evidence stays inaccessible, and gaps are conspicuous.
3. Independently inspect synthetic approved, denied and interrupted attempts. Verify denial has no target effect and reconcile ambiguous effects before retry. State the exact paths covered.
4. Record the restore rehearsal, known-good revision, operator, recovery verification, observation window, backlog and remaining risks. Obtain named engineering/QA, operator, product/docs, governance and independent reviewer sign-offs before the release maintainer records go/no-go.

## Lock and provenance hold

The reporting lock guard rejects the lock on `main` at `6e6ebf51`. The committed lock SHA-256 is `535010469947806e6b8f0edff97bd211ca96b573dccd81dd08556e3f7b43b337`, while the report policy lists `f54797a4c415df7a40ec6550479a903cb33ba4225921eefcbe7e7d5fb7e7dc8e` for both input and output. The intervening change pins `oxlint@1.94.0` and its platform packages. [Dependency change](https://github.com/groktopus/proprio/pull/125)

The release maintainer must review the lock change and arrange the trusted
reporting lock refresh. GitHub has no active refresh workflow at the verified
baseline. The repository owner needs to provide the authorized workflow,
protected environment and installed lockfile bot. Once the trusted refresh
lands, resync public input pins and run the SDK checks for #358 and #363 on
the exact candidate. [Runner operations](../../tests/runner-e2e/OPERATIONS.md#hosted-report-dependencies)

## Hold, recovery and resume

Hold expansion for missing decision/dispatch/terminal evidence, authority mismatch, private evidence exposure, an unresolved target effect, a source-epoch mismatch, or a stale lock/provenance identity. Pause affected writes or exports as appropriate, preserve evidence allowed by current retention policy, retain the external archive/checkpoint, and reconcile target effects and deletion obligations before retry or resume. Do not blindly resend an action with an unresolved dispatch intent. Rehearse compatible restore or roll-forward, record the known-good revision and decision owner, then rerun checks on the resumed candidate.

The recovery and audit work is tracked in [#150 restore reconciliation](https://github.com/groktopus/proprio/pull/361), [#206 capture/export/restore qualification](https://github.com/groktopus/proprio/pull/353), [#360 checkpointed export](https://github.com/groktopus/proprio/pull/360), [#369 older-restore export rehearsal](https://github.com/groktopus/proprio/pull/369), [#366 direct dispatch receipt](https://github.com/groktopus/proprio/pull/366), [#370 approved dispatch receipt](https://github.com/groktopus/proprio/pull/370), and [#368 end-to-end reconstruction](https://github.com/groktopus/proprio/pull/368). Preserve external archive evidence independently of application restore state; the archive/checkpoint must be reconciled with the current source epoch and deletion obligations before delivery resumes.

## Review order

1. Review the governance coverage and the adapter prerequisite for commentary,
   then review operator opt-in. [#351](https://github.com/groktopus/proprio/pull/351) [#373](https://github.com/groktopus/proprio/pull/373) [#352](https://github.com/groktopus/proprio/pull/352)
2. Review older-restore deletion, the audit design and the run-visibility guard.
   These PRs target `main`. [#361](https://github.com/groktopus/proprio/pull/361) [#353](https://github.com/groktopus/proprio/pull/353) [#354](https://github.com/groktopus/proprio/pull/354)
3. Review initial capture, then checkpointed export. [#359](https://github.com/groktopus/proprio/pull/359) → [#360](https://github.com/groktopus/proprio/pull/360)
4. From checkpointed export, review the two dependent branches in their listed order.
   - Older-restore archive, snapshot visibility, orphan privacy, overlapping collection, page access records, capacity limits, invalidation, expiry and quota recovery. [#369](https://github.com/groktopus/proprio/pull/369) → [#374](https://github.com/groktopus/proprio/pull/374) → [#375](https://github.com/groktopus/proprio/pull/375) → [#376](https://github.com/groktopus/proprio/pull/376) → [#378](https://github.com/groktopus/proprio/pull/378) → [#379](https://github.com/groktopus/proprio/pull/379) → [#380](https://github.com/groktopus/proprio/pull/380) → [#381](https://github.com/groktopus/proprio/pull/381) → [#382](https://github.com/groktopus/proprio/pull/382) → [#383](https://github.com/groktopus/proprio/pull/383)
   - Approval resolution, direct dispatch, approved dispatch and historical policy. [#362](https://github.com/groktopus/proprio/pull/362) → [#366](https://github.com/groktopus/proprio/pull/366) → [#370](https://github.com/groktopus/proprio/pull/370) → [#363](https://github.com/groktopus/proprio/pull/363)
5. Review runtime provenance and independent authority before qualifying
   end-to-end reconstruction. Runtime provenance and the reconstruction fixture
   both target historical policy; independent authority targets `main`. [#358](https://github.com/groktopus/proprio/pull/358) [#357](https://github.com/groktopus/proprio/pull/357) [#368](https://github.com/groktopus/proprio/pull/368)

After a base PR lands, check the next PR's comparison and verify its current
head against `main` when retargeting it. Rebase stacked branches as needed to
keep each remaining comparison limited to its own change.

The member archive-preview fix passed hosted checks and merged to `main` as
`37fc31e233d75442f783d9cf888cf250ec58bf16`. The earlier disposable
composition `8554a986893ce0604a7370ec6913ef5df451c15d` included its source
head and passed all 56 OpenAPI tests, generated API consistency, and the
archive-preview route's malformed-ID and missing-member checks.
[OpenAPI prerequisite](https://github.com/groktopus/proprio/pull/347)
[Hosted smoke](https://github.com/groktopus/proprio/actions/runs/45531492632/job/138933277965)
