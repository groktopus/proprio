# Governance evidence for authenticated self-hosted deployments

Start a review with the company, task, run, and time window. Each source below
answers a different question. Use the target system to verify whether an external
write took effect.

## Evidence sources

| Question | Source and correlation | Access | Retention and coverage |
| --- | --- | --- | --- |
| What did the agent change in Proprio? | Task history and `GET /api/companies/:companyId/audit/agent-actions` show logged product mutations. Retain the event ID, affected entity ID, and run ID if present. Check the entity itself for its current state. | Company access and issue or case visibility apply. The default `actorScope=agents` query and CSV require board audit access (`audit:view_agent_actions` or instance administrator). The `actorScope=all` query offers basic results without run attribution or run-ID filters to readers without that audit authority. | Proprio stores activity in the product database. Product lifecycle operations can remove records. The CSV contains up to 10,000 projected rows and omits event IDs and full details. The `audit.exported` activity event records filters, row count and the truncation flag. |
| What did the managed gateway decide or record about execution? | Use `GET /api/companies/:companyId/tools/runs/:runId/decisions` to find linked invocations. Use `GET /api/tool-gateway/audit?companyId=…` for call and connection activity, including some events without an invocation. Record available event, invocation, run, issue, connection and policy IDs, plus decision, reason and outcome. | Connection audit authority applies. The gateway route also checks board audit permission (`tools:view_audit`). Delegated-agent reads additionally filter each row by connection and task visibility. Board audit may include company records for private tasks. | Proprio stores the events and invocation records in the product database. The gateway returns recent-first pages of up to 100 candidates. Follow its cursor even when the visible page is empty. The per-run lookup starts with invocations and can omit denials without that link. The gateway feed omits standalone policy-decision and trust-rule-use events. A matched policy ID alone cannot establish the historical rule after an edit. |
| Who authorized a managed action? | Follow the invocation to its tool action request. Record the request ID, status, deciding principal (`decidedByUserId` or `decidedByAgentId`), decision time (`decidedAt`), and saved action fingerprint when available. Check the linked invocation and call events for execution time and outcome. | The company action-request list applies per-row connection and task checks to delegated agents. Board readers use company-level access. Approval authority is checked separately. | Proprio retains the request and invocation with product data. A decision authorizes the saved action. An approval alone gives no evidence of execution. |
| What did the runner or model provider report? | Inspect the run and `GET /api/heartbeat-runs/:runId/events` for structured events. Use the run ID and event sequence. Keep provider request IDs where available. For provider-native tools, obtain the provider's audit evidence and correlate it with that request or the target receipt. | Run reads follow company, telemetry and run visibility checks. Raw trace reveal and download require instance-admin and company access. Those endpoints use separate authority from ordinary run telemetry. Reveal and download are audited. | Proprio stores structured events in the database and run logs in the configured evidence store. Raw provider captures are opt-in diagnostics with a 24-hour expiry. Event coverage depends on runtime and effective configuration. Provider-native tools, direct network requests, shell commands and filesystem actions can operate outside the managed gateway. |
| What changed downstream? | Inspect the target's own object, version history, request receipt or audit event. Match the resource, operation, environment and, where supported, request or idempotency ID. For local effects, use records from the relevant host or workspace. | The deployer arranges a separately authorized target or infrastructure reviewer. | The deployer owns collection and retention under the target system's policy. A gateway success reports the observed call result. A timeout can leave the effect unresolved. |

Proprio supplies the product records listed above. The deployer owns the evidence
window, reviewer access, database and evidence-store recovery, and collection
from providers, hosts and targets. Keep any approved external copies under their
own access, retention and deletion controls. Plan separately for backup copies and
object versions. See [run evidence storage](run-evidence-storage.md#trace-deletion-expiry-and-sleep)
and [gateway audit operations](MCP-RUNTIME-OPERATIONS.md#alerts).

## Deployment inventory

Record the following without credentials, prompts or raw tool arguments.

- App revision, topology, company, capture time and evidence window.
- Effective runner and version, provider and model, including any observed
  fallback, and the available tool, skill and connection profile. Record unknown
  values as unknown.
- Destinations for product records, run evidence, provider requests, tool
  requests and independently retained evidence. Name the accountable operator
  and the retention, expiry and deletion owner for each destination.
- Who can request, approve, execute and revoke the selected action. Record the
  rule scope, target identity and reviewer access to company and private-task
  evidence.
- Which changes require a new review. Include changes to the runner, model,
  connection, target, policy, approval scope, identity, visibility, retention
  or storage.

## Synthetic reviewer walkthrough

1. In an authenticated test deployment, create a synthetic task with a unique
   marker. Use a managed connector that writes to a disposable target and give
   the reviewer independent read access to that target. Record its starting state.
2. Run a harmless Proprio task mutation and an approval-gated target write. From
   the task history, capture the company, task and run IDs. Look up the mutation
   in the agent-action audit query. Set `runId` and an ISO timestamp range
   with `from` and `to`. Pass the returned `nextCursor` as `cursor` to view later
   pages. For structured run events, pass the last `seq` as `afterSeq` until the
   evidence window is covered or the endpoint returns an empty page. The run
   event limit defaults to 200 and is capped at 1,000.
3. Open the run's managed decisions and follow the invocation to its action
   request. Compare the saved action with the decision, the deciding principal
   and the recorded execution outcome. Use the gateway audit query for unlinked
   events or earlier steps in the same window. For recent evidence tied to a
   known connection, also check `GET /api/tool-connections/:connectionId/activity`.
   A surviving request can lack saved arguments or previews after
   [connection data deletion](../docs/guides/board-operator/deleting-connection-data.md).
4. Use the connector's target state or receipt to verify the write against the
   recorded starting state. Repeat with a denied attempt and check that its
   target state did not change. For an uncertain result, reconcile with the
   target before retrying.
5. If an expected row is absent, check access, filters, cursors, run linkage,
   capture settings and retention. Check the gateway audit-write failure alert
   when a managed record should exist. The alert looks back one hour. Check
   retained monitoring or logs for an older incident window. Record unresolved
   gaps explicitly. An empty result alone cannot establish that an action or
   effect was absent.

This guide describes source coverage and a review procedure. Record the exact
configuration and the results of your exercise before claiming qualification for
a runner, deployment or effect path.
