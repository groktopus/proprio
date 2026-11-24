# Docker Quickstart

Run Proprio in Docker without installing Node or pnpm locally.

All commands below assume you are in the **project root** (the directory containing `package.json`), not inside `docker/`.

## Building the image

```sh
docker build --target production -t proprio-local .
```

The Dockerfile installs common agent tools (`git`, `gh`, `curl`, `wget`, `ripgrep`, `python3`) and the Claude, Codex, and OpenCode CLIs.

Build arguments:

| Arg | Default | Purpose |
|-----|---------|---------|
| `USER_UID` | `1000` | UID for the container `node` user (match your host UID to avoid permission issues on bind mounts) |
| `USER_GID` | `1000` | GID for the container `node` group |
| `CLI_TOOLS_CACHE_EPOCH` | empty | Refresh OS package and transitive npm resolution |
| `PROPRIO_BUILD_VERSION` | empty | Runtime version when Git metadata is unavailable |
| `PROPRIO_BUILD_COMMIT` | empty | Source commit written into the server build stamp and runtime environment |
| `PROPRIO_RUNNER_EXPECT_INPUTS_DIGEST` | empty | Inputs digest of the published Runner image a build was given as `runner-artifacts`; the build fails on any other Runner. Leave it empty for a build that makes its own Runner |

```sh
docker build --target production -t proprio-local \
  --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) .
```

The image starts the server from a runtime bundle, `server/dist-runtime/index.mjs`,
with plain `node`. The build creates it from the server's `tsc` output with
`pnpm --filter @groktopus/server build:runtime` (`server/scripts/bundle-runtime.mjs`),
compiling in the workspace packages that otherwise load as TypeScript source.
This avoids transpiling them through the tsx loader on every boot. To check a
build boots, run `scripts/server-boot-smoke.sh node server/dist-runtime/index.mjs`;
PR CI runs the same check after `pnpm build`.

### Refresh pinned image inputs

The production build pins the external Node image indexes by digest and the
five top-level harness CLIs by exact npm version. The full-stack Compose file
also pins PostgreSQL. For the Linux amd64 profile, record the resolved platform
manifest with `docker buildx imagetools inspect --raw` and retain it with the
build evidence. The index digest fixes its platform manifests.

To refresh the pins, resolve the new image index and CLI versions, update
`Dockerfile` and the full-stack Compose file in a PR, and run:

```sh
node scripts/check-self-hosted-image-pins.mjs
docker build --pull --no-cache --platform linux/amd64 --target production -t proprio-local .
docker run --rm --entrypoint npm proprio-local ls --global --depth=0 --json \
  | node scripts/check-self-hosted-image-pins.mjs --installed
```

Run both Compose readiness and state retention checks before qualifying the
new build. The checks cover base-image identity and exact top-level harness
versions. OS packages and npm transitive dependencies can still change on a
clean rebuild. Promote by tested artifact digest when distributing an image.
The CLI layer can be refreshed with `CLI_TOOLS_CACHE_EPOCH`.

## Image source

Proprio does not publish or promote images for this bootstrap. Build from this
checkout, and do not substitute a container image from a different project.

## Docker Compose

Run these commands from the repository root with Docker Engine 28.0.0 or later,
Docker Compose, and OpenSSL. For a new instance, copy the example once:

```sh
test ! -e docker/.env && install -m 600 docker/.env.compose.example docker/.env
```

Generate separate values with `openssl rand -hex 32` for `BETTER_AUTH_SECRET`
and `PROPRIO_TOOL_ACTION_SIGNING_SECRET`. Set them in `docker/.env`, keep that
file private, and reuse the same values across restarts and upgrades. For the
full stack, generate a third hex value for `PROPRIO_POSTGRES_PASSWORD`. A hex
password can be used directly in the PostgreSQL connection URL.

Existing deployments should keep their signing values. If you previously left
the tool-action secret unset, keep that setting to retain signatures derived
from the persisted secrets master key. Resolve outstanding approvals before
rotating signing values. Keep the signing values and master key with backups.

### Quickstart with embedded PostgreSQL

```sh
docker compose --env-file docker/.env -f docker/docker-compose.quickstart.yml up --build -d --wait
curl -fsS http://localhost:3100/api/health
```

Look for `"status":"ok"` and open <http://localhost:3100>. The application
health check waits for readiness, including startup recovery. The quickstart
persists database files, uploads, keys and workspaces under the bind mount
`./data/docker-proprio`. A relative `PROPRIO_DATA_DIR` is relative to the
Compose file, so `../data/pc` maps to `data/pc` in the repository root.

For a custom port and data directory, put these values in `docker/.env`
before running the same launch command:

```dotenv
PROPRIO_PORT=3200
PROPRIO_DATA_DIR=../data/pc
```

Open <http://localhost:3200>. The default public URL follows the configured
port. If you already set `PROPRIO_PUBLIC_URL`, update it to match. Supply
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` when you want to exercise those
adapters.

### Full stack with PostgreSQL 17

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml up --build -d --wait
curl -fsS http://localhost:3100/api/health
```

PostgreSQL uses the `pgdata` volume. The server uses the `proprio-data` volume
for instance configuration, keys, uploads and workspaces. Keep the same
Compose project name and both volumes when upgrading.

If your existing full stack used the old built-in database password, back up
the database and the Proprio volume before switching files. Set the new hex
password in `docker/.env`. With the original Compose project name, stop the
server and start only the database from the new configuration:

```sh
docker compose --env-file docker/.env -f docker/docker-compose.yml stop server
docker compose --env-file docker/.env -f docker/docker-compose.yml up -d --wait db
docker compose --env-file docker/.env -f docker/docker-compose.yml exec db psql -U proprio -d proprio
```

At the `psql` prompt, run `\password proprio` and enter the same new password
twice. Then run `\q`, start the full stack, and verify readiness and your
existing records. Changing the initialization variable alone does not change a
role password in an existing volume.

### Network access

Both stacks publish the web port on `127.0.0.1` by default. Use Docker Engine
28.0.0 or later for host-only publication. See [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/). Keep it there for
a reverse proxy on the same host and set `PROPRIO_PUBLIC_URL` to the external
HTTPS origin. To bind directly to a LAN or tailnet IP, set `PROPRIO_BIND_IP`
to that interface's address and `PROPRIO_PUBLIC_URL` to the URL clients use.
List any extra trusted hostnames in `PROPRIO_ALLOWED_HOSTNAMES`. Keep
authenticated access enabled and restrict access at the network or proxy.

PostgreSQL stays on the Compose network. See [Local PostgreSQL](DATABASE.md#2-local-postgresql-docker)
to opt in to a loopback-only port for development tools.

### Back up and restore Compose data

Keep the exact source SHA or image digest, project name, Compose files and
overrides, and a protected copy of `docker/.env` with each backup. Retain
the local secrets master key in `/proprio`, or save the external key using
your deployment's secret store. Back up any workspace bind mounts, object
storage, or other external artifact directories separately. The commands
below cover the default storage layout.

Run from the repository root. Use the same Compose project name and overrides
you used when launching. For each backup of either layout, create a private
directory outside the checkout and application volumes. The commands publish
the recovery set as `backup` after all archive commands succeed.

```bash
umask 077
backup_root="$(mktemp -d)" && backup_dir="$backup_root/backup"
```

#### Embedded PostgreSQL quickstart

Stop Proprio before copying embedded PostgreSQL files. The archive includes
the database, instance configuration, local keys, storage, and workspaces
under the bind mount.

```bash
(
  set -euo pipefail
  quick=(docker compose --env-file docker/.env -f docker/docker-compose.quickstart.yml)
  staged="$backup_dir.partial"
  test ! -e "$backup_dir"
  mkdir -m 700 "$staged"
  install -m 600 docker/.env "$staged/compose.env"
  "${quick[@]}" stop proprio
  "${quick[@]}" run --rm --no-deps -T --entrypoint tar proprio \
    -C /proprio -czf - . > "$staged/proprio.tar.gz"
  tar -tzf "$staged/proprio.tar.gz" >/dev/null
  mv -T "$staged" "$backup_dir"
)
```

Keep the archive off the host. After a routine backup, restart the same
project with `up -d --wait`. For a pre-upgrade backup, keep the app and
other writers stopped until the upgrade step below.

To restore, use a clean checkout of the recorded revision and copy
`compose.env` from the backup to a private `docker/restore.env`. Set
`PROPRIO_DATA_DIR` to a new, empty path, `PROPRIO_PORT` to a free port, and
`PROPRIO_PUBLIC_URL` to a matching URL if it was set explicitly. Use a new
Compose project, for example `proprio-restore`. Build the image if needed.

Before the first rehearsal boot, use a disposable host or enforce an
outbound firewall policy for the restore network. Block access to production
integrations and agent runtimes. Mount only copies of external workspaces,
artifact storage, and other shared data. Save the following override as
`docker/restore-only.yml`, using `server` in place of `proprio` for the full
stack. This disables scheduled heartbeats during the rehearsal. Keep the
external isolation in place because startup still performs recovery.

```yaml
services:
  proprio:
    environment:
      HEARTBEAT_SCHEDULER_ENABLED: "false"
```

```bash
(
  set -euo pipefail
  quick_restore=(docker compose -p proprio-restore --env-file docker/restore.env
    -f docker/docker-compose.quickstart.yml -f docker/restore-only.yml)
  "${quick_restore[@]}" run --rm --no-deps -T --entrypoint sh proprio \
    -ec 'test -z "$(ls -A /proprio)" && exec tar --numeric-owner -C /proprio -xzf -' \
    < "$backup_dir/proprio.tar.gz"
  "${quick_restore[@]}" up -d --wait
)
```

#### Separate PostgreSQL full stack

Stop the app and any other database writers. Leave PostgreSQL running and
use its native logical backup, then save the Proprio volume separately.
Do not copy a live PostgreSQL data directory.

```bash
(
  set -euo pipefail
  full=(docker compose --env-file docker/.env -f docker/docker-compose.yml)
  staged="$backup_dir.partial"
  test ! -e "$backup_dir"
  mkdir -m 700 "$staged"
  install -m 600 docker/.env "$staged/compose.env"
  "${full[@]}" stop server
  "${full[@]}" exec -T db sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
    > "$staged/postgres.dump"
  "${full[@]}" exec -T db pg_restore --list < "$staged/postgres.dump" >/dev/null
  "${full[@]}" run --rm --no-deps -T --entrypoint tar server \
    -C /proprio -czf - . > "$staged/proprio.tar.gz"
  tar -tzf "$staged/proprio.tar.gz" >/dev/null
  mv -T "$staged" "$backup_dir"
)
```

Use the same restart guidance as for the embedded layout. Restore with a
fresh Compose project and fresh named volumes on the recorded version.
Use the restored environment, outbound isolation, and `server` override
described above. Keep the signing values and master key from the backup.

```bash
(
  set -euo pipefail
  full_restore=(docker compose -p proprio-restore --env-file docker/restore.env
    -f docker/docker-compose.yml -f docker/restore-only.yml)
  "${full_restore[@]}" up -d --wait db
  "${full_restore[@]}" exec -T db sh -ec '
    pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    < "$backup_dir/postgres.dump"
  "${full_restore[@]}" run --rm --no-deps -T --entrypoint sh server \
    -ec 'test -z "$(ls -A /proprio)" && exec tar --numeric-owner -C /proprio -xzf -' \
    < "$backup_dir/proprio.tar.gz"
  "${full_restore[@]}" up -d --wait
)
```

If a restore fails, use a fresh target for the next attempt. After either
restore succeeds, check `/api/health` for `"status":"ok"`, sign in, and
verify a known board record and any required files. Rehearse in isolation
before pointing production traffic at the restored deployment. Linux
host-loss recovery is tracked separately in
[#134](https://github.com/groktopus/proprio/issues/134).

### Upgrade the Compose application

1. Record the running revision or digest and back up the topology using the
   commands above. Keep the original keys, configuration, and backup. Keep
   production traffic and other writers off the instance until the candidate
   is verified.
2. Check out the selected candidate. Use the same Compose project name, data
   path or volumes, and signing values. Review its release notes for database
   and credential changes.
3. Run the normal `up --build -d --wait` command against the candidate.
   Check readiness, sign in, and verify a known board record and file.
4. If the new revision fails after a database migration, follow the release's
   recovery path. Restore into a fresh project on the known-good revision
   unless the documented change supports a payload rollback on the new
   schema. Never use `down --volumes` on an existing installation to upgrade.

Run `scripts/compose-state-smoke.sh` on a disposable Docker host to rehearse
application recreation and fresh restore for both default topologies. The
script creates isolated projects, signs in through the normal board API,
and runs a synthetic local agent. It checks the same company, successful
run, and single persisted receipt after recreation and restore. It reports
the PostgreSQL versions on both sides and the dump and restore client
versions for the full stack.
Pass a locally available image or immutable image reference as its argument
to check that image without rebuilding. The smoke uses synthetic credentials
and requires Docker Compose, Bash, Python 3, OpenSSL, curl, and jq.

### Untrusted PR review

Isolated container for reviewing untrusted pull requests with Codex or Claude, without exposing your host machine. See `doc/UNTRUSTED-PR-REVIEW.md` for the full workflow.

```sh
docker compose -f docker/docker-compose.untrusted-review.yml build
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
```

## Authenticated Compose (Single Public URL)

For authenticated deployments, set one canonical public URL and let Proprio derive auth/callback defaults:

```yaml
services:
  proprio:
    environment:
      PROPRIO_DEPLOYMENT_MODE: authenticated
      PROPRIO_DEPLOYMENT_EXPOSURE: private
      PROPRIO_PUBLIC_URL: https://desk.koker.net
```

`PROPRIO_PUBLIC_URL` is used as the primary source for:

- auth public base URL
- Better Auth base URL defaults
- bootstrap invite URL defaults
- hostname allowlist defaults (hostname extracted from URL)

For fresh `authenticated/private` Docker or appliance-style installs, the first
admin can now be claimed entirely from the browser after sign-in. Open the
Proprio URL, sign in or create an account, then choose `Claim this instance`
on the setup screen. This browser claim is disabled for `authenticated/public`;
public deployments should run the high-entropy CLI invite fallback instead:

```sh
pnpm proprio auth bootstrap-ceo
```

Granular overrides remain available if needed (`PROPRIO_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `PROPRIO_ALLOWED_HOSTNAMES`).

Set `PROPRIO_ALLOWED_HOSTNAMES` explicitly only when you need additional hostnames beyond the public URL host (for example Tailscale/LAN aliases or multiple private hostnames).

### Optional Vercel Connect credentials

Vercel Connect's backend integration is retained for controlled testing and
existing Vercel-backed connections, but its new-connection UI is currently
withheld from **Apps → Browse**. Setting
`PROPRIO_VERCEL_CONNECT_ENABLED=true` does not expose a customer-facing setup
entry. Native provider setup screens remain unchanged. Vercel-hosted deployments use the
workload OIDC token Vercel injects. Other hosted and self-hosted deployments
can provide `PROPRIO_VERCEL_CONNECT_ACCESS_TOKEN` as a deployment bootstrap
secret only when that token type is accepted by the live Connect API:

```yaml
services:
  proprio:
    environment:
      PROPRIO_VERCEL_CONNECT_ENABLED: "true"
      PROPRIO_VERCEL_CONNECT_ACCESS_TOKEN: ${PROPRIO_VERCEL_CONNECT_ACCESS_TOKEN}
```

Do not save that access token in a company secret or connection config. It is
instance bootstrap authority for the operator-selected Vercel account. A token's
long expiry and broad Vercel scope do not prove Connect compatibility; validate
it with connector metadata before rollout. Workload OIDC takes precedence when
both authorities are present. Turning the feature flag off hides new
Vercel-backed setup; existing connections keep resolving while workload OIDC or
the bootstrap token remains available. Missing or invalid authority fails
closed. See the [Vercel Connect operator guide](./connections/VERCEL-CONNECT.md).

## Claude + Codex Local Adapters in Docker

The image pre-installs:

- `claude` (Anthropic Claude Code CLI)
- `codex` (OpenAI Codex CLI)
- `python3` (used to run local subscription sign-in in a pseudo-terminal)

Start the container, then open **Apps → Connections** to connect a Claude or
Codex subscription in your browser. You can also enter a provider API key there.
You do not run a shell command or configure a CLI home.

```sh
docker run --name proprio \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PROPRIO_HOME=/proprio \
  -v "$(pwd)/data/docker-proprio:/proprio" \
  proprio-local
```

Notes:

- The image provides the CLI and Python prerequisites for local subscription sign-in.
- Adapter environment checks in Proprio surface missing authentication or CLI prerequisites.

## Podman Quadlet (systemd)

The `docker/quadlet/` directory contains unit files to run Proprio + PostgreSQL as systemd services via Podman Quadlet.

| File | Purpose |
|------|---------|
| `docker/quadlet/proprio.pod` | Pod definition — groups containers into a shared network namespace |
| `docker/quadlet/proprio.container` | Proprio server — joins the pod, connects to Postgres at `127.0.0.1` |
| `docker/quadlet/proprio-db.container` | PostgreSQL 17 — joins the pod, health-checked |

### Setup

1. Build the image (see above).

2. Copy quadlet files to your systemd directory:

   ```sh
   # Rootless (recommended)
   cp docker/quadlet/*.pod docker/quadlet/*.container \
     ~/.config/containers/systemd/

   # Or rootful
   sudo cp docker/quadlet/*.pod docker/quadlet/*.container \
     /etc/containers/systemd/
   ```

3. Create a secrets env file (keep out of version control):

   ```sh
   cat > ~/.config/containers/systemd/proprio.env <<EOL
   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
   PROPRIO_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)
   POSTGRES_USER=proprio
   POSTGRES_PASSWORD=proprio
   POSTGRES_DB=proprio
   DATABASE_URL=postgres://proprio:proprio@127.0.0.1:5432/proprio
   # OPENAI_API_KEY=sk-...
   # ANTHROPIC_API_KEY=sk-...
   EOL
   ```

4. Create the data directory and start:

   ```sh
   mkdir -p ~/.local/share/proprio
   systemctl --user daemon-reload
   systemctl --user start proprio-pod
   ```

### Quadlet management

```sh
journalctl --user -u proprio -f        # App logs
journalctl --user -u proprio-db -f     # DB logs
systemctl --user status proprio-pod    # Pod status
systemctl --user restart proprio-pod   # Restart all
systemctl --user stop proprio-pod      # Stop all
```

### Quadlet notes

- **First boot**: Unlike Docker Compose's `condition: service_healthy`, Quadlet's `After=` only waits for the DB unit to *start*, not for PostgreSQL to be ready. On a cold first boot you may see one or two restart attempts in `journalctl --user -u proprio` while PostgreSQL initialises — this is expected and resolves automatically via `Restart=on-failure`.
- Containers in a pod share `localhost`, so Proprio reaches Postgres at `127.0.0.1:5432`.
- PostgreSQL data persists in the `proprio-pgdata` named volume.
- Proprio data persists at `~/.local/share/proprio`.
- For rootful quadlet deployment, remove `%h` prefixes and use absolute paths.

## Onboard Smoke Test (Ubuntu + npm only)

Use this when you want to mimic a fresh machine that only has Ubuntu + npm and verify:

- `pnpm proprio onboard --yes` completes
- the server binds to `0.0.0.0:3100` so host access works
- onboard/run banners and startup logs are visible in your terminal

Build + run:

```sh
./scripts/docker-onboard-smoke.sh
```

Open: `http://localhost:3131` (default smoke host port)

Useful overrides:

```sh
HOST_PORT=3200 PROPRIO_VERSION=latest ./scripts/docker-onboard-smoke.sh
PROPRIO_DEPLOYMENT_MODE=authenticated PROPRIO_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
SMOKE_DETACH=true SMOKE_METADATA_FILE=/tmp/proprio-smoke.env PROPRIO_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Notes:

- Persistent data is mounted at `./data/docker-onboard-smoke` by default.
- Container runtime user id defaults to your local `id -u` so the mounted data dir stays writable while avoiding root runtime.
- Smoke script defaults to `authenticated/private` mode so `HOST=0.0.0.0` can be exposed to the host.
- Smoke script defaults host port to `3131` to avoid conflicts with local Proprio on `3100`.
- Smoke script also defaults `PROPRIO_PUBLIC_URL` to `http://localhost:<HOST_PORT>` so bootstrap invite URLs and auth callbacks use the reachable host port instead of the container's internal `3100`.
- In authenticated mode, the smoke script defaults `SMOKE_AUTO_BOOTSTRAP=true` and drives the real bootstrap path automatically: it signs up a real user, runs `proprio auth bootstrap-ceo` inside the container to mint a real bootstrap invite, accepts that invite over HTTP, and verifies board session access.
- Run the script in the foreground to watch the onboarding flow; stop with `Ctrl+C` after validation.
- Set `SMOKE_DETACH=true` to leave the container running for automation and optionally write shell-ready metadata to `SMOKE_METADATA_FILE`.
- Set `SMOKE_CONTAINER_NAME` to fix the container's name up front. Automation that has to collect diagnostics when the script *fails* needs a name it already knows, rather than one it can only read back out of a successful run. Defaults to the image name.
- The container's logs are dumped to `SMOKE_LOG_FILE` (default `$TMPDIR/<container name>.log`) before the script tears the container down, so a run that never became ready still leaves its logs behind.
- The image definition is in `docker/Dockerfile.onboard-smoke`.

## General Notes

- The `docker-entrypoint.sh` adjusts the container `node` user UID/GID at startup to match the values passed via `USER_UID`/`USER_GID`, avoiding permission issues on bind-mounted volumes.
- Before it drops privileges, the entrypoint makes sure `PROPRIO_HOME` is owned by the `node` user. Each boot checks only the home directory and its first three levels. The first boot (and any boot after a UID/GID change) also checks the full tree, and then writes `PROPRIO_HOME/.proprio-ownership-verified`. While that marker is current, later boots skip the full-tree walk, which can take minutes on homes with many files. A mismatch triggers a recursive `chown`. If files deep in the tree get the wrong owner (for example, after a restore as root), delete the marker and restart to force a full check. If a check fails (for example, with an I/O error), the entrypoint does not write the marker, so the next boot checks again.
- The entrypoint writes timestamped lines when it starts, around the full ownership check or any repair (with the duration), and just before it starts the server, so you can measure the pre-start time from the container log.
- Proprio data persists via Docker volumes/bind mounts (compose) or at `~/.local/share/proprio` (quadlet).

## Native Runner build cache

The image compiles the native Runner once, in the `runner-artifacts-runnerd`
stage, with the package-owned Rust compiler, the release profile and locked
Cargo dependencies. That stage reads only the files Cargo reads.

Ordinary server, UI or Runner TypeScript changes can reuse the entire native
build through the existing registry cache (`mode=max`). A change to Rust
source, embedded protocol inputs, a dependency manifest, the Cargo lockfile or
the compiler compiles the daemon and its dependencies again. Each platform
gets its own native build; no cross-architecture binary is reused. No
additional GitHub Actions cache is created.

The `runner-artifacts-build` stage takes the build commit as an argument, so
every stamped build runs it: the frozen install, the Runner's TypeScript
build and the provider pack. Cargo finds the compiled daemon current there.

Cloud builds import one registry cache: the first available full-SHA cache in
the current commit's ten-entry first-parent ancestry, with the legacy cache
as a final fallback. Each build still exports its own SHA cache with
`mode=max`. In fresh-builder checks, importing several historical manifests
missed native layers that a single matching manifest reused. The selector
inspects metadata after Docker login, stops at the first available cache, and
permits a cold build if no cache can be read.

Rust input file times are normalized in both stages so fresh checkouts do not
force Cargo to rebuild unchanged source. The application build runs no Cargo
command. Cache misses only cost compilation time.
