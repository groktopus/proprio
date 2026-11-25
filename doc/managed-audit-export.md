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
3. Persist the page to separately governed storage. Deduplicate events by source
   and stable event ID. Event IDs can remain the same after a database restore,
   so do not include the source epoch in the archive's event deduplication key.
   Bind each export ID and resume checkpoint to its source epoch; after epoch
   rotation, reconcile and create a fresh export instead of resuming the old one.
   Then record the returned `nextCursor` and send it as `cursor` on the next
   request. A repeated page uses the same event IDs.
4. Confirm that the final page reports `complete`, the archived count equals
   `eventCount`, and the watermark equals the SHA-256 of the compact JSON
   array of archived event IDs in lexicographic order.

An export belongs to the creating operator and company. Company, audit and task
access are checked for eligible events. For a missing task or run, snapshot
creation reports an incomplete source unless the surviving binding proves the
event is outside the operator's access. Before releasing a page, the API checks
every event in the snapshot because the count and watermark describe all pages.
If any event is unavailable, the API returns `snapshot_incomplete` without
returning the page, count or watermark. Preserve the checkpoint and
reconcile before opening a new export. A source epoch change or an expired
snapshot also requires a new export after reconciliation. Snapshots expire
after 24 hours. Starting a new export clears expired snapshots for its company.

Keep permissible evidence in the independent archive under the archive's access,
retention and erasure policy. Company deletion can remove product-side records.
An export receipt proves the scope and membership of one snapshot. Use target
receipts to establish what a managed action changed.

For periodic collection, re-export a bounded overlapping lookback using a new
export ID, then deduplicate the archived events by `(source, event ID)`. Keep
each snapshot's bounds, source epoch, count and watermark with its delivery
checkpoint. Do not treat a completed snapshot as proof that its time interval is
final: a covered gateway transaction can commit after the snapshot was created
while carrying an earlier `occurredAt`, and the next adjacent interval will
exclude that event. A fresh overlapping snapshot can find it while the source
row remains available. The current watermark proves membership and delivery of
one frozen snapshot only; it is not a commit-ordered high-water mark and gives
no upper bound on late commits. This overlap procedure reduces the exposure but
does not guarantee completeness for arbitrarily delayed transactions. Reconcile
the affected interval against source or target evidence when completeness is
required.

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
