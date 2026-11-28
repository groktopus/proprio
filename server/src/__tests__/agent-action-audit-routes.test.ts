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
  issueAccessGrants,
  issueComments,
  issueDocuments,
  issues,
  managedAuditEvents,
  managedAuditExportPageAccess,
  managedAuditExports,
  principalPermissionGrants,
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  type DbTransaction,
} from "@groktopus/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { MAX_SNAPSHOT_EVENTS, readManagedAuditExportPage } from "../services/managed-audit-export.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { deleteAgentDependencies } from "../services/agent-deletion.js";

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

  async function seed(targetDb: Db = db) {
    const company = await targetDb.insert(companies).values({
      name: "Audit Company",
      issuePrefix: `AU${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [agent, otherAgent] = await targetDb.insert(agents).values([1, 2].map((index) => ({
      companyId: company.id,
      name: `Audit Agent ${index}`,
      role: "engineer",
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }))).returning();
    const issue = await targetDb.insert(issues).values({
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Audit target",
      status: "todo",
      priority: "medium",
    }).returning().then((rows) => rows[0]!);
    const comment = await targetDb.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorAgentId: agent.id,
      body: "A useful comment excerpt for the audit feed.",
    }).returning().then((rows) => rows[0]!);
    const document = await targetDb.insert(documents).values({
      companyId: company.id,
      title: "Plan",
      latestBody: "Plan body",
      createdByAgentId: agent.id,
      updatedByAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    const issueDocument = await targetDb.insert(issueDocuments).values({
      companyId: company.id,
      issueId: issue.id,
      documentId: document.id,
      key: "plan",
    }).returning().then((rows) => rows[0]!);
    const run = await targetDb.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      responsibleUserId: "legacy-user",
    }).returning().then((rows) => rows[0]!);
    const base = new Date("2026-07-17T00:00:00.000Z");
    await targetDb.insert(activityLog).values([
      { companyId: company.id, actorType: "agent", actorId: agent.id, action: "issue.comment.created", entityType: "issue_comment", entityId: comment.id, agentId: agent.id, runId: run.id, responsibleUserId: null, createdAt: new Date(base.getTime() + 3000) },
      { companyId: company.id, actorType: "system", actorId: "system", action: "issue.document.updated", entityType: "issue_document", entityId: issueDocument.id, agentId: agent.id, runId: run.id, responsibleUserId: "direct-user", createdAt: new Date(base.getTime() + 2000) },
      { companyId: company.id, actorType: "agent", actorId: otherAgent.id, action: "issue.updated", entityType: "issue", entityId: issue.id, agentId: otherAgent.id, responsibleUserId: "other-user", createdAt: new Date(base.getTime() + 1000) },
    ]);
    return { company, agent, otherAgent, issue, comment, issueDocument, run };
  }

  it("keeps private binding loss private and isolates competing expired-snapshot cleanup", async () => {
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
      companyId: company.id, title: "Private binding fixture", visibility: "private", responsibleUserId: randomUUID(),
    }).returning();
    const at = new Date("2026-07-17T00:00:01.000Z");
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    const epoch = randomUUID();
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      await db.insert(managedAuditEvents).values({
        companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
        occurredAt: at, eventType: "invocation_decision_recorded", phase: "policy_decision",
        decision: "allow", status: "authorized", taskId: privateTask.id, runId: randomUUID(), invocationId: randomUUID(),
      });
      await db.delete(issues).where(eq(issues.id, privateTask.id));
      const privateLoss = await board.post(`/api/companies/${company.id}/audit/managed-exports`).send(window);
      expect(privateLoss.status, privateLoss.text).toBe(201);
      expect(privateLoss.body).toMatchObject({ eventCount: 0, sourceEpoch: epoch });
      expect(privateLoss.body).not.toHaveProperty("details");

      const expiredAt = new Date(Date.now() - 1_000);
      await db.insert(managedAuditExports).values({
        companyId: company.id, userId, sourceEpoch: epoch, from: new Date(window.from), to: new Date(window.to),
        eventIds: [], watermark: createHash("sha256").update("[]").digest("hex"), expiresAt: expiredAt,
      });
      const creates = await Promise.all(Array.from({ length: 4 }, () =>
        board.post(`/api/companies/${company.id}/audit/managed-exports`).send(window)));
      expect(creates.map(response => response.status)).toEqual([201, 201, 201, 201]);
      expect(creates.map(response => response.body.eventCount)).toEqual([0, 0, 0, 0]);
      expect(await db.select().from(managedAuditExports).where(eq(managedAuditExports.expiresAt, expiredAt))).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a missing issue-scoped run only to an actor who can read the persisted issue scope", async () => {
    const { company, agent, issue, run } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const epoch = randomUUID();
    const occurredAt = Date.now();
    const from = new Date(Math.floor(occurredAt / 1_000) * 1_000 - 10_000).toISOString();
    const to = new Date(Date.parse(from) + 2_000).toISOString();
    const window = { from, to };
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId: issue.id }).where(eq(heartbeatRuns.id, run.id));
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      const [application] = await db.insert(toolApplications).values({
        companyId: company.id, applicationKey: `audit-${randomUUID()}`, name: "Audit fixture", type: "mcp_http", status: "active",
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId: company.id, applicationId: application!.id, name: "Audit connection", uid: `audit/${randomUUID()}`,
        transport: "mcp_remote", status: "active", enabled: true, config: { url: "https://example.invalid/mcp" },
      }).returning();
      const [catalogEntry] = await db.insert(toolCatalogEntries).values({
        companyId: company.id, applicationId: application!.id, connectionId: connection!.id,
        name: "audit_fixture", toolName: "audit_fixture", riskLevel: "read", versionHash: randomUUID(), schemaHash: randomUUID(),
      }).returning();
      const input = {
        companyId: company.id,
        actor: { actorType: "agent" as const, actorId: agent.id, agentId: agent.id },
        runContext: { heartbeatRunId: run.id, issueId: issue.id },
        request: { connectionId: connection!.id, catalogEntryId: catalogEntry!.id, toolName: "audit_fixture", arguments: {} },
      };
      const policy = toolAccessPolicyService(db);
      const decision = await policy.decide(input);
      await policy.recordInvocation(input, decision);
      const [capturedEvent] = await db.select().from(managedAuditEvents).where(eq(managedAuditEvents.runId, run.id));
      expect(capturedEvent).toMatchObject({ runScopeKind: "issue", runIssueId: issue.id, taskId: issue.id });
      await db.update(managedAuditEvents).set({ occurredAt: new Date(Date.parse(from) + 1_000) })
        .where(eq(managedAuditEvents.id, capturedEvent!.id));

      // Exercise the production lifecycle path that removes the run while
      // retaining its managed audit event and canonical privacy provenance.
      await db.transaction((tx: DbTransaction) => deleteAgentDependencies(tx, company.id, agent.id));
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id))).toHaveLength(0);
      expect(await db.select().from(managedAuditEvents).where(eq(managedAuditEvents.id, capturedEvent!.id))).toHaveLength(1);

      const response = await board.post(`/api/companies/${company.id}/audit/managed-exports`).send(window);

      expect(response.status, response.text).toBe(409);
      expect(response.body).toMatchObject({ details: { reasonCode: "snapshot_incomplete" } });
      expect(response.text).not.toContain(capturedEvent!.id);
      expect(response.text).not.toContain(run.id);
      expect(await db.select().from(managedAuditExports)).toHaveLength(0);
      expect((await db.select().from(activityLog)).filter(row => row.action === "audit.managed_export_created")).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exports a frozen managed audit window beyond the CSV cap and detects known missing bindings", async () => {
    const { company, agent, issue, run } = await seed();
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
    // Keep the large qualification representative of production rows: most
    // events are unbound, while task/run-scoped rows exercise both visibility
    // predicates during the full-membership read.
    const eventRows = Array.from({ length: 10_037 }, (_, index) => ({
      ...baseEvent,
      id: randomUUID(),
      invocationId: randomUUID(),
      ...(index % 17 === 0 ? { taskId: issue.id } : {}),
      ...(index % 29 === 0 ? { runId: run.id } : {}),
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
      const lateEventId = "00000000-0000-0000-0000-000000000001";
      await db.insert(managedAuditEvents).values({ ...baseEvent, id: lateEventId, invocationId: randomUUID() });
      const first = await board.get(exportPath).set("If-None-Match", 'W/"anything"');
      expect(first.status, first.text).toBe(200);
      expect(first.body).toMatchObject({ deliveredThrough: 200, complete: false, nextCursor: expect.any(String) });
      expect(first.body.events[0]).not.toHaveProperty("operationFingerprint");
      expect(first.body.events[0]).not.toHaveProperty("providerRequestId");
      expect((await board.get(exportPath)).body).toEqual(first.body);
      expect(await pageAccess()).toHaveLength(2);
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
      expect(archived).not.toContain(lateEventId);
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

      // A rescan of the same interval discovers a transaction that committed
      // after the first membership snapshot was frozen.
      const rescan = await board.post(path).send(window);
      expect(rescan.status, rescan.text).toBe(201);
      expect(rescan.body.eventCount).toBe(eventRows.length + 1);
      const rescannedPage = await board.get(`${path}/${rescan.body.exportId}`);
      expect(rescannedPage.status, rescannedPage.text).toBe(200);
      expect(rescannedPage.body.events.map((event: { id: string }) => event.id)).toContain(lateEventId);

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
      await db.delete(managedAuditExports).where(eq(managedAuditExports.id, receipt.body.exportId));
      expect(await pageAccess()).toHaveLength(allPageAccess.length);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 45_000);

  it("recovers a late commit only through a fresh overlap and fences the old epoch", async () => {
    const { company, agent } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const writerDb = createDb(tempDb!.connectionString, { maxConnections: 1, applicationName: "audit-overlap-writer" });
    const epoch = randomUUID();
    const nextEpoch = randomUUID();
    const from = "2026-07-17T00:00:00.000Z";
    const boundary = "2026-07-17T00:00:02.000Z";
    const to = "2026-07-17T00:00:04.000Z";
    const eventId = randomUUID();
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", epoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);

    let releaseWriter!: () => void;
    const writerMayCommit = new Promise<void>(resolve => { releaseWriter = resolve; });
    let inserted!: () => void;
    const insertedPromise = new Promise<void>(resolve => { inserted = resolve; });
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
      inserted();
      await writerMayCommit;
    });

    try {
      await insertedPromise;
      const path = `/api/companies/${company.id}/audit/managed-exports`;
      const initial = await board.post(path).send({ from, to: boundary }).expect(201);
      const adjacent = await board.post(path).send({ from: boundary, to }).expect(201);
      expect(initial.body.eventCount).toBe(0);
      expect(adjacent.body.eventCount).toBe(0);

      releaseWriter();
      await lateTransaction;
      const initialPage = await board.get(`${path}/${initial.body.exportId}`).expect(200);
      const adjacentPage = await board.get(`${path}/${adjacent.body.exportId}`).expect(200);
      expect(initialPage.body.events).toEqual([]);
      expect(adjacentPage.body.events).toEqual([]);

      const overlap = await board.post(path).send({ from, to }).expect(201);
      const overlapPage = await board.get(`${path}/${overlap.body.exportId}`).expect(200);
      expect(overlapPage.body.events).toMatchObject([{ id: eventId, source: "tool_gateway" }]);
      expect(overlapPage.body.complete).toBe(true);

      vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", nextEpoch);
      expect((await board.get(`${path}/${overlap.body.exportId}`)).body)
        .toMatchObject({ details: { reasonCode: "source_epoch_changed" } });
      const nextEpochExport = await board.post(path).send({ from, to }).expect(201);
      const nextEpochPage = await board.get(`${path}/${nextEpochExport.body.exportId}`).expect(200);
      expect(nextEpochPage.body.events).toMatchObject([{ id: eventId, source: "tool_gateway" }]);
      const archivedKeys = [overlapPage.body.events[0], nextEpochPage.body.events[0]]
        .map(event => `${event.source}:${event.id}`);
      expect(new Set(archivedKeys).size).toBe(1);
    } finally {
      releaseWriter();
      vi.unstubAllEnvs();
      await lateTransaction;
      await writerDb.$client.end({ timeout: 1 });
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

  it("does not reveal a missing task when a surviving run is bound to another user's private task", async () => {
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
      companyId: company.id, title: "Private surviving binding", visibility: "private", responsibleUserId: randomUUID(),
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, scopeKind: "issue", issueId: privateTask.id,
    }).returning();
    const missingTaskId = randomUUID();
    await db.insert(managedAuditEvents).values({
      companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
      occurredAt: new Date("2026-07-17T00:00:01.000Z"), eventType: "invocation_decision_recorded",
      phase: "policy_decision", decision: "allow", status: "authorized", taskId: missingTaskId,
      runId: run.id, invocationId: randomUUID(),
    });

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
      expect(page.text).not.toContain(missingTaskId);
      expect(page.text).not.toContain(run.id);
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

  it("rejects an audit window whose frozen membership exceeds the bound", async () => {
    const { company, agent } = await seed();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const occurredAt = new Date("2026-07-17T00:00:01.000Z");
    const rows = Array.from({ length: MAX_SNAPSHOT_EVENTS + 1 }, () => ({
      companyId: company.id, actorType: "agent", actorId: agent.id, source: "tool_gateway",
      occurredAt, eventType: "invocation_decision_recorded", phase: "policy_decision",
      decision: "allow", status: "authorized", invocationId: randomUUID(),
    }));
    for (let index = 0; index < rows.length; index += 1_000) {
      await db.insert(managedAuditEvents).values(rows.slice(index, index + 1_000));
    }
    const path = `/api/companies/${company.id}/audit/managed-exports`;
    const window = { from: "2026-07-17T00:00:00.000Z", to: "2026-07-17T00:00:02.000Z" };
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", randomUUID());
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", window.from);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      const response = await board.post(path).send(window);
      expect(response.status, response.text).toBe(409);
      expect(response.body).toMatchObject({ details: { reasonCode: "snapshot_too_large", maxEvents: MAX_SNAPSHOT_EVENTS } });
      expect(await db.select().from(managedAuditExports)).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);

  it("fails closed when another reader holds the export validation lock", async () => {
    const { company } = await seed();
    const userId = randomUUID();
    const sourceEpoch = randomUUID();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: userId, membershipRole: "operator", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id, principalType: "user", principalId: userId, permissionKey: "audit:view_agent_actions",
    });
    const [snapshot] = await db.insert(managedAuditExports).values({
      companyId: company.id, userId, sourceEpoch, from: new Date("2026-07-17T00:00:00.000Z"),
      to: new Date("2026-07-17T00:00:02.000Z"), eventIds: [], watermark: createHash("sha256").update("[]").digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const board = request(await createApp(db, { type: "board", source: "session", userId, companyIds: [company.id] }));
    const key = `managed-audit-export:${snapshot!.id}`;
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_SOURCE_EPOCH", sourceEpoch);
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_CAPTURE_FROM", "2026-07-17T00:00:00.000Z");
    vi.stubEnv("PROPRIO_MANAGED_AUDIT_RETAIN_AFTER", undefined);
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
        const response = await board.get(`/api/companies/${company.id}/audit/managed-exports/${snapshot!.id}`);
        expect(response.status, response.text).toBe(409);
        expect(response.body).toMatchObject({ details: { reasonCode: "snapshot_read_busy" } });
        expect(response.body).not.toHaveProperty("events");
      });
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

describe("managed audit export bounded failure mapping", () => {
  it("maps a cancelled validation query to a fail-closed conflict", async () => {
    const timeoutDb = {
      transaction: async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      },
    } as unknown as Db;
    await expect(readManagedAuditExportPage(timeoutDb, {
      companyId: randomUUID(), sourceEpoch: randomUUID(),
      actor: { type: "board", source: "session", userId: randomUUID(), companyIds: [] },
    }, randomUUID())).rejects.toMatchObject({
      status: 409,
      details: { reasonCode: "snapshot_read_timeout" },
    });
  });
});
