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
- keep the Docker image aligned with the installed `@cloudflare/sandbox` version

## SDK migration status

This template currently uses the SDK 0.7 API. The shared provider lock retains
0.7.21. Do not update only the SDK to 1.x: it removes the Sandbox class and
requires a provider-owned Durable Object and a different container setup.
[Issue #36](https://github.com/groktopus/proprio/issues/36) tracks the SDK/image
upgrade and staging checks. Dependabot major SDK updates are deferred until
that work is ready. Other dependency updates continue.

[Cloudflare recommends](https://developers.cloudflare.com/sandbox/sdk/migrate/)
upgrading older applications to SDK and image 0.12.14 before moving to 1.0. Its
0.x bug and security support ends on 2026-12-31. The deployed-class switch to
the new scheduling policy is one-way, so rehearse it on a staging Worker.
