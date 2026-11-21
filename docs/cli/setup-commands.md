---
title: Setup Commands
summary: Onboard, run, doctor, and configure
---

Instance setup and diagnostics commands.

## `proprio run`

One-command bootstrap and start:

```sh
pnpm proprio run
```

Does:

1. Auto-onboards if config is missing
2. Runs `proprio doctor` with repair enabled
3. Starts the server when checks pass

Choose a specific instance:

```sh
pnpm proprio run --instance dev
```

## `proprio onboard`

Interactive first-time setup:

```sh
pnpm proprio onboard
```

If Proprio is already configured, rerunning `onboard` keeps the existing config in place. Use `proprio configure` to change settings on an existing install.

First prompt:

1. `Quickstart` (recommended): local defaults (embedded database, no LLM provider, local disk storage, default secrets)
2. `Advanced setup`: full interactive configuration

Start immediately after onboarding:

```sh
pnpm proprio onboard --run
```

Quickstart defaults + immediate start:

```sh
pnpm proprio onboard --yes
```

When onboarding starts Proprio from an interactive terminal, it opens the
onboarding page in your browser once. Non-interactive terminals stay silent.
Suppress browser opening explicitly for headless or automated runs with either
environment variable:

```sh
PROPRIO_NO_BROWSER=1 pnpm proprio onboard --yes
PROPRIO_OPEN_ON_LISTEN=false pnpm proprio onboard --yes
```

On an existing install, `--yes` now preserves the current config and just starts Proprio with that setup.

## `proprio doctor`

Health checks with optional auto-repair:

```sh
pnpm proprio doctor
pnpm proprio doctor --repair
```

Validates:

- Server configuration
- Database connectivity
- Secrets adapter configuration, including AWS Secrets Manager non-secret env
  config when selected
- Storage configuration
- Missing key files

## `proprio configure`

Update configuration sections:

```sh
pnpm proprio configure --section server
pnpm proprio configure --section secrets
pnpm proprio configure --section storage
```

`--section secrets` updates the deployment-level provider used as the fallback
for secrets that do not target a specific company vault. Per-company provider
vaults (named instances, default vault selection, multiple vaults per provider,
coming-soon GCP/Vault) live in the board UI under
`Company Settings → Secrets → Provider vaults` and the
`/api/companies/{companyId}/secret-provider-configs` API.

## `proprio env`

Show resolved environment configuration:

```sh
pnpm proprio env
```

This now includes bind-oriented deployment settings such as `PROPRIO_BIND` and `PROPRIO_BIND_HOST` when configured.

## `proprio allowed-hostname`

Allow a private hostname for authenticated/private mode:

```sh
pnpm proprio allowed-hostname my-tailscale-host
```

## Local Storage Paths

| Data | Default Path |
|------|-------------|
| Config | `~/.proprio/instances/default/config.json` |
| Database | `~/.proprio/instances/default/db` |
| Logs | `~/.proprio/instances/default/logs` |
| Storage | `~/.proprio/instances/default/data/storage` |
| Secrets key | `~/.proprio/instances/default/secrets/master.key` |

Override with:

```sh
PROPRIO_HOME=/custom/home PROPRIO_INSTANCE_ID=dev pnpm proprio run
```

Or pass `--data-dir` directly on any command:

```sh
pnpm proprio run --data-dir ./tmp/proprio-dev
pnpm proprio doctor --data-dir ./tmp/proprio-dev
```
