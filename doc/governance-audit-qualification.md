# Managed audit reconstruction rehearsal

Run the bounded exercise against an isolated authenticated application with
PostgreSQL, the local process adapter, and a synthetic HTTP MCP target. The
process adapter runs deterministic Node.js commands and uses no model account
or live connector credential. The target keeps an independent local ledger
outside the Proprio database and application storage.

```sh
pnpm exec vitest run server/src/__tests__/managed-audit-reconstruction.integration.test.ts
```

The fixture uses a separate reviewer with company audit authority. It follows
each task to the run that owns the invocation, then matches the action request,
decision principal, historical policy fingerprint, call receipts and observed
outcome. The operator changes the policy after the first run. The reviewer
reads all three timelines again after the application restarts.

- The approved request calls the target once.
- The declined request has zero target effects.
- The interrupted request writes to the independent ledger and drops its HTTP
  response. The gateway reports a failure. The reviewer reconciles the target
  ledger before any retry.

Record the exact tested commit, Node version, runner and connector profiles, and
the test and CI results with the release evidence. Retain correlation IDs only
when the deployment's evidence rules permit them. This fixture qualifies the
run-bound process adapter and the synthetic HTTP path. Other runners,
provider-native tools, and independent audit export across restore require
their own evidence.
