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

The page invalidation follow-up locks the snapshot through validation and
access record commit. Its PostgreSQL race fixture checked that a reader
waiting on a concurrent invalidation returns a retryable error and writes
no access record. The invalidation event records the company, operator and
export ID once. All 31 exact audit route tests passed on `d5fb6cfd` with one
ordinary connection. Composition `374d5d95c45c5682b43c2a42878d0ebb950247f9`
against main `19b4a032` passed 88 audit export, reconstruction and OpenAPI
tests with the default pool. At `479b8d0e`, all 31 export route tests
passed again after placing the receipt in protected storage with company
cascade. A lookalike company activity write could not alter that receipt.
[Page invalidation follow-up](https://github.com/groktopus/proprio/pull/384)

The quota replacement PR excludes permanently invalidated snapshots from the
32-per-operator and 128-per-company active limits. The route regression
returned 429 before the change and 201 after it. At `c6c8819f`, all 32 audit
route tests passed with one ordinary connection. The losing writer returned
PostgreSQL serialization state `40001` and a retryable response. The prior marker remains
readable within its existing owner-scoped retention window.
[Replacement quota](https://github.com/groktopus/proprio/pull/385)

The durable retirement PR preserves the stored expiry and fences superseded
snapshots across clock skew and cutoff rollback. The old code returned HTTP
200 in the cutoff rollback regression. The fixed revision `cf30a93f` passed
all 32 route tests with one ordinary connection. The peak fixture retired
128 snapshots of 20,000 IDs each. Two successive creates released eight
memberships each and left one protected retirement summary.
[Durable retirement](https://github.com/groktopus/proprio/pull/386)

Composition `1550223299c12acd2daf9dbc512c83ff12c91a2f` against main
`19b4a032` passed 89 export, reconstruction and OpenAPI tests on Node
24.22.1 with isolated PostgreSQL and the default pool. The composition
regenerated the protected transition receipt migration as 0512 after
dispatch, page-access receipts and snapshot invalidation. Numbering, safety,
compatibility and generated OpenAPI checks passed.

The response cleanup passed 32 exact audit route tests on `656ff0a0`.
It removes a preview-only page offset. Cursor resume, completion and protected
page access records remain covered. Its composition
`cae64e90f488ccdf942f79a976b058e7379d58db` against main `19b4a032`
passed all 89 audit, reconstruction and OpenAPI tests.
[Response cleanup](https://github.com/groktopus/proprio/pull/387)

Retirement review found that expiry cleanup also needs a durable terminal
marker when the reading replica is behind the writer. The reviewed head
`1698339a` passed all 35 route tests with one ordinary connection. The peak
fixture exercised one marker deletion, three expiry clears and four retirement
clears in one transaction. A cutoff rollback still returned a conflict for a
retired row whose membership was gone. The same suite checks failed-create
rollback, a bounded company lock wait and sanitized protected receipt errors.
DB and server typechecks passed. [Reviewed retirement](https://github.com/groktopus/proprio/pull/386)

The current-main composition `3d64f8c4510018e1ab8fd636a9cb2f4350eaecc7`
passed 92 audit, reconstruction and OpenAPI tests. It regenerated the
terminal cleanup migration as 0513 after the transition receipt migration.
Migration safety, compatibility and generated OpenAPI checks passed. The
response cleanup revision `d5d044cc` passed all 35 route tests with the
reviewed retirement base.

Hosted stability and durable-work qualification passed for adapter head
`40aa561ef4a65d4bef7a925a20ec2901c3f6338b`. The retained report records that
source revision, baseline `49611a24b54166eda41cde8a26706592cc394034`, and five
recovery cases. [Hosted adapter qualification](https://github.com/groktopus/proprio/actions/runs/45535156471)

The Pi follow-up stages explicit inventories in a fresh local directory or
in a unique in-place SSH asset when the shared host supplies authentication.
Head `c3ede10d` passed 17 tests, including a credential-free Pi 0.74.0 CLI
check for ambient, selected and empty discovery. Its probe uses a disposable
child home and waits for a complete RPC response. Pi extensions
can add their own resources. Codex reuses bundled discovery when the
inventory is implicit. The reviewed head `a59b7b0b` passed 14 execution tests.
A representative bundled entry verified removal of a live deselected link.
[Pi isolation](https://github.com/groktopus/proprio/pull/389) [Codex inventory](https://github.com/groktopus/proprio/pull/388)

OpenCode stages explicit local inventories in the private runtime config and
reports managed assignments as run scoped. It filters older managed links
from the private native config and resolves selected skills through canonical
source paths. Its compatibility flag also hides operator-owned Claude skills
auto-discovered in user and project folders. OpenCode native and explicitly
configured paths still follow provider rules. The pinned OpenCode 1.19.6
probe verified both selected and empty discovery.
Gemini locates managed links through the CLI home setting. Use separate
absolute provider roots for separate Gemini state and resume data. The
Cursor CLI documentation has no skill-only home setting. Separate whole
provider homes require their own operator configuration.
[OpenCode isolation](https://github.com/groktopus/proprio/pull/391)
[Gemini provider home](https://github.com/groktopus/proprio/pull/390)

Composition `928a3db8af5c69e0c7c9c37933e41f33b74fd792` against main
`2363fe6f` passed 276 audit, reconstruction, OpenAPI, adapter and scheduling
tests on Node 24.22.1. The initial scheduling run found a read-only Git
marker above the temporary workspace. Two failures reproduced on unmodified
main. The rerun used an isolated application home and temporary directory
under a valid disposable Git root. Composition
`abbeccfe4fec6a7de1605a70a16e9c27efed1813` added both adapter follow-ups to
that base and passed 198 adapter, commentary and receipt recovery tests.
Hosted Linux source qualification on that exact composition failed while
building the managed update. Two runner capability inventories still listed
the removed incidental-feedback heading. The update did not reach rollback
or later recovery steps. Head `095e8294` regenerated both inventories and
passed their validation, four validator tests, and protocol coverage.
[Failed composition qualification](https://github.com/groktopus/proprio/actions/runs/45555172910)
[Manifest correction](https://github.com/groktopus/proprio/pull/352)

Composition `b02e4f28eee960fbc91144bb0b45ff55c4486594` includes the
Gemini and OpenCode updates. Node 24 and disposable PostgreSQL passed 78
adapter, commentary and receipt recovery tests. The Gemini relative-home
execution regression also passed. On that composition, concurrent retries
repaired an interrupted audit retirement index build. They preserved the
cleared and uncleared snapshots and recorded one migration receipt. The
same recovery has a focused regression on the retirement PR's migration.
[Audit retirement replay](https://github.com/groktopus/proprio/pull/392)


Composition `df2439efa02b50ec702ffe94bf8ac6cf16a6ae71` added the reviewed
Pi and Codex changes, the manifest correction, and the audit replay test
using the integrated migration number. Node 24 and disposable PostgreSQL
passed 102 focused tests across adapters, commentary, receipt recovery and
audit migration replay, including the pinned Pi CLI check. The capability
contract, inventory, protocol coverage, and workflow traceability checks
also passed. The replacement hosted run succeeded on that source and base
`2363fe6fb68ece06e6dc4207e93be8b9c7646cc0`. Its retained report records
passed managed update and rollback, fresh-target restore, active migration
recovery, interruption diagnostics, and browser task readback. It reports
zero observed data loss in the active-run migration case.
[Hosted composition result](https://github.com/groktopus/proprio/actions/runs/45557310471)
[Retained qualification report](https://github.com/groktopus/proprio/actions/runs/45557310471/artifacts/14998240145)


The standard-pool reconstruction and native receipt suites passed eight more
tests on `df2439ef`. OpenAPI generation matched the checked-in schema. A
single-connection stress run passed 98 other tests and timed out before
the HTTP task-create response. The task-create fix returned HTTP 201 on
the same route under stress and passed all 12 human-directed work tests.
The stress replay then stalled in the tool-action wake delivery after
approval. PostgreSQL showed an idle delivery transaction holding the one
ordinary connection while the code tried a second ordinary-pool read.
The delivery fix returned HTTP 200 from the approval route. A later
deferred wake promotion still stalled with the single-connection setting.
[Task-create transaction fix](https://github.com/groktopus/proprio/pull/393)
[Wake delivery transaction fix](https://github.com/groktopus/proprio/pull/394)

The hosted durable-work check passed on wake delivery head
`f47472b3c18ea78a62cc82dfce9680ed39530157`.
[Wake delivery CI](https://github.com/groktopus/proprio/actions/runs/45563179883)

The updated migration replay test located the migration through the journal
on both the retirement PR and its renumbered composition. It observed both
calls waiting for the migration advisory lock before allowing either call
to repair the index. [Reviewed migration test](https://github.com/groktopus/proprio/pull/392)

Composition `f94bf90f75493a35a41f71aa904b2072a0f8ab54` passed 111 focused
tests on Node 24 and disposable PostgreSQL with the standard ordinary pool.
The suite includes commentary, the pinned Pi and OpenCode probes, migration
replay, synthetic audit reconstruction and native receipt recovery. This
revision includes the reviewed adapter changes and both new pool fixes.

The final pool follow-up passes the transaction reader through deferred
wake promotion for session and attribution reads. On
`248ba8107848dade87914f97fed328518af1e328`, the authenticated reconstruction
passed with one ordinary connection. It reconstructed the approved, denied,
and interrupted actions through the synthetic target after controller restart.
The same source passed 111 standard-pool tests, the OpenAPI generation check,
and the runner capability checks. Hosted Linux qualification succeeded for
this exact source against baseline `2363fe6fb68ece06e6dc4207e93be8b9c7646cc0`.
The retained report records five passed cases, including managed update and
rollback, fresh-target restore, active-run migration recovery, interruption
diagnostics and browser task readback. The active-run migration case recorded
zero observed data loss.
[Exact composition qualification](https://github.com/groktopus/proprio/actions/runs/45563068633)
[Retained qualification report](https://github.com/groktopus/proprio/actions/runs/45563068633/artifacts/14999529201)

The bounded routine promotion regression uses real heartbeat completion on
one database connection. It verifies that a previously deferred wake links
to a successor with the owner recorded on the original routine run. The
regression stalled when transaction-reader forwarding was removed, then
passed with the fix. All 54 heartbeat liveness tests and the scoped server
typecheck passed on `8779c411fd36969906ff930296479229dc5996c3`.
[Deferred wake promotion](https://github.com/groktopus/proprio/pull/395)

Composition `82d25021500a2e4e65a3b2079d958a082ea22ab2` includes the
review changes for audit marker retention, export pool isolation and the
approval response after an interruption. It passed all 92 audit route and
OpenAPI tests, the one-connection authenticated reconstruction, generated
OpenAPI validation and the scoped server typecheck. The audit suite includes
a 20,000-event export with task and run membership checks held at the
database while another company's ordinary activity API succeeds.
[Marker retention](https://github.com/groktopus/proprio/pull/396)
[Export pool isolation](https://github.com/groktopus/proprio/pull/397)

The approval regression checks that the interruption sweep preserves a
prior unresolved intent, blocks a replacement before dispatch and reports
the failed replacement with reconciliation guidance. Five relevant gateway
tests passed on the approval fix head `2d7145fb47afaa74711842560ab9ba5144dc98ef`.
On `c9ff65083002543365efbb59e4b7e139652369f4`, all 41 MCP Tasks tests
passed, including stable correlation across protocol negotiation and task
collection under one intent and one terminal receipt.
[Interruption fence](https://github.com/groktopus/proprio/pull/398)
[Approval outcome](https://github.com/groktopus/proprio/pull/399)
[MCP protocol recovery](https://github.com/groktopus/proprio/pull/400)

The combined MCP Tasks and wake queue adapter suites passed all 174 tests
on composition `1b9c872f2de5055184ca6152be9d78580d2049f2`. This includes the
foreign-company fixture fix. On the baseline, its test setup failed at the
company-scoped parent constraint. The corrected fixture gets to the
application query and verifies that it rejects the foreign child. The exact
fixture head `e793dced9ab52fb7855474ec65daec5bf2cf4f6e` passed all 132 wake
queue adapter tests and verifies that the child lookup binds the requested
company. The hosted durable-work check passed on that exact head.
[Wake queue test fixture](https://github.com/groktopus/proprio/pull/401)
[Wake queue fixture CI](https://github.com/groktopus/proprio/actions/runs/45567960266)
The later hosted stability and durable-work rerun also passed on that head.
[Wake fixture rerun](https://github.com/groktopus/proprio/actions/runs/45568551197)

The Apps review queue checks the approval result on the standalone and
linked-interaction paths. Both show the reconciliation message for a failed
action and preserve the distinction between approval and execution. The
Always allow path indicates that the permission may still apply. A mounted
live region retains the failure when the reviewed row disappears. Five UI
tests and the UI typecheck passed for the source at
`8c8adac71e7e90cfece165c16275e9f60c5a4e89`. Chromium verified keyboard
activation, the failure text in the accessibility tree, and Tab navigation
on Allow once, Always allow and linked reviews. Focus moved once when the
reviewer stayed in the submitting row. Focus remained where the reviewer
moved it during a pending response or after returning to a previously selected
connection. A standalone screen reader announcement remains unverified.
[Approval feedback](https://github.com/groktopus/proprio/pull/402)

The authenticated tool-call OpenAPI contract documents the 409 reconciliation
reason. It leaves the internal dispatch classification private. All 56
OpenAPI and five Apps queue tests and the generated OpenAPI check passed on
composition `4ad55ab58824ed3622d17df421e438aaa2d8dee5`.
[Gateway conflict contract](https://github.com/groktopus/proprio/pull/403)

Composition `a176612803e5836ef31f56f858973cf05a7ecb53` passed 214 tests
across audit routes, MCP Tasks, wake queue and the Apps review queue. The
one-connection authenticated reconstruction and generated OpenAPI check
also passed.

The authenticated approved-caller follow-up settles the replacement claim
only when the earlier intent blocked it before dispatch. It preserves the
reconciliation reason across the remote deadline and omits the internal
classification from the caller response. The regression holds the real
fingerprint lock past the deadline, checks the failed replacement in
PostgreSQL and verifies that the original unresolved intent stays open.
Six focused gateway tests and all 77 audit route and MCP Tasks tests
passed on composed source `d87f64c97347ffa7db3dd8b744e62c63720b8f00`.
The scoped server typecheck and generated OpenAPI check passed. Hosted
Linux qualification passed all five cases on this source against
`2363fe6fb68ece06e6dc4207e93be8b9c7646cc0`. Its retained report records zero
observed data loss in active-run migration recovery.
[Exact composition qualification](https://github.com/groktopus/proprio/actions/runs/45569138741)
[Retained qualification report](https://github.com/groktopus/proprio/actions/runs/45569138741/artifacts/15002831958)

The final local review composition `9909f614fe3bc379c16507645229afce6fc667ec`
passed nine focused gateway tests and the scoped server typecheck. It
settles both approved and unapproved
replacements blocked before dispatch. The no-approval regression verifies a
failed invocation, its original idempotency key, one failure event and
activity entry, and an open original intent with no new dispatch receipt.
[Gateway review fixes](https://github.com/groktopus/proprio/pull/403)
[Exact local review source](https://github.com/groktopus/proprio/commit/9909f614fe3bc379c16507645229afce6fc667ec)

Composition `b04311c661f927c2a324f833d0344c9fd03e9d01` incorporates main
`5e97a154d87317fc7a9aa051289974b02caf4827` and the reviewed Apps focus
change. It passed 79 tests across OpenAPI, the dependency diagnosis view,
wake diagnostics routes and Apps review. The OpenAPI generation check and
one-connection authenticated reconstruction also passed. The main change
added dependency diagnosis and investigation surfaces.
[Dependency investigation](https://github.com/groktopus/proprio/pull/308)

Composition `109847c866991fe061a658c818dc3607cf6cd126` also incorporates
main `166175cc093a569eed60b59f6df70f6c10c43290`. That main update contains
only the dependency restart test and its worker. The new restart test,
one-connection authenticated reconstruction, and scoped UI typecheck passed
on the composed source.
[Dependency restart regression](https://github.com/groktopus/proprio/pull/309)
[Current-main composition](https://github.com/groktopus/proprio/commit/109847c866991fe061a658c818dc3607cf6cd126)

Hosted Linux source qualification is running for that composition against
`166175cc093a569eed60b59f6df70f6c10c43290`.
[Current-main hosted qualification](https://github.com/groktopus/proprio/actions/runs/45575479150)

The subsequent review composition `0153750703bbb358692e5c8cb8fd77c3d18958bc`
passed 139 audit export, MCP Tasks, OpenAPI and Apps queue tests, plus four
focused gateway cases and the generated OpenAPI check. The large snapshot
test observed the full membership query waiting on its lock, kept another
company's API responsive, and replayed after deleting an off-page event.
Replay reported an incomplete snapshot without an additional page-access
receipt. The collector guidance records both mixed-version limitations.
[Rollout guidance](https://github.com/groktopus/proprio/pull/396)
[20,000-event export](https://github.com/groktopus/proprio/pull/397)

The interruption fixture removes the receipt fault before running the
sweep and compares the complete original dispatch row after the sweep.
The #398 slice still returns an executing replacement approval. The
dependent #399 fix returns a failed replacement and its reconciliation
message. Both exact heads passed the focused scenario. The MCP Tasks
fixture observes the committed intent before the legacy send is rejected,
then verifies one terminal outcome on the original invocation across all
company receipts. The Apps API and service share the nullable approval
response and report a settled failure without suggesting retry.
[Interruption fixture](https://github.com/groktopus/proprio/pull/398)
[Approval outcome](https://github.com/groktopus/proprio/pull/399)
[MCP Tasks](https://github.com/groktopus/proprio/pull/400)
[Approval feedback](https://github.com/groktopus/proprio/pull/402)

A full gateway run on `01537507` exposed 14 failures. The corrections
preserve definitive guard failures and keep an open intent after a write
may have started. Five approval fixtures now exercise the authoritative
human review transaction. A cancellation before HTTP handoff leaves the
request unstarted. The cancellation regression failed before the fix and
passed with the other 27 guarded transport tests at `6bc82a32`.

On `f69b90d6044ab0a874212e0670f532dbbd036479`, the full gateway file
passed 125 cases and failed three GitHub connection/catalog cases. The
same three failed on exact main `166175cc093a569eed60b59f6df70f6c10c43290`.
The one-connection reconstruction and scoped server typecheck passed. Main
advanced to `27339f998b4d8e7ae95bbc14395979b9d134ee88` with only a
dependency investigation browser test change.
[Transport classification](https://github.com/groktopus/proprio/pull/404)
[Human approval fixtures](https://github.com/groktopus/proprio/pull/405)
[Reviewed gateway composition](https://github.com/groktopus/proprio/commit/f69b90d6044ab0a874212e0670f532dbbd036479)

The authenticated reconstruction passed on the final local source with one
database connection, Node 24.22.1, a local process adapter, and a synthetic
loopback HTTP MCP target. The fixture used no model account. A separate company
operator with audit access joined the evidence after recreating the controller
against the same PostgreSQL database. These IDs refer to disposable data.

| Case | Task | Run | Invocation | Action request | Observed outcome |
| --- | --- | --- | --- | --- | --- |
| Approved | `feff8024-1dce-48c8-b543-dc89b48c876f` | `fae362ef-1270-416a-9888-57d64691f77d` | `e57f2bf9-7f5e-468a-89c5-9d2c168d5353` | `b3a23b55-7b64-4965-9218-4d9d87f382c9` | Success receipt and one target effect |
| Denied | `0b26d849-9ca2-4b5c-9339-a92b012745ff` | `b3382e10-6a0e-4482-8558-1aa1e87a6e52` | `b1d4114c-1cb8-4b81-9e6a-335d90dcdcb5` | `ef312478-0f31-4f72-81fd-3b573f4a85dd` | Denied with zero target effects |
| Interrupted | `fc4fee6d-edcf-4c2f-b867-f4148d3556b9` | `20d2678d-cfcc-4e9b-861c-350ea142781f` | `327ca0bd-6bb4-442a-a2bb-96a152708552` | `62cf7a85-1737-44c3-affe-e17b858776e8` | Open intent and one durable target effect after the lost response |

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

The reporting lock and SDK public-input checks reject `main` at
`2363fe6fb68ece06e6dc4207e93be8b9c7646cc0`. The committed lock SHA-256 is
`535010469947806e6b8f0edff97bd211ca96b573dccd81dd08556e3f7b43b337`. The same
lock bytes remain on `166175cc093a569eed60b59f6df70f6c10c43290`. The report
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

Hold expansion for missing decision/dispatch/terminal evidence, authority mismatch, private evidence exposure, an unresolved target effect, a source-epoch mismatch, or a stale lock/provenance identity. Pause affected writes or exports as appropriate, preserve evidence allowed by current retention policy, retain the external archive/checkpoint, and reconcile target effects and deletion obligations before retry or resume. Do not blindly resend an action with an unresolved dispatch intent. Rehearse compatible restore or roll-forward, record the known-good revision and decision owner, then rerun checks on the resumed candidate.

The recovery and audit work is tracked in [#150 restore reconciliation](https://github.com/groktopus/proprio/pull/361), [#206 capture/export/restore qualification](https://github.com/groktopus/proprio/pull/353), [#360 checkpointed export](https://github.com/groktopus/proprio/pull/360), [#369 older-restore export rehearsal](https://github.com/groktopus/proprio/pull/369), [#366 direct dispatch receipt](https://github.com/groktopus/proprio/pull/366), [#370 approved dispatch receipt](https://github.com/groktopus/proprio/pull/370), and [#368 end-to-end reconstruction](https://github.com/groktopus/proprio/pull/368). Preserve external archive evidence independently of application restore state; the archive/checkpoint must be reconciled with the current source epoch and deletion obligations before delivery resumes.

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
   both target historical policy; independent authority targets `main`. [#358](https://github.com/groktopus/proprio/pull/358) [#357](https://github.com/groktopus/proprio/pull/357) [#368](https://github.com/groktopus/proprio/pull/368)
6. Review the one-connection task and wake changes before repeating the
   stress reconstruction on the selected source. Task creation and wake delivery
   target `main`. Deferred promotion follows wake delivery. The independent
   [#401](https://github.com/groktopus/proprio/pull/401) fixture correction also targets `main`.
   [#393](https://github.com/groktopus/proprio/pull/393) [#394](https://github.com/groktopus/proprio/pull/394) [#395](https://github.com/groktopus/proprio/pull/395)

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
