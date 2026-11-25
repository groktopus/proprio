---
title: Activity
summary: Activity log queries
---

Query the audit trail of all mutations across the company.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

## What Gets Logged

All mutations are recorded:

- Issue creation, updates, status transitions, assignments
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, approval/rejection decisions
- Comment creation
- Budget changes
- Company configuration changes

The activity log is append-only and immutable.

## Managed Audit Exports

`POST /api/companies/{companyId}/audit/managed-exports` opens a snapshot for a
half-open interval given by the `from` and `to` timestamps.

`GET /api/companies/{companyId}/audit/managed-exports/{exportId}` reads a page.
Use the preceding page's `nextCursor` as the `cursor` query parameter to resume.
Responses are `no-store`; a GET returns its authenticated page body despite
conditional request headers, and records access before releasing that body.
HEAD validates the request without recording a page release. A page access
record failure returns HTTP `500` with a fixed diagnostic and releases no page.
Every page verifies access to all events in the snapshot. If any event is
missing or no longer visible, the API returns HTTP `409` with
`details.reasonCode` set to `snapshot_incomplete`. The response contains no
events, event count, or watermark. The snapshot and its cursors remain invalid
if the missing event returns or becomes visible again. Reconcile the checkpoint
before opening a new snapshot.
Once every export-serving replica uses marker-aware cleanup, the owner receives
`409 snapshot_expired` for at least 24 hours after expiry when the source epoch
and retention window still apply. An older replica can remove a marker sooner
during a rolling upgrade or rollback. After cleanup removes a marker, the
response is `404 snapshot_missing` and the checkpoint needs reconciliation.

Both endpoints require an authenticated board session with audit access. Either
endpoint can return HTTP `409` with `details.reasonCode` set to
`retention_window_expired`. If the requested interval begins before the
configured retention cutoff, open a new snapshot with a start time at or after
the cutoff. A cursor for an expired window cannot be resumed. For
`409 snapshot_membership_limit`, create a narrower snapshot. For
`429 export_busy` or `503 export_retry_required`, retry the same request or
cursor with backoff. For a creation request with `413 snapshot_membership_limit`,
narrow the time window and consult the [export guide](../../doc/managed-audit-export.md)
for intervals that cannot be split. A create request returns
`429 principal_snapshot_limit` at the operator's snapshot limit or
`429 active_snapshot_limit` at the company's limit. Resume a retained snapshot
you own or retry after one expires.
