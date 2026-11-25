import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, gt, sql } from "drizzle-orm";
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
  dedicatedDbConnectionStats,
  documents,
  heartbeatRuns,
  issueAccessGrants,
  issueComments,
  issueDocuments,
  issues,
  managedAuditEvents,
  managedAuditExportPageAccess,
  managedAuditExports,
  managedAuditTransitionReceipts,
  principalPermissionGrants,
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
  withDedicatedDbConnection,
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
    await db.delete(managedAuditExportPageAccess);
    await db.delete(managedAuditTransitionReceipts);
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
    await db.delete(issueAccessGrants);
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
    const { company, agent, issue } = await seed();
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
    const [visibleRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, scopeKind: "issue", issueId: issue.id, status: "succeeded",
    }).returning();
    const eventRows = Array.from({ length: 10_037 }, (_, index) => ({
      ...baseEvent, id: randomUUID(), invocationId: randomUUID(),
      ...(index % 10 === 0 ? { taskId: issue.id, runId: visibleRun.id } : {}),
    }));
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
      const pageAccess = () => db.select().from(managedAuditExportPageAccess)
        .where(eq(managedAuditExportPageAccess.exportId, receipt.body.exportId));
      expect(await pageAccess()).toHaveLength(0);
      expect((await anon.get(exportPath)).status).toBe(403);
      await board.head(exportPath).expect(200);
      expect(await pageAccess()).toHaveLength(0);
      await db.insert(managedAuditEvents).values({ ...baseEvent, invocationId: randomUUID() });
      const first = await board.get(exportPath).set("If-None-Match", 'W/"anything"');
      expect(first.status, first.text).toBe(200);
      expect(first.body).toMatchObject({ deliveredThrough: 200, complete: false, nextCursor: expect.any(String) });
      expect((await board.get(exportPath)).body).toEqual(first.body);
      expect((await board.get(exportPath).query({ cursor: "10036." + "a".repeat(64) })).status).toBe(409);
      const firstPageAccess = await pageAccess();
      expect(firstPageAccess).toHaveLength(2);
      for (const row of firstPageAccess) {
        expect(row).toMatchObject({
          companyId: company.id, exportId: receipt.body.exportId, userId, pageOffset: 0, itemCount: 200,
        });
      }

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
      const allPageAccess = await pageAccess();
      expect(allPageAccess).toHaveLength(Math.ceil(expectedIds.length / 200) + 1);
      expect(allPageAccess).toContainEqual(expect.objectContaining({ userId, pageOffset: 10_000, itemCount: 37 }));
      await db.execute(sql`alter table managed_audit_export_page_access rename to unavailable_page_access`);
      try {
        const auditWriteFailed = await board.get(exportPath).expect(500);
        expect(auditWriteFailed.body).not.toHaveProperty("events");
        expect(auditWriteFailed.text).not.toContain(company.id);
        expect(auditWriteFailed.text).not.toContain(receipt.body.exportId);
        expect(auditWriteFailed.body).toMatchObject({ error: "Managed audit page access could not be recorded" });
      } finally {
        await db.execute(sql`alter table unavailable_page_access rename to managed_audit_export_page_access`);
      }

      await db.delete(managedAuditEvents).where(eq(managedAuditEvents.id, expectedIds[0]));
      expect((await board.get(exportPath)).body).toMatchObject({ details: { reasonCode: "snapshot_incomplete" } });
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
      expect((await board.get(exportPath)).body).toMatchObject({ details: { reasonCode: "source_epoch_changed" } });
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
      await expect(readManagedAuditExportPage(db, {
        companyId: company.id, sourceEpoch: epoch.toLowerCase(), retainAfter: null,
        actor: { type: "board", source: "session", userId, companyIds: [company.id] },
      }, receipt.body.exportId)).rejects.toMatchObject({ status: 403 });
      expect((await board.get(exportPath)).status).toBe(403);
      await db.delete(managedAuditExports).where(eq(managedAuditExports.id, receipt.body.exportId));
      expect(await pageAccess()).toHaveLength(allPageAccess.length);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 45_000);

  it("rejects managed audit windows above the bounded snapshot membership", async () => {
    const { company, agent } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const at = new Date("2026-07-17T00:00:01.000Z");
    const baseEvent = {
      companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
      occurredAt: at, eventType: "invocation_decision_recorded", phase: "policy_decision",
      decision: "allow", status: "authorized",
    };
    const eventRows = Array.from({ length: 20_001 }, () => ({ ...baseEvent, id: randomUUID(), invocationId: randomUUID() }));
    for (let index = 0; index < eventRows.length; index += 1_000) {
      await db.insert(managedAuditEvents).values(eventRows.slice(index, index + 1_000));
    }
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    const epoch = randomUUID();
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      const response = await board.post(`/api/companies/${company.id}/audit/managed-exports`).send(window);
      expect(response.status, response.text).toBe(413);
      expect(response.body).toMatchObject({ details: { reasonCode: "snapshot_membership_limit" } });
      expect(await db.select().from(managedAuditExports)).toHaveLength(0);
      expect((await db.select().from(activityLog)).filter(row => row.action === "audit.managed_export_created")).toHaveLength(0);

      const oversizedExportId = randomUUID();
      await db.insert(managedAuditExports).values({
        id: oversizedExportId,
        companyId: company.id,
        userId,
        sourceEpoch: epoch,
        from: new Date(window.from),
        to: new Date(window.to),
        eventIds: Array.from({ length: 20_001 }, () => randomUUID()),
        watermark: "synthetic-oversized-membership",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const replay = await board.get(`/api/companies/${company.id}/audit/managed-exports/${oversizedExportId}`);
      expect(replay.status, replay.text).toBe(409);
      expect(replay.body).toMatchObject({ details: { reasonCode: "snapshot_membership_limit" } });
      expect(replay.body).not.toHaveProperty("eventCount");
      expect(replay.body).not.toHaveProperty("watermark");
      expect(replay.body).not.toHaveProperty("events");
    } finally {
      vi.unstubAllEnvs();
    }
  }, 45_000);

  it("keeps a recent snapshot expiration distinguishable after cleanup", async () => {
    const { company, agent } = await seed();
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const users = [userId, otherUserId];
    await db.insert(companyMemberships).values(users.map(principalId => ({
      companyId: company.id, principalType: "user", principalId, membershipRole: "operator", status: "active",
    })));
    await db.insert(principalPermissionGrants).values(users.map(principalId => ({
      companyId: company.id, principalType: "user", principalId, permissionKey: "audit:view_agent_actions",
    })));
    const [board, otherBoard] = await Promise.all(users.map(async principalId =>
      request(await createApp(db, { type: "board", source: "session", userId: principalId, companyIds: [company.id] })),
    ));
    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    await db.insert(managedAuditEvents).values({
      companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
      occurredAt: new Date("2026-07-17T00:00:01.000Z"), eventType: "invocation_decision_recorded",
      phase: "policy_decision", decision: "allow", status: "authorized", invocationId: randomUUID(),
    });
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      const created = await board.post(path).send(window).expect(201);
      expect(created.body.eventCount).toBe(1);
      const exportPath = `${path}/${created.body.exportId}`;
      const row = eq(managedAuditExports.id, created.body.exportId);
      const expired = new Date(Date.now() - 1_000);
      await db.update(managedAuditExports).set({ expiresAt: expired }).where(row);
      expect((await board.get(exportPath).expect(409)).body)
        .toMatchObject({ details: { reasonCode: "snapshot_expired" } });

      await board.post(path).send(window).expect(201);
      const afterCleanup = await board.get(exportPath).expect(409);
      expect(afterCleanup.body).toMatchObject({ details: { reasonCode: "snapshot_expired" } });
      expect(afterCleanup.body).not.toHaveProperty("eventCount");
      const [marker] = await db.select({ expiresAt: managedAuditExports.expiresAt, eventIds: managedAuditExports.eventIds })
        .from(managedAuditExports).where(row);
      expect(marker).toEqual({ expiresAt: expired, eventIds: [] });
      expect((await otherBoard.get(exportPath).expect(404)).body)
        .toMatchObject({ details: { reasonCode: "snapshot_missing" } });

      await db.update(managedAuditExports).set({ expiresAt: new Date(0) }).where(row);
      await board.post(path).send(window).expect(201);
      expect((await board.get(exportPath).expect(404)).body)
        .toMatchObject({ details: { reasonCode: "snapshot_missing" } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows another auditor to collect when one owner reaches the principal snapshot limit", async () => {
    const { company } = await seed();
    const users = [randomUUID(), randomUUID()];
    await db.insert(companyMemberships).values(users.map(principalId => ({
      companyId: company.id, principalType: "user", principalId, membershipRole: "operator", status: "active",
    })));
    await db.insert(principalPermissionGrants).values(users.map(principalId => ({
      companyId: company.id, principalType: "user", principalId, permissionKey: "audit:view_agent_actions",
    })));
    const [first, second] = await Promise.all(users.map(async userId =>
      request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] })),
    ));
    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    const epoch = randomUUID();
    await db.insert(managedAuditExports).values(Array.from({ length: 32 }, () => ({
      companyId: company.id, userId: users[0], sourceEpoch: epoch,
      from: new Date(window.from), to: new Date(window.to), eventIds: [], watermark: "fixture",
      expiresAt: new Date(Date.now() + 60_000),
    })));
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      expect((await first.post(path).send(window).expect(429)).body)
        .toMatchObject({ details: { reasonCode: "principal_snapshot_limit" } });
      await second.post(path).send(window).expect(201);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reclaims quota after an epoch or retention change while keeping old checkpoints fenced", async () => {
    const { company } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, {
      type: "board", source: "session", userId, companyIds: [company.id],
    }));
    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const oldEpoch = randomUUID();
    const currentEpoch = randomUUID();
    const window = { from: "2026-07-17T00:00:01.000Z", to: "2026-07-17T00:00:02.000Z" };
    const oldStart = "2026-07-17T00:00:00.000Z";
    const [oldEpochRow, oldRetentionRow] = await db.insert(managedAuditExports).values(
      Array.from({ length: 128 }, (_, index) => ({
        companyId: company.id, userId, sourceEpoch: index % 2 ? currentEpoch : oldEpoch,
        from: new Date(index % 2 ? oldStart : window.from), to: new Date(window.to),
        eventIds: [randomUUID()], watermark: "fixture", expiresAt: new Date(Date.now() + 60_000),
      })),
    ).returning({ id: managedAuditExports.id });
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", currentEpoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", oldStart);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", window.from);
    try {
      await board.post(path).send(window).expect(201);
      for (const [row, reasonCode] of [[oldEpochRow, "source_epoch_changed"], [oldRetentionRow, "retention_window_expired"]] as const) {
        const stale = await board.get(`${path}/${row.id}`).expect(409);
        expect(stale.body).toMatchObject({ details: { reasonCode } });
        expect(stale.body).not.toHaveProperty("eventCount");
        const [marker] = await db.select({ eventIds: managedAuditExports.eventIds }).from(managedAuditExports)
          .where(eq(managedAuditExports.id, row.id));
        expect(marker.eventIds).toEqual([]);
      }
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
      expect((await board.get(`${path}/${oldRetentionRow.id}`).expect(409)).body)
        .toMatchObject({ details: { reasonCode: "snapshot_expired" } });
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", oldEpoch);
      expect((await board.get(`${path}/${oldEpochRow.id}`).expect(409)).body)
        .toMatchObject({ details: { reasonCode: "snapshot_expired" } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reserves snapshot storage per company even when another database client sees the same last slot", async () => {
    const { company } = await seed();
    const { company: otherCompany } = await seed();
    const userId = randomUUID();
    const principals = [company.id, otherCompany.id].map(companyId => ({ companyId, principalId: userId }));
    await db.insert(companyMemberships).values(principals.map(principal => ({
      ...principal, principalType: "user", membershipRole: "operator", status: "active",
    })));
    await db.insert(principalPermissionGrants).values(principals.map(principal => ({
      ...principal, principalType: "user", permissionKey: "audit:view_agent_actions",
    })));
    const board = request(await createApp(db, {
      type: "board", source: "session", userId, companyIds: [company.id, otherCompany.id],
    }));
    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    const epoch = randomUUID();
    const fields = {
      companyId: company.id, userId, sourceEpoch: epoch, from: new Date(window.from), to: new Date(window.to),
      eventIds: [], watermark: createHash("sha256").update("[]").digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const saved = await db.insert(managedAuditExports)
      .values(Array.from({ length: 127 }, () => ({ ...fields, userId: randomUUID() })))
      .returning({ id: managedAuditExports.id });
    const [expired] = await db.insert(managedAuditExports).values({
      ...fields, expiresAt: new Date(0),
    }).returning({ id: managedAuditExports.id });
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);

    const otherWriter = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const replica = otherWriter.transaction(async tx => {
      const active = await tx.select({ id: managedAuditExports.id }).from(managedAuditExports).where(and(
        eq(managedAuditExports.companyId, company.id), gt(managedAuditExports.expiresAt, new Date()),
      )).limit(128);
      expect(active).toHaveLength(127);
      ready.resolve();
      await release.promise;
      await tx.insert(managedAuditExports).values(fields);
    }, { isolationLevel: "serializable" });
    try {
      await Promise.race([ready.promise, replica]);
      await board.post(path).send(window).expect(201);
      const rejectedReplica = expect(replica).rejects.toMatchObject({ cause: { code: "40001" } });
      release.resolve();
      await rejectedReplica;

      const limited = await board.post(path).send(window).expect(429);
      expect(limited.body).toMatchObject({ details: { reasonCode: "active_snapshot_limit" } });
      const retained = await db.select({ id: managedAuditExports.id }).from(managedAuditExports)
        .where(eq(managedAuditExports.companyId, company.id));
      expect(retained).toHaveLength(128);
      expect(retained.map(entry => entry.id)).not.toContain(expired.id);
      await board.post(`/api/companies/${otherCompany.id}/audit/managed-exports`).send(window).expect(201);

      await db.update(managedAuditExports).set({ expiresAt: new Date(0) }).where(eq(managedAuditExports.id, saved[0].id));
      await board.post(path).send(window).expect(201);
    } finally {
      release.resolve();
      await Promise.allSettled([replica]);
      await otherWriter.$client.end();
      vi.unstubAllEnvs();
    }
  });

  it("returns a retryable failure when its serializable snapshot quota loses a writer race", async () => {
    const { company } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    const epoch = randomUUID();
    const retainAfter = "2026-07-01T00:00:00.000Z";
    const triggerKey = 380_380;
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", retainAfter);
    const lockDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const writerDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    let held = false;
    let losingRequest: Promise<{ status: number; body: Record<string, unknown>; text: string }> | undefined;
    try {
      await db.insert(managedAuditExports).values(Array.from({ length: 31 }, () => ({
        companyId: company.id, userId, sourceEpoch: epoch,
        from: new Date(window.from), to: new Date(window.to), eventIds: [],
        watermark: "quota-race-fixture", expiresAt: new Date(Date.now() + 60_000),
      })));
      await db.execute(sql`create function public.proprio_test_block_managed_export_insert() returns trigger language plpgsql as $$ begin if new.watermark not in ('quota-race-fixture', 'winning-concurrent-quota-writer') then perform pg_advisory_xact_lock(380380::bigint); end if; return new; end $$`);
      await db.execute(sql`create trigger proprio_test_block_managed_export_insert before insert on managed_audit_exports for each row execute function public.proprio_test_block_managed_export_insert()`);
      await lockDb.execute(sql`select pg_advisory_lock(${triggerKey}::bigint)`);
      held = true;

      losingRequest = board.post(path).send(window).then(response => response);
      await vi.waitFor(async () => {
        const [waiting] = await db.execute<{ count: number }>(sql`
          select count(*)::int as count from pg_locks
          where locktype = 'advisory' and not granted and classid = 0 and objid = ${triggerKey}::oid
        `);
        expect(waiting.count).toBeGreaterThan(0);
      });
      await writerDb.transaction(async tx => {
        await tx.execute(sql`select count(*) from managed_audit_exports where company_id = ${company.id} and user_id = ${userId} and source_epoch = ${epoch} and expires_at > now() and from_at >= ${retainAfter}::timestamptz`);
        await tx.insert(managedAuditExports).values({
          companyId: company.id, userId, sourceEpoch: epoch,
          from: new Date(window.from), to: new Date(window.to), eventIds: [],
          watermark: "winning-concurrent-quota-writer", expiresAt: new Date(Date.now() + 60_000),
        });
      }, { isolationLevel: "serializable" });
      await lockDb.execute(sql`select pg_advisory_unlock(${triggerKey}::bigint)`);
      held = false;

      const response = await losingRequest;
      expect(response.status, response.text).toBe(503);
      expect(response.body).toMatchObject({ details: { reasonCode: "export_retry_required" } });
      const snapshots = await db.select().from(managedAuditExports).where(eq(managedAuditExports.companyId, company.id));
      expect(snapshots).toHaveLength(32);
      expect(snapshots.filter(snapshot => snapshot.watermark === "winning-concurrent-quota-writer")).toHaveLength(1);
      expect(snapshots.filter(snapshot => snapshot.watermark === "quota-race-fixture")).toHaveLength(31);
      expect((await db.select().from(activityLog)).filter(row => row.action === "audit.managed_export_created")).toHaveLength(0);
    } finally {
      if (held) await lockDb.execute(sql`select pg_advisory_unlock(${triggerKey}::bigint)`).catch(() => undefined);
      await Promise.allSettled([losingRequest]);
      await db.execute(sql`drop trigger if exists proprio_test_block_managed_export_insert on managed_audit_exports`);
      await db.execute(sql`drop function if exists public.proprio_test_block_managed_export_insert()`);
      await writerDb.$client.end();
      await lockDb.$client.end();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it.each(["managed_audit_exports", "managed_audit_export_page_access"])(
    "keeps the ordinary pool available while an audit page waits for %s",
    async (tableName) => {
      const { company } = await seed();
      const { company: secondCompany } = await seed();
      const userId = randomUUID();
      const secondUserId = randomUUID();
      const principals = [
        { companyId: company.id, principalId: userId },
        { companyId: secondCompany.id, principalId: secondUserId },
      ];
      await db.insert(companyMemberships).values(principals.map(principal => ({
        ...principal, principalType: "user", membershipRole: "operator", status: "active",
      })));
      await db.insert(principalPermissionGrants).values(principals.map(principal => ({
        ...principal, principalType: "user", permissionKey: "audit:view_agent_actions",
      })));
      const requestDb = createDb(tempDb!.connectionString, { maxConnections: 1, dedicatedConnectionMax: 1 });
      const lockDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
      const board = request(await createApp(requestDb, { type: "board", source: "session", userId, companyIds: [company.id] }));
      const secondBoard = request(await createApp(requestDb, {
        type: "board", source: "session", userId: secondUserId, companyIds: [secondCompany.id],
      }));
      const path = `/api/companies/${company.id}/audit/managed-exports`;
      const secondPath = `/api/companies/${secondCompany.id}/audit/managed-exports`;
      const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
      const release = Promise.withResolvers<void>();
      let lock: Promise<void> | undefined;
      let pending: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
      const otherRequests: Array<Promise<{ status: number; body: Record<string, unknown> }>> = [];
      let completed = false;
      try {
        const saved = await board.post(path).send(window).expect(201);
        const exportPath = `${path}/${saved.body.exportId}`;
        const secondSaved = await secondBoard.post(secondPath).send(window).expect(201);
        const secondExport = `${secondPath}/${secondSaved.body.exportId}`;
        await withDedicatedDbConnection(requestDb, async () => {
          const unavailable = await board.get(exportPath).timeout({ deadline: 2_000 }).expect(503);
          expect(unavailable.body).toMatchObject({ details: { reasonCode: "export_retry_required" } });
          expect(dedicatedDbConnectionStats(requestDb)?.inUse).toBe(1);
        });
        const locked = Promise.withResolvers<void>();
        lock = lockDb.transaction(async tx => {
          await tx.execute(sql`lock table ${sql.identifier(tableName)} in access exclusive mode`);
          locked.resolve();
          await release.promise;
        });
        await Promise.race([locked.promise, lock]);
        pending = board.get(exportPath).then(({ status, body }) => {
          completed = true;
          return { status, body };
        });
        await vi.waitFor(() => expect(dedicatedDbConnectionStats(requestDb)?.inUse).toBe(1));

        const busy = await board.get(exportPath).timeout({ deadline: 2_000 }).expect(429);
        expect(busy.body).toMatchObject({ details: { reasonCode: "export_busy" } });
        for (let index = 0; index < 2; index++) {
          otherRequests.push(secondBoard.get(secondExport).then(({ status, body }) => ({ status, body })));
        }
        expect(await Promise.race(otherRequests)).toMatchObject({ status: 429, body: { details: { reasonCode: "export_busy" } } });
        await board.get(`/api/companies/${company.id}/activity`).timeout({ deadline: 2_000 }).expect(200);
        expect(completed).toBe(false);

        const timedOut = await pending;
        expect(timedOut).toMatchObject({ status: 503, body: { details: { reasonCode: "export_retry_required" } } });
        expect(timedOut.body).not.toHaveProperty("events");
        release.resolve();
        await lock;
        const outcomes = await Promise.all(otherRequests);
        expect(outcomes.map(result => result.status).sort()).toEqual([200, 429]);
        await board.get(exportPath).expect(200);
      } finally {
        release.resolve();
        await Promise.allSettled([lock, pending, ...otherRequests]);
        await Promise.all([lockDb.$client.end(), requestDb.$client.end()]);
        vi.unstubAllEnvs();
      }
    },
    30_000,
  );

  // This race belongs with the route fixtures because it needs a held PostgreSQL
  // writer plus the suite's authenticated HTTP requests and shared snapshot setup.
  it("finds a late-committing event only through a fresh overlapping export", async () => {
    const { company, agent } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const epoch = randomUUID();
    const from = "2026-07-17T00:00:00.000Z";
    const boundary = "2026-07-17T00:00:02.000Z";
    const to = "2026-07-17T00:00:04.000Z";
    const eventId = randomUUID();
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);

    let signalInserted!: () => void;
    const inserted = new Promise<void>(resolve => { signalInserted = resolve; });
    let finishTransaction!: () => void;
    const transactionMayCommit = new Promise<void>(resolve => { finishTransaction = resolve; });
    const writerDb = createDb(tempDb!.connectionString);
    const lateTransaction = writerDb.transaction(async tx => {
      await tx.insert(managedAuditEvents).values({
        id: eventId,
        companyId: company.id,
        source: "tool_gateway",
        schemaVersion: 1,
        eventType: "invocation_decision_recorded",
        phase: "policy_decision",
        occurredAt: new Date("2026-07-17T00:00:01.000Z"),
        invocationId: randomUUID(),
        actorType: "agent",
        actorId: agent.id,
        decision: "allow",
        status: "authorized",
      });
      signalInserted();
      await transactionMayCommit;
    });

    try {
      await Promise.race([inserted, lateTransaction]);
      const path = `/api/companies/${company.id}/audit/managed-exports`;
      const first = await board.post(path).send({ from, to: boundary }).expect(201);
      expect(first.body.eventCount).toBe(0);

      finishTransaction();
      await lateTransaction;
      const adjacent = await board.post(path).send({ from: boundary, to }).expect(201);
      expect(adjacent.body.eventCount).toBe(0);
      const firstPage = await board.get(`${path}/${first.body.exportId}`).expect(200);
      const adjacentPage = await board.get(`${path}/${adjacent.body.exportId}`).expect(200);
      expect(firstPage.body.events).toEqual([]);
      expect(adjacentPage.body.events).toEqual([]);

      const overlapping = await board.post(path).send({ from, to }).expect(201);
      const overlapPage = await board.get(`${path}/${overlapping.body.exportId}`).expect(200);
      expect(overlapPage.body.events).toMatchObject([{ id: eventId, source: "tool_gateway" }]);
      expect(overlapPage.body.complete).toBe(true);

      // A source epoch fences old export checkpoints, while stable event IDs
      // still deduplicate archived evidence across epochs.
      const nextEpoch = randomUUID();
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", nextEpoch);
      expect((await board.get(`${path}/${overlapping.body.exportId}`)).body)
        .toMatchObject({ details: { reasonCode: "source_epoch_changed" } });
      const nextEpochExport = await board.post(path).send({ from, to }).expect(201);
      const nextEpochPage = await board.get(`${path}/${nextEpochExport.body.exportId}`).expect(200);
      expect(nextEpochPage.body.events).toMatchObject([{ id: eventId, source: "tool_gateway" }]);
      const archivedKeys = [overlapPage.body.events[0], nextEpochPage.body.events[0]]
        .map(event => `${event.source}:${event.id}`);
      expect(new Set(archivedKeys).size).toBe(1);
    } finally {
      finishTransaction();
      try {
        await lateTransaction;
      } finally {
        vi.unstubAllEnvs();
        await writerDb.$client.end();
      }
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

      await db.update(issues).set({ visibility: "open", responsibleUserId: null }).where(eq(issues.id, issue.id));
      const resumed = await board.get(exportPath).query({ cursor: first.body.nextCursor }).expect(409);
      expect(resumed.body).toMatchObject({ details: { reasonCode: "snapshot_incomplete" } });
      expect(resumed.body).not.toHaveProperty("eventCount");
      expect(resumed.body).not.toHaveProperty("watermark");
      expect(resumed.body).not.toHaveProperty("events");
      const [snapshot] = await db.select({
        invalidated: managedAuditExports.invalidated, eventIds: managedAuditExports.eventIds,
      }).from(managedAuditExports).where(eq(managedAuditExports.id, created.body.exportId));
      expect(snapshot).toEqual({ invalidated: true, eventIds: [] });
      expect((await db.select().from(activityLog))
        .filter(row => row.action === "audit.managed_export_invalidated")).toHaveLength(0);
      const receipts = await db.select().from(managedAuditTransitionReceipts)
        .where(eq(managedAuditTransitionReceipts.exportId, created.body.exportId));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        companyId: company.id,
        transition: "export_invalidated",
        actorId: userId,
        exportId: created.body.exportId,
        recordCount: 1,
        source: "tool_gateway",
      });
      const [protection] = await db.execute<{
        rls: boolean; public_grants: boolean; anon_select: boolean; authenticated_select: boolean;
      }>(sql`select relation.relrowsecurity as rls,
        exists(select 1 from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) grant_entry
          where grant_entry.grantee = 0) as public_grants,
        coalesce((select has_table_privilege(role_entry.oid, relation.oid, 'select') from pg_roles role_entry where role_entry.rolname = 'anon'), false) as anon_select,
        coalesce((select has_table_privilege(role_entry.oid, relation.oid, 'select') from pg_roles role_entry where role_entry.rolname = 'authenticated'), false) as authenticated_select
        from pg_class relation where relation.oid = 'managed_audit_transition_receipts'::regclass`);
      expect(protection).toEqual({ rls: true, public_grants: false, anon_select: false, authenticated_select: false });

      // The public activity writer may accept a lookalike event, but it cannot
      // alter or expose the protected server-authored receipt.
      const forgedExportId = randomUUID();
      const forgedActorId = randomUUID();
      await board.post(`/api/companies/${company.id}/activity`).send({
        actorType: "user", actorId: forgedActorId, action: "audit.managed_export_invalidated",
        entityType: "company", entityId: company.id,
        details: { exportId: forgedExportId, recordCount: 999_999 },
      }).expect(201);
      expect((await db.select().from(managedAuditTransitionReceipts)
        .where(eq(managedAuditTransitionReceipts.companyId, company.id))).map(row => row.recordCount)).toEqual([1]);
      const activityView = await board.get(`/api/companies/${company.id}/activity`).expect(200);
      const publicInvalidations = activityView.body.filter((row: { action: string }) => row.action === "audit.managed_export_invalidated");
      expect(publicInvalidations).toHaveLength(1);
      expect(publicInvalidations[0]?.actorId).toBe(forgedActorId);
      expect(publicInvalidations[0]?.details).toMatchObject({ exportId: forgedExportId, recordCount: 999_999 });

      await db.update(managedAuditExports).set({ expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(managedAuditExports.id, created.body.exportId));
      const fresh = await board.post(path).send(window).expect(201);
      expect(fresh.body.eventCount).toBe(201);
      expect(fresh.body.exportId).not.toBe(created.body.exportId);
      expect(await db.select().from(managedAuditExports)
        .where(eq(managedAuditExports.id, created.body.exportId))).toHaveLength(0);
      expect(await db.select().from(managedAuditTransitionReceipts)
        .where(eq(managedAuditTransitionReceipts.exportId, created.body.exportId))).toHaveLength(1);

      // The company FK cascades only at actual company retirement; snapshots
      // and expiration do not own this receipt.
      const deletionCompany = (await db.insert(companies).values({ name: "Receipt cascade fixture" }).returning())[0]!;
      await db.insert(managedAuditTransitionReceipts).values({
        companyId: deletionCompany.id,
        transition: "company_exports_retired",
        actorId: userId,
        exportId: null,
        recordCount: 1,
        source: "company_retirement",
      });
      await db.delete(companies).where(eq(companies.id, deletionCompany.id));
      expect(await db.select().from(managedAuditTransitionReceipts)
        .where(eq(managedAuditTransitionReceipts.companyId, deletionCompany.id))).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not release a page from a repeatable-read snapshot after concurrent invalidation wins", async () => {
    const { company, agent } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const from = "2026-07-17T00:00:00.000Z";
    const to = "2026-07-17T00:00:02.000Z";
    await db.insert(managedAuditEvents).values({
      companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
      occurredAt: new Date("2026-07-17T00:00:01.000Z"), eventType: "invocation_decision_recorded",
      phase: "policy_decision", decision: "allow", status: "authorized", invocationId: randomUUID(),
    });
    const path = `/api/companies/${company.id}/audit/managed-exports`;
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    const writer = createDb(tempDb!.connectionString, { maxConnections: 1 });
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let locker: Promise<unknown> | undefined;
    let pendingRead: Promise<request.Response> | undefined;
    try {
      const created = await board.post(path).send({ from, to }).expect(201);
      const exportPath = `${path}/${created.body.exportId}`;
      let writerPid = 0;
      locker = writer.transaction(async tx => {
        await tx.select({ id: managedAuditExports.id }).from(managedAuditExports)
          .where(eq(managedAuditExports.id, created.body.exportId)).for("no key update");
        const [owner] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        writerPid = owner!.pid;
        locked.resolve();
        await release.promise;
        await tx.update(managedAuditExports).set({ invalidated: true, eventIds: [] })
          .where(eq(managedAuditExports.id, created.body.exportId));
      });
      await Promise.race([locked.promise, locker]);
      pendingRead = board.get(exportPath).then(response => response);
      // Prove the HTTP transaction is blocked by this writer, rather than
      // relying on a timing delay before committing the competing update.
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity
          where datname = current_database() and query like '%managed_audit_exports%'
            and ${writerPid} = any(pg_blocking_pids(pid))`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 1_500, interval: 20 });
      release.resolve();
      await locker;
      const response = await pendingRead;
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ details: { reasonCode: "export_retry_required" } });
      expect(await db.select().from(managedAuditExportPageAccess)
        .where(eq(managedAuditExportPageAccess.exportId, created.body.exportId))).toHaveLength(0);
      await board.get(exportPath).expect(409);
    } finally {
      release.resolve();
      if (locker) await Promise.allSettled([locker]);
      if (pendingRead) await Promise.allSettled([pendingRead]);
      await writer.$client.end();
      vi.unstubAllEnvs();
    }
  });

  it("does not reveal a missing run bound to another user's private task", async () => {
    const { company, agent } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const [privateTask] = await db.insert(issues).values({
      companyId: company.id, title: "Private binding", visibility: "private", responsibleUserId: randomUUID(),
    }).returning();
    const [deletedRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id }).returning();
    await db.insert(managedAuditEvents).values({
      companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
      occurredAt: new Date("2026-07-17T00:00:01.000Z"), eventType: "invocation_decision_recorded",
      phase: "policy_decision", decision: "allow", status: "authorized", taskId: privateTask.id,
      runId: deletedRun.id, invocationId: randomUUID(),
    });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, deletedRun.id));

    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      const created = await board.post(path).send(window).expect(201);
      expect(created.body.eventCount).toBe(0);
      const page = await board.get(`${path}/${created.body.exportId}`).expect(200);
      expect(page.body).toMatchObject({ eventCount: 0, events: [], complete: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["responsibility_dashboard", "responsibility_bar", "responsibility_status_update", "automation_conversation"])(
    "keeps %s audit events visible only to their owner, including when a binding disappears",
    async (originKind) => {
      const { company, agent } = await seed();
      const ownerId = randomUUID();
      const auditorId = randomUUID();
      const userIds = [ownerId, auditorId];
      await db.insert(companyMemberships).values(userIds.map(userId => ({
        companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
      })));
      await db.insert(principalPermissionGrants).values(userIds.map(userId => ({
        companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
      })));
      const [owner, auditor] = await Promise.all(userIds.map(async userId =>
        request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }))));
      const [conversation] = await db.insert(issues).values({
        companyId: company.id, originKind, originId: ownerId, title: "Personal conversation",
        visibility: "private", responsibleUserId: ownerId,
      }).returning();
      await db.insert(issueAccessGrants).values({
        issueId: conversation.id, subjectType: "user", subjectId: auditorId, source: "explicit",
      });
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: company.id, agentId: agent.id, scopeKind: "issue", issueId: conversation.id,
      }).returning();
      const event = {
        companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
        occurredAt: new Date("2026-07-17T00:00:01.000Z"), eventType: "invocation_decision_recorded",
        phase: "policy_decision", decision: "allow", status: "authorized",
      } as const;
      const [taskEvent, runEvent] = await db.insert(managedAuditEvents).values([
        { ...event, taskId: conversation.id, invocationId: randomUUID() },
        { ...event, runId: run.id, invocationId: randomUUID() },
      ]).returning();
      const path = `/api/companies/${company.id}/audit/managed-exports`;
      const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
      vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
      try {
        const owned = await owner.post(path).send(window).expect(201);
        const page = await owner.get(`${path}/${owned.body.exportId}`).expect(200);
        expect(page.body.events.map((entry: { id: string }) => entry.id).sort()).toEqual([taskEvent.id, runEvent.id].sort());

        const excluded = await auditor.post(path).send(window).expect(201);
        expect(excluded.body.eventCount).toBe(0);
        const empty = await auditor.get(`${path}/${excluded.body.exportId}`).expect(200);
        expect(empty.body.events).toEqual([]);

        await db.update(managedAuditEvents).set({ runId: randomUUID() }).where(eq(managedAuditEvents.id, taskEvent.id));
        await db.update(managedAuditEvents).set({ taskId: randomUUID() }).where(eq(managedAuditEvents.id, runEvent.id));
        expect((await auditor.post(path).send(window).expect(201)).body.eventCount).toBe(0);
        expect((await owner.post(path).send(window).expect(409)).body.details.reasonCode).toBe("snapshot_incomplete");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

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
      const oldEpochMarker = await restoredBoard.get(`${path}/${expired.body.exportId}`).expect(409);
      expect(oldEpochMarker.body).toMatchObject({ details: { reasonCode: "source_epoch_changed" } });

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
