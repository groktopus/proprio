import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issues,
  goals,
  projects,
} from "@groktopus/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS,
  issueService,
} from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create deduplication route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue create deduplication routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("proprio-issue-create-deduplication-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Proprio",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  it("replays the existing issue for the same company idempotency key", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Prepare release", idempotencyKey: "run-1:prepare-release" })
      .expect(201);
    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        parentId: parent.id,
        title: "Different retry payload",
        idempotencyKey: "run-1:prepare-release",
        allowDuplicate: true,
      })
      .expect(200);

    expect(replay.body).toMatchObject({
      id: first.body.id,
      title: "Prepare release",
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
    expect(await db.select().from(issueCreateIdempotencyKeys)).toHaveLength(1);
  });

  it("expires old idempotency keys before replay lookup", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const oldIssueId = randomUUID();
    const idempotencyKey = "run-1:expired-retry";
    const expiredCreatedAt = new Date(
      Date.now() - (ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    await db.insert(issues).values({
      id: oldIssueId,
      companyId,
      parentId: parent.id,
      title: "Expired retry target",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueCreateIdempotencyKeys).values({
      companyId,
      idempotencyKey,
      issueId: oldIssueId,
      createdAt: expiredCreatedAt,
    });

    const recreated = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Expired retry creates new work", idempotencyKey })
      .expect(201);

    const rows = await db.select().from(issueCreateIdempotencyKeys);
    expect(recreated.body.id).not.toBe(oldIssueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      idempotencyKey,
      issueId: recreated.body.id,
    });
  });

  it("returns a recent open sibling whose normalized title matches", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Create   a single PR" })
      .expect(201);
    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "  create a SINGLE pr  " })
      .expect(200);

    expect(duplicate.body).toMatchObject({
      id: first.body.id,
      deduplicated: true,
      deduplicationReason: "recent_open_title",
    });
  });

  it("serializes keyed and title-only creates for the same issue", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const [keyed, titleOnly] = await Promise.all([
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Coordinate launch", idempotencyKey: "run-2:coordinate-launch" }),
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Coordinate launch" }),
    ]);

    expect([keyed.status, titleOnly.status].sort()).toEqual([200, 201]);
    expect(keyed.body.id).toBe(titleOnly.body.id);
    expect([keyed, titleOnly].find((response) => response.status === 200)?.body).toMatchObject({
      deduplicated: true,
      deduplicationReason: "recent_open_title",
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(1);
    expect(await db.select().from(issueCreateIdempotencyKeys)).toEqual([
      expect.objectContaining({ issueId: keyed.body.id, idempotencyKey: "run-2:coordinate-launch" }),
    ]);

    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Different title", idempotencyKey: "run-2:coordinate-launch" })
      .expect(200);
    expect(replay.body).toMatchObject({
      id: keyed.body.id,
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
  });

  it("allows an explicit duplicate create", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Investigate incident" })
      .expect(201);
    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Investigate incident", allowDuplicate: true })
      .expect(201);

    expect(duplicate.body.id).not.toBe(first.body.id);
  });

  it("does not apply the route soft guard to internal service creates", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const svc = issueService(db);

    const first = await svc.create(companyId, {
      parentId: parent.id,
      title: "System-generated follow-up",
      status: "todo",
      priority: "medium",
    });
    const second = await svc.create(companyId, {
      parentId: parent.id,
      title: "System-generated follow-up",
      status: "todo",
      priority: "medium",
    });

    expect(second.id).not.toBe(first.id);
  });

  it("does not let closed or older issues block a recreate", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const oldIssueId = randomUUID();
    const closedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: oldIssueId,
        companyId,
        parentId: parent.id,
        title: "Retry old work",
        status: "todo",
        priority: "medium",
        createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000),
      },
      {
        id: closedIssueId,
        companyId,
        parentId: parent.id,
        title: "Retry closed work",
        status: "done",
        priority: "medium",
      },
    ]);

    const recreatedOld = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Retry old work" })
      .expect(201);
    const recreatedClosed = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Retry closed work" })
      .expect(201);

    expect(recreatedOld.body.id).not.toBe(oldIssueId);
    expect(recreatedClosed.body.id).not.toBe(closedIssueId);
  });

  it("preserves explicit task goals and moves inherited goals through the issue API", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const app = createApp();
    const [goalA, goalB, goalC] = await db.insert(goals).values([
      { companyId, title: "Goal A", level: "company", status: "active" },
      { companyId, title: "Goal B", level: "company", status: "active" },
      { companyId, title: "Goal C", level: "company", status: "active" },
    ]).returning();
    const [projectA, projectB] = await db.insert(projects).values([
      { companyId, name: "Project A", goalId: goalA!.id },
      { companyId, name: "Project B", goalId: goalB!.id },
    ]).returning();
    const [foreignGoal] = await db.insert(goals).values({
      companyId: otherCompanyId,
      title: "Foreign goal",
      level: "company",
      status: "active",
    }).returning();

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Cross-company goal", goalId: foreignGoal!.id, allowDuplicate: true })
      .expect(404);

    const explicit = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Explicit A", projectId: projectA!.id, goalId: goalA!.id, allowDuplicate: true })
      .expect(201);
    const inherited = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Inherited A", projectId: projectA!.id, allowDuplicate: true })
      .expect(201);
    expect(explicit.body).not.toHaveProperty("goalOriginGoalId");
    expect(inherited.body).not.toHaveProperty("goalOriginGoalId");

    await request(app).patch(`/api/issues/${explicit.body.id}`)
      .send({ goalId: foreignGoal!.id }).expect(404);

    const explicitPatch = await request(app).patch(`/api/issues/${explicit.body.id}`)
      .send({ projectId: projectB!.id }).expect(200);
    expect(explicitPatch.body).not.toHaveProperty("goalOriginGoalId");
    const inheritedPatch = await request(app).patch(`/api/issues/${inherited.body.id}`)
      .send({ projectId: projectB!.id }).expect(200);
    expect(inheritedPatch.body).not.toHaveProperty("goalOriginGoalId");
    const child = await request(app).post(`/api/issues/${inherited.body.id}/children`)
      .send({ title: "Inherited destination child", projectId: projectA!.id, allowDuplicate: true })
      .expect(201);
    expect(child.body).toMatchObject({ goalId: goalA!.id, goalOrigin: "inherited" });
    expect(child.body).not.toHaveProperty("goalOriginGoalId");
    const list = await request(app).get(`/api/companies/${companyId}/issues?view=index`).expect(200);
    expect(list.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: explicit.body.id }),
      expect.objectContaining({ id: inherited.body.id }),
    ]));
    expect(JSON.stringify(list.body)).not.toContain("goalOriginGoalId");

    const [explicitRow] = await db.select().from(issues).where(eq(issues.id, explicit.body.id));
    const [inheritedRow] = await db.select().from(issues).where(eq(issues.id, inherited.body.id));
    expect(explicitRow).toMatchObject({ goalId: goalA!.id, goalOrigin: "explicit", projectId: projectB!.id });
    expect(inheritedRow).toMatchObject({ goalId: goalB!.id, goalOrigin: "inherited", projectId: projectB!.id });

    const detail = await request(app).get(`/api/issues/${explicit.body.id}`).expect(200);
    const context = await request(app).get(`/api/issues/${explicit.body.id}/heartbeat-context`).expect(200);
    expect(detail.body.goalId).toBe(goalA!.id);
    expect(context.body.issue.goalId).toBe(detail.body.goalId);

    await request(app).patch(`/api/issues/${explicit.body.id}`)
      .send({ projectId: projectA!.id, goalId: goalC!.id }).expect(200);
    let changed = await db.select().from(issues).where(eq(issues.id, explicit.body.id)).then((rows) => rows[0]!);
    expect(changed).toMatchObject({ projectId: projectA!.id, goalId: goalC!.id, goalOrigin: "explicit" });
    await request(app).patch(`/api/issues/${explicit.body.id}`)
      .send({ projectId: projectB!.id, goalId: null }).expect(200);
    changed = await db.select().from(issues).where(eq(issues.id, explicit.body.id)).then((rows) => rows[0]!);
    expect(changed).toMatchObject({ projectId: projectB!.id, goalId: goalB!.id, goalOrigin: "inherited" });
  });

  it("resolves goal binding from the row locked for a concurrent update", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const [goalA, goalB, goalC] = await db.insert(goals).values([
      { companyId, title: "Concurrent A", level: "company", status: "active" },
      { companyId, title: "Concurrent B", level: "company", status: "active" },
      { companyId, title: "Concurrent C", level: "company", status: "active" },
    ]).returning();
    const [projectA, projectB] = await db.insert(projects).values([
      { companyId, name: "Concurrent Project A", goalId: goalA!.id },
      { companyId, name: "Concurrent Project B", goalId: goalB!.id },
    ]).returning();
    const explicit = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Concurrent explicit", projectId: projectA!.id, goalId: goalA!.id, allowDuplicate: true })
      .expect(201);
    const inherited = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Concurrent inherited", projectId: projectA!.id, allowDuplicate: true })
      .expect(201);

    async function queueTwoUpdates(issueId: string, firstPatch: Record<string, unknown>, secondPatch: Record<string, unknown>) {
      let markLocked!: () => void;
      let release!: () => void;
      const rowLocked = new Promise<void>((resolve) => { markLocked = resolve; });
      const mayCommit = new Promise<void>((resolve) => { release = resolve; });
      const blocker = db.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
        markLocked();
        await mayCommit;
      });
      await rowLocked;

      let first: Promise<unknown> | undefined;
      let second: Promise<unknown> | undefined;
      const waitingUpdates = async () => (await db.execute<{ count: number }>(sql`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `))[0]!.count;
      try {
        first = request(app).patch(`/api/issues/${issueId}`).send(firstPatch).expect(200).then((response) => response);
        await expect.poll(waitingUpdates, { timeout: 5000 }).toBe(1);
        second = request(app).patch(`/api/issues/${issueId}`).send(secondPatch).expect(200).then((response) => response);
        await expect.poll(waitingUpdates, { timeout: 5000 }).toBe(2);
        release();
        await blocker;
        await Promise.all([first, second]);
      } finally {
        release();
        await blocker;
        await Promise.allSettled([first, second].filter((pending): pending is Promise<unknown> => pending !== undefined));
      }
    }

    await queueTwoUpdates(explicit.body.id, { goalId: goalC!.id }, { title: "Concurrent explicit after wait" });
    const [afterExplicit] = await db.select().from(issues).where(eq(issues.id, explicit.body.id));
    expect(afterExplicit).toMatchObject({ goalId: goalC!.id, goalOrigin: "explicit", title: "Concurrent explicit after wait" });

    await queueTwoUpdates(inherited.body.id, { projectId: projectB!.id }, { title: "Concurrent inherited after wait" });
    const [afterInherited] = await db.select().from(issues).where(eq(issues.id, inherited.body.id));
    expect(afterInherited).toMatchObject({ projectId: projectB!.id, goalId: goalB!.id, goalOrigin: "inherited", title: "Concurrent inherited after wait" });
  });

  it("rejects a foreign explicit goal before stopping the issue's live run", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const app = createApp();
    const [foreignGoal] = await db.insert(goals).values({
      companyId: otherCompanyId,
      title: "Foreign live-run goal",
      level: "company",
      status: "active",
    }).returning();
    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Live-run task", allowDuplicate: true })
      .expect(201);
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Live-run owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.update(issues).set({
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      checkoutRunId: runId,
    }).where(eq(issues.id, created.body.id));

    await request(app).patch(`/api/issues/${created.body.id}`)
      .send({ status: "done", projectId: null, goalId: foreignGoal!.id })
      .expect(404);

    const [taskAfter] = await db.select().from(issues).where(eq(issues.id, created.body.id));
    const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(taskAfter).toMatchObject({ status: "in_progress", executionRunId: runId });
    expect(runAfter?.status).toBe("running");
  });

  it("keeps legacy rows with unknown origin on the prior fallback heuristic", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const [goalA, goalB] = await db.insert(goals).values([
      { companyId, title: "Legacy A", level: "company", status: "active" },
      { companyId, title: "Legacy B", level: "company", status: "active" },
    ]).returning();
    const [projectA, projectB] = await db.insert(projects).values([
      { companyId, name: "Legacy Project A", goalId: goalA!.id },
      { companyId, name: "Legacy Project B", goalId: goalB!.id },
    ]).returning();
    const [legacy] = await db.insert(issues).values({
      companyId, title: "Legacy task", projectId: projectA!.id, goalId: goalA!.id,
    }).returning();
    expect(legacy!.goalOrigin).toBe("unknown");

    await request(app).patch(`/api/issues/${legacy!.id}`)
      .send({ projectId: projectB!.id }).expect(200);
    const [moved] = await db.select().from(issues).where(eq(issues.id, legacy!.id));
    expect(moved).toMatchObject({ goalId: goalB!.id, goalOrigin: "unknown" });
  });

  it("invalidates provenance when a mixed-version writer changes goalId", async () => {
    const companyId = await seedCompany();
    const app = createApp();
    const [goalA, goalB] = await db.insert(goals).values([
      { companyId, title: "Mixed-version A", level: "company", status: "active" },
      { companyId, title: "Mixed-version B", level: "company", status: "active" },
    ]).returning();
    const [projectA, projectB] = await db.insert(projects).values([
      { companyId, name: "Mixed-version Project A", goalId: goalA!.id },
      { companyId, name: "Mixed-version Project B", goalId: goalB!.id },
    ]).returning();
    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Mixed-version task", projectId: projectA!.id, goalId: goalA!.id, allowDuplicate: true })
      .expect(201);

    // Simulate an older server that only knows about goal_id. Its write leaves
    // the marker associated with A behind while changing the live choice to B.
    await db.update(issues).set({ goalId: goalB!.id })
      .where(eq(issues.id, created.body.id));
    await request(app).get(`/api/issues/${created.body.id}`).expect(200)
      .then((response) => {
        expect(response.body.goalOrigin).toBe("unknown");
        expect(response.body).not.toHaveProperty("goalOriginGoalId");
      });

    await request(app).patch(`/api/issues/${created.body.id}`)
      .send({ projectId: projectB!.id }).expect(200);
    const [moved] = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(moved).toMatchObject({
      projectId: projectB!.id,
      goalId: goalB!.id,
      goalOrigin: "unknown",
      goalOriginGoalId: goalB!.id,
    });
  });

  it("stores the request run header on manual creates", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const runId = randomUUID();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Creating agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("X-Proprio-Run-Id", runId)
      .send({ parentId: parent.id, title: "Attributed create" })
      .expect(201);
    const [created] = await db.select().from(issues).where(eq(issues.id, response.body.id));

    expect(created.originKind).toBe("manual");
    expect(created.originRunId).toBe(runId);
  });
});
