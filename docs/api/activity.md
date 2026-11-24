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
half-open interval given by `from` and `to`. `GET
/api/companies/{companyId}/audit/managed-exports/{exportId}` reads a page; pass
the preceding page's `nextCursor` as `cursor` to resume.
half-open interval given by the `from` and `to` timestamps.

`GET /api/companies/{companyId}/audit/managed-exports/{exportId}` reads a page.
Use the preceding page's `nextCursor` as the `cursor` query parameter to resume.
Every page verifies access to all events in the snapshot. If any event is
missing or no longer visible, the API returns HTTP `409` with
`details.reasonCode` set to `snapshot_incomplete`. The response contains no
events, event count, or watermark.

Both endpoints require an authenticated board session with audit access. Either
endpoint can return HTTP `409` with `details.reasonCode` set to
`retention_window_expired`. Open a new snapshot with a start at or after the
configured cutoff. A cursor for an expired window cannot be resumed. When
advancing the cutoff, remove API instances with the old setting from export
traffic before treating the new boundary as enforced.
