# Cloudflare Sandbox Bridge Template

This Worker is the operator-facing bridge used by `@groktopus/plugin-cloudflare-sandbox`.

It exposes a small authenticated JSON API under `/api/proprio-sandbox/v1` and translates Proprio lease and command requests into Cloudflare Sandbox SDK calls.

## What it does

- health and probe
- acquire, resume, release, and destroy leases
- execute commands in a sandbox session
- clean up timed-out sessions so Proprio does not inherit wedged background processes

## Prerequisites

1. Cloudflare account with Sandbox / Containers access
2. `wrangler` configured for that account
3. Docker running locally for `wrangler deploy`
4. A bridge auth token set as a Worker secret:

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
```

## Local development

```bash
cd bridge-template
pnpm install --ignore-workspace --no-lockfile
pnpm test
pnpm typecheck
pnpm dev
```

## Deploy

```bash
pnpm deploy
```

After deploy, configure Proprio with:

- `bridgeBaseUrl`: your Worker URL
- `bridgeAuthToken`: the same bearer token value stored in `BRIDGE_AUTH_TOKEN`

## Notes

- `reuseLease: true` should only be used together with `keepAlive: true`
- `.workers.dev` is fine for bridge HTTP traffic, but preview/wildcard host flows are intentionally out of scope here
- keep each Docker image or shim aligned with the SDK its Worker uses

## SDK 1.0 staging candidate

The default Worker uses the legacy `sandbox-0x` alias and image 0.12.14. The
separate `wrangler.v1.jsonc` configuration uses the bridge-owned
`ProprioSandboxV1` class and the shim from SDK 1.0.3. It is a separate Worker
with its own container application and SQLite storage.

The Worker authorizes each bridge request before it resolves a lease. The
Durable Object owns container startup, idle timeout, keep-alive alarms,
session environment, and command cancellation. Resume checks the workspace
sentinel through the 1.0 SDK. A stopped container returns a lost-state
response without creating a replacement. Non-keep-alive idle timeouts on the
1.0 path must be positive and at most six hours.

### Verify before routing leases

The existing provider CI installs both exact SDK versions, typechecks both
Worker entry points, runs the bridge tests, and builds the 1.0 Worker and
container with Wrangler's dry-run mode. A dry run cannot exercise Cloudflare's
container scheduling, native process termination, alarms, or service routing.

Use a staging Worker and container application with unique names. On staging,
verify an authenticated acquire and resume, separate named and default session
settings, stdin and both streamed output channels, a real command timeout,
a client disconnect, Stop, and release. Confirm a child process from a
timed-out command cannot continue changing the workspace. Check both idle
expiry and keep-alive across a Durable Object restart. Confirm that resume
returns lost state after destruction. Obtain operator approval before changing
any deployment or lease routing.

### Cutover and recovery

Create a new Proprio execution environment with the 1.0 Worker URL and its
own bearer token. Send fresh leases to that environment. Keep existing
environments and leases on their original Worker until they are drained.
A lease ID is scoped to its Worker even if the ID text also exists elsewhere.

For a workspace that must move, quiesce its old lease and capture and validate
its workspace backup while the old container still holds the files. Restore
the files into a fresh lease on the other Worker. Let the new Worker write
and verify its own lease sentinel. Keep the original workspace backup until
the restored lease is verified.

For rollback, send new leases to the legacy environment. Keep the 1.0 Worker
available for leases that it already owns. Drain those leases and recover any
required workspaces before removing its container application.

[Issue #36](https://github.com/groktopus/proprio/issues/36) tracks the
remaining staging evidence. See the [Cloudflare migration guide](https://developers.cloudflare.com/sandbox/sdk/migrate/)
for the platform's in-place scheduling limits and recovery options.
