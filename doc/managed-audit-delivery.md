# Managed audit delivery contract

**Status:** design proposal for #206. Qualification covers one managed tool-call path.

This document states the target contract; it is not evidence that the contract
is implemented or qualified. A successful page response, cursor, or source
export receipt only describes source-side snapshot progress. It does not prove
that an independently governed archive committed the page. Until a durable
archive acknowledgement protocol is implemented and qualified, no event is
eligible for pruning based on page reads, cursors, or source receipts.

At this proposal's base, `/companies/:companyId/audit/agent-actions` is a live
JSON/CSV projection, not an independently retained archive. The requirements
below describe the eventual managed-gateway capture and export contract. A
source-side snapshot/page implementation is only a partial delivery path until
archive acknowledgement, privacy revalidation, capture coverage, and the
qualification criteria below are implemented and pass.

## First covered path

Qualify one Runner and one synthetic managed connector invoked through the
Proprio tool gateway. Export the minimized lifecycle from effective policy
decision through any required approval to the gateway's observed outcome:

| Stage | Authoritative transition and required capture boundary |
| --- | --- |
| Policy decision and invocation admission | `toolInvocations` / `toolCallEvents`, written by `server/src/services/tool-access-policy.ts`. Capture the decision with invocation admission, including allow, deny, or approval-required. |
| Approval request and resolution | `toolActionRequests` and linked `approvals`. Capture each status transition in its owning transaction. Formal approval creation on the gateway path must be captured in the gateway transaction that inserts it, using its invocation, action-request, and task context; do not depend on the later task backlink. |
| Dispatch intent | The gateway's guarded `startToolInvocation` transition to `executing`, after any required approval claim and policy re-admission. Capture only when that transition succeeds. A rejected or expired approval has no dispatch-intent event. |
| Call outcome | `toolInvocations` / `toolCallEvents`, written by `server/src/services/tool-gateway.ts`. Capture success or a known failure after dispatch. An ambiguous external effect remains unknown until reconciled; keep a durable retry fence for the original run and invocation until then. |

The first path covers approvals attached to a gateway action only. General
formal approvals outside this path, the separate `decisionInvocations` service,
arbitrary activity-log entries, native runner traces, plugin writes, and the
connector's own target-side ledger are unsupported. #207 can add historical
policy/runtime provenance without expanding this event population. #209 still
requires independent target-side inspection for approved, denied, and
interrupted effects.

These are target capture owners, not claims about current atomicity. Invocation
admission can precede approval and dispatch; the gateway later calls
`startToolInvocation` after approval and policy re-admission. The eventual
outbox must therefore record policy decision with admission and dispatch intent
with the successful `startToolInvocation` transition in separate transactions.
Formal approval creation on the gateway path inserts the approval before the
action request receives its backlink, so capture must use the IDs already
present in that creation transaction. In the current interruption sweep,
`toolReviewInterruptionService.sweep` settles an interrupted request and
invocation in `writeToolReviewChange`; its callback runs after commit to emit
connection telemetry and reflect review lifecycle. It does not append managed
audit evidence. The eventual recovery transaction must append a receipt
recording an unknown external effect in that same transaction. Do not report
the request's `failed` status as proof that the external call failed.

The external call itself cannot share a database transaction. Commit dispatch
intent before invoking the connector. If outcome capture fails after the
external call, the committed intent remains unresolved: retries in the
original run as well as recovery runs must hit a durable fence, and no second
connector call may occur until the outcome is reconciled. A best-effort
recovery callback is not that fence.

## Event and export contract

Each append-only event has a stable event ID, schema version, source name,
company ID, event/observation times, actor, lifecycle event type, and a
stage-specific policy decision, approval status, or execution outcome. Include
applicable run, invocation, action-request, approval, and connection IDs, plus
policy/runtime revision IDs or non-secret fingerprints. Do not export
credentials, raw tool arguments, request/response bodies, diagnostic payloads,
or unredacted task content. An external archive deduplicates by
`(source,eventId)`.

Keep task authorization provenance separately from the exported event fields.
Persist whether visibility is company-scoped or task-scoped and the durable ID
of every task that governs access; do not infer company scope from a nullable
source foreign key. Preserve that provenance if the source task or run is
deleted. A missing task must not turn formerly task-scoped evidence into
company-wide evidence. If current visibility cannot be established, fail
closed and invalidate the snapshot. Never copy source diagnostic payloads to
retain authorization context.

The target permissioned API creates a short-lived frozen export over the
supported append-only event set. At snapshot creation, use one repeatable-read
database snapshot to materialize authorized event membership, stable page
ordinals, a fixed item count, and a deterministic digest of `(source,eventId)`
pairs sorted lexicographically. The target source receipt would expose source
identity, export ID, source epoch, count, digest watermark, and source-side page
progress. It is not an archive acknowledgement. A cursor names an export and
ordinal so a collector can resume after interruption and safely deduplicate a
repeated page; the collector must persist each page and its checkpoint with its
independently governed archive.

The outbox record stores only the fields above, internal authorization
provenance, and a pointer to the authoritative source event. Do not copy the
source row's diagnostic payload. A page response, cursor advance, or source
receipt does not prove archive commit and cannot authorize pruning. Until a
separately authenticated durable archive acknowledgement identifies the
source epoch and committed export/digest, retain outbox records through their
declared retention. If no verifiable acknowledgement exists at expiry, retain
an explicit loss marker in the independent coverage/loss ledger and report the
interval incomplete. Product deletion must preserve permissible acknowledged
evidence and explicitly account for
uncollected eligible evidence before removing outbox rows. Evidence never
verified as committed by the independent archive cannot be claimed as
independently retained.

This is a fixed snapshot watermark, not a global event sequence. There is no
per-company producer counter and no claim of monotonic incremental ordering.
Each export scans the retained supported set; collectors reconcile by stable
event IDs and receipt digest. This costs a full scan but avoids introducing a
new lock into every company write path. An incremental sequence may be added
only with a separately reviewed transaction/lock protocol.

### Privacy and access

The API requires company access and an explicit audit-delivery permission.
Private-task and issue visibility predicates apply before materialization and
before counts/digests are computed. A snapshot is bound to its creator and
company. Before returning any receipt or page, recheck the export permission
and establish current eligibility for the entire frozen membership, not only
the page being read. If any member loses eligibility or its scope cannot be
resolved, invalidate the whole export and require a new snapshot. Do not return
stale counts, positions, or digests after invalidation. Cursor paging cannot
reveal hidden row counts or positions.

Snapshot creation is not evidence that anyone downloaded the export. Audit each
successful page release with the authenticated exporting actor, export ID, and
page/cursor and item-count metadata. Do not log event payloads in that access
record. Qualification must verify the actor and export ID for the released
page, including after access changes invalidate the snapshot.

The existing `/companies/:companyId/audit/agent-actions` endpoint is not this
contract: its cursor pages a live newest-first projection, it has no export ID
or frozen watermark, and its CSV wrapper caps at 10,000 rows. Paging its JSON
response beyond that cap still cannot protect an interrupted collector from
source deletion or detect a restore fork.

## Loss, restore, and archive behavior

Target behavior: snapshot expiry returns an inspectable `snapshot_expired`
incomplete result; it does not silently create a replacement export. Capture
failure publishes no complete receipt and returns an inspectable source/reason.
A known missing source or unsupported interval is reported as incomplete,
never as an empty, complete export. The collector stores its export ID, cursor,
epoch, counts, digest, and receipts with the independently governed archive.

Coverage must not be inferred from the surviving event IDs. Publish a durable
coverage manifest outside the database rollback boundary with the capture start
time, supported producers, schema version, and source epoch. Receipts name the
requested interval and can be complete only when it is inside declared
coverage and no capture gap or unresolved dispatch is known. An empty event set
within a covered interval may be complete; an interval before or outside
coverage is incomplete. A failed transaction cannot reliably record its own
loss marker: pre-dispatch capture failure must block dispatch, while a
post-dispatch outcome failure leaves the already-committed dispatch intent
unresolved until recovery appends an unknown receipt. If recovery cannot append
that receipt, keep an independent durable gap or unresolved-capture record
outside the failed transaction and database rollback boundary; never let the
failed transaction roll back the only evidence that coverage is incomplete.

An older database restore can rewind the event set. Core cannot infer every
restore from a value stored only in that database. Before restored service or
export resumes, the operator must rotate a source epoch outside the rollback
boundary. Collectors compare it with their externally stored epoch; a mismatch
invalidates old cursors and requires reconciliation. The exact operator
handoff is not specified by #150: that issue addresses private provider-trace
deletion obligations, not a general audit-stream epoch. It must be defined and
exercised separately for #206.

The archive has its own owner, retention, access, and erasure policy. Product
deletion must not silently erase permissible evidence already exported, and
must not cause restricted or expired evidence to be republished. The #150
restore procedure must define which deletion obligations survive restore,
where their records live outside the rollback boundary, and when reconciliation
blocks access. If deletion or restore removes supported events before export,
the exporter reports the loss when it is known; it must not claim that the
remaining rows prove completeness. The existing `tool_runtime_metric_counters`
audit-write-failure metric is only a best-effort company/minute warning, not a
completeness counter or delivery receipt; it has no event identity and shares
the product database restore/deletion boundary.

## Why not a per-company sequence

A serialized append-only outbox with a per-company sequence could prove
continuity only if every producer writes the event with its authoritative state
in one transaction. Such a counter needs a consistent lock order across all
producers and a lock held through commit to preserve sequence order. The bounded
snapshot design freezes event membership, count, and digest without adding a
producer lock. A subsequent scan finds late-committing events by ID. Append-only retention and transactional capture
are required for that claim. A digest proves which set was exported; it does not
prove that an unsupported producer emitted an event. General formal approvals
outside the gateway path and `decisionInvocations` remain explicit coverage gaps.

Target behavior if the source set cannot remain append-only until collection,
or if transactional capture cannot be established at the covered gateway
boundaries, the API returns an explicit incomplete/loss outcome. It must not
substitute a best-effort live collector for the guarantee in #206.

## Verification before qualification

Use the normal gateway and export paths in a fixture that verifies:

- More than 10,000 events across multiple pages; interruption and resume from
  the source cursor; repeated pages do not double-count. A source cursor is not
  counted as archive acknowledgement. Verify that only a durable archive
  acknowledgement permits pruning; without one, retain evidence until expiry
  and surface an explicit loss marker for unacknowledged evidence.
- Expired snapshots, failed capture, source-epoch mismatch, out-of-coverage
  intervals, and a deliberately unavailable/lost source produce inspectable
  incomplete outcomes. A pre-dispatch capture failure blocks dispatch; a
  post-dispatch capture failure remains fenced and resolves to an unknown
  external effect in the recovery transaction.
- Cross-company and private-task records are excluded before materialization,
  page positions, counts, and digests. Change visibility for a member on page
  one, then verify that every later page and receipt is invalidated, including
  when the member was on a different page. Task deletion preserves internal
  authorization provenance and fails closed rather than widening scope.
- Successful page releases create an access audit record with the actual
  exporting actor and export ID. Snapshot creation alone is not a download.
- Approved, denied, rejected/expired approval, and interrupted calls correlate
  policy, approval, dispatch intent, and gateway outcome. Approval creation is
  captured before its task backlink exists. Interrupt after dispatch and verify
  an unknown external effect, not a known failed call or missing outcome. Retry
  after an ambiguous provider response in the original run and verify there is
  no second connector call. Independently inspect target state for #209.
- Exercise older restore and deletion against the #150 operator procedure;
  preserve permitted archived evidence, exclude expired/restricted evidence,
  and surface loss of unexported evidence. Verify coverage start and known-loss
  records survive independently of the event ID set and the database restore.

Record revision, deployment configuration, runner, connector, visibility,
archive policy, source epoch, operators, and remaining unsupported paths with
the fixture result. Until these checks pass, this is a proposed contract, not
evidence of completeness.
