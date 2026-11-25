import { execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authAccounts, authUsers, companies, createDb, principalPermissionGrants, toolActionRequests } from "@groktopus/db";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import type { ToolActionRequestListItem, ToolRunDecision } from "@groktopus/shared";
import { accessService } from "../services/access.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
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

async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) =>
    listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Missing controller port");
  return address.port;
}

async function startController(home: string, config: string, databaseUrl: string, port: number) {
  const child = fork(fileURLToPath(new URL("./helpers/maintenance/server-child.ts", import.meta.url)), [], {
    execArgv: ["--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url))],
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test",
      PROPRIO_HOME: home,
      PROPRIO_CONFIG: config,
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? "4",
      PROPRIO_AGENT_JWT_SECRET: process.env.PROPRIO_AGENT_JWT_SECRET,
      PROPRIO_TOOL_ACTION_SIGNING_SECRET: process.env.PROPRIO_TOOL_ACTION_SIGNING_SECRET,
      PROPRIO_DECISION_SIGNING_SECRET: process.env.PROPRIO_DECISION_SIGNING_SECRET,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
      PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH: process.env.PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH,
      PROPRIO_MANAGED_AUDIT_CAPTURE_FROM: process.env.PROPRIO_MANAGED_AUDIT_CAPTURE_FROM,
      PROPRIO_AUTH_RATE_LIMIT_ENABLED: "false",
      PROPRIO_ANNOUNCEMENTS_ENABLED: "false",
      PROPRIO_IN_WORKTREE: "false",
      PROPRIO_UI_DEV_MIDDLEWARE: "false",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", chunk => { output = (output + chunk).slice(-8000); });
  }
  const exited = new Promise<number | null>(resolve => child.once("close", resolve));
  try {
    const readyPort = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out starting audit controller")), 45_000);
      child.on("message", (message: { kind?: string; port?: number; error?: string }) => {
        if (message.kind === "ready" && message.port) { clearTimeout(timeout); resolve(message.port); }
        else if (message.kind === "error") { clearTimeout(timeout); reject(new Error(message.error)); }
      });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      void exited.then(code => { clearTimeout(timeout); reject(new Error(`Audit controller exited with code ${code}`)); });
    });
    expect(readyPort).toBe(port);
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw new Error(`Unable to start audit controller:
${output}`, { cause: error });
  }
  return {
    pid: child.pid!,
    async close() {
      if (child.connected) child.send({ id: 1, command: "shutdown" });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try { expect(await exited, output).toBe(0); }
      finally { clearTimeout(timeout); }
    },
  };
}

it.skipIf(!recoveryPostgresSupport.supported)("reconstructs managed effects after an authenticated controller restart", async () => {
  const isolatedHome = createIsolatedTestHome();
  const home = isolatedHome.home;
  const ledger = join(home, "target-effects.jsonl");
  let controller: Awaited<ReturnType<typeof startController>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>> | undefined;
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
    const exportFrom = new Date().toISOString();
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", exportFrom);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    const workspace = join(home, "runner");
    await mkdir(workspace);
    execFileSync("git", ["init", "-q", workspace]);
    vi.stubEnv("PROPRIO_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PROPRIO_TOOL_ACTION_SIGNING_SECRET", randomUUID());
    vi.stubEnv("PROPRIO_DECISION_SIGNING_SECRET", randomUUID());
    vi.stubEnv("BETTER_AUTH_SECRET", randomUUID() + randomUUID());
    vi.stubEnv("PROPRIO_AUTH_RATE_LIMIT_ENABLED", "false");
    database = await startRecoveryPostgres("proprio-audit-reconstruction-db-");
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const config = join(home, "config.json");
    await writeFile(config, JSON.stringify({
      $meta: { version: 1, updatedAt: exportFrom, source: "onboard" },
      database: { mode: "postgres", connectionString: database.connectionString, backup: { enabled: false, intervalMinutes: 60, dir: join(home, "backups") } },
      logging: { mode: "file", logDir: join(home, "logs") },
      server: { deploymentMode: "authenticated", exposure: "private", bind: "loopback", host: "127.0.0.1", port, serveUi: false },
      auth: { baseUrlMode: "explicit", publicBaseUrl: origin, disableSignUp: true },
      storage: { provider: "local_disk", localDisk: { baseDir: join(home, "storage") } },
      secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: join(home, "master.key") } },
      telemetry: { enabled: false }, updates: { checkEnabled: false },
    }), { mode: 0o600 });
    db = createDb(database.connectionString);
    const companyId = randomUUID();
    const ownerId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Audit reconstruction", issuePrefix: "AUD",
      requireBoardApprovalForNewAgents: false,
    });
    const access = accessService(db);
    const credentials = [];
    for (const [userId, name, role] of [[ownerId, "Fixture owner", "owner"], [reviewerId, "Independent reviewer", "operator"]] as const) {
      const email = `${userId}@fixture.invalid`;
      const password = `fixture-${randomUUID()}`;
      await db.insert(authUsers).values({ id: userId, name, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(authAccounts).values({ id: randomUUID(), issuer: "local:credential", accountId: userId,
        providerId: "credential", userId, password: await hashPassword(password), createdAt: new Date(), updatedAt: new Date() });
      await access.ensureMembership(companyId, "user", userId, role, "active");
      await access.ensureRoleDefaultGrants(companyId, userId, role, ownerId);
      credentials.push({ email, password });
    }
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: reviewerId, permissionKey: "audit:view_agent_actions",
    }).onConflictDoNothing();
    controller = await startController(home, config, database.connectionString, port);
    const [ownerCookie, reviewerCookie] = await Promise.all(credentials.map(async credential => {
      const response = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(credential),
      });
      expect(response.status, await response.text()).toBe(200);
      const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      expect(cookie).not.toBe("");
      return cookie;
    }));
    let cookie = ownerCookie;
    const fixtureIssueIds: string[] = [];
    const api = async (method: string, path: string, data?: unknown, session = cookie) => {
      const response = await fetch(origin + "/api" + path, {
        method, headers: { cookie: session, origin, "Content-Type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json() };
    };
    cleanupRuns = async () => {
      for (const issueId of fixtureIssueIds) {
        const runs = await api("GET", `/issues/${issueId}/runs`, undefined, ownerCookie);
        if (runs.status !== 200) continue;
        for (const run of runs.body as Array<{ runId: string; status: string }>) {
          if (run.status === "queued" || run.status === "running") await api("POST", `/heartbeat-runs/${run.runId}/cancel`, {}, ownerCookie);
        }
      }
    };
    const agentIds: string[] = [];
    for (const marker of markers) {
      const agent = await api("POST", `/companies/${companyId}/agents`, {
        name: `Audit fixture runner ${marker}`, role: "engineer", adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: workspace },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        permissions: {},
      });
      expect(agent, JSON.stringify(agent)).toMatchObject({ status: 201 });
      await vi.waitFor(async () => {
        const state = await api("GET", `/agents/${agent.body.id}`);
        expect(state).toMatchObject({ status: 200, body: { lifecycleState: "ready" } });
      }, { timeout: 15_000, interval: 250 });
      agentIds.push(agent.body.id);
    }

    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
    const companyPath = `/companies/${companyId}`;
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
      const decision = await api("POST", `/tool-gateway/action-requests/${requestId}/${marker === "denied" ? "decline" : "approve"}`, { companyId: companyId });
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
    const firstControllerPid = controller.pid;
    await controller.close();
    controller = await startController(home, config, database.connectionString, port);
    expect(controller.pid).not.toBe(firstControllerPid);
    cookie = reviewerCookie;
    const exportPath = `${companyPath}/audit/managed-exports`;
    const snapshot = await api("POST", exportPath, { from: exportFrom, to: new Date().toISOString() });
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(201);
    const page = await api("GET", `${exportPath}/${snapshot.body.exportId}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body).toMatchObject({
      complete: true,
      eventCount: snapshot.body.eventCount,
      watermark: snapshot.body.watermark,
    });
    const events = page.body.events as Array<{ invocationId: string; phase: string; status: string }>;
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
      const invocationEvents = events.filter(event => event.invocationId === ids.invocationId);
      const phases = invocationEvents.map(event => event.phase).sort();
      const expectedPhases = ["approval_resolution", "policy_decision"];
      if (marker !== "denied") expectedPhases.push("dispatch_intent");
      if (marker === "approved") expectedPhases.push("terminal_outcome");
      expect(phases).toEqual(expectedPhases.sort());
      for (const event of invocationEvents) {
        expect(event).toMatchObject({ taskId: ids.issueId, runId: ids.runId, requestId: ids.requestId });
        if (event.phase !== "policy_decision") expect(event).toMatchObject({ actorType: "user", actorId: ownerId });
      }
      fingerprints.set(marker, fingerprint);
      if (marker === "denied") expect(record.invocation.status).toBe("denied");
      if (marker === "approved") {
        expect(record.invocation.status).toBe("succeeded");
        expect(invocationEvents.find(event => event.phase === "terminal_outcome")?.status).toBe("succeeded");
        expect(record.auditEvents.some(event => event.invocationId === ids.invocationId && event.actionRequestId === ids.requestId && event.eventType === "call_completed" && event.outcome === "success")).toBe(true);
      }
      if (marker === "interrupted") {
        expect(record.invocation.status).toBe("executing");
        expect(record.auditEvents.some(event => event.eventType === "call_failed" || event.eventType === "call_completed")).toBe(false);
      }
    }
    expect(fingerprints.get("approved")).not.toBe(fingerprints.get("denied"));
    expect(fingerprints.get("denied")).toBe(fingerprints.get("interrupted"));
    const observedTargetEffects = await effects();
    expect(observedTargetEffects).toEqual(["approved", "interrupted"]);
    const pending = await api("GET", `${companyPath}/tools/action-requests?status=pending`);
    expect(pending.status).toBe(200);
    expect((pending.body.actionRequests as ToolActionRequestListItem[]).filter(item => [...cases.values()].some(ids => ids.issueId === item.request.issueId))).toHaveLength(0);
    const durableRequests = await db.select({ issueId: toolActionRequests.issueId })
      .from(toolActionRequests).where(eq(toolActionRequests.companyId, companyId));
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
        controllerRestart: { beforePid: firstControllerPid, afterPid: controller.pid },
        connectorProfile: "synthetic localhost HTTP MCP target",
        reviewer: "separate company operator with default audit role grants",
        companyId: companyId,
        auditExport: {
          exportId: snapshot.body.exportId,
          eventCount: page.body.eventCount,
          watermark: page.body.watermark,
        },
        cases: Object.fromEntries([...cases].map(([marker, ids]) => [marker, {
          issueId: ids.issueId, runId: ids.runId, invocationId: ids.invocationId,
          actionRequestId: ids.requestId, policyFingerprint: ids.fingerprint, policyPriority: ids.priority,
          auditPhases: events.filter(event => event.invocationId === ids.invocationId).map(event => event.phase).sort(),
          targetEffects: observedTargetEffects.filter(effect => effect === marker),
        }])),
        outcomes: { approved: "success receipt and one target effect", denied: "denied with zero target effects", interrupted: "target effect durable; response lost; no retry submitted" },
        scope: "authenticated controller process restart against the same disposable PostgreSQL database",
      }, null, 2) + "\n", { mode: 0o600 });
    }
  } finally {
    try { await cleanupRuns?.(); } catch { /* Preserve the original fixture failure while attempting shutdown. */ }
    try {
      await controller?.close();
    } finally {
      await db?.$client.end();
      await database?.cleanup();
      if (target.listening) await new Promise<void>(resolve => target.close(() => resolve()));
      isolatedHome.cleanup();
      vi.unstubAllEnvs();
    }
  }
}, 150_000);
