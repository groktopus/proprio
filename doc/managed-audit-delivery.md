# Managed audit delivery contract

**Status:** proposed for #206; not implemented or release-qualified. This
contract defines one managed tool-call path, not a complete company audit feed.

## First covered path

Qualify one Runner and one synthetic managed connector invoked through the
Proprio tool gateway. Export the minimized lifecycle from effective policy
decision through any required approval to the gateway's observed outcome:

| Stage | Authoritative state and producer boundary |
| --- | --- |
| Policy decision and dispatch intent | `toolInvocations` / `toolCallEvents`, written by `server/src/services/tool-access-policy.ts`. The decision and intent must commit before the connector is called; failure blocks dispatch. |
| Gateway approval request/resolution | `toolActionRequests` and linked `approvals`. Capture a resolution with the status transition in its owning service transaction. |
| Call outcome | `toolInvocations` / `toolCallEvents`, written by `server/src/services/tool-gateway.ts`. Capture success, failure, timeout, or unknown after dispatch. An ambiguous result remains unknown until reconciled; do not retry under a new invocation identity. |

The first path covers approvals attached to a gateway action only. General
formal approvals outside this path, the separate `decisionInvocations` service,
arbitrary activity-log entries, native runner traces, plugin writes, and the
connector's own target-side ledger are unsupported. #207 can add historical
policy/runtime provenance without expanding this event population. #209 still
requires independent target-side inspection for approved, denied, and
interrupted effects.

Current writes are not all atomic with their authoritative state. For example,
`tool-access-policy.ts` writes invocation and call evidence separately, gateway
events can follow action-request or call-state changes, and `routes/approvals.ts`
logs formal approval after `svc.approve()`. Add a minimized append-only
`managed_audit_events` outbox and insert its records in the same transaction as
the source transition: policy decision/dispatch intent with invocation
admission, approval request/resolution with action-request status, and call
receipt with invocation outcome. Linked formal approval must be captured at its
own approval-service transition. The external call itself cannot share a
database transaction: commit a dispatch intent first, then commit the receipt
or preserve an explicit unknown outcome.

## Event and export contract

Each append-only event has a stable event ID, schema version, source name,
company ID, event/observation times, actor, outcome, and applicable run,
invocation, action-request, approval, and connection IDs. Include policy/runtime
revision IDs or non-secret fingerprints. Do not export credentials, raw tool
arguments, request/response bodies, diagnostic payloads, or unredacted task
content. An external archive deduplicates by `(source, eventId)`.

The permissioned API creates a short-lived frozen export over the supported
append-only event set. At snapshot creation, use one repeatable-read database
snapshot to materialize authorized event membership, stable page ordinals, a
fixed item count, and a deterministic digest of `(source,eventId)` pairs
sorted lexicographically. The receipt exposes source identity, export ID, source epoch, count,
digest watermark, and completion state. Pages read only the materialized set;
they never requery mutable source tables. The cursor names an export and ordinal,
so a collector can persist each page before acknowledging its cursor, resume
after interruption, and safely deduplicate a repeated page.

The outbox record stores only the fields above plus a pointer to the
authoritative source event. Do not copy the source row's diagnostic payload.
Keep records until they are archived or their declared retention expires; an
expired interval must leave an explicit retention/loss marker. Product deletion
must export or explicitly account for uncollected eligible evidence before it
removes outbox rows. Evidence never delivered to the independent archive cannot
be claimed as independently retained.

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
company; authorization is rechecked on every page, and revoked access fails
closed. Cursor paging cannot reveal hidden row counts or positions.

The existing `/companies/:companyId/audit/agent-actions` endpoint is not this
contract: its cursor pages a live newest-first projection, it has no export ID
or frozen watermark, and its CSV wrapper caps at 10,000 rows. Paging its JSON
response beyond that cap still cannot protect an interrupted collector from
source deletion or detect a restore fork.

## Loss, restore, and archive behavior

Snapshot expiry returns an inspectable `snapshot_expired` incomplete result; it
does not silently create a replacement export. Capture failure publishes no
complete receipt and returns an inspectable source/reason. A known missing
source or unsupported interval is reported as incomplete, never as an empty,
complete export. The collector stores its export ID, cursor, epoch, counts,
digest, and receipts with the independently governed archive.

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
in one transaction. Taking a company counter lock before existing domain locks
can invert lock order; taking it later can allow commit-order gaps. The bounded
snapshot design instead adds no producer lock: it freezes event membership,
count, and digest at one database snapshot, and a full subsequent scan finds
late-committing events by ID. Append-only retention and transactional capture
are required for that claim. A digest proves which set was exported; it does not
prove that an unsupported producer emitted an event. General formal approvals outside the gateway path and
`decisionInvocations` therefore remain explicit gaps until their producers are
adapted and qualified.

If the source set cannot remain append-only until collection, or if
transactional capture cannot be established at the covered gateway boundaries,
the API returns an explicit incomplete/loss outcome. It must not substitute a
best-effort live collector for the guarantee in #206.

## Verification before qualification

Use the normal gateway and export paths in a fixture that verifies:

- More than 10,000 events across multiple pages; interruption and resume from
  the acknowledged cursor; repeated pages do not double-count; receipt count
  and digest match the archived event-ID set.
- Expired snapshots, failed capture, source-epoch mismatch, and a deliberately
  unavailable/lost source produce inspectable incomplete outcomes.
- Cross-company and private-task records are excluded before materialization,
  page positions, counts, and digests; unauthorized and revoked reads fail.
- Approved, denied, and interrupted calls correlate policy, approval, dispatch
  intent, and gateway outcome. Independently inspect target state for #209.
- Exercise older restore and deletion against the #150 operator procedure;
  preserve permitted archived evidence, exclude expired/restricted evidence,
  and surface loss of unexported evidence.

Record revision, deployment configuration, runner, connector, visibility,
archive policy, source epoch, operators, and remaining unsupported paths with
the fixture result. Until these checks pass, this is a proposed contract, not
evidence of completeness.
