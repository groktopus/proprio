import { randomBytes, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { activityLog, agentWakeupRequests, agents, companyMemberships, companies, createDb, heartbeatRuns, issueRelations, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@groktopus/db";
import type { Request } from "express";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { afterEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startMaintenancePostgresProxy } from "./helpers/maintenance/postgres-proxy.js";

const support = await getEmbeddedPostgresTestSupport();
const crashPoint = "issue.dependency_diagnosis.after_claim_before_wake";
const childEntry = path.join(import.meta.dirname, "helpers/maintenance/server-child.ts");
const tsxLoader = path.resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs");
const children = new Set<ChildProcess>();

function issueActorApi(db: ReturnType<typeof createDb>, actor: Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
  app.use(errorHandler);
  return app;
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve controller port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startController(input: { home: string; config: string; port: number; databaseUrl: string;
  crashControl: string; crashReceipt: string }) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PROPRIO_HOME: input.home,
    PROPRIO_CONFIG: input.config,
    DATABASE_URL: input.databaseUrl,
    DATABASE_POOL_MAX: "4",
    PROPRIO_INSTANCE_ID: "dependency-diagnosis-controller-test",
    PROPRIO_AGENT_JWT_SECRET: randomBytes(32).toString("hex"),
    PROPRIO_DECISION_SIGNING_SECRET: randomBytes(32).toString("hex"),
    PROPRIO_TOOL_ACTION_SIGNING_SECRET: randomBytes(32).toString("hex"),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PROPRIO_CRASH_POINT_CONTROL: input.crashControl,
    PROPRIO_CRASH_POINT_RECEIPT: input.crashReceipt,
    PROPRIO_MIGRATION_PROMPT: "never",
    PROPRIO_MIGRATION_AUTO_APPLY: "true",
    PROPRIO_UI_DEV_MIDDLEWARE: "false",
    PROPRIO_IN_WORKTREE: "false",
    PROPRIO_ANNOUNCEMENTS_ENABLED: "false",
    PROPRIO_DB_BACKUP_ENABLED: "false",
    PROPRIO_MANAGED_RUNTIME_HTTPS: "off",
    HEARTBEAT_SCHEDULER_ENABLED: "true",
  };
  const child = fork(childEntry, [], { cwd: path.resolve(import.meta.dirname, "../../.."),
    execArgv: ["--import", tsxLoader], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", value => { output += value; });
  child.stderr?.setEncoding("utf8").on("data", value => { output += value; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => {
    children.delete(child);
    resolve({ code, signal });
  }));
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Controller boot timed out: ${output.slice(-8000)}`)), 120_000);
    child.on("message", (message: any) => {
      if (message?.kind === "ready") { clearTimeout(timeout); resolve(message.port); }
      else if (message?.kind === "error") { clearTimeout(timeout); reject(new Error(message.error)); }
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Controller exited during boot (${code}/${signal}): ${output.slice(-8000)}`));
    });
  });
  return {
    child, port, exited,
    async api<T>(method: string, route: string, body?: unknown): Promise<T> {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
      return result as T;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.send({ id: 1, command: "shutdown" });
      await exited;
    },
    get output() { return output; },
  };
}

async function waitFor<T>(read: () => Promise<T | null>, ready: (value: T) => boolean, message: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
});

describe.skipIf(!support.supported)("dependency diagnosis in a restarted full controller", () => {
  it.each(["retained agent", "reassigned to board"] as const)("reconciles one claim after restart with %s", async (ownership) => {
    const database = await startEmbeddedPostgresTestDatabase("dependency-diagnosis-controller-");
    const db = createDb(database.connectionString, { maxConnections: 4 });
    const proxy = await startMaintenancePostgresProxy(database.connectionString);
    const home = await mkdtemp(path.join(os.tmpdir(), "dependency-diagnosis-controller-"));
    const port = await reservePort();
    const config = path.join(home, "config.json");
    const control = path.join(home, "crash-point-control.txt");
    const receipt = path.join(home, "crash-point-receipt.jsonl");
    const effectFile = path.join(home, "diagnosis-effect.txt");
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    let controller: Awaited<ReturnType<typeof startController>> | undefined;
    let restarted: Awaited<ReturnType<typeof startController>> | undefined;
    try {
      await writeFile(config, JSON.stringify({
        $meta: { version: 1, updatedAt: new Date().toISOString(), source: "onboard" },
        database: { mode: "postgres", connectionString: proxy.url, backup: { enabled: false, intervalMinutes: 60, dir: path.join(home, "backups") } },
        logging: { mode: "file", logDir: path.join(home, "logs") },
        server: { deploymentMode: "local_trusted", exposure: "private", bind: "loopback", host: "127.0.0.1", port, serveUi: false },
        storage: { provider: "local_disk", localDisk: { baseDir: path.join(home, "storage") } },
        secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: path.join(home, "master.key") } },
        telemetry: { enabled: false }, updates: { checkEnabled: false },
      }));
      await writeFile(control, `controller-crash ${crashPoint}\n`);

      // First real server boot is empty. Arm before seeding because the
      // relation write can wake the normal assigned-work queue immediately.
      controller = await startController({ home, config, port, databaseUrl: proxy.url, crashControl: control, crashReceipt: receipt });
      const prefix = `D${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`;
      await db.insert(companies).values({ id: companyId, name: "Full controller diagnosis", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", membershipRole: "owner" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Process fixture", role: "engineer", status: "idle",
        lifecycleState: "ready", adapterType: "process", adapterConfig: { command: process.execPath,
          args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'invoked')", effectFile], cwd: process.cwd() },
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } }, permissions: {} });
      const old = new Date(Date.now() - 10 * 60_000);
      await db.insert(issues).values([
        { id: parentId, companyId, identifier: `${prefix}-1`, issueNumber: 1, title: "Parent with no active dependency path",
          status: "in_progress", assigneeAgentId: agentId, createdAt: old, updatedAt: old },
        { id: childId, companyId, identifier: `${prefix}-2`, issueNumber: 2, title: "Unassigned required dependency",
          status: "todo", createdAt: old, updatedAt: old },
      ]);
      await db.insert(issueRelations).values({ companyId, issueId: childId, relatedIssueId: parentId, type: "blocks" });

      const crash = await controller.exited;
      expect(crash.signal, controller.output).toBe("SIGKILL");
      expect(await readFile(receipt, "utf8")).toContain(crashPoint);
      const claim = await waitFor(async () => {
        const [row] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
          eq(activityLog.entityId, parentId), eq(activityLog.action, "issue.dependency_diagnosis.requested")));
        return row ?? null;
      }, row => (row.details as Record<string, unknown>).outcome === "pending", "The controller did not persist the diagnosis claim");

      const diagnosisKey = String((claim.details as Record<string, unknown>).idempotencyKey);
      expect(diagnosisKey).toMatch(/^issue_blocker_stalled:diagnosis:[a-f0-9]{64}$/);
      const receiptFilter = and(eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, diagnosisKey));
      expect(await db.select().from(agentWakeupRequests).where(receiptFilter)).toHaveLength(0);

      let eligibleParentId: string | null = null;
      if (ownership === "reassigned to board") {
        // Reassign through the production task PATCH route while the old worker
        // is dead, then send that old actor's late completion through the same
        // route. The human owner remains durable and the old agent is refused.
        const boardApi = issueActorApi(db, { type: "board", userId: "local-board", companyIds: [companyId],
          isInstanceAdmin: true, source: "local_implicit" });
        const reassigned = await request(boardApi).patch(`/api/issues/${parentId}`).send({ assigneeAgentId: null, assigneeUserId: "local-board" });
        expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
        const afterReassignment = (await db.select().from(issues).where(eq(issues.id, parentId)))[0];
        expect(afterReassignment).toMatchObject({ status: "in_progress", assigneeAgentId: null, assigneeUserId: "local-board" });

        const staleAgentApi = issueActorApi(db, { type: "agent", agentId, companyId, source: "agent_jwt" });
        const staleCompletion = await request(staleAgentApi).patch(`/api/issues/${parentId}`).send({ status: "done" });
        expect(staleCompletion.status, JSON.stringify(staleCompletion.body)).toBe(403);
        expect((await db.select().from(issues).where(eq(issues.id, parentId)))[0]).toMatchObject({
          status: "in_progress", assigneeAgentId: null, assigneeUserId: "local-board",
        });

        // A second parent gives the test a positive signal that the restarted
        // controller ran its diagnosis sweep.
        const eligibleAgentId = randomUUID();
        eligibleParentId = randomUUID();
        await db.insert(agents).values({ id: eligibleAgentId, companyId, name: "Eligible fixture", role: "engineer",
          status: "idle", lifecycleState: "ready", adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", "console.log('eligible diagnosis')"], cwd: process.cwd() },
          runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } }, permissions: {} });
        await db.insert(issues).values({ id: eligibleParentId, companyId, identifier: `${prefix}-3`, issueNumber: 3,
          title: "Other eligible parent", status: "in_progress", assigneeAgentId: eligibleAgentId, createdAt: old, updatedAt: old });
        await db.insert(issueRelations).values({ companyId, issueId: childId, relatedIssueId: eligibleParentId, type: "blocks" });
      }

      // Reuse the same config, PostgreSQL proxy, database and runtime control
      // file. Startup recovery must respect the task's current owner.
      await writeFile(control, "");
      restarted = await startController({ home, config, port, databaseUrl: proxy.url, crashControl: control, crashReceipt: receipt });
      if (eligibleParentId) {
        await waitFor(async () => {
          const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
          return rows.find(row => (row.payload as Record<string, unknown>).issueId === eligibleParentId) ?? null;
        }, row => row.reason === "issue_blocker_stalled", "The restarted controller did not diagnose the eligible parent");
        expect(await db.select().from(agentWakeupRequests).where(receiptFilter)).toHaveLength(0);
        const diagnostics = await restarted.api<{ events: Array<{ kind: string; reason?: string }> }>(
          "GET", `/issues/${parentId}/diagnostics/wakes`);
        expect(diagnostics.events.some(event => event.kind === "wake_request" && event.reason === "issue_blocker_stalled")).toBe(false);
        expect((await db.select().from(issues).where(eq(issues.id, parentId)))[0]).toMatchObject({
          status: "in_progress", assigneeAgentId: null, assigneeUserId: "local-board",
        });
        await expect(access(effectFile)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      const wake = await waitFor(async () => {
        const [row] = await db.select().from(agentWakeupRequests).where(receiptFilter);
        return row ?? null;
      }, row => ["completed", "failed", "skipped", "cancelled"].includes(row.status),
      "Controller restart did not settle its diagnosis wake");
      expect(await db.select().from(agentWakeupRequests).where(receiptFilter)).toHaveLength(1);
      expect(wake).toMatchObject({ reason: "issue_blocker_stalled", requestedByActorType: "system",
        status: "completed", payload: { issueId: parentId } });
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.wakeupRequestId, wake.id)));
      expect(run).toMatchObject({ status: "succeeded",
        contextSnapshot: { issueId: parentId, dependencyDiagnosis: true, dependencyDiagnosisKey: diagnosisKey } });
      expect(await readFile(effectFile, "utf8")).toBe("invoked");

      // Verify the restarted controller's real HTTP route sees the durable
      // recovery state through ordinary loopback board access.
      const diagnostics = await restarted.api<{ events: Array<{ kind: string; reason?: string; status?: string }> }>(
        "GET", `/issues/${parentId}/diagnostics/wakes`);
      expect(diagnostics.events).toContainEqual(expect.objectContaining({ kind: "wake_request", reason: "issue_blocker_stalled", status: "completed" }));
    } finally {
      if (restarted) await restarted.stop().catch(() => {});
      if (controller && controller.child.exitCode === null && controller.child.signalCode === null) {
        controller.child.kill("SIGKILL");
        await controller.exited;
      }
      await proxy.stop();
      await db.$client.end({ timeout: 0 });
      await database.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 2);
});
