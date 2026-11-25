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
returning the page, count or watermark. Preserve the checkpoint and
reconcile before opening a new export. The server commits an access record
before releasing each successful page, including a replay. The record holds the
company, operator, export ID, page offset, item count and access time. Storage
operators can review it by company and export ID in
`managed_audit_export_page_access`. Keep access to this table restricted because
offsets and counts can disclose private evidence. The record survives snapshot
expiry. The storage owner applies the deployment's audit retention policy to
these records and any database backups that contain them.

A source epoch change or an expired
snapshot also requires a new export after reconciliation. Snapshots expire
after 24 hours. Starting a new export clears expired snapshots for its company.

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
and rotating `PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH`, that checkpoint reports
`source_epoch_changed`; it is not a new complete export. A fresh API snapshot
uses the restored data and current access. The test rejects the expired event
window, verifies a new page omits restricted evidence, and verifies an advanced
retention boundary invalidates its cursor. The qualification scope is an
isolated logical restore with a local archive fixture.

The 24-hour snapshot expiry and the operator's event retention boundary control
delivery. The independent archive owner applies a separate erasure policy.
Before reopening export after an older restore, reconcile individual deletion
obligations from separately retained records. Rotating the source epoch fences
old checkpoints. It cannot identify an individual record restored from backup.
