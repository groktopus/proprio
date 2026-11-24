---
title: Docker
summary: Docker Compose quickstart
---

Run Proprio in Docker without installing Node or pnpm locally.

## Compose quickstart

Clone the repository and run these commands from its root. Install Docker
Engine 28.0.0 or later, Docker Compose, and OpenSSL on the host. For a fresh checkout, copy
the environment template:

```sh
test ! -e docker/.env && install -m 600 docker/.env.compose.example docker/.env
```

Run `openssl rand -hex 32` twice. Save the first value as
`BETTER_AUTH_SECRET` and the second as `PROPRIO_TOOL_ACTION_SIGNING_SECRET`
in `docker/.env`. Retain those values for future starts.

```sh
docker compose --env-file docker/.env -f docker/docker-compose.quickstart.yml up --build -d --wait
curl -fsS http://localhost:3100/api/health
```

When the response contains `"status":"ok"`, open
[http://localhost:3100](http://localhost:3100). The web port is local to the
Docker host and the stack uses embedded PostgreSQL.

For a custom port, set `PROPRIO_PORT=3200` in `docker/.env` and run the same
launch command. Open <http://localhost:3200>. The default public URL follows
the port. If you set an explicit `PROPRIO_PUBLIC_URL`, update it as well.

See the [Docker operations guide](https://github.com/groktopus/proprio/blob/main/doc/DOCKER.md)
for full-stack PostgreSQL, host access settings, and the database password
migration for existing installations.

## Manual Docker build

```sh
docker build --target production -t proprio-local .
docker run --name proprio \
  --env-file docker/.env \
  -p 127.0.0.1:3100:3100 \
  -e PROPRIO_PUBLIC_URL=http://localhost:3100 \
  -v "$(pwd)/data/docker-proprio:/proprio" \
  proprio-local
```

## Data Persistence

All data is persisted under the bind mount (`./data/docker-proprio`):

- Embedded PostgreSQL data
- Uploaded assets
- Local secrets key
- Agent workspace data

## Local Adapter CLIs in Docker

The Docker image pre-installs these agent CLIs so their `*_local` adapters can run inside the container:

- `claude` (Anthropic Claude Code CLI) — `claude_local`
- `codex` (OpenAI Codex CLI) — `codex_local`
- `opencode` (OpenCode multi-provider CLI) — `opencode_local`
- `gemini` (Google Gemini CLI) — `gemini_local` (experimental)

Pass API keys to enable local adapter runs inside the container:

```sh
docker run --name proprio \
  --env-file docker/.env \
  -p 127.0.0.1:3100:3100 \
  -e PROPRIO_PUBLIC_URL=http://localhost:3100 \
  -e OPENAI_API_KEY=sk-... \
  -e ANTHROPIC_API_KEY=sk-... \
  -e GEMINI_API_KEY=... \
  -v "$(pwd)/data/docker-proprio:/proprio" \
  proprio-local
```

Each adapter reads its provider's standard credentials — for example `ANTHROPIC_API_KEY` (Claude), `OPENAI_API_KEY` (Codex), and `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini). OpenCode is multi-provider and uses whichever provider key you supply.

> **Gemini key restrictions:** Google requires Gemini API keys to be *restricted* to the Gemini API (scoped in the Google Cloud console); unrestricted keys are blocked and `gemini_local` runs will fail with an auth error. Create a restricted key, or authenticate with `gemini auth login` (OAuth) and persist `~/.gemini` via the data volume so the credential survives container restarts.

The image sets `GEMINI_SANDBOX=false` so the Gemini CLI does not try to launch its own (Docker-in-Docker) sandbox inside the container. The `gemini_local` adapter already passes `--sandbox=none` per run, so this env var only matters if you invoke `gemini` manually inside the container; override it if you have nested-container support and want CLI-level sandboxing.

Without API keys, the app runs normally — adapter environment checks will surface missing prerequisites.
