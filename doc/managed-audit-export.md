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

1. Send `POST /api/companies/:companyId/audit/managed-exports` with `from` and
   `to` ISO timestamps. The interval includes `from` and excludes `to`.
2. Store the returned export ID, source epoch, bounds, event count and watermark.
   Request `GET /api/companies/:companyId/audit/managed-exports/:exportId`.
3. Persist the page to separately governed storage. Deduplicate events by source
   and ID. Then record the returned `nextCursor` and send it as `cursor` on the
   next request. A repeated page uses the same event IDs.
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
access are checked for eligible events. A page with unavailable evidence returns
`snapshot_incomplete` and sends no partial page. Preserve the checkpoint and
reconcile before opening a new export. A source epoch change or an expired
snapshot also requires a new export after reconciliation. Snapshots expire
after 24 hours. Starting a new export clears expired snapshots for its company.

Exported event objects contain only the public event fields in the API contract.
Internal run-scope provenance is never returned in a page.

Keep permissible evidence in the independent archive under the archive's access,
retention and erasure policy. Company deletion can remove product-side records.
An export receipt proves the scope and membership of one snapshot. Use target
receipts to establish what a managed action changed.
