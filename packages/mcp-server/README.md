# Proprio MCP Server

Model Context Protocol server for Proprio.

This package is a thin MCP wrapper over the existing Proprio REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `PROPRIO_API_URL` - Proprio base URL, for example `http://localhost:3100`
- `PROPRIO_API_KEY` - bearer token used for `/api` requests
- `PROPRIO_COMPANY_ID` - optional default company for company-scoped tools
- `PROPRIO_AGENT_ID` - optional default agent for checkout helpers
- `PROPRIO_RUN_ID` - optional run id forwarded on mutating requests

Inside an active heartbeat, Proprio also injects `PROPRIO_RUNTIME_TOOLS_*` variables. They enable the run-scoped `connections_search` and `connection_request` tools and expire with the run.

## Usage

```sh
npx -y @groktopus/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @groktopus/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Run-scoped connection tools:

- `connections_search`
- `connection_request`

Read tools:

- `proprioMe`
- `proprioInboxLite`
- `proprioListAgents`
- `proprioGetAgent`
- `proprioListIssues`
- `proprioGetIssue`
- `proprioGetHeartbeatContext`
- `proprioListComments`
- `proprioGetComment`
- `proprioListIssueApprovals`
- `proprioListDocuments`
- `proprioGetDocument`
- `proprioListDocumentRevisions`
- `proprioListProjects`
- `proprioGetProject`
- `proprioGetIssueWorkspaceRuntime`
- `proprioWaitForIssueWorkspaceService`
- `proprioListGoals`
- `proprioGetGoal`
- `proprioListApprovals`
- `proprioGetApproval`
- `proprioGetApprovalIssues`
- `proprioListApprovalComments`

Write tools:

- `proprioCreateIssue`
- `proprioUpdateIssue`
- `proprioCheckoutIssue`
- `proprioReleaseIssue`
- `proprioAddComment`
- `proprioSuggestTasks`
- `proprioAskUserQuestions`
- `proprioRequestConfirmation`
- `proprioUpsertIssueDocument`
- `proprioRestoreIssueDocumentRevision`
- `proprioControlIssueWorkspaceServices`
- `proprioCreateApproval`
- `proprioLinkIssueApproval`
- `proprioUnlinkIssueApproval`
- `proprioApprovalDecision`
- `proprioAddApprovalComment`

Escape hatch:

- `proprioApiRequest`

`proprioApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
