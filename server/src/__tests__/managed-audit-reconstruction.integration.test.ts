import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { authUsers, companies, toolActionRequests } from "@groktopus/db";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import type { ToolActionRequestListItem, ToolRunDecision } from "@groktopus/shared";
import { accessService } from "../services/access.js";
import { heartbeatService } from "../services/heartbeat.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";

const markers = ["approved", "denied", "interrupted"] as const;

const runner = `
const [connectionId, marker, attemptFile] = process.argv.slice(1);
const fs = await import("node:fs");
try { fs.writeFileSync(attemptFile, "attempted", { flag: "wx" }); }
catch (error) { if (error.code === "EEXIST") process.exit(0); throw error; }
const base = process.env.PROPRIO_API_URL.replace(/\\/api\\/?$/, "");
const api = (path, init) => fetch(base + "/api" + path, init);
const session = await api("/tool-gateway/sessions", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.PROPRIO_API_KEY, "content-type": "application/json" },
  body: JSON.stringify({ ttlMs: 60000 }),
});
if (!session.ok) throw new Error("Gateway session failed: " + session.status);
const headers = { "x-proprio-tool-gateway-token": (await session.json()).token, "content-type": "application/json" };
const listed = await api("/tool-gateway/tools", { headers });
if (!listed.ok) throw new Error("Gateway catalog failed: " + listed.status);
const tool = (await listed.json()).find(item => item.connectionId === connectionId);
if (!tool) throw new Error("Managed fixture tool unavailable");
const call = await api("/tool-gateway/tools/call", {
  method: "POST", headers, body: JSON.stringify({ tool: tool.name, parameters: { marker }, idempotencyKey: marker }),
});
const result = await call.json();
console.log(JSON.stringify({ runId: process.env.PROPRIO_RUN_ID, status: call.status, reason: result.reasonCode ?? null }));
if (call.status !== 200 && (call.status !== 409 || result.reasonCode !== "approval_required")) throw new Error("Expected a governed action");
`;

it.skipIf(!recoveryPostgresSupport.supported)("reconstructs managed effects from an authenticated process run and an independent target", async () => {
  const isolatedHome = createIsolatedTestHome();
  const home = isolatedHome.home;
  const ledger = join(home, "target-effects.jsonl");
  const origin = "https://audit.fixture.invalid";
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>> | undefined;
  let lifecycle: ReturnType<typeof configureAgentLifecycle> | undefined;
  let cleanupRuns: (() => Promise<void>) | undefined;
  const target = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    let result: unknown;
    switch (input.method) {
      case "initialize":
        result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Audit fixture", version: "1" } };
        break;
      case "tools/list":
        result = { tools: [{
          name: "write_fixture_marker",
          description: "Write the synthetic marker to the fixture ledger",
          inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false },
        }] };
        break;
      case "tools/call": {
        const marker = input.params?.arguments?.marker;
        if (typeof marker !== "string" || !markers.some(candidate => candidate === marker)) {
          res.writeHead(400).end();
          return;
        }
        await appendFile(ledger, JSON.stringify({ marker }) + "\n");
        if (marker === "interrupted") {
          // The target effect is durable, but the gateway receives no success response.
          res.destroy();
          return;
        }
        result = { content: [{ type: "text", text: "Fixture marker written" }] };
        break;
      }
      default:
        res.writeHead(req.method === "DELETE" ? 204 : 202).end();
        return;
    }
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });

  const effects = async () => (await readFile(ledger, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).trim().split("\n").filter(Boolean).map(line => JSON.parse(line).marker);

  try {
    vi.stubEnv("PROPRIO_HOME", home);
    const workspace = join(home, "runner");
    await mkdir(workspace);
    execFileSync("git", ["init", "-q", workspace]);
    vi.stubEnv("PROPRIO_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PROPRIO_TOOL_ACTION_SIGNING_SECRET", randomUUID());
    vi.stubEnv("BETTER_AUTH_SECRET", randomUUID() + randomUUID());
    vi.stubEnv("PROPRIO_AUTH_RATE_LIMIT_ENABLED", "false");
    database = await startRecoveryPostgres("proprio-audit-reconstruction-db-");
    server = await startRunnerApiTestServer({ humanSessions: true, authPublicBaseUrl: origin, databaseUrl: database.connectionString });
    vi.stubEnv("PROPRIO_API_URL", server.apiUrl);
    const f = await server.fixture({ connectionScenario: "fresh" });
    const ownerId = f.responsibleUserId!;
    const access = accessService(server.db);
    await access.ensureMembership(f.companyId, "user", ownerId, "owner", "active");
    await access.ensureRoleDefaultGrants(f.companyId, ownerId, "owner", ownerId);
    await server.db.update(companies).set({ requireBoardApprovalForNewAgents: false }).where(eq(companies.id, f.companyId));
    let cookie = await server.humanSession(ownerId);
    const reviewerId = randomUUID();
    await server.db.insert(authUsers).values({
      id: reviewerId, name: "Independent audit reviewer", email: `${reviewerId}@fixture.invalid`,
      createdAt: new Date(), updatedAt: new Date(),
    });
    await access.ensureMembership(f.companyId, "user", reviewerId, "operator", "active");
    await access.ensureRoleDefaultGrants(f.companyId, reviewerId, "operator", reviewerId);
    const reviewerCookie = await server.humanSession(reviewerId);
    const api = async (method: string, path: string, data?: unknown, session = cookie) => {
      const url = server!.apiUrl;
      const response = await fetch(url + "/api" + path, {
        method, headers: { cookie: session, origin: url, "Content-Type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() };
    };
    cleanupRuns = async () => {
      for (const issueId of fixtureIssueIds) {
        const runs = await api("GET", `/issues/${issueId}/runs`);
        if (runs.status !== 200) continue;
        for (const run of runs.body as Array<{ runId: string; status: string }>) {
          if (run.status === "queued" || run.status === "running") await api("POST", `/heartbeat-runs/${run.runId}/cancel`, {});
        }
      }
      await heartbeatService(server!.db).drainActiveRunExecutions();
    };
    lifecycle = configureAgentLifecycle(server.db, {
      requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete",
    });
    const agentIds: string[] = [];
    for (const marker of markers) {
      const agent = await api("POST", `/companies/${f.companyId}/agents`, {
        name: `Audit fixture runner ${marker}`, role: "engineer", adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: workspace },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
      });
      expect(agent, JSON.stringify(agent)).toMatchObject({ status: 201 });
      await lifecycle.process(agent.body.id);
      agentIds.push(agent.body.id);
    }

    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
    const companyPath = `/companies/${f.companyId}`;
    const connection = await api("POST", `${companyPath}/tools/apps/connect`, {
      name: "Independent synthetic target", link: `http://127.0.0.1:${address.port}/mcp`,
    });
    expect(connection, JSON.stringify(connection)).toMatchObject({ status: 201 });
    const entryId = connection.body.catalog[0].id;
    const connectionId = connection.body.connectionId;
    const finished = await api("POST", `${companyPath}/tools/apps/${connectionId}/finish`, {
      enabledCatalogEntryIds: [entryId], access: { agentIds },
    });
    expect(finished, JSON.stringify(finished)).toMatchObject({ status: 200 });
    const createdPolicy = await api("POST", `${companyPath}/tools/policies`, {
      name: "Require review of synthetic writes",
      policyType: "require_approval",
      selectors: { connectionId, agentIds, catalogEntryId: entryId },
      priority: 1,
    });
    expect(createdPolicy).toMatchObject({ status: 201 });
    const policyId = createdPolicy.body.id;

    const cases = new Map<string, { issueId: string; runId: string; invocationId: string; requestId: string; fingerprint: string; priority: number }>();
    const fixtureIssueIds: string[] = [];
    for (const [index, marker] of markers.entries()) {
      const agentId = agentIds[index];
      const configured = await api("PATCH", `/agents/${agentId}`, {
        adapterConfig: { command: process.execPath, args: ["--input-type=module", "-e", runner, connectionId, marker, join(home, `${marker}.attempted`)], cwd: workspace },
        replaceAdapterConfig: true,
      });
      expect(configured, JSON.stringify(configured)).toMatchObject({ status: 200 });
      const issue = await api("POST", `${companyPath}/issues`, {
        title: `Audit action ${marker}`, assigneeAgentId: agentId, status: "in_progress",
      });
      expect(issue, JSON.stringify(issue)).toMatchObject({ status: 201 });
      fixtureIssueIds.push(issue.body.id);

      let pending: ToolActionRequestListItem | undefined;
      await vi.waitFor(async () => {
        const response = await api("GET", `${companyPath}/tools/action-requests?status=pending`);
        expect(response.status).toBe(200);
        pending = response.body.actionRequests.find((entry: ToolActionRequestListItem) => entry.request.issueId === issue.body.id);
        expect(pending).toBeTruthy();
      }, { timeout: 15_000, interval: 250 });
      expect(await effects()).toEqual(index === 0 ? [] : ["approved"]);
      if (!pending) throw new Error("The managed action request did not persist");
      const { id: requestId, invocationId } = pending.request;
      const taskRuns = await api("GET", `/issues/${issue.body.id}/runs`);
      expect(taskRuns.status).toBe(200);
      const candidates = await Promise.all(taskRuns.body
        .filter((run: { adapterType: string }) => run.adapterType === "process")
        .map(async (run: { runId: string }) => {
          const timeline = await api("GET", `${companyPath}/tools/runs/${run.runId}/decisions`, undefined, reviewerCookie);
          expect(timeline.status, JSON.stringify(timeline.body)).toBe(200);
          return timeline.body.decisions.some((row: { invocation: { id: string } }) =>
            row.invocation.id === invocationId) ? run.runId : null;
        }));
      const runId = candidates.find((candidate): candidate is string => candidate !== null);
      if (!runId) throw new Error("The request did not correlate with a visible task run");
      const beforeDecision = await api("GET", `${companyPath}/tools/runs/${runId}/decisions`, undefined, reviewerCookie);
      expect(beforeDecision.status).toBe(200);
      const beforeRecord = (beforeDecision.body.decisions as ToolRunDecision[]).find(item => item.invocation.id === invocationId);
      const beforePolicy = beforeRecord?.policyProvenance.policies.find(policy => policy.policyId === policyId);
      expect(beforePolicy).toMatchObject({ priority: index === 0 ? 1 : 2 });
      if (!beforePolicy) throw new Error("The evaluated policy snapshot was not available before decision");
      const decision = await api("POST", `/tool-gateway/action-requests/${requestId}/${marker === "denied" ? "decline" : "approve"}`, { companyId: f.companyId });
      expect(decision, JSON.stringify(decision)).toMatchObject({ status: 200 });
      cases.set(marker, { issueId: issue.body.id, runId, invocationId, requestId, fingerprint: beforePolicy.revisionFingerprint, priority: beforePolicy.priority });
      if (marker !== "denied") await vi.waitFor(async () => expect(await effects()).toContain(marker), { timeout: 5_000 });
      if (index === 0) {
        expect(await api("PATCH", `${companyPath}/tools/policies/${policyId}`, { priority: 2 })).toMatchObject({ status: 200 });
      }
    }

    // Stop queued or running fixture continuations before closing the controller.
    // The independently observed call receipts above are already durable.
    for (const { issueId } of cases.values()) {
      const runs = await api("GET", `/issues/${issueId}/runs`);
      expect(runs.status).toBe(200);
      for (const run of runs.body as Array<{ runId: string; status: string }>) {
        if (run.status === "queued" || run.status === "running") {
          expect((await api("POST", `/heartbeat-runs/${run.runId}/cancel`, {})).status).toBe(200);
        }
      }
    }
    await heartbeatService(server.db).drainActiveRunExecutions();
    await lifecycle.stop();
    lifecycle = undefined;
    await server.close();
    server = await startRunnerApiTestServer({ humanSessions: true, authPublicBaseUrl: origin, databaseUrl: database.connectionString });
    cookie = reviewerCookie;
    const fingerprints = new Map<string, string>();
    for (const [marker, ids] of cases) {
      const reviewerRuns = await api("GET", `/issues/${ids.issueId}/runs`);
      expect(reviewerRuns.status, JSON.stringify(reviewerRuns.body)).toBe(200);
      const reviewerRunIds = (reviewerRuns.body as Array<{ runId: string; adapterType: string }>)
        .filter(run => run.adapterType === "process").map(run => run.runId);
      expect(reviewerRunIds).toContain(ids.runId);
      const matchingRunIds: string[] = [];
      for (const runId of reviewerRunIds) {
        const timeline = await api("GET", `${companyPath}/tools/runs/${runId}/decisions`);
        expect(timeline.status, JSON.stringify(timeline.body)).toBe(200);
        if ((timeline.body.decisions as ToolRunDecision[]).some(row => row.invocation.id === ids.invocationId)) matchingRunIds.push(runId);
      }
      expect(matchingRunIds).toEqual([ids.runId]);
      const response = await api("GET", `${companyPath}/tools/runs/${ids.runId}/decisions`);
      expect(response, JSON.stringify(response)).toMatchObject({ status: 200 });
      const record = (response.body.decisions as ToolRunDecision[]).find(item => item.invocation.id === ids.invocationId);
      expect(record).toMatchObject({
        invocation: { runId: ids.runId, issueId: ids.issueId, matchedPolicyIds: [policyId] },
        actionRequest: { id: ids.requestId, decidedByUserId: ownerId },
        policyProvenance: { captureStatus: "recorded" },
      });
      const fingerprint = record?.policyProvenance.policies.find(policy => policy.policyId === policyId)?.revisionFingerprint;
      if (!record || !fingerprint) throw new Error("The historical policy revision did not survive restart");
      expect(record.policyProvenance.policies.find(policy => policy.policyId === policyId)).toMatchObject({
        revisionFingerprint: ids.fingerprint, priority: ids.priority,
      });
      fingerprints.set(marker, fingerprint);
      if (marker === "denied") expect(record.invocation.status).toBe("denied");
      if (marker === "approved") {
        expect(record.invocation.status).toBe("succeeded");
        expect(record.auditEvents.some(event => event.invocationId === ids.invocationId && event.actionRequestId === ids.requestId && event.eventType === "call_completed" && event.outcome === "success")).toBe(true);
      }
      if (marker === "interrupted") {
        expect(["failed", "timed_out"]).toContain(record.invocation.status);
        expect(record.auditEvents.some(event => event.eventType === "call_failed")).toBe(true);
      }
    }
    expect(fingerprints.get("approved")).not.toBe(fingerprints.get("denied"));
    expect(fingerprints.get("denied")).toBe(fingerprints.get("interrupted"));
    expect(await effects()).toEqual(["approved", "interrupted"]);
    const pending = await api("GET", `${companyPath}/tools/action-requests?status=pending`);
    expect(pending.status).toBe(200);
    expect((pending.body.actionRequests as ToolActionRequestListItem[]).filter(item => [...cases.values()].some(ids => ids.issueId === item.request.issueId))).toHaveLength(0);
    const durableRequests = await server.db.select({ issueId: toolActionRequests.issueId })
      .from(toolActionRequests).where(eq(toolActionRequests.companyId, f.companyId));
    for (const issueId of fixtureIssueIds) {
      expect(durableRequests.filter(request => request.issueId === issueId)).toHaveLength(1);
    }
    const evidencePath = process.env.PROPRIO_AUDIT_RECONSTRUCTION_EVIDENCE_PATH;
    if (evidencePath) {
      await mkdir(join(evidencePath, ".."), { recursive: true });
      await writeFile(evidencePath, JSON.stringify({
        schemaVersion: 1,
        testedRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        runnerProfile: "local process adapter; no model account",
        connectorProfile: "synthetic localhost HTTP MCP target",
        reviewer: "separate company operator with default audit role grants",
        companyId: f.companyId,
        cases: Object.fromEntries([...cases].map(([marker, ids]) => [marker, {
          issueId: ids.issueId, runId: ids.runId, invocationId: ids.invocationId,
          actionRequestId: ids.requestId, policyFingerprint: ids.fingerprint, policyPriority: ids.priority,
          targetEffects: marker === "denied" ? [] : [marker],
        }])),
        outcomes: { approved: "success receipt and one target effect", denied: "denied with zero target effects", interrupted: "target effect durable; response lost; no retry submitted" },
        scope: "same-PostgreSQL test-server recreation in one Vitest process; not production index startup or independent database restore",
      }, null, 2) + "\n", { mode: 0o600 });
    }
  } finally {
    try { await cleanupRuns?.(); } catch { /* Preserve the original fixture failure while attempting shutdown. */ }
    await lifecycle?.stop();
    await server?.close();
    await database?.cleanup();
    if (target.listening) await new Promise<void>(resolve => target.close(() => resolve()));
    isolatedHome.cleanup();
    vi.unstubAllEnvs();
  }
}, 90_000);
