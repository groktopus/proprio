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

Set `PROPRIO_MANAGED_AUDIT_RETAIN_AFTER` on every API instance to the earliest
event time allowed by the deployment's retention policy. Use an ISO timestamp
with an offset and no more than three fractional-second digits. A window before
this boundary, or a cursor for such a window, returns
`retention_window_expired`. When advancing the boundary, remove API instances
with the old setting from export traffic before treating the new boundary as
enforced.

An export snapshot contains at most 100,000 visible event IDs. A request that
would exceed this bound returns `snapshot_too_large`; split the time interval
into smaller windows and reconcile each checkpoint independently. Page reads
serialize per export and use a five-second database statement bound. A busy
reader returns `snapshot_read_busy`; a query that reaches the bound returns
`snapshot_read_timeout` without releasing a partial page.

1. Send `POST /api/companies/:companyId/audit/managed-exports` with `from` and
   `to` ISO timestamps. The interval includes `from` and excludes `to`.
2. Store the returned export ID, source epoch, bounds, event count and watermark.
   Request `GET /api/companies/:companyId/audit/managed-exports/:exportId`.
3. Persist every page's membership under its export ID before advancing the
   cursor, even when the payload is already present in the archive. Deduplicate
   archived events by `(source, event ID)`; the event ID remains stable across
   restores and source-epoch rotations. Persist the page's IDs and payloads
   before recording the returned `nextCursor`. If a collector stops after the
   page write but before cursor advancement, replay that page idempotently. A
   repeated page uses the same event IDs.
4. Confirm that the final page reports `complete`, the archived count equals
   `eventCount`, and the watermark equals the SHA-256 of the compact JSON
   array of archived event IDs in lexicographic order.

The receipt sets `completenessScope` to `authorized_scope`. `complete` means
that every member in this frozen, currently authorized scope was delivered. It
does not prove global source completeness. A lost run binding is reported only
when stored provenance proves that the current operator may read its source.
Private, deleted, historical, or unknown bindings are not identified or counted
as authorized loss. A null run scope never means company scope. Keep capture
boundaries and independent checkpoints so operators can reconcile these gaps.

An invocation's `occurredAt` can predate the commit that makes its event
visible. A transaction that commits after a window snapshot is frozen can be
absent from that export even when its timestamp is inside the window. Rescan
previously exported windows during reconciliation and deduplicate by stable
event ID; a completed snapshot is final only for its frozen membership, not
for all events that may later commit into the interval.

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
`managed_audit_export_page_access` through the authorized database operator
role. The migration revokes Data API role grants and enables row-level
security. The table owner retains access. Offsets and counts can disclose
private evidence. The record survives snapshot deletion and expiry. The
storage owner applies the deployment's audit retention policy to these records
and any database backups that contain them.

A source epoch change or an expired
snapshot also requires a new export after reconciliation. Snapshots expire
after 24 hours. Starting a new export clears expired snapshots for its company.

Exported event objects contain only the public event fields in the API contract.
Internal run-scope provenance is never returned in a page.

Keep permissible evidence in the independent archive under the archive's access,
retention and erasure policy. Company deletion can remove product-side records.
An export receipt proves the scope and membership of one snapshot. Use target
receipts to establish what a managed action changed.

For periodic collection, use a fresh export ID for a bounded overlapping
lookback. Set its `from` to the latest of the desired lookback start,
`PROPRIO_MANAGED_AUDIT_CAPTURE_FROM`, and `PROPRIO_MANAGED_AUDIT_RETAIN_AFTER`
when configured. Create it only when that effective `from` precedes `to`, and
record any clipped portion for source reconciliation. Keep the source epoch,
export ID, bounds, count, watermark, page membership and cursor together. A
snapshot that expires must be reconciled before opening another one.

An invocation can carry an earlier `occurredAt` while its transaction commits
after the initial snapshot. That event is absent from both the frozen initial
window and a fresh adjacent window that starts at the initial boundary. A new
overlapping export can find it while the source row remains available. The
watermark proves membership and delivery for that one frozen snapshot, not a
commit-ordered high-water mark; delays beyond the bounded lookback require
source or target reconciliation. A source-epoch change fences old exports, so
start a fresh export after reconciliation and deduplicate its event by the same
`(source, event ID)` key.
