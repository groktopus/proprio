# Issue company-owned links

Issue #149 hardens five optional issue links at PostgreSQL's write boundary:

| Issue field | Referenced owner key | Delete behavior |
| --- | --- | --- |
| `project_id` | `projects(company_id, id)` | Block deletion while linked, as before |
| `parent_id` | `issues(company_id, id)` | Block deletion while linked, as before |
| `assignee_agent_id` | `agents(company_id, id)` | Block deletion while linked, as before |
| `checkout_run_id` | `heartbeat_runs(company_id, id)` | Set only `checkout_run_id` to null |
| `execution_run_id` | `heartbeat_runs(company_id, id)` | Set only `execution_run_id` to null |

The project, parent, and assignee links remain nullable. The run links remain
nullable and preserve their previous `ON DELETE SET NULL` behavior. PostgreSQL's
column-list action is required on the composite run keys; a plain composite
`SET NULL` would also clear `issues.company_id`. The syntax is supported by
PostgreSQL 15 and later; the repository's Docker deployment uses PostgreSQL 17.

## Migration and existing-data audit

Migration 0503 creates the referenced heartbeat-run key with a concurrent,
idempotent unique index. Migration 0504 drops the five former ID-only foreign
keys and installs the company-and-ID replacements as `NOT VALID`. It commits
that enforcement fence before migration 0505 validates historical rows.
Normal writes are checked as soon as 0504 commits. Validation is a separate
step so its table scan does not keep the stronger lock used to install the
constraints.

Before 0505 validates the data, run this read-only audit. It should return no
rows. The old foreign keys prevent dangling IDs, so each returned row identifies
a same-ID reference owned by another company.

```sql
SELECT 'project_id' AS link, i.id AS issue_id, i.company_id,
       i.project_id AS referenced_id, p.company_id AS referenced_company_id
FROM issues i JOIN projects p ON p.id = i.project_id
WHERE p.company_id <> i.company_id
UNION ALL
SELECT 'parent_id', i.id, i.company_id, i.parent_id, p.company_id
FROM issues i JOIN issues p ON p.id = i.parent_id
WHERE p.company_id <> i.company_id
UNION ALL
SELECT 'assignee_agent_id', i.id, i.company_id, i.assignee_agent_id, a.company_id
FROM issues i JOIN agents a ON a.id = i.assignee_agent_id
WHERE a.company_id <> i.company_id
UNION ALL
SELECT 'checkout_run_id', i.id, i.company_id, i.checkout_run_id, r.company_id
FROM issues i JOIN heartbeat_runs r ON r.id = i.checkout_run_id
WHERE r.company_id <> i.company_id
UNION ALL
SELECT 'execution_run_id', i.id, i.company_id, i.execution_run_id, r.company_id
FROM issues i JOIN heartbeat_runs r ON r.id = i.execution_run_id
WHERE r.company_id <> i.company_id;
```

The migration does not rewrite or null links automatically. If the audit finds
conflicts, review each issue with its owner. Correct the referenced ID when the
intended target is in the issue's company; clear an optional link only when the
owner confirms that removing the relationship is appropriate. Keep 0504's new
write checks in place, make the reviewed repair, rerun the audit, then retry
0505. If a conflict is fixed by moving an issue to another company, review its
other company-scoped data as a separate operation.

The PostgreSQL acceptance test seeds ordinary same-company issue links and a
legacy issue whose five links point to another company. Its audit finds one
conflict per link, 0505 fails without changing those links, and validation
succeeds after the test explicitly clears them. This is isolated fixture data;
no hosted or operator database was read for this change.

## Links not changed by #149

This invariant covers the five links listed above. Other issue references remain
outside this database invariant because they have separate semantics and were
not selected by #149: conversation and creator agent identity, goals, project
and execution workspace selection, privacy ancestry, and audit-only origin
provenance. This change does not make a cross-company reference for those fields
an authorization exception; their existing route and service checks remain in
force. Any additional same-company constraints need a separate domain review.

The issue creation/import and run-dispatch integration suites exercise the
existing normal writers against these constraints. In particular, the company
portability import test proves that imported parent hierarchies remain linked
inside the new company, while the run-dispatch PostgreSQL adapter tests exercise
background assignment of execution runs.
