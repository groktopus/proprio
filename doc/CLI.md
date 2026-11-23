# CLI Reference

Proprio CLI now supports both:

- installation and lifecycle management (`install`, `uninstall`, `update`, `upgrade`, `service`)
- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Browser-approved Board authentication

`pnpm proprio auth login --api-base <instance-url>` creates a ten-minute
challenge and prints a browser approval link. The link uses the instance's
canonical public origin when configured, so reverse proxies do not send the
browser to an internal upstream hostname. Sign in to the instance, review
the requesting command and full Board access, then approve. The pending token
cannot authenticate before approval. The CLI verifies its resulting identity
before storing its credential in its private auth store. The default Board key
expires after thirty days; `pnpm proprio auth logout` attempts server-side revocation and removes the
local credential; check its `revoked` result.

A requested company supplies audit context, not a restriction on the key's
access. Approval requires current access to that company (active membership or
instance-admin authority). A different person cannot take over an approved
challenge. Cancellation and approval serialize on the same challenge; cancelling
an already approved challenge does not revoke its key.

The instance limits challenge creation to twenty requests per minute per client
IP, and polling to 120, using separate process-local budgets. The normal
one-second poll interval remains supported. HTTP 429 includes `Retry-After`.
Operators behind a proxy must configure `TRUST_PROXY` for their actual trusted
proxy boundary; client-supplied forwarding headers alone never mint a budget.
These limits are per instance process, not a distributed denial-of-service or
historical-record retention guarantee.

The browser approval page retries only rate-limited challenge reads, up to
three times. It honors the server delay, or waits sixty seconds when no valid
delay is provided. Scheduling stops at ten minutes or a known earlier
challenge expiry. Browser suspension can delay a queued read. The server still
enforces the original expiry. Approval is never resubmitted automatically.

Cloud front doors must preserve only anonymous challenge creation and
capability-bound status polling. Approval uses the normal signed-in browser;
no Cloud user identity is synthesized for the CLI's unauthenticated requests.

## Security: safe invocation for content-bearing arguments

Use `pnpm proprio` for any command whose argument can hold untrusted or
semi-trusted content. Untrusted content includes issue text, comment bodies,
Markdown, pasted snippets, and model output. `npx` runs the CLI binary directly.
It passes the argument as an inert `argv` value. It does not run a shell over the
value. `pnpm proprio` works on any machine with Node: it runs a local install
of the `proprio` package, and it fetches the published package when no local
install is present.

Do not use `pnpm proprio` for a content-bearing argument. `pnpm proprio`
is a `package.json` script. `pnpm` builds a `/bin/sh` command string and appends
the argument to it, so the shell reads the argument first. The shell interprets
these spans before the CLI starts:

- command substitution: a backtick pair or `$( )`
- variable expansion: `$NAME` or `${NAME}` (this can leak a secret value into the persisted argument)

A crafted value can run an arbitrary command as the invoking user. A crafted
value can also expand an environment variable into the stored argument. No
CLI-side check stops this, because the shell runs before `cli/src` starts. This
is true even when the argument comes from a quoted shell variable, because `pnpm`
re-evaluates the value in its own shell.

Safe forms:

- `pnpm proprio <command> <args>` — the documented default. It passes an inert
  `argv` value and runs on any machine.
- `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>` —
  the safe form to run the local source from a monorepo checkout. It is the exact
  command that the `pnpm proprio` script wraps, but it runs directly, so no
  shell reads the argument. Use it when you must test your local `cli/src`
  changes with a content-bearing argument.

Unsafe or broken forms:

- `pnpm proprio <command> <args>` — unsafe. `pnpm` runs the argument through a
  shell first.
- `pnpm run <script> -- <args>`, or any `package.json` script that wraps the CLI —
  unsafe for the same reason.
- `pnpm exec proprio <command> <args>` — broken. The root workspace does not
  depend on the `proprio` package, so `pnpm` does not link its binary into
  `node_modules/.bin`. The command fails with `Command "proprio" not found`,
  even after a build. Do not use it.

Static placeholders only: a document must show a static placeholder such as
`<host>` in a command example, never a live `$( )` or `$NAME` span. The reader's
own shell expands such a span on paste, before any CLI or `npx` receives argv, so
a direct-exec form does not stop it.

`pnpm proprio` stays acceptable only for a fully literal local lifecycle or
setup command. A fully literal command carries no substitutable value. It has no
placeholder, no example value the reader replaces, no interpolation, no path, no
ref, no id, and no name. It holds the subcommand and, at most, flags that take no
value.

The allowlist of literal commands lives in one place:
`server/src/__tests__/cli-invocation-safety.test.ts`. A guard test enforces it
fail-closed. Any `pnpm proprio` line whose command string is not an exact
allowlist entry is an offender. The allowlist holds commands such as `run`,
`onboard`, `onboard --yes`, `doctor`, `configure --section <name>`, `connect`,
`env-lab up`, `env-lab down`, `context show`, `context list`,
`worktree ensure-seeded`, and `worktree env`.

Every invocation that carries a positional value or an option value uses
`pnpm proprio` instead. This covers a hostname (`allowed-hostname`), an import
URL or folder (`company import`), an identifier or secret (`--company-id`,
`--agent-id`, `--claim-secret`), a payload (`--payload-json`), free text
(`--body`, `--title`, `--comment`), a data directory (`--data-dir`), an instance
(`--instance`), a bind preset (`--bind`), a context-profile name, and every
worktree path, ref, id, or name option. A runtime value counts as non-fixed even
when it looks safe. The private-hostname guard builds `allowed-hostname <value>`
from the request Host header, so it uses `pnpm proprio`.

For a command that must run the local checked-out source with a value, use the
direct-exec form: `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts
<command> <args>`.

The `pnpm --filter @groktopus/*` build and test commands are not CLI
invocation. They do not change.

### Offline and air-gapped use

`pnpm proprio` runs offline when the `proprio` package is already in a
local install or in the npm cache. It reaches the network only when the package
is in neither place.

To force cache-only resolution and block any network attempt, run
`npx --offline proprio <command> <args>`. Use `npx --prefer-offline
proprio` when you accept a fetch only for a missing package.

To prepare an air-gapped host, install the package one time while the host is
online. Run `npm install -g proprio`, or run the documented `install.sh`
path. After that step, both `pnpm proprio` and the installed `proprio`
binary run offline. Both pass an inert `argv` value.

To move the package without a registry, run `npm pack proprio` on an online
host. Copy the tarball to the air-gapped host. Run `npm install -g
./proprio-<version>.tgz`.

Do not use `pnpm proprio` as an offline fallback for a content-bearing
argument. It runs the argument through a shell first, offline or online. It also
resolves only inside a monorepo checkout.

A monorepo contributor who works offline uses the direct-exec form that this
section documents above: `node cli/node_modules/tsx/dist/cli.mjs
cli/src/index.ts <command> <args>`. It passes an inert `argv` value and runs the
local source.

## Base Usage

Use repo script in development:

```sh
pnpm proprio --help
```

No published installer exists for Proprio. In a checkout use `pnpm proprio run`
to start the local CLI. For content-bearing arguments, use the direct source form
described above.

## Isolated Manual Test Drives

`proprio test-drive` creates or reuses an isolated local data directory,
ensures one usable CEO agent exists in a fresh database, starts Proprio in the
foreground, and opens the browser after initialization succeeds. It never
installs a background service and never creates a goal, project, issue, task,
or heartbeat.

```sh
pnpm proprio test-drive \
  [-d, --data-dir <path>] \
  [--company-name <name>] \
  [--agent-name <name>] \
  [--harness <claude|codex|opencode>] \
  [--model <model-id>] \
  [--api-key-env <variable> | --api-key <value>] \
  [--no-browser]
```

Defaults are `Test Company`, a `CEO` agent with the `ceo` role, and the Claude
harness. Without `--data-dir`, every invocation creates a unique OS temporary
directory and prints its absolute path. The directory is retained after exit
for inspection. An explicit data directory is reused and is never reset. The
reused directory must use Proprio's embedded database; `DATABASE_URL`,
`DATABASE_MIGRATION_URL`, and configs with `database.mode: postgres` are
rejected so test-drive cannot mutate an external database. The server also
ignores the invocation directory's `.env` for test-drive launches, while still
loading the selected instance's own environment file. Reused directories also
retain the normal guard against colliding with a managed Proprio service. The
server uses the first available loopback port at or above `3100`, so an
unrelated local Proprio process can remain running.

Harness configuration:

| Harness | Agent adapter | Agent credential variable | Model |
| --- | --- | --- | --- |
| `claude` | `claude_local` | `ANTHROPIC_API_KEY` | Optional; omitted uses the adapter default |
| `codex` | `codex_local` | `OPENAI_API_KEY` | Optional; omitted uses the adapter default |
| `opencode` | `opencode_local` | `OPENROUTER_API_KEY` | Required and must begin with `openrouter/` |

OpenCode model references retain their complete path, including additional
slashes:

```sh
OPENROUTER_API_KEY=... pnpm proprio test-drive \
  --harness opencode \
  --model openrouter/anthropic/claude-sonnet-4.5
```

Credentials come from `--api-key`, the variable named by `--api-key-env`, or
the harness's canonical environment variable shown in the table. `--api-key`
and `--api-key-env` are mutually exclusive. A custom source variable is still
stored and projected under the canonical target variable:

```sh
MY_ROUTER_KEY=... pnpm proprio test-drive \
  --harness opencode \
  --model openrouter/openai/gpt-5.4 \
  --api-key-env MY_ROUTER_KEY
```

Credentials are stored through Proprio's user-secret reference path and are
redacted from Proprio command output. Proprio does not print `--api-key`,
and it removes the value from its JavaScript argument view immediately after
Commander parses it. Proprio does not put the raw argument list in telemetry,
API metadata, or diagnostics. Command wrappers, operating-system process
listings, and shell history can still expose values passed in arguments. This
is an explicit tradeoff for the local test-drive workflow. Prefer an exported
canonical variable or `--api-key-env` when that matters. Provider connectivity,
local harness installation, credential validity, and model availability are
intentionally checked only when the agent first runs.

When invoked inside a linked Git worktree, the command ignores inherited
`PROPRIO_IN_WORKTREE` state, launches in worktree mode, and verifies **Run
tasks in this worktree** is armed for the current instance before opening the
browser. In a primary checkout or non-Git directory it launches without
worktree mode and does not alter the setting. On reuse, if any company already
exists, all bootstrap flags are ignored and companies, agents, and secrets are
left untouched; worktree-setting reconciliation is the only permitted
mutation.

Use `--no-browser` for a foreground instance that prints its ready URL without
opening it.

## Install, Update, And Uninstall

This is a source-only bootstrap. See [Running from source](INSTALLING.md).
The registry and remote installer commands inherited from the original project
are not part of the supported install path.

## Onboarding And Service Management

Interactive onboarding offers to install a background service on supported
platforms. `--yes` never installs it implicitly; automation must opt in.

```sh
proprio onboard
proprio onboard --yes
proprio onboard --yes --install-service
proprio onboard --yes --no-install-service
```

Service lifecycle commands remain under the `service` namespace:

```sh
proprio service install [--no-start-now] [--no-start-on-login]
proprio service uninstall
proprio service start
proprio service stop
proprio service restart [--wait]
proprio service status [--json]
proprio service logs [-f]
```

A successful restart requires a new supervisor process and a health response
from that process. Managed Git updates also require the health response to
report the selected commit, even when the package version stays the same.
The restart result includes the recovery report when it matches the request.

Every service verb supports `--instance <id>` and `--json`. Linux and WSL2 use
a systemd user unit when available; macOS uses a LaunchAgent. Unsupported
environments receive foreground `proprio run` guidance.

`proprio doctor` includes managed-install and service-health diagnostics in
addition to configuration, storage, database, logging, and port checks.

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `proprio onboard` and `proprio configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `proprio run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `PROPRIO_DEPLOYMENT_MODE`
- `proprio run` and `proprio doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm proprio allowed-hostname dotta-macbook-pro
```

Bring up the default local SSH fixture for environment testing:

```sh
pnpm proprio env-lab up
pnpm proprio env-lab doctor
pnpm proprio env-lab status --json
pnpm proprio env-lab down
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

API base resolution order:

1. `--api-base <url>`
2. `PROPRIO_API_URL`
3. selected context profile `apiBase`
4. local Proprio config server port
5. `http://localhost:3100`

Connection failures include the attempted URL and a `GET /api/health` check hint.

## Connect Wizard

```sh
pnpm proprio connect
```

`connect` confirms the resolved API base, verifies `GET /api/health`, authenticates board access when needed, and saves a persona-aware profile:

- `persona=board` for board operator profiles
- `persona=agent` with `agentId` and `agentName` for agent profiles

Profiles store token env-var names, not plaintext tokens. The wizard prints shell exports for the newly created token.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.proprio`:

```sh
pnpm proprio run --data-dir ./tmp/proprio-dev
pnpm proprio issue list --data-dir ./tmp/proprio-dev
```

## Context Profiles

Store local defaults in `~/.proprio/context.json`:

```sh
pnpm proprio context set --api-base http://localhost:3100 --company-id <company-id>
pnpm proprio context set --persona agent --agent-id <agent-id> --api-key-env-var-name PROPRIO_API_KEY
pnpm proprio context show
pnpm proprio context list
pnpm proprio context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm proprio context set --api-key-env-var-name PROPRIO_API_KEY
export PROPRIO_API_KEY=...
```

## Organization Commands

```sh
pnpm proprio company list
pnpm proprio company get <company-id>
pnpm proprio company current [--company-id <company-id>]
pnpm proprio company stats
pnpm proprio company create --payload-json '{...}'
pnpm proprio company update <company-id> --payload-json '{...}'
pnpm proprio company branding:update <company-id> --payload-json '{...}'
pnpm proprio company archive <company-id>
pnpm proprio company export <company-id> --out ./company --include company,agents,projects,issues,skills
pnpm proprio company export:preview <company-id> --payload-json '{...}'
pnpm proprio company export:api <company-id> --payload-json '{...}'
pnpm proprio company import ./company --target new --new-company-name "Imported Company"
pnpm proprio company import:preview <company-id> --payload-json '{...}'
pnpm proprio company import:apply <company-id> --payload-json '{...}'
pnpm proprio company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm proprio company delete PAP --yes --confirm PAP
pnpm proprio company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- With agent authentication, `company list` and `company current` are
  agent-safe company selectors. `company list` first tries the board-wide list;
  if that is forbidden, it uses `--company-id`, `PROPRIO_COMPANY_ID`, context,
  or `/api/agents/me` and then reads only that scoped company.
- `company create` requires board/instance-admin authentication because it is
  an instance-wide setup command.
- Deletion is server-gated by `PROPRIO_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `PROPRIO_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm proprio issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm proprio issue get <issue-id-or-identifier>
pnpm proprio issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high] [--parent-id <issue-id> | --standalone]
pnpm proprio issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm proprio issue delete <issue-id> --yes
pnpm proprio issue comment <issue-id> --body "..." [--attachment-id <id...>] [--reopen]
pnpm proprio issue comments <issue-id> [--limit 50]
pnpm proprio issue comment:get <issue-id> <comment-id>
pnpm proprio issue comment:delete <issue-id> <comment-id>
pnpm proprio issue runs <issue-id-or-identifier>
pnpm proprio issue live-runs <issue-id-or-identifier>
pnpm proprio issue active-run <issue-id-or-identifier>
pnpm proprio issue heartbeat-context <issue-id>
pnpm proprio issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm proprio issue release <issue-id>
pnpm proprio issue force-release <issue-id>
```

`issue create` sent from an agent run bound to an ordinary execution task is parented under that task when `--parent-id` is omitted; pass `--standalone` to create intentionally top-level work (`parentId: null`). The two flags are mutually exclusive.

Issue subresources are exposed as Proprio API wrappers. Commands that map to broad server schemas accept JSON payloads and validate them with shared schemas before sending.

```sh
pnpm proprio issue child:create <issue-id> --payload-json '{"title":"Child task"}'
pnpm proprio issue approvals <issue-id>
pnpm proprio issue approval:link <issue-id> <approval-id>
pnpm proprio issue approval:unlink <issue-id> <approval-id>
pnpm proprio issue read <issue-id>
pnpm proprio issue unread <issue-id>
pnpm proprio issue archive <issue-id>
pnpm proprio issue unarchive <issue-id>
pnpm proprio issue recovery-actions <issue-id>
pnpm proprio issue recovery:resolve <issue-id> --outcome restored --source-issue-status todo
```

```sh
pnpm proprio issue documents <issue-id> [--include-system]
pnpm proprio issue document:get <issue-id> <key>
pnpm proprio issue document:put <issue-id> <key> --body-file ./plan.md [--title Plan]
pnpm proprio issue document:lock <issue-id> <key>
pnpm proprio issue document:unlock <issue-id> <key>
pnpm proprio issue document:revisions <issue-id> <key>
pnpm proprio issue document:restore <issue-id> <key> <revision-id>
pnpm proprio issue document:delete <issue-id> <key>
```

```sh
pnpm proprio issue work-products <issue-id>
pnpm proprio issue work-product:create <issue-id> --payload-json '{"type":"pull_request","provider":"github","title":"PR"}'
pnpm proprio issue work-product:update <work-product-id> --payload-json '{"status":"archived"}'
pnpm proprio issue work-product:delete <work-product-id>
pnpm proprio issue interactions <issue-id>
pnpm proprio issue interaction:create <issue-id> --payload-json '{"kind":"request_confirmation","payload":{"version":1,"prompt":"Continue?"}}'
pnpm proprio issue interaction:accept <issue-id> <interaction-id> [--selected-client-keys key1,key2]
pnpm proprio issue interaction:reject <issue-id> <interaction-id> [--reason "..."]
pnpm proprio issue interaction:respond <issue-id> <interaction-id> --answers-json '[{"questionId":"q1","optionIds":["yes"]}]'
pnpm proprio issue interaction:cancel <issue-id> <interaction-id> [--reason "..."]
```

```sh
pnpm proprio issue tree-state <issue-id>
pnpm proprio issue tree-preview <issue-id> --payload-json '{"mode":"pause"}'
pnpm proprio issue tree-holds <issue-id> [--status active] [--include-members]
pnpm proprio issue tree-hold:create <issue-id> --payload-json '{"mode":"pause","reason":"review"}'
pnpm proprio issue tree-hold:get <issue-id> <hold-id>
pnpm proprio issue tree-hold:release <issue-id> <hold-id> [--payload-json '{"reason":"done"}']
pnpm proprio issue attachments <issue-id>
pnpm proprio issue attachment:upload <issue-id> --company-id <company-id> --file ./artifact.txt
pnpm proprio issue attachment:download <attachment-id> [--out ./artifact.txt]
pnpm proprio issue attachment:delete <attachment-id>
pnpm proprio issue label:list --company-id <company-id>
pnpm proprio issue label:create --company-id <company-id> --name bug --color '#ff0000'
pnpm proprio issue label:delete <label-id>
pnpm proprio issue feedback:votes <issue-id>
pnpm proprio issue feedback:vote <issue-id> --payload-json '{"targetType":"issue_comment","targetId":"...","vote":"up"}'
```

## Project Commands

```sh
pnpm proprio project list --company-id <company-id>
pnpm proprio project get <project-id-or-shortname> [--company-id <company-id>]
pnpm proprio project create --company-id <company-id> --name "Launch Site" [--goal-ids <id1,id2>] [--lead-agent-id <id>]
pnpm proprio project update <project-id-or-shortname> [--status in_progress] [--company-id <company-id>]
pnpm proprio project delete <project-id-or-shortname> --yes [--company-id <company-id>]
```

Advanced project fields accept JSON:

```sh
pnpm proprio project create --company-id <company-id> --name "Ops" --env-json '{"OPENAI_API_KEY":{"kind":"secret","secretName":"openai-api-key"}}'
pnpm proprio project update <project-id> --execution-workspace-policy-json '{"enabled":true,"defaultMode":"shared_workspace"}'
```

## Goal Commands

```sh
pnpm proprio goal list --company-id <company-id>
pnpm proprio goal get <goal-id>
pnpm proprio goal create --company-id <company-id> --title "Grow revenue" [--level company] [--status active]
pnpm proprio goal update <goal-id> [--title "..."] [--status achieved]
pnpm proprio goal delete <goal-id> --yes
```

## Agent Commands

```sh
pnpm proprio agent list --company-id <company-id>
pnpm proprio agent get <agent-id>
pnpm proprio agent create --company-id <company-id> --payload-json '{"name":"Builder","adapterType":"codex_local"}'
pnpm proprio agent hire --company-id <company-id> --payload-json '{...}'
pnpm proprio agent update <agent-id> --payload-json '{"title":"Senior Builder"}'
pnpm proprio agent delete <agent-id> --yes
pnpm proprio agent me
pnpm proprio agent inbox
pnpm proprio agent inbox-mine --user-id <board-user-id>
pnpm proprio agent wake <agent-id-or-shortname> [--company-id <company-id>] [--reason "..."] [--payload '{"issueId":"..."}']
pnpm proprio agent pause <agent-id>
pnpm proprio agent resume <agent-id>
pnpm proprio agent approve <agent-id>
pnpm proprio agent terminate <agent-id>
pnpm proprio agent heartbeat:invoke <agent-id>
pnpm proprio agent claude-login <agent-id>
pnpm proprio agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

Agent configuration and runtime endpoints:

```sh
pnpm proprio agent permissions:update <agent-id> --payload-json '{"canCreateAgents":true,"canCreateSkills":true,"canAssignTasks":true}'
pnpm proprio agent permission:grant <agent-id> commentary:view
pnpm proprio agent permission:revoke <agent-id> commentary:view
pnpm proprio agent configuration <agent-id>
pnpm proprio agent config-revisions <agent-id>
pnpm proprio agent config-revision:get <agent-id> <revision-id>
pnpm proprio agent config-revision:rollback <agent-id> <revision-id>
pnpm proprio agent runtime-state <agent-id>
pnpm proprio agent runtime-state:reset-session <agent-id> [--task-key <key>]
pnpm proprio agent task-sessions <agent-id>
pnpm proprio agent skills <agent-id>
pnpm proprio agent skills:sync <agent-id> --desired-skills proprio,github --mode add
pnpm proprio agent instructions-path:update <agent-id> --payload-json '{"path":"/path/to/AGENTS.md"}'
pnpm proprio agent instructions-bundle <agent-id>
pnpm proprio agent instructions-bundle:update <agent-id> --payload-json '{"mode":"managed"}'
pnpm proprio agent instructions-file:get <agent-id> --path AGENTS.md
pnpm proprio agent instructions-file:put <agent-id> --path AGENTS.md --content-file ./AGENTS.md
pnpm proprio agent instructions-file:delete <agent-id> --path AGENTS.md --yes
```

`permission:grant` and `permission:revoke` require a Board login with
`users:manage_permissions` in the agent's company. They change one permission
key and preserve all other grants. A grant applies without starting a new run.
Granting a key replaces that key's scope with an unscoped company grant;
revoking removes the key. Use `agent get <agent-id> --json` to inspect
`access.grants`. These commands do not reactivate an inactive membership.

Agent config, instructions, skills, project env, environment, secret, and workspace edits affect the next run. Active runs finish with the config they started with. When a saved session, reused workspace, or sandbox lease no longer matches the effective next-run config, Proprio may start fresh execution and records non-sensitive freshness categories in run result JSON and workspace operation logs.

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Proprio agent:

- creates a new long-lived agent API key
- installs missing Proprio skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `PROPRIO_API_URL`, `PROPRIO_COMPANY_ID`, `PROPRIO_AGENT_ID`, and `PROPRIO_API_KEY`

Example for shortname-based local setup:

```sh
pnpm proprio agent local-cli codexcoder --company-id <company-id>
pnpm proprio agent local-cli claudecoder --company-id <company-id>
```

## Token Commands

Agent API keys are scoped to one company and one agent. Plaintext tokens are printed once at creation.

```sh
pnpm proprio token agent create --company-id <company-id> --agent <agent-id-or-name> --name external-worker
pnpm proprio token agent list --company-id <company-id> --agent <agent-id-or-name>
pnpm proprio token agent revoke --company-id <company-id> --agent <agent-id-or-name> <key-id>
```

Named board API keys use the board authorization model, support revocation and expiration metadata, and are audited server-side.

```sh
pnpm proprio token board create --company-id <company-id> --name external-admin
pnpm proprio token board create --name short-lived --ttl-days 7
pnpm proprio token board list
pnpm proprio token board revoke <key-id>
```

## Run Commands

`proprio run` without a subcommand still bootstraps and starts a local Proprio instance. The subcommands below inspect and control API heartbeat runs.

```sh
pnpm proprio run list --company-id <company-id> [--agent-id <agent-id>] [--limit 50]
pnpm proprio run live --company-id <company-id> [--limit 50] [--min-count 0]
pnpm proprio run get <run-id>
pnpm proprio run events <run-id> [--after-seq 0] [--limit 200]
pnpm proprio run log <run-id> [--offset 0] [--limit-bytes 16384] [--text]
pnpm proprio run cancel <run-id>
pnpm proprio run issues <run-id>
pnpm proprio run workspace-operations <run-id>
pnpm proprio run workspace-log <operation-id> [--offset 0] [--limit-bytes 16384] [--text]
pnpm proprio run watchdog-decision <run-id> --decision continue [--reason "..."]
```

## Routine Commands

`proprio routines disable-all` remains the local maintenance command. The singular `routine` group maps to the REST API.

```sh
pnpm proprio routine list --company-id <company-id> [--project-id <project-id>]
pnpm proprio routine create --company-id <company-id> --payload-json '{...}'
pnpm proprio routine get <routine-id>
pnpm proprio routine update <routine-id> --payload-json '{...}'
pnpm proprio routine revisions <routine-id>
pnpm proprio routine revision:restore <routine-id> <revision-id>
pnpm proprio routine runs <routine-id> [--limit 50]
pnpm proprio routine run <routine-id> [--payload-json '{...}']
pnpm proprio routine trigger:create <routine-id> --payload-json '{...}'
pnpm proprio routine trigger:update <trigger-id> --payload-json '{...}'
pnpm proprio routine trigger:delete <trigger-id>
pnpm proprio routine trigger:rotate-secret <trigger-id>
pnpm proprio routine trigger:fire <public-id> [--payload-json '{...}']
```

## Prompt Handoff

Prompt handoff creates Proprio work. It does not create a chat session.

```sh
pnpm proprio agent-prompt <agent-name-or-id> <agent-api-key> "Prompt here"
pnpm proprio agent prompt --agent <agent-name-or-id> --api-key-env PROPRIO_API_KEY "Prompt here"
pnpm proprio agent prompt --profile my-agent "Prompt here"
pnpm proprio board prompt --company-id <company-id> --agent <agent-name-or-id> "Prompt here"
```

By default the command creates a `todo` issue assigned to the target agent and wakes the agent. Use `--issue <issue-id>` to add a comment to existing work, and `--no-wake` to skip the wakeup.

## Skills Commands

`proprio skills` covers three distinct operations:

1. **Company install** — adds or updates a row in `company_skills` for the
   whole company. This is what `skills install`, `skills import`, `skills create`,
   and `skills scan-projects` do.
2. **Agent attach** — merges an agent's *desired* company skill set with an
   explicit `add`, `remove`, or `replace` mode (`skills agent sync`/`clear`).
   This is a desired-state operation on the agent's adapter config; it does not
   change the company library.
3. **Adapter runtime sync** — the adapter reconciles the desired skill set
   with files on disk and reports an `AgentSkillSnapshot` (`skills agent list`).
   `skills agent sync` triggers this automatically after updating desired state.

Required Proprio runtime skills (heartbeat, etc.) remain server-enforced and
are added on top of whatever the desired set names.

Company skill mutations (`skills install`, `skills import`, `skills create`, and
`skills scan-projects`) are open to same-company actors by default. Missing
`skills:create` grants and `canCreateSkills` settings do not deny these commands;
only an explicit company skill policy restriction does. Core safety and company
boundary checks still apply, and `agents:create` remains required when a command
also creates agents.

### Catalog (app-shipped skills)

The Proprio app ships a curated catalog under `@groktopus/skills-catalog`.
Browse and inspect commands never mutate company state; `install` adds a catalog
skill to the company library.

```sh
pnpm proprio skills browse [--kind bundled|optional] [--category <slug>] [--query <text>]
pnpm proprio skills search "<text>" [--kind bundled|optional] [--category <slug>]
pnpm proprio skills inspect <catalog-id-or-key-or-slug>
pnpm proprio skills install <catalog-id-or-key-or-slug> [--as <slug>] [--force] --company-id <company-id>
```

Catalog semantics:

- **Bundled** skills live in `packages/skills-catalog/catalog/bundled/<category>/<slug>`
  and are recommended defaults for most companies. They use canonical key
  `proprio/bundled/<category>/<slug>`.
- **Optional** skills live in `packages/skills-catalog/catalog/optional/<category>/<slug>`
  and are role-specific or domain-specific (browser, AWS ops, etc.). Same key
  shape with `optional` in place of `bundled`.
- `skills install` materializes the catalog files into a company-managed skill
  directory and records provenance (`catalogId`, `catalogKey`, `packageVersion`,
  `originHash`, …) so future updates and audit decisions stay consistent.
- `--as <slug>` overrides the company skill slug. `--force` may replace a
  same-key catalog-managed skill but never bypasses hard validation or hard-stop
  audit findings.

Examples:

```sh
pnpm proprio skills browse --kind bundled --company-id <company-id>
pnpm proprio skills search "pull request" --kind bundled
pnpm proprio skills inspect github-pr-workflow
pnpm proprio skills install github-pr-workflow --company-id <company-id>
pnpm proprio skills install proprio:optional:browser:agent-browser --company-id <company-id>
```

External GitHub, skills.sh, local-path, and URL sources still go through
`skills import`; catalog commands are for the app-shipped catalog only.

### Organization library

```sh
pnpm proprio skills list --company-id <company-id>
pnpm proprio skills show <skill-id-or-key-or-slug> --company-id <company-id>
pnpm proprio skills file <skill-id-or-key-or-slug> [--path SKILL.md] --company-id <company-id>
pnpm proprio skills import <source> --company-id <company-id>
pnpm proprio skills create --name "Review PRs" [--slug review-prs] [--description "..."] [--body-file SKILL.md] --company-id <company-id>
pnpm proprio skills scan-projects [--project-id <id>...] [--workspace-id <id>...] --company-id <company-id>
pnpm proprio skills check [skill-id-or-key-or-slug] --company-id <company-id>
pnpm proprio skills update <skill-id-or-key-or-slug> [--force] --company-id <company-id>
pnpm proprio skills update --all [--force] --company-id <company-id>
pnpm proprio skills audit [skill-id-or-key-or-slug] --company-id <company-id>
pnpm proprio skills reset <skill-id-or-key-or-slug> [--yes] [--force] --company-id <company-id>
pnpm proprio skills remove <skill-id-or-key-or-slug> --yes --company-id <company-id>
```

`skills import <source>` accepts a skills.sh URL, the equivalent
`<owner>/<repo>/<skill>` shorthand, a GitHub URL, a local path, or an
`npx skills add …` command. See `references/company-skills.md` in the agent
skill bundle for the source-type table.

`skills check`, `skills update`, `skills audit`, and `skills reset` are the
maintenance loop for catalog-installed skills:

- `check` reports whether each skill's installed bytes match its pinned origin
  (`hasUpdate`, `installedHash`, `originHash`, `updateHoldReason`,
  `auditVerdict`).
- `update` installs the pinned update through the existing install-update API.
  `--all` checks every company skill and updates only those with
  `hasUpdate=true`. `--force` discards local-modification or soft-audit holds;
  hard-stop audit findings still block the update.
- `audit` re-scans installed bytes and reports findings without executing
  anything.
- `reset` reinstalls a catalog-managed skill from its pinned origin, discarding
  local edits. Prompts in a TTY; requires `--yes` for non-interactive use.

### Agent attach

```sh
pnpm proprio skills agent list <agent-id-or-shortname> --company-id <company-id>
pnpm proprio skills agent sync <agent-id-or-shortname> --skill <skill-id-or-key-or-slug> [--skill <skill-id-or-key-or-slug>...] --mode <add|remove|replace> --company-id <company-id>
pnpm proprio skills agent clear <agent-id-or-shortname> --yes --company-id <company-id>
```

`skills agent sync` requires a merge mode and returns the resulting adapter
`AgentSkillSnapshot`. `add` preserves all unnamed assignments, `remove` deletes
only named assignments, and `replace` destructively overwrites the complete
non-required desired skill set.
`skills agent clear` sends an empty desired list. Required Proprio skills are
still enforced by the server in both cases.

### Notes

- Skill references accept company skill `id`, canonical `key`, or unique
  `slug`; catalog references accept catalog `id`, `key`, or unique `slug`.
- `skills file` prints raw file content in human mode so it can be piped.
- `skills create --body-file -` reads the skill markdown body from stdin.
- `skills remove`, `skills reset`, and `skills agent clear` prompt in a TTY and
  require `--yes` in non-interactive use.
- `--json` prints the raw API result for each command.

## Teams Commands

`proprio teams` works with the app-shipped team catalog in
`@groktopus/teams-catalog`. Browse, search, inspect, and file reads do not
change company state. `preview` runs the company import planner, and `install`
imports the catalog team into an existing company.

```sh
pnpm proprio teams browse [--kind bundled|optional] [--category <slug>] [--query <text>]
pnpm proprio teams search "<text>" [--kind bundled|optional] [--category <slug>]
pnpm proprio teams inspect <catalog-id-or-key-or-slug> [--file TEAM.md]
pnpm proprio teams preview <catalog-id-or-key-or-slug> --company-id <company-id>
pnpm proprio teams install <catalog-id-or-key-or-slug> --company-id <company-id>
```

Preview reports each planned agent adapter, its provider when available, and
whether the catalog selected the default. The JSON result also includes the
source manifest and any runtime selection errors.

Preview/install options:

- Under agent authentication, use `proprio company list --json`,
  `proprio company current --json`, or `PROPRIO_COMPANY_ID` to select the
  target company. `company list` falls back to the scoped current company when
  board-wide listing is forbidden. `teams install` creates agents and therefore
  requires board authentication, an `agents:create` grant, or an agent with the
  `canCreateAgents` permission (enabled by default for newly created
  standard-trust agents; low-trust agents and pre-existing agents without an
  explicit value stay disabled).
- `--request-approval-on-forbidden` turns a 403 install denial into a linked
  board approval request instead of a raw failed command; use
  `--approval-issue-id <id>` to attach it to a specific issue. During Proprio
  task runs with `PROPRIO_TASK_ID` set, this fallback is automatic so
  agent-run walkthroughs leave a pending approval path instead of a raw 403.
- `--target-manager-agent-id <id>` or `--target-manager-slug <slug>` reparents
  catalog root agents under an existing manager.
- `--agent <slug>` and `--selected-file <path>` narrow the import.
- `--collision-strategy rename|skip|replace` controls name/key collisions.
- `--adapter-override <slug=type>` applies a per-agent adapter selection.
  Repeat the option for other agents. Use the same overrides for preview and
  install.
- `--allow-external-sources`, `--allow-unpinned-optional-sources`, and
  `--allow-local-path-sources` explicitly opt into higher-trust source policy.
  Local-path sources are development-only and stay blocked unless that flag is
  passed.

## Secrets Commands

```sh
pnpm proprio secrets list --company-id <company-id>
pnpm proprio secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
pnpm proprio secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm proprio secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm proprio secrets doctor --company-id <company-id>
pnpm proprio secrets provider-configs --company-id <company-id>
pnpm proprio secrets provider-config:create --company-id <company-id> --payload-json '{...}'
pnpm proprio secrets provider-config:discovery-preview --company-id <company-id> --payload-json '{...}'
pnpm proprio secrets provider-config:get <config-id>
pnpm proprio secrets provider-config:update <config-id> --payload-json '{...}'
pnpm proprio secrets provider-config:default <config-id>
pnpm proprio secrets provider-config:health <config-id>
pnpm proprio secrets provider-config:delete <config-id>
pnpm proprio secrets remote-import:preview --company-id <company-id> --payload-json '{...}'
pnpm proprio secrets remote-import --company-id <company-id> --payload-json '{...}'
pnpm proprio secrets migrate-inline-env --company-id <company-id> [--apply]
```

Secret listing and declarations never print secret values. `create` accepts
`--value-env` so shell history does not capture the value. `link` records
provider-owned references without copying the secret value into Proprio.
For AWS-backed secrets, `secrets doctor` reports missing non-secret provider
env and the expected AWS SDK runtime credential source; do not store AWS
bootstrap credentials in Proprio secrets.

Per-company provider vaults (multiple vault instances per provider, default
vault selection, coming-soon GCP/Vault) can be configured from the board UI under
`Organization Settings → Secrets → Vaults` or through the provider-config CLI
commands above. See the
[secrets deploy guide](../docs/deploy/secrets.md#provider-vaults) and
[API reference](../docs/api/secrets.md#provider-vaults) for the contract.

## Approval Commands

```sh
pnpm proprio approval list --company-id <company-id> [--status pending]
pnpm proprio approval get <approval-id>
pnpm proprio approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm proprio approval approve <approval-id> [--decision-note "..."]
pnpm proprio approval reject <approval-id> [--decision-note "..."]
pnpm proprio approval request-revision <approval-id> [--decision-note "..."]
pnpm proprio approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm proprio approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm proprio activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
pnpm proprio activity create --company-id <company-id> --payload-json '{...}'
pnpm proprio activity issue <issue-id>
```

## Dashboard Commands

```sh
pnpm proprio dashboard get --company-id <company-id>
```

## Org And Agent Config Commands

```sh
pnpm proprio whoami
pnpm proprio openapi
pnpm proprio org get --company-id <company-id>
pnpm proprio org svg --company-id <company-id> [--out org.svg]
pnpm proprio org png --company-id <company-id> [--out org.png]
pnpm proprio agent-config list --company-id <company-id>
```

## Access, Profile, And Instance Commands

```sh
pnpm proprio profile session
pnpm proprio profile get
pnpm proprio profile update --payload-json '{...}'
pnpm proprio profile company-user <user-slug> --company-id <company-id>
pnpm proprio invite list --company-id <company-id>
pnpm proprio invite create --company-id <company-id> --payload-json '{...}'
pnpm proprio invite revoke <invite-id>
pnpm proprio invite show <token>
pnpm proprio invite accept <token> [--payload-json '{...}']
pnpm proprio invite onboarding:text <token>
pnpm proprio join list --company-id <company-id> [--status pending_approval]
pnpm proprio join approve <request-id> --company-id <company-id>
pnpm proprio join reject <request-id> --company-id <company-id>
pnpm proprio join claim-key <request-id> --claim-secret <secret>
pnpm proprio member list --company-id <company-id>
pnpm proprio member update <member-id> --company-id <company-id> --payload-json '{...}'
pnpm proprio member role-and-grants <member-id> --company-id <company-id> --payload-json '{...}'
pnpm proprio member permissions <member-id> --company-id <company-id> --payload-json '{...}'
pnpm proprio member archive <member-id> --company-id <company-id> [--payload-json '{...}']
pnpm proprio admin user list [--query <text>]
pnpm proprio admin user promote <user-id>
pnpm proprio admin user demote <user-id>
pnpm proprio admin user company-access <user-id>
pnpm proprio admin user company-access:update <user-id> --payload-json '{...}'
```

CLI auth challenge endpoints are also exposed for tooling that needs the raw challenge lifecycle:

```sh
pnpm proprio auth challenge create --payload-json '{...}'
PROPRIO_CHALLENGE_SECRET=<challenge-secret> pnpm proprio auth challenge get <challenge-id> --token-env PROPRIO_CHALLENGE_SECRET
PROPRIO_CHALLENGE_SECRET=<challenge-secret> pnpm proprio auth challenge approve <challenge-id> --token-env PROPRIO_CHALLENGE_SECRET
PROPRIO_CHALLENGE_SECRET=<challenge-secret> pnpm proprio auth challenge cancel <challenge-id> --token-env PROPRIO_CHALLENGE_SECRET
pnpm proprio auth revoke-current
```

`--token <challenge-secret>` is still supported for compatibility, but `--token-env` avoids putting challenge secrets in shell history or process arguments.

Use the challenge UUID returned by `auth challenge create` for get, approve, and
cancel. With the required secret and approval authentication present, malformed
IDs return HTTP 400 before database access. A status request without a secret
returns HTTP 404. Unknown challenges or incorrect challenge secrets still return
HTTP 404. Approval requires board authentication, checked before ID validation.

## Instance Settings Commands

```sh
pnpm proprio instance scheduler-heartbeats
pnpm proprio instance settings:general
pnpm proprio instance settings:general:update --payload-json '{...}'
pnpm proprio instance settings:experimental
pnpm proprio instance settings:experimental:update --payload-json '{...}'
pnpm proprio instance database-backup
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

```sh
pnpm proprio sidebar preferences
pnpm proprio sidebar preferences:update --payload-json '{...}'
pnpm proprio sidebar project-preferences --company-id <company-id>
pnpm proprio sidebar project-preferences:update --company-id <company-id> --payload-json '{...}'
pnpm proprio sidebar badges --company-id <company-id>
pnpm proprio inbox dismissals --company-id <company-id>
pnpm proprio inbox dismiss --company-id <company-id> --payload-json '{"itemKey":"run:<run-id>"}'
pnpm proprio board-claim show <token>
pnpm proprio board-claim claim <token> [--payload-json '{...}']
pnpm proprio openclaw invite-prompt --company-id <company-id> --payload-json '{...}'
pnpm proprio available-skill list
pnpm proprio available-skill index
pnpm proprio available-skill get <skill-name>
pnpm proprio llm agent-configuration
pnpm proprio llm agent-configuration:adapter <adapter-type>
pnpm proprio llm agent-icons
```

Hermes gateway uses the generic invite/join commands above rather than
`openclaw invite-prompt`. Create an agent invite, read
`invite onboarding:text`, submit a join request with
`adapterType: "hermes_gateway"` and `agentDefaultsPayload.apiBaseUrl` /
`agentDefaultsPayload.apiKey`, then approve and claim the key with the `join`
commands. See [HERMES_GATEWAY_ONBOARDING.md](./HERMES_GATEWAY_ONBOARDING.md).

## Adapter, Asset, And Skill Commands

```sh
pnpm proprio adapter list
pnpm proprio adapter install --payload-json '{"packageName":"@scope/adapter","version":"1.2.3"}'
pnpm proprio adapter get <adapter-type>
pnpm proprio adapter update <adapter-type> --payload-json '{"disabled":true}'
pnpm proprio adapter override <adapter-type> --payload-json '{"paused":true}'
pnpm proprio adapter reload <adapter-type>
pnpm proprio adapter reinstall <adapter-type>
pnpm proprio adapter delete <adapter-type>
pnpm proprio adapter config-schema <adapter-type>
pnpm proprio adapter ui-parser <adapter-type>
pnpm proprio adapter models <adapter-type> --company-id <company-id> [--refresh] [--environment-id <id>]
pnpm proprio adapter detect-model <adapter-type> --company-id <company-id>
pnpm proprio adapter test-environment <adapter-type> --company-id <company-id> --payload-json '{...}'
```

```sh
pnpm proprio asset image:upload --company-id <company-id> --file ./image.png [--namespace docs] [--alt "..."]
pnpm proprio asset logo:upload --company-id <company-id> --file ./logo.svg
pnpm proprio asset content <asset-id> --out ./asset.bin
```

```sh
pnpm proprio skill list --company-id <company-id>
pnpm proprio skill get <skill-id> --company-id <company-id>
pnpm proprio skill file <skill-id> --company-id <company-id> [--path SKILL.md]
pnpm proprio skill create --company-id <company-id> --payload-json '{...}'
pnpm proprio skill file:update <skill-id> --company-id <company-id> --payload-json '{...}'
pnpm proprio skill import --company-id <company-id> --payload-json '{"source":"github:owner/repo/path"}'
pnpm proprio skill scan-projects --company-id <company-id> --payload-json '{...}'
pnpm proprio skill update-status <skill-id> --company-id <company-id>
pnpm proprio skill install-update <skill-id> --company-id <company-id>
pnpm proprio skill delete <skill-id> --company-id <company-id>
```

## Cost, Finance, And Budget Commands

```sh
pnpm proprio cost summary --company-id <company-id>
pnpm proprio cost by-agent --company-id <company-id>
pnpm proprio cost by-agent-model --company-id <company-id>
pnpm proprio cost by-provider --company-id <company-id>
pnpm proprio cost by-biller --company-id <company-id>
pnpm proprio cost by-project --company-id <company-id>
pnpm proprio cost window-spend --company-id <company-id>
pnpm proprio cost quota-windows --company-id <company-id>
pnpm proprio cost issue <issue-id>
pnpm proprio cost event:create --company-id <company-id> --payload-json '{...}'
```

```sh
pnpm proprio finance event:create --company-id <company-id> --payload-json '{...}'
pnpm proprio finance events --company-id <company-id>
pnpm proprio finance summary --company-id <company-id>
pnpm proprio finance by-biller --company-id <company-id>
pnpm proprio finance by-kind --company-id <company-id>
pnpm proprio budget overview --company-id <company-id>
pnpm proprio budget policy:upsert --company-id <company-id> --payload-json '{...}'
pnpm proprio budget company:update --company-id <company-id> --payload-json '{...}'
pnpm proprio budget agent:update <agent-id> --payload-json '{...}'
pnpm proprio budget incident:resolve <incident-id> --company-id <company-id> [--payload-json '{...}']
```

## Workspace And Environment Commands

```sh
pnpm proprio workspace list --company-id <company-id>
pnpm proprio workspace get <execution-workspace-id>
pnpm proprio workspace close-readiness <execution-workspace-id>
pnpm proprio workspace operations <execution-workspace-id>
pnpm proprio workspace update <execution-workspace-id> --payload-json '{...}'
pnpm proprio workspace runtime-service <execution-workspace-id> start --payload-json '{...}'
pnpm proprio workspace runtime-command <execution-workspace-id> run --payload-json '{...}'
```

```sh
pnpm proprio environment list --company-id <company-id>
pnpm proprio environment capabilities --company-id <company-id>
pnpm proprio environment create --company-id <company-id> --payload-json '{...}'
pnpm proprio environment get <environment-id>
pnpm proprio environment leases <environment-id>
pnpm proprio environment lease <lease-id>
pnpm proprio environment update <environment-id> --payload-json '{...}'
pnpm proprio environment delete <environment-id>
pnpm proprio environment probe <environment-id>
pnpm proprio environment probe-config --company-id <company-id> --payload-json '{...}'
```

```sh
pnpm proprio project-workspace list <project-id>
pnpm proprio project-workspace create <project-id> --payload-json '{...}'
pnpm proprio project-workspace update <project-id> <workspace-id> --payload-json '{...}'
pnpm proprio project-workspace delete <project-id> <workspace-id>
pnpm proprio project-workspace runtime-service <project-id> <workspace-id> restart --payload-json '{...}'
pnpm proprio project-workspace runtime-command <project-id> <workspace-id> run --payload-json '{...}'
```

## Plugin Commands

Existing plugin lifecycle commands remain available: `plugin init`, `list`, `install`, `uninstall`, `enable`, `disable`, `inspect`, and `examples`.

```sh
pnpm proprio plugin ui-contributions
pnpm proprio plugin tools
pnpm proprio plugin tool:execute --payload-json '{...}'
pnpm proprio plugin health <plugin-id>
pnpm proprio plugin logs <plugin-id>
pnpm proprio plugin upgrade <plugin-id>
pnpm proprio plugin config <plugin-id> --company-id <company-id>
pnpm proprio plugin config:set <plugin-id> --company-id <company-id> --payload-json '{"configJson":{...}}'
pnpm proprio plugin config:test <plugin-id> --company-id <company-id> --payload-json '{"configJson":{...}}'
pnpm proprio plugin jobs <plugin-id>
pnpm proprio plugin job:runs <plugin-id> <job-id>
pnpm proprio plugin job:trigger <plugin-id> <job-id> [--payload-json '{...}']
pnpm proprio plugin webhook <plugin-id> <endpoint-key> [--payload-json '{...}']
pnpm proprio plugin dashboard <plugin-id>
pnpm proprio plugin bridge:data <plugin-id> --payload-json '{...}'
pnpm proprio plugin bridge:action <plugin-id> --payload-json '{...}'
pnpm proprio plugin bridge:stream <plugin-id> <channel> [--duration-ms 10000]
pnpm proprio plugin data <plugin-id> <key> --payload-json '{...}'
pnpm proprio plugin action <plugin-id> <key> --payload-json '{...}'
pnpm proprio plugin local-folders <plugin-id> --company-id <company-id>
pnpm proprio plugin local-folder:status <plugin-id> <folder-key> --company-id <company-id>
pnpm proprio plugin local-folder:validate <plugin-id> <folder-key> --company-id <company-id> [--payload-json '{...}']
pnpm proprio plugin local-folder:set <plugin-id> <folder-key> --company-id <company-id> --payload-json '{...}'
```

Feedback traces can be fetched directly by ID when automating export workflows:

```sh
pnpm proprio feedback trace <trace-id>
pnpm proprio feedback bundle <trace-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm proprio heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Local Proprio data lives under the selected instance root. `PROPRIO_HOME` chooses the home directory and `PROPRIO_INSTANCE_ID` chooses the instance.

```text
~/.proprio/                                     # PROPRIO_HOME
└── instances/
    └── default/                                  # instance root (PROPRIO_INSTANCE_ID)
        ├── config.json                           # runtime config
        ├── .env                                  # instance env file
        ├── db/                                   # embedded PostgreSQL data
        ├── data/
        │   ├── storage/                          # local_disk uploads
        │   └── backups/                          # automatic DB backups
        ├── logs/
        ├── secrets/
        │   └── master.key                        # local_encrypted master key
        ├── workspaces/                           # default agent workspaces
        ├── projects/                             # project execution workspaces
        ├── companies/                            # per-company adapter homes (e.g. codex-home)
        └── codex-home/                           # per-instance codex home (when not company-scoped)
```

Default paths for the canonical install:

- config: `~/.proprio/instances/default/config.json`
- embedded db: `~/.proprio/instances/default/db`
- logs: `~/.proprio/instances/default/logs`
- storage: `~/.proprio/instances/default/data/storage`
- secrets key: `~/.proprio/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
PROPRIO_HOME=/custom/home PROPRIO_INSTANCE_ID=dev pnpm proprio run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm proprio configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)

When a challenge poll receives HTTP 429, the CLI waits for `Retry-After` and
continues the same challenge. A missing or invalid value uses the normal poll
interval. The wait never extends the original challenge deadline and never
creates another challenge or key. This allows concurrent logins on a shared IP
to complete after the process-local limit clears.

Revocation records use the current key owner and trusted original creation or
approved-challenge company context. Removing a company membership does not
remove that audit history. Revocation and its audit records commit together;
an audit failure leaves the key unchanged so the operation can be retried.
Historical creation rows with a NULL responsible user do not provide trusted
revocation context. The original approved challenge or current authorized
company context can still provide that destination. Client-supplied activity
rows cannot establish key ownership or a revocation audit destination.
