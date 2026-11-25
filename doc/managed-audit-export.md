# Managed audit export

An authenticated board operator with `audit:view_agent_actions` can create a
frozen export of minimized managed gateway evidence. The initial source covers
newly recorded gateway invocation decisions. Check the receipt's coverage before
using it. Gateway dispatch, approval resolution and observed effects have
separate evidence sources until those events are qualified for delivery.

Set `PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH` to an operator-generated UUID and
`PROPRIO_MANAGED_AUDIT_CAPTURE_FROM` to the UTC instant when all covered gateway
writers started capturing records for that epoch. Set both on each API instance.
Keep the configuration and archive checkpoints outside the database backup.
After an older restore, reconcile deletion obligations and rotate the epoch
before enabling export. Record which intervals require reconciliation. The
database and these settings cannot tell an archive that an event was lost before
it was first collected.

Set `PROPRIO_MANAGED_AUDIT_RETAIN_AFTER` to the earliest event time allowed by
the deployment's data retention policy, if it has an expiry boundary. Set the
same cutoff on every API instance that serves export creation or page reads.
Use an ISO timestamp with an offset and at most three fractional-second digits.
The API returns `retention_window_expired` for an export that overlaps an older interval.
This also invalidates a cursor created before the retention boundary advanced.
Keep this boundary outside the database rollback domain.

1. Send `POST /api/companies/:companyId/audit/managed-exports` with `from` and
   `to` ISO timestamps. The interval includes `from` and excludes `to`.
2. Store the returned export ID, source epoch, bounds, event count and watermark.
   Request `GET /api/companies/:companyId/audit/managed-exports/:exportId`.
3. Persist each page's event IDs under this export ID, even if all its payloads
   were already archived. This preserves membership for the snapshot count and
   watermark. Deduplicate archived events by `(source, event ID)`, which remains
   stable for events carried across a restore and source-epoch rotation. Bind the export ID
   and resume checkpoint to the source epoch. Persist the page's payloads and
   IDs before advancing the checkpoint to the returned `nextCursor`. If a crash
   occurs before advancing it, replay the same page idempotently. A repeated
   page uses the same event IDs.
4. Confirm that the final page reports `complete`. Count the distinct event IDs
   recorded for this export ID and compare the count to `eventCount`. Compare
   the watermark to the SHA-256 of those IDs encoded as a compact JSON array in
   lexicographic order.

An export belongs to the creating operator and company. Company, audit and task
access are checked for eligible events. Personal conversations also require
owner access, including when the only surviving reference is a run bound to the
conversation. For a missing task or run, snapshot creation reports an incomplete
source unless the surviving binding proves the event is outside the operator's
access. Before releasing a page, the API checks
every event in the snapshot because the count and watermark describe all pages.
If any event is unavailable, the API returns `snapshot_incomplete` without
returning the page, count or watermark. The server persists the invalidation
until the snapshot expires and discards its membership. Old cursors remain
invalid after the evidence becomes visible again. The server serializes page
validation and invalidation for each snapshot. It records the company, operator,
export ID and one transitioned-snapshot count in `managed_audit_transition_receipts` in
the same transaction. This protected database receipt is not exposed through
company activity or WebSocket publications; only the database owner can read
it. A client-written activity row cannot create or alter the receipt. The
company foreign key cascades when the company is deleted, while snapshot expiry
does not remove it. Drain every older API replica before claiming this
visibility guarantee because mixed-version replicas may still publish the old
activity event. Preserve the checkpoint and reconcile before opening a new
export. The server commits an access record
before releasing each successful page, including a replay. The record holds the
company, operator, export ID, page offset, item count and access time. Storage
operators can review it by company and export ID in
`managed_audit_export_page_access` through the authorized database operator
role. The migration revokes Data API role grants and enables row-level
security. The table owner retains access. Offsets and counts can disclose
private evidence. The record survives snapshot
expiry. The storage owner applies the deployment's audit retention policy to
these records and any database backups that contain them.

Each snapshot supports up to 20,000 visible events. If creation returns
`413 snapshot_membership_limit`, split the time window and preserve the
collector's overlap and deduplication rules. A cursor from an oversized
snapshot returns `409 snapshot_membership_limit`. Create a narrower snapshot
before continuing. If more than 20,000 events share the same millisecond,
record the affected interval and source epoch as an unresolved gap. Preserve
the checkpoint before that interval and reconcile it with an independently
authorized source of audit evidence before marking the interval complete.

An API process runs one export operation at a time. Up to three other
companies can queue one request each. The oldest queued company gets the next
slot. Duplicate requests for an active or queued company, a full queue, and
a wait beyond 25 seconds return `429 export_busy`. Export work uses the
dedicated connection budget. PostgreSQL statements have a five-second maximum
timeout, and the export closes a lease that exceeds seven seconds. An exhausted
connection budget, an interrupted lease, or database contention returns
`503 export_retry_required`. Retry with backoff using the same request or
cursor. Advance the checkpoint only after the page arrives and the collector
persists its membership and payloads.

A company can retain up to 128 active snapshots across all operators, with up
to 32 per operator. Creation returns `429 principal_snapshot_limit` when the
operator has reached the limit or `429 active_snapshot_limit` when the company
has reached its limit. Resume a snapshot you own or retry after one expires.
The limits take effect after every replica that creates exports is upgraded.
Rolling out a changed limit does not rebalance existing active snapshots that
still match the current source epoch and retention boundary. If the new limit
is lower than an operator's existing count, new creation remains capped until
the count falls below the limit through expiry or invalidation.
Invalidating a snapshot immediately frees both its operator and company quota
slots. Its thin invalidation marker remains available through the snapshot's
original expiry and the marker-retention period after expiry.

Successful creation retires snapshots from older epochs or windows before the
configured cutoff by setting their durable invalidation marker. It keeps each
snapshot's original expiry time, so a replica with a clock behind the writer
cannot treat a retired receipt as complete after memberships are released.
Readers check source epoch and retention cutoff first, then preserve the
existing `snapshot_expired` response for an expired receipt, then check the
invalidation marker. Before its original expiry, a reader with a clock behind
the retirement writer still sees the durable marker. Retired checkpoints
return `source_epoch_changed` or `retention_window_expired` while the boundary
is in force, and `snapshot_incomplete` if that boundary is rolled back before
expiry. Drain replicas with older settings before accepting export traffic
after a source epoch or cutoff change.

A successful create processes at most eight expired or retired snapshots for
cleanup. This includes deleting markers beyond retention and clearing retained
memberships of up to 20,000 IDs each. Each clear commits with a terminal
marker, and later creates continue the cleanup. Retired snapshots do not
consume active capacity. The protected `company_exports_retired` receipt
records the company, operator, source and number of retired snapshots.

The API keeps an owner-scoped marker for 24 hours after expiry. A reader in the
current epoch and retention window returns `409 snapshot_expired` after the
original expiry. A slower reader that still considers a cleared snapshot live
returns `409 snapshot_incomplete`. Once cleanup removes the marker, the cursor
returns `404 snapshot_missing`. Page access records follow separate retention
rules.

A source epoch change, a retired checkpoint, or an expired snapshot requires a
new export after reconciliation. Snapshots expire after 24 hours.

Keep permissible evidence in the independent archive under the archive's access,
retention and erasure policy. Company deletion can remove product-side records.
An export receipt proves the scope and membership of one snapshot. Use target
receipts to establish what a managed action changed.

For periodic collection, re-export a bounded overlapping lookback using a new
export ID. Set `from` to the latest of the desired lookback start,
`PROPRIO_MANAGED_AUDIT_CAPTURE_FROM`, and `PROPRIO_MANAGED_AUDIT_RETAIN_AFTER`
when configured. Create an export only when that `from` precedes `to`. Record any
portion of the desired interval left outside the request for reconciliation.
Keep the source epoch,
export ID, bounds, count, watermark, page membership and cursor together. If a
snapshot expires, reconcile its checkpoint before opening a fresh export.

A covered gateway transaction can commit after the snapshot was created while
carrying an earlier `occurredAt`. An adjacent interval will exclude it. A fresh
overlapping snapshot can find it while the source row remains available. The
watermark verifies membership and delivery for one frozen snapshot. If a
transaction commits after its event time has passed out of the lookback,
reconcile the affected interval against source or target evidence.

## Restore qualification and limits

`server/src/__tests__/agent-action-audit-routes.test.ts` exercises the normal
export API against an older JavaScript logical backup restored into a sibling
database. It writes delivered page bytes and the resume checkpoint to files
outside both databases, resumes by that checkpoint, and verifies the archived
ID watermark after a source row is deleted. The old checkpoint reports
`snapshot_incomplete` when its row is missing. After restoring the older backup
and rotating `PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH`, that checkpoint and a
retained expiry marker from the old epoch both report `source_epoch_changed`. A fresh API snapshot
uses the restored data and current access. The test rejects the expired event
window, verifies a new page omits restricted evidence, and verifies an advanced
retention boundary invalidates its cursor. The qualification scope is an
isolated logical restore with a local archive fixture.

The 24-hour snapshot expiry and the operator's event retention boundary control
delivery. The independent archive owner applies a separate erasure policy.
Before reopening export after an older restore, reconcile individual deletion
obligations from separately retained records. Rotating the source epoch fences
old checkpoints. It cannot identify an individual record restored from backup.
