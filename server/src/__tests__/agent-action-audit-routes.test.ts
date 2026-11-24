import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  caseAccessSources,
  caseEvents,
  cases,
  closeRegisteredClients,
  companies,
  companyMemberships,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  managedAuditEvents,
  managedAuditExports,
  principalPermissionGrants,
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@groktopus/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { readManagedAuditExportPage } from "../services/managed-audit-export.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;
let activityRoutes: typeof import("../routes/activity.js").activityRoutes;

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", activityRoutes(db));
  app.use(errorHandler);
  return app;
}

describePostgres("agent action audit routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    ({ activityRoutes } = await import("../routes/activity.js"));
    tempDb = await startEmbeddedPostgresTestDatabase("proprio-agent-action-audit-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(managedAuditExports);
    await db.delete(managedAuditEvents);
    await db.delete(caseEvents);
    await db.delete(cases);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed(database: Db = db) {
    const db = database;
    const company = await db.insert(companies).values({
      name: "Audit Company",
      issuePrefix: `AU${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [agent, otherAgent] = await db.insert(agents).values([1, 2].map((index) => ({
      companyId: company.id,
      name: `Audit Agent ${index}`,
      role: "engineer",
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }))).returning();
    const issue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Audit target",
      status: "todo",
      priority: "medium",
    }).returning().then((rows) => rows[0]!);
    const comment = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorAgentId: agent.id,
      body: "A useful comment excerpt for the audit feed.",
    }).returning().then((rows) => rows[0]!);
    const document = await db.insert(documents).values({
      companyId: company.id,
      title: "Plan",
      latestBody: "Plan body",
      createdByAgentId: agent.id,
      updatedByAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    const issueDocument = await db.insert(issueDocuments).values({
      companyId: company.id,
      issueId: issue.id,
      documentId: document.id,
      key: "plan",
    }).returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      responsibleUserId: "legacy-user",
    }).returning().then((rows) => rows[0]!);
    const base = new Date("2026-07-17T00:00:00.000Z");
    await db.insert(activityLog).values([
      { companyId: company.id, actorType: "agent", actorId: agent.id, action: "issue.comment.created", entityType: "issue_comment", entityId: comment.id, agentId: agent.id, runId: run.id, responsibleUserId: null, createdAt: new Date(base.getTime() + 3000) },
      { companyId: company.id, actorType: "system", actorId: "system", action: "issue.document.updated", entityType: "issue_document", entityId: issueDocument.id, agentId: agent.id, runId: run.id, responsibleUserId: "direct-user", createdAt: new Date(base.getTime() + 2000) },
      { companyId: company.id, actorType: "agent", actorId: otherAgent.id, action: "issue.updated", entityType: "issue", entityId: issue.id, agentId: otherAgent.id, responsibleUserId: "other-user", createdAt: new Date(base.getTime() + 1000) },
    ]);
    return { company, agent, otherAgent, issue, comment, issueDocument, run };
  }

  it("exports a frozen managed audit window beyond the CSV cap and detects known missing bindings", async () => {
    const { company, agent } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const anon = request(await createApp(db, { type: "none", source: "none" }));
    const epoch = randomUUID().toUpperCase();
    const at = new Date("2026-07-17T00:00:01.000Z");
    const baseEvent = {
      companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
      occurredAt: at, eventType: "invocation_decision_recorded", phase: "policy_decision",
      decision: "allow", status: "authorized",
    };
    const eventRows = Array.from({ length: 10_037 }, () => ({ ...baseEvent, id: randomUUID(), invocationId: randomUUID() }));
    for (let index = 0; index < eventRows.length; index += 1_000) {
      await db.insert(managedAuditEvents).values(eventRows.slice(index, index + 1_000));
    }
    const [privateTask] = await db.insert(issues).values({
      companyId: company.id, title: "Private export fixture", visibility: "private", responsibleUserId: randomUUID(),
    }).returning();
    const [privateRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, issueId: privateTask.id, status: "succeeded",
    }).returning();
    const [otherCompany] = await db.insert(companies).values({ name: "Other company", issuePrefix: "AUDITX" }).returning();
    await db.insert(managedAuditEvents).values([
      { ...baseEvent, taskId: privateTask.id, invocationId: randomUUID() },
      { ...baseEvent, runId: privateRun.id, invocationId: randomUUID() },
      { ...baseEvent, companyId: otherCompany.id, invocationId: randomUUID() },
    ]);

    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      expect((await anon.post(path).send(window)).status).toBe(403);
      expect(await db.select().from(managedAuditExports)).toHaveLength(0);
      expect((await board.post(path).send({ ...window, from: "2026-07-16T00:00:00Z" })).body)
        .toMatchObject({ details: { reasonCode: "unsupported_interval" } });
      expect((await board.post(path).send({ ...window, from: "2026-07-17T00:00:00.000900Z" })).status).toBe(400);
      expect((await board.post(path).send({ ...window, to: "2026-07-17T00:00:02.000900Z" })).status).toBe(400);
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", "2026-07-17T00:00:00.000900Z");
      expect((await board.post(path).send(window)).status).toBe(403);
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
      const [deletedRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id }).returning();
      await db.insert(managedAuditEvents).values({ ...baseEvent, runId: deletedRun.id, invocationId: randomUUID() });
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, deletedRun.id));
      const orphaned = await board.post(path).send(window);
      expect(orphaned.status, orphaned.text).toBe(409);
      expect(orphaned.body).toMatchObject({ details: { reasonCode: "snapshot_incomplete" } });
      expect(await db.select().from(managedAuditExports)).toHaveLength(0);
      expect((await db.select().from(activityLog)).filter(row => row.action === "audit.managed_export_created")).toHaveLength(0);
      await db.delete(managedAuditEvents).where(eq(managedAuditEvents.runId, deletedRun.id));
      const receipt = await board.post(path).send(window);
      expect(receipt.status, receipt.text).toBe(201);
      expect(receipt.body).toMatchObject({ eventCount: eventRows.length, sourceEpoch: epoch.toLowerCase() });
      const exportAudit = (await db.select().from(activityLog)).filter(row => row.action === "audit.managed_export_created");
      expect(exportAudit).toHaveLength(1);
      expect(exportAudit[0]).toMatchObject({ companyId: company.id, actorType: "user", actorId: userId, entityType: "company", entityId: company.id, details: { exportId: receipt.body.exportId } });
      const exportPath = `${path}/${receipt.body.exportId}`;
      await db.insert(managedAuditEvents).values({ ...baseEvent, invocationId: randomUUID() });
      const first = await board.get(exportPath);
      expect(first.status, first.text).toBe(200);
      expect(first.body).toMatchObject({ deliveredThrough: 200, complete: false, nextCursor: expect.any(String) });
      expect((await board.get(exportPath)).body).toEqual(first.body);
      expect((await board.get(exportPath).query({ cursor: "10036." + "a".repeat(64) })).status).toBe(409);

      const archived = first.body.events.map((event: { id: string }) => event.id);
      let page = first.body;
      while (page.nextCursor) {
        const resumed = await board.get(exportPath).query({ cursor: page.nextCursor });
        expect(resumed.status, resumed.text).toBe(200);
        page = resumed.body;
        archived.push(...page.events.map((event: { id: string }) => event.id));
      }
      const expectedIds = eventRows.map(event => event.id).sort();
      expect(archived).toEqual(expectedIds);
      expect(page).toMatchObject({ complete: true, deliveredThrough: expectedIds.length });
      expect(createHash("sha256").update(JSON.stringify(archived)).digest("hex")).toBe(receipt.body.watermark);

      await db.delete(managedAuditEvents).where(eq(managedAuditEvents.id, expectedIds[0]));
      expect((await board.get(exportPath)).body).toMatchObject({ details: { reasonCode: "snapshot_incomplete" } });
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
      expect((await board.get(exportPath)).body).toMatchObject({ details: { reasonCode: "source_epoch_changed" } });
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
      await expect(readManagedAuditExportPage(db, {
        companyId: company.id, sourceEpoch: epoch.toLowerCase(),
        actor: { type: "board", source: "session", userId, companyIds: [company.id] },
      }, receipt.body.exportId)).rejects.toMatchObject({ status: 403 });
      expect((await board.get(exportPath)).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 45_000);

  it("invalidates a frozen audit export when evidence on another page loses visibility", async () => {
    const { company, agent, issue } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const event = {
      companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
      occurredAt: new Date("2026-07-17T00:00:01.000Z"), eventType: "invocation_decision_recorded",
      phase: "policy_decision", decision: "allow", status: "authorized",
    };
    const privateCandidateId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insert(managedAuditEvents).values([
      ...Array.from({ length: 200 }, (_, i) => ({
        ...event, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, invocationId: randomUUID(),
      })),
      { ...event, id: privateCandidateId, taskId: issue.id, invocationId: randomUUID() },
    ]);

    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      const created = await board.post(path).send(window).expect(201);
      expect(created.body.eventCount).toBe(201);
      const exportPath = `${path}/${created.body.exportId}`;
      const first = await board.get(exportPath).expect(200);
      const second = await board.get(exportPath).query({ cursor: first.body.nextCursor }).expect(200);
      expect(second.body.events).toMatchObject([{ id: privateCandidateId }]);

      await db.update(issues).set({ visibility: "private", responsibleUserId: randomUUID() }).where(eq(issues.id, issue.id));
      const replay = await board.get(exportPath).expect(409);
      expect(replay.body).toMatchObject({ details: { reasonCode: "snapshot_incomplete" } });
      expect(replay.body).not.toHaveProperty("eventCount");
      expect(replay.body).not.toHaveProperty("watermark");
      expect(replay.body).not.toHaveProperty("events");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retains archive bytes and checkpoints outside an older restore and rotates the source epoch", async ({ skip }) => {
    const oldEpoch = randomUUID();
    const newEpoch = randomUUID();
    const from = "2026-07-17T00:00:00.000Z";
    const to = "2026-07-17T00:00:02.000Z";
    const olderFrom = "2026-07-16T00:00:00.000Z";
    const tempDir = await mkdtemp(join(tmpdir(), "managed-audit-restore-"));
    let targetUrl: string | null = null;
    let targetName: string | null = null;
    let adminUrl: string | null = null;
    let dedicatedFixture: typeof tempDb = null;
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", oldEpoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", olderFrom);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      try {
        await db.$client.begin(tx => tx`SET LOCAL session_replication_role = replica`);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "42501") throw error;
        // A CREATEDB-only external fixture supports the route suite, but cannot
        // replay the JavaScript backup's session replication setting.
        vi.stubEnv("PROPRIO_TEST_POSTGRES_ADMIN_URL", undefined);
        const embeddedSupport = await getEmbeddedPostgresTestSupport();
        if (!embeddedSupport.supported) skip(embeddedSupport.reason);
        dedicatedFixture = await startEmbeddedPostgresTestDatabase("proprio-agent-audit-restore-");
      }
      const sourceFixture = dedicatedFixture ?? tempDb!;
      const sourceDb = dedicatedFixture ? createDb(sourceFixture.connectionString) : db;
      const { company, agent } = await seed(sourceDb);
      const userId = randomUUID();
      await sourceDb.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
      });
      await sourceDb.insert(principalPermissionGrants).values({
        companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
      });
      const actor = { type: "board" as const, source: "session" as const, userId, companyIds: [company.id] };
      const board = request(await createApp(sourceDb, actor));
      const rows = Array.from({ length: 205 }, () => ({
        companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
        occurredAt: new Date("2026-07-17T00:00:01.000Z"), eventType: "invocation_decision_recorded",
        phase: "policy_decision", decision: "allow", status: "authorized", invocationId: randomUUID(),
      }));
      await sourceDb.insert(managedAuditEvents).values(rows);
      const [privateTask] = await sourceDb.insert(issues).values({
        companyId: company.id, title: "Restricted retained evidence", visibility: "private", responsibleUserId: randomUUID(),
      }).returning();
      const [restricted] = await sourceDb.insert(managedAuditEvents).values({
        companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
        occurredAt: new Date("2026-07-17T00:00:01.000Z"), eventType: "invocation_decision_recorded",
        phase: "policy_decision", decision: "allow", status: "authorized", invocationId: randomUUID(), taskId: privateTask.id,
      }).returning();

      const path = `/api/companies/${company.id}/audit/managed-exports`;
      const window = { from, to };
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", "2026-07-17T00:00:00.000001Z");
      const imprecise = await board.post(path).send(window);
      expect(imprecise.status).toBe(403);
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", from);
      const created = await board.post(path).send(window);
      expect(created.status, created.text).toBe(201);
      expect(created.body.eventCount).toBe(rows.length);
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
      const exportPath = `${path}/${created.body.exportId}`;
      const first = await board.get(exportPath);
      expect(first.status, first.text).toBe(200);
      expect(first.body).toMatchObject({ deliveredThrough: 200, complete: false, nextCursor: expect.any(String) });
      expect(first.body.events.some((event: { id: string }) => event.id === restricted.id)).toBe(false);

      // These files are the independently retained archive page and resume checkpoint.
      const archiveFile = join(tempDir, "managed-audit-pages.jsonl");
      const checkpointFile = join(tempDir, "managed-audit-checkpoint.json");
      await writeFile(archiveFile, `${first.text}\n`);
      await writeFile(checkpointFile, JSON.stringify({
        exportId: created.body.exportId, sourceEpoch: oldEpoch, cursor: first.body.nextCursor,
        watermark: created.body.watermark, eventCount: created.body.eventCount,
      }));

      const [olderEvent] = await sourceDb.insert(managedAuditEvents).values({
        ...rows[0]!, invocationId: randomUUID(), occurredAt: new Date(olderFrom),
      }).returning();
      const olderReceipt = await board.post(path).send({ from: olderFrom, to: from });
      expect(olderReceipt.status).toBe(201);
      expect((await board.get(`${path}/${olderReceipt.body.exportId}`)).body.events)
        .toMatchObject([expect.objectContaining({ id: olderEvent.id })]);

      const expired = await board.post(path).send(window);
      expect(expired.status).toBe(201);
      await sourceDb.update(managedAuditExports).set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(managedAuditExports.id, expired.body.exportId));
      expect((await board.get(`${path}/${expired.body.exportId}`)).body)
        .toMatchObject({ details: { reasonCode: "snapshot_expired" } });

      const backup = await runDatabaseBackup({
        connectionString: sourceFixture.connectionString,
        backupDir: tempDir,
        backupEngine: "javascript",
        retention: { dailyDays: 1, weeklyWeeks: 0, monthlyMonths: 0 },
      });

      const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8")) as {
        cursor: string; exportId: string; eventCount: number; sourceEpoch: string; watermark: string;
      };
      const checkpointPath = `${path}/${checkpoint.exportId}`;
      const second = await board.get(checkpointPath).query({ cursor: checkpoint.cursor });
      expect(second.status, second.text).toBe(200);
      expect(second.body).toMatchObject({
        deliveredThrough: checkpoint.eventCount, complete: true, nextCursor: null,
        sourceEpoch: checkpoint.sourceEpoch, watermark: checkpoint.watermark,
      });
      await appendFile(archiveFile, `${second.text}\n`);
      const archivedBytes = await readFile(archiveFile);
      const archivedPages = archivedBytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
      const archivedEvents = archivedPages.flatMap(page => page.events as Array<{ id: string }>);
      const archivedIds = archivedEvents.map(event => event.id).sort();
      expect(archivedIds).toHaveLength(checkpoint.eventCount);
      expect(new Set(archivedIds).size).toBe(checkpoint.eventCount);
      expect(createHash("sha256").update(JSON.stringify(archivedIds)).digest("hex")).toBe(checkpoint.watermark);

      // A missing row is an explicit incomplete checkpoint, never a fresh complete page.
      const missingId = second.body.events[0].id as string;
      await sourceDb.delete(managedAuditEvents).where(eq(managedAuditEvents.id, missingId));
      const incomplete = await board.get(checkpointPath).query({ cursor: checkpoint.cursor });
      expect(incomplete.status).toBe(409);
      expect(incomplete.body).toMatchObject({ details: { reasonCode: "snapshot_incomplete" } });

      const source = new URL(sourceFixture.connectionString);
      const admin = new URL(sourceFixture.connectionString);
      admin.pathname = "/postgres";
      adminUrl = admin.toString();
      targetName = `audit_restore_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      expect(await ensurePostgresDatabase(adminUrl, targetName)).toBe("created");
      source.pathname = `/${targetName}`;
      targetUrl = source.toString();
      await runDatabaseRestore({ connectionString: targetUrl, backupFile: backup.backupFile });

      vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", newEpoch);
      const restoredDb = createDb(targetUrl);
      const restoredBoard = request(await createApp(restoredDb, actor));
      const restoredCheckpoint = JSON.parse(await readFile(checkpointFile, "utf8")) as { cursor: string; exportId: string };
      const stale = await restoredBoard.get(`${path}/${restoredCheckpoint.exportId}`).query({ cursor: restoredCheckpoint.cursor });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ details: { reasonCode: "source_epoch_changed" } });

      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", from);
      const beyondRetention = await restoredBoard.post(path).send({ from: olderFrom, to });
      expect(beyondRetention.status).toBe(409);
      expect(beyondRetention.body).toMatchObject({ details: { reasonCode: "retention_window_expired" } });

      const fresh = await restoredBoard.post(path).send(window);
      expect(fresh.status, fresh.text).toBe(201);
      expect(fresh.body).toMatchObject({ sourceEpoch: newEpoch, eventCount: rows.length });
      const restoredPage = await restoredBoard.get(`${path}/${fresh.body.exportId}`);
      expect(restoredPage.body).toMatchObject({ complete: false });
      expect(restoredPage.body.events.some((event: { id: string }) =>
        event.id === olderEvent.id || event.id === restricted.id)).toBe(false);
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", "2026-07-17T00:00:00.000001Z");
      const impreciseResume = await restoredBoard.get(`${path}/${fresh.body.exportId}`)
        .query({ cursor: restoredPage.body.nextCursor });
      expect(impreciseResume.status).toBe(403);
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", to);
      const shortened = await restoredBoard.get(`${path}/${fresh.body.exportId}`).query({ cursor: restoredPage.body.nextCursor });
      expect(shortened.status).toBe(409);
      expect(shortened.body).toMatchObject({ details: { reasonCode: "retention_window_expired" } });
      expect((await restoredBoard.get(`${path}/${expired.body.exportId}`)).status).toBe(404);

      expect(await readFile(archiveFile)).toEqual(archivedBytes);
      expect(archivedIds).toContain(missingId);
    } finally {
      vi.unstubAllEnvs();
      try {
        if (targetUrl) await closeRegisteredClients(targetUrl, { scope: "database" });
        if (targetName && adminUrl) {
          const admin = createDb(adminUrl);
          try { await admin.$client`DROP DATABASE ${admin.$client(targetName)}`; }
          finally { await closeRegisteredClients(adminUrl, { scope: "database" }); }
        }
      } finally {
        try { await dedicatedFixture?.cleanup(); }
        finally { await rm(tempDir, { recursive: true, force: true }); }
      }
    }
  }, 90_000);

  async function seedActorOnlyRows(companyId: string) {
    return db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: "board-user",
        action: "company.updated",
        entityType: "company",
        entityId: companyId,
        responsibleUserId: "sensitive-responsible-user",
        details: { changed: "name" },
        createdAt: new Date("2026-07-17T00:00:06.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "scheduler",
        action: "heartbeat.scheduled",
        entityType: "company",
        entityId: companyId,
        details: { schedule: "private-schedule" },
        createdAt: new Date("2026-07-17T00:00:05.000Z"),
      },
      {
        companyId,
        actorType: "plugin",
        actorId: "example-plugin",
        action: "plugin.synced",
        entityType: "company",
        entityId: companyId,
        details: { pluginConfig: "private-config" },
        createdAt: new Date("2026-07-17T00:00:04.000Z"),
      },
    ]).returning();
  }

  it("keeps agent audit reads, filters and CSV exports closed to commentary-only viewers", async () => {
    const { company } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "viewer", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "commentary:view",
    });
    const app = await createApp(db, { type: "board", userId, companyIds: [company.id], source: "session" });
    const url = `/api/companies/${company.id}/audit/agent-actions`;
    for (const path of [url, `${url}?actorScope=all&action=issue`, `${url}.csv`]) {
      expect((await request(app).get(path).expect(403)).body.error).toContain("audit:view_agent_actions");
    }
    expect((await request(app).get(`${url}?actorScope=all`).expect(200)).body.accessTier).toBe("basic");
  });

  it("denies agents and board users without the audit permission", async () => {
    const { company, agent } = await seed();
    const agentResponse = await request(await createApp(db, {
      type: "agent", agentId: agent.id, companyId: company.id, source: "agent_jwt",
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(agentResponse.status).toBe(403);

    const agentAllActorsResponse = await request(await createApp(db, {
      type: "agent", agentId: agent.id, companyId: company.id, source: "agent_jwt",
    })).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all`);
    expect(agentAllActorsResponse.status, JSON.stringify(agentAllActorsResponse.body)).toBe(200);
    expect(agentAllActorsResponse.body.items).toHaveLength(3);
    expect(agentAllActorsResponse.body.items.every((item: { responsibleUserId: string | null }) => (
      item.responsibleUserId === null
    ))).toBe(true);

    const boardResponse = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(boardResponse.status).toBe(403);
    expect(boardResponse.body.error).toContain("audit:view_agent_actions");

    const invalidBoardResponse = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?limit=invalid`);
    expect(invalidBoardResponse.status).toBe(403);
    expect(invalidBoardResponse.body.error).toContain("audit:view_agent_actions");
  }, 30_000);

  it("lets a company member read basic all-actor rows without attribution", async () => {
    const { company } = await seed();
    await seedActorOnlyRows(company.id);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "reader",
      status: "active",
      membershipRole: "viewer",
    });
    const app = await createApp(db, {
      type: "board",
      userId: "reader",
      companyIds: [company.id],
      source: "session",
      isInstanceAdmin: false,
    });

    const items: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const response = await request(app)
        .get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&limit=2${cursorQuery}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      items.push(...response.body.items);
      expect(response.body.accessTier).toBe("basic");
      cursor = response.body.nextCursor;
    } while (cursor);

    expect(items).toHaveLength(6);
    expect(new Set(items.map((item) => item.actorType))).toEqual(
      new Set(["agent", "user", "system", "plugin"]),
    );
    for (const item of items) {
      expect(item).toMatchObject({
        agentId: null,
        runId: null,
        responsibleUserId: null,
        details: null,
      });
      expect(item).toEqual(expect.objectContaining({
        actorType: expect.any(String),
        actorId: expect.any(String),
        action: expect.any(String),
        entityType: expect.any(String),
        entityId: expect.any(String),
        createdAt: expect.any(String),
      }));
    }
  });

  it("rejects the full filter set for a basic all-actors reader", async () => {
    const { company, agent, issue, run } = await seed();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "reader",
      status: "active",
      membershipRole: "viewer",
    });
    const app = await createApp(db, {
      type: "board",
      userId: "reader",
      companyIds: [company.id],
      source: "session",
      isInstanceAdmin: false,
    });
    const filters = [
      `agentId=${agent.id}`,
      "responsibleUserId=legacy-user",
      `runId=${run.id}`,
      "entityType=issue",
      `entityId=${issue.id}`,
      "action=issue.",
      "actorType=agent",
      "from=2026-07-17T00%3A00%3A00.000Z",
      "to=2026-07-18T00%3A00%3A00.000Z",
    ];

    for (const filter of filters) {
      const response = await request(app).get(
        `/api/companies/${company.id}/audit/agent-actions?actorScope=all&${filter}`,
      );
      expect(response.status, filter).toBe(403);
      expect(response.body.error).toContain("audit:view_agent_actions");
    }
  });

  it("merges historical case changes into filtered audit before privacy and cursor pagination", async () => {
    const { company, agent, issue } = await seed();
    await db.update(issues).set({ visibility: "private", assigneeAgentId: agent.id }).where(eq(issues.id, issue.id));
    const [openCase, privateCase] = await db.insert(cases).values([
      { companyId: company.id, caseNumber: 1, identifier: `${company.issuePrefix}-C1`, caseType: "receipt", title: "Morning coffee" },
      { companyId: company.id, caseNumber: 2, identifier: `${company.issuePrefix}-C2`, caseType: "receipt", title: "Private receipt" },
    ]).returning();
    await db.insert(caseAccessSources).values({ companyId: company.id, caseId: privateCase.id, sourceKind: "issue", sourceId: issue.id });
    const events = await db.insert(caseEvents).values([
      { companyId: company.id, caseId: openCase.id, kind: "created", actorType: "agent", actorAgentId: agent.id, createdAt: new Date("2030-01-01") },
      { companyId: company.id, caseId: openCase.id, kind: "fields_changed", actorType: "agent", actorAgentId: agent.id, createdAt: new Date("2030-01-02") },
      { companyId: company.id, caseId: openCase.id, kind: "handoff_delivered", actorType: "agent", actorAgentId: agent.id, createdAt: new Date("2030-01-03") },
      { companyId: company.id, caseId: privateCase.id, kind: "fields_changed", actorType: "agent", actorAgentId: agent.id, payload: { secret: "hidden" }, createdAt: new Date("2030-01-04") },
    ]).returning();
    const [mirroredHandoff] = await db.insert(activityLog).values({ companyId: company.id, actorType: "agent", actorId: agent.id, agentId: agent.id,
      action: "case.handoff_delivered", entityType: "case", entityId: openCase.id, createdAt: new Date("2030-01-03") }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "reader", status: "active", membershipRole: "viewer" });
    const app = await createApp(db, { type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false });
    const items: Array<{ id: string; entityId: string; agentId: string | null; details: unknown; entity: unknown }> = [];
    let cursor: string | null = null;
    do {
      const response = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&entityType=case&action=case.&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.accessTier).toBe("basic");
      items.push(...response.body.items);
      cursor = response.body.nextCursor;
    } while (cursor);
    expect(items.map(item => item.id)).toEqual([mirroredHandoff.id, events[1].id, events[0].id]);
    expect(items.every(item => item.entityId === openCase.id && item.agentId === null && item.details === null)).toBe(true);
    expect(items[0].entity).toMatchObject({ case: { id: openCase.id, identifier: openCase.identifier, title: "Morning coffee" } });
    const scoped = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&entityType=case&entityId=${openCase.id}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.items.map((item: { id: string }) => item.id)).toEqual(items.map(item => item.id));
    const byIdentifier = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&entityType=case&entityId=${openCase.identifier.toLowerCase()}`);
    expect(byIdentifier.status).toBe(200);
    expect(byIdentifier.body.items.map((item: { id: string }) => item.id)).toEqual(items.map(item => item.id));
    const hidden = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&entityType=case&entityId=${privateCase.id}`);
    expect(hidden.status).toBe(200);
    expect(hidden.body).toMatchObject({ items: [], nextCursor: null });
    await request(app).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all&entityType=case&agentId=${agent.id}`).expect(403);
  });

  it("keeps the default scope unchanged and gives permitted readers the full all-actors view", async () => {
    const { company } = await seed();
    const actorOnlyRows = await seedActorOnlyRows(company.id);
    const app = await createApp(db, {
      type: "board",
      userId: "local-board",
      companyIds: [company.id],
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    const defaultResponse = await request(app)
      .get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(defaultResponse.status, JSON.stringify(defaultResponse.body)).toBe(200);
    expect(defaultResponse.body.items).toHaveLength(3);
    expect(defaultResponse.body.items.map((item: { id: string }) => item.id)).not.toContain(actorOnlyRows[0]!.id);

    const allResponse = await request(app)
      .get(`/api/companies/${company.id}/audit/agent-actions?actorScope=all`);
    expect(allResponse.status, JSON.stringify(allResponse.body)).toBe(200);
    expect(defaultResponse.body.accessTier).toBe("full");
    expect(allResponse.body.accessTier).toBe("full");
    expect(allResponse.body.items).toHaveLength(6);
    expect(allResponse.body.items.find((item: { id: string }) => item.id === actorOnlyRows[0]!.id)).toMatchObject({
      responsibleUserId: "sensitive-responsible-user",
      details: { changed: "name" },
    });
  });

  it("returns a client error for invalid audit query parameters", async () => {
    const { company } = await seed();
    const response = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?limit=invalid`);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid agent action audit query");

    const scopeResponse = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?actorScope=unknown`);
    expect(scopeResponse.status).toBe(400);
    expect(scopeResponse.body.error).toBe("Invalid agent action audit query");

    const cursorResponse = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?cursor=invalid`);
    expect(cursorResponse.status).toBe(400);
    expect(cursorResponse.body.error).toBe("Invalid audit cursor");

    const nonUuidCursor = Buffer.from(JSON.stringify({
      createdAt: "2026-07-17T00:00:00.000000Z",
      id: "not-a-uuid",
    }), "utf8").toString("base64url");
    const nonUuidCursorResponse = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions?cursor=${encodeURIComponent(nonUuidCursor)}`);
    expect(nonUuidCursorResponse.status).toBe(400);
    expect(nonUuidCursorResponse.body.error).toBe("Invalid audit cursor");
  });

  it("preserves sub-millisecond cursor precision across pages", async () => {
    const { company, agent } = await seed();
    await db.delete(activityLog);
    const newerId = randomUUID();
    const olderId = randomUUID();
    await db.execute(sql`
      insert into activity_log (
        id, company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, created_at
      ) values
        (${newerId}::uuid, ${company.id}::uuid, 'agent', ${agent.id}, 'audit.precision', 'company', ${company.id}, ${agent.id}::uuid, '2026-07-17T00:00:00.001900Z'::timestamptz),
        (${olderId}::uuid, ${company.id}::uuid, 'agent', ${agent.id}, 'audit.precision', 'company', ${company.id}, ${agent.id}::uuid, '2026-07-17T00:00:00.001100Z'::timestamptz)
    `);

    const app = await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    });
    const first = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?action=audit.precision&limit=1`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual([newerId]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app).get(
      `/api/companies/${company.id}/audit/agent-actions?action=audit.precision&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([olderId]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("paginates, filters, enriches entities, and falls back to the run responsible user", async () => {
    const { company, agent, otherAgent, issue, comment, issueDocument, run } = await seed();
    const app = await createApp(db, { type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false });
    const first = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?limit=1`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0].responsibleUserId).toBe("legacy-user");
    expect(first.body.items[0].entity.comment).toEqual({ id: comment.id, excerpt: "A useful comment excerpt for the audit feed." });
    expect(first.body.items[0].entity.issue).toMatchObject({ id: issue.id, identifier: issue.identifier, title: issue.title });
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items[0].entity.document).toEqual({ id: expect.any(String), key: "plan" });

    const cases = [
      [`agentId=${agent.id}`, 2],
      ["responsibleUserId=legacy-user", 1],
      [`runId=${run.id}`, 2],
      ["entityType=issue_document", 1],
      [`entityId=${issueDocument.id}`, 1],
      ["action=issue.comment", 1],
      ["actorType=system", 1],
      ["from=2026-07-17T00%3A00%3A01.500Z&to=2026-07-17T00%3A00%3A02.500Z", 1],
      [`agentId=${otherAgent.id}`, 1],
    ] as const;
    for (const [query, count] of cases) {
      const response = await request(app).get(`/api/companies/${company.id}/audit/agent-actions?${query}`);
      expect(response.status, `${query}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(response.body.items, query).toHaveLength(count);
    }
  });

  it("does not enrich hidden issues or mismatched entity types", async () => {
    const { company, agent, comment, run } = await seed();
    const hiddenIssue = await db.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-HIDDEN`,
      title: "Hidden audit target",
      status: "todo",
      priority: "medium",
      hiddenAt: new Date(),
    }).returning().then((rows) => rows[0]!);
    const hiddenComment = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: hiddenIssue.id,
      authorAgentId: agent.id,
      body: "Hidden audit comment",
    }).returning().then((rows) => rows[0]!);
    const [hiddenActivity, hiddenDocumentActivity, mismatchedActivity] = await db.insert(activityLog).values([
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "issue.comment.created",
        entityType: "issue",
        entityId: hiddenIssue.id,
        agentId: agent.id,
        runId: run.id,
        details: {
          commentId: hiddenComment.id,
          bodySnippet: hiddenComment.body,
          identifier: hiddenIssue.identifier,
          issueTitle: hiddenIssue.title,
        },
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "issue.document_updated",
        entityType: "issue",
        entityId: hiddenIssue.id,
        agentId: agent.id,
        runId: run.id,
        details: {
          documentId: randomUUID(),
          key: "plan",
          title: "Hidden document title",
        },
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: agent.id,
        action: "company.updated",
        entityType: "company",
        entityId: comment.id,
        agentId: agent.id,
        runId: run.id,
      },
    ]).returning();

    const response = await request(await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items.find((item: { id: string }) => item.id === hiddenActivity.id)?.entity).toEqual({
      issue: null,
      comment: null,
      document: null,
    });
    expect(response.body.items.find((item: { id: string }) => item.id === hiddenActivity.id)?.details).toBeNull();
    expect(response.body.items.find((item: { id: string }) => item.id === hiddenDocumentActivity.id)?.details).toBeNull();
    expect(response.body.items.find((item: { id: string }) => item.id === mismatchedActivity.id)?.entity).toEqual({
      issue: null,
      comment: null,
      document: null,
    });
  });

  it("exports the audit feed as CSV and logs the export action", async () => {
    const { company, issue, comment } = await seed();
    await db.update(issues).set({ title: "=2+2" }).where(eq(issues.id, issue.id));
    await db.update(issueComments).set({ body: "@SUM(A1)" }).where(eq(issueComments.id, comment.id));
    const app = await createApp(db, {
      type: "board", userId: "local-board", companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false,
    });
    const response = await request(app).get(`/api/companies/${company.id}/audit/agent-actions.csv`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain(`agent-audit-${company.id}.csv`);

    const lines = response.text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "createdAt,action,actorType,actorId,agentId,runId,responsibleUserId,entityType,entityId,issueIdentifier,issueTitle,commentExcerpt,documentKey",
    );
    // Three seeded activity rows → three CSV data rows (the export reads before it logs itself).
    expect(lines).toHaveLength(4);
    // User-controlled cells are preserved as text rather than executable formulas.
    expect(response.text).toContain("'=2+2");
    expect(response.text).toContain("'@SUM(A1)");

    // The export is itself recorded as an auditable action.
    const logged = (await db.select().from(activityLog)).filter((row) => row.action === "audit.exported");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.entityType).toBe("company");
    expect(logged[0]!.entityId).toBe(company.id);
    expect(logged[0]!.details).toMatchObject({ format: "csv", rowCount: 3, truncated: false });
  });

  it("denies CSV export without the audit permission and logs nothing", async () => {
    const { company } = await seed();
    const response = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions.csv`);
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("audit:view_agent_actions");

    const logged = (await db.select().from(activityLog)).filter((row) => row.action === "audit.exported");
    expect(logged).toHaveLength(0);
  });

  it("allows a signed-in board user with the explicit permission", async () => {
    const { company } = await seed();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: "reader", status: "active", membershipRole: "viewer",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: "reader", permissionKey: "audit:view_agent_actions", scope: null, grantedByUserId: null,
    });
    const response = await request(await createApp(db, {
      type: "board", userId: "reader", companyIds: [company.id], source: "session", isInstanceAdmin: false,
    })).get(`/api/companies/${company.id}/audit/agent-actions`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items).toHaveLength(3);
  });
});
