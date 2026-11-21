---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm proprio issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm proprio issue get <issue-id-or-identifier>

# Create issue
pnpm proprio issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm proprio issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm proprio issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm proprio issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm proprio issue release <issue-id>
```

## Company Commands

```sh
pnpm proprio company list
pnpm proprio company get <company-id>
pnpm proprio company current [--company-id <company-id>]

# Export to portable folder package (writes manifest + markdown files)
pnpm proprio company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm proprio company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm proprio company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

`company import` is unavailable against cloud-managed instances — the
server answers `403` with `code: "cloud_managed"`. Export remains available
there.

With agent authentication, use `company list` or `company current` to resolve
the scoped company. `company list` first tries the board-wide list; if that is
forbidden, it falls back to `--company-id`, `PROPRIO_COMPANY_ID`, context, or
`/api/agents/me` and returns only that scoped company. `company create` requires
board/instance-admin authentication because it is an instance-wide setup
command.

## Agent Commands

```sh
pnpm proprio agent list
pnpm proprio agent get <agent-id>
```

## Skills Commands

```sh
# Browse app-shipped catalog skills without changing company state
pnpm proprio skills browse [--kind bundled|optional] [--category software-development] [--query github]
pnpm proprio skills search "pull request" [--json]

# Inspect catalog metadata and file inventory before install
pnpm proprio skills inspect github-pr-workflow

# Install a catalog skill into the company skill library
# This does not attach the skill to any agent.
pnpm proprio skills install github-pr-workflow --company-id <company-id>
pnpm proprio skills install github-pr-workflow --as pr-flow --force --company-id <company-id>

# External sources still use import instead of catalog install
pnpm proprio skills import ./skills/my-skill --company-id <company-id>
pnpm proprio skills import owner/repo/path/to/skill --company-id <company-id>

# Attach desired company skills to an agent after install/import
pnpm proprio skills agent sync <agent-id> --skill github-pr-workflow --mode add --company-id <company-id>
```

## Approval Commands

```sh
# List approvals
pnpm proprio approval list [--status pending]

# Get approval
pnpm proprio approval get <approval-id>

# Create approval
pnpm proprio approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm proprio approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm proprio approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm proprio approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm proprio approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm proprio approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm proprio activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm proprio dashboard get
```

## Instance Settings

```sh
pnpm proprio instance settings:general
pnpm proprio instance settings:general:update --payload-json '{...}'
pnpm proprio instance settings:experimental
pnpm proprio instance settings:experimental:update --payload-json '{...}'
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

## Heartbeat

```sh
pnpm proprio heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
