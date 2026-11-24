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

An export belongs to the creating operator and company. Company, audit and task
access are checked for eligible events. A page with unavailable evidence returns
`snapshot_incomplete` and sends no partial page. Preserve the checkpoint and
reconcile before opening a new export. A source epoch change or an expired
snapshot also requires a new export after reconciliation. Snapshots expire
after 24 hours. Starting a new export clears expired snapshots for its company.

Keep permissible evidence in the independent archive under the archive's access,
retention and erasure policy. Company deletion can remove product-side records.
An export receipt proves the scope and membership of one snapshot. Use target
receipts to establish what a managed action changed.

## Restore qualification and limits

`server/src/__tests__/agent-action-audit-routes.test.ts` exercises the normal
export API against an older JavaScript logical backup restored into a sibling
database. It writes delivered page bytes and the resume checkpoint to files
outside both databases, resumes by that checkpoint, and verifies the archived
ID watermark after a source row is deleted. The old checkpoint reports
`snapshot_incomplete` when its row is missing. After restoring the older backup
and rotating `PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH`, that checkpoint reports
`source_epoch_changed`; it is not a new complete export. A fresh API snapshot
uses the restored data and current access, omits a private-task event, and
removes expired snapshot records. The fixture qualifies an isolated logical
restore/fork, not production PITR or an external archive provider.

The 24-hour expiry applies to export snapshots, not individual managed audit
events. There is no event-level expiry marker or restore-time deletion ledger
for this source. The independent archive owner must apply its own retention and
erasure rules. Before reopening export after an older restore, reconcile
product deletion obligations from the separately retained records; rotating
the source epoch only fences old checkpoints and does not identify rows a
restore may have resurrected. The test demonstrates snapshot-gap and epoch
signals, not automatic reconciliation of event deletion obligations.
