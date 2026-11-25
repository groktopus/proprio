# Managed audit reconstruction rehearsal

Run the bounded exercise against an isolated authenticated application with
PostgreSQL, the local process adapter, and a synthetic HTTP MCP target. The
process adapter runs deterministic Node.js commands and uses no model account
or live connector credential. The target keeps an independent local ledger
outside the Proprio database and application storage.

```sh
PROPRIO_AUDIT_RECONSTRUCTION_EVIDENCE_PATH=/tmp/proprio-audit-reconstruction-evidence.json \
  pnpm exec vitest run server/src/__tests__/managed-audit-reconstruction.integration.test.ts
```

The fixture uses a separate reviewer with the operator role and the managed
audit grant. Before approval, the reviewer sees the invocation and its policy
snapshot. After application restart, the reviewer starts from each issue, lists
its runs, locates the invocation, and matches the action request, decision
principal, unchanged policy fingerprint and priority, and call receipts. The
operator changes policy priority after the first run. The successful case must
have a `call_completed` success event linked to its invocation and request.
The reviewer also reads a managed audit export after server recreation and
matches its events to the task, invocation, run and human decision. The
interrupted action retains its dispatch intent and stays unresolved.

- The approved request calls the target once.
- The declined request has zero target effects.
- The interrupted request writes to the independent ledger and drops its HTTP
  response. A per-case fixture guard prevents the process adapter's continuation
  from resubmitting the call; the test also asserts that no pending second
  action request exists. The reviewer reconciles the target ledger before any
  retry.

When the environment variable is set, the test writes a mode-0600 JSON evidence
file outside the disposable test home. It includes the tested revision, Node
and platform, runner and connector profiles, reviewer role, correlation IDs,
policy fingerprints/priorities, and outcomes. Store that file with the test and
CI result for the release; retain correlation IDs only when deployment policy
allows it.

The restart here closes and recreates the Express test server in the same
Vitest process against the same PostgreSQL database. It does not exercise
`server/src/index.ts` startup/recovery jobs, process restart, database restore,
or an independent target-ledger restore. PostgreSQL holds Proprio's audit,
invocation, approval and policy provenance; the synthetic target's JSONL file
is the independent evidence of the external effect. Missing or unknown
provenance is not treated as proof of absence: the reviewer must report the
API's missing request, empty event set, or `captureStatus: unknown` and obtain
external evidence. A late or interrupted effect is reconciled against the
target ledger before any retry; this fixture does not authorize automatic
resubmission. Provider-native tool execution, other adapters, and evidence
survival across independent restore remain unqualified.
