import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import {
  activityLog,
  companies,
  createDb,
  goals,
  issues,
  projectGoals,
  projects as projectsTable,
} from "@groktopus/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { projectService } from "../services/projects.js";
import { goalRoutes } from "../routes/goals.js";
import { errorHandler } from "../middleware/error-handler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project goal validation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A project's goals must exist and belong to the same company. Before this
// validation, a nonexistent goal id died at the projects.goal_id foreign key
// as an opaque 500 (observed live 2026-09-03, retried four times by the
// caller), and a goal from another company linked silently — the foreign key
// proves existence, not ownership.
describeEmbeddedPostgres("project goal validation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("proprio-project-goal-validation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectGoals);
    await db.delete(projectsTable);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string): Promise<string> {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `GV${prefixCounter}` })
      .returning();
    return company.id;
  }

  async function seedGoal(companyId: string, title: string): Promise<string> {
    const [goal] = await db
      .insert(goals)
      .values({ companyId, title, level: "task", status: "active" })
      .returning();
    return goal.id;
  }

  function deleteGoal(companyId: string, goalId: string) {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "fixture-board", source: "session", companyIds: [companyId] };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);
    return request(app).delete(`/api/goals/${goalId}`);
  }

  function deletionEvents(goalId: string) {
    return db.select().from(activityLog)
      .where(and(eq(activityLog.action, "goal.deleted"), eq(activityLog.entityId, goalId)));
  }

  it.each(["primary", "secondary", "legacy"] as const)(
    "returns a project conflict when deleting a goal linked as %s",
    async (link) => {
      const companyId = await seedCompany("Project link");
      const goalId = await seedGoal(companyId, "Linked goal");
      const otherGoalId = await seedGoal(companyId, "Another goal");
      const project = link === "legacy"
        ? (await db.insert(projectsTable).values({ companyId, name: "Legacy project", goalId }).returning())[0]!
        : await projectService(db).create(companyId, {
          name: "Rocket",
          goalIds: link === "primary" ? [goalId, otherGoalId] : [otherGoalId, goalId],
        });

      const response = await deleteGoal(companyId, goalId);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: "Remove this goal from its linked projects before deleting it.",
        details: { code: "goal_in_use", relationship: "project" },
      });
      const [stored] = await db.select().from(projectsTable).where(eq(projectsTable.id, project.id));
      expect(stored?.goalId).toBe(link === "secondary" ? otherGoalId : goalId);
      const links = await db.select().from(projectGoals).where(eq(projectGoals.projectId, project.id));
      expect(links.map(row => row.goalId).sort()).toEqual(link === "legacy" ? [] : [goalId, otherGoalId].sort());
      expect(await deletionEvents(goalId)).toEqual([]);
    },
  );

  it.each([
    ["child_goal", "Move or remove this goal's child goals before deleting it."],
    ["task", "Remove this goal from its linked tasks before deleting it."],
  ] as const)("returns an actionable %s deletion conflict", async (relationship, message) => {
    const companyId = await seedCompany("Dependent rows");
    const goalId = await seedGoal(companyId, "Linked goal");
    if (relationship === "child_goal") {
      await db.insert(goals).values({ companyId, title: "Child goal", parentId: goalId });
    } else {
      await db.insert(issues).values({ companyId, title: "Linked task", goalId });
    }

    const response = await deleteGoal(companyId, goalId);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: message, details: { code: "goal_in_use", relationship } });
    expect(await db.select().from(goals).where(eq(goals.id, goalId))).toHaveLength(1);
    expect(await deletionEvents(goalId)).toEqual([]);
  });

  it("deletes a standalone goal once and logs the successful mutation", async () => {
    const companyId = await seedCompany("Standalone");
    const goalId = await seedGoal(companyId, "Standalone goal");
    const foreignCompanyId = await seedCompany("Other company");
    await deleteGoal(foreignCompanyId, goalId).expect(404);

    const response = await deleteGoal(companyId, goalId);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(goalId);
    await deleteGoal(companyId, goalId).expect(404);
    expect(await db.select().from(goals).where(eq(goals.id, goalId))).toEqual([]);
    expect(await deletionEvents(goalId)).toMatchObject([{ companyId, actorId: "fixture-board" }]);
  });

  it("rolls back goal deletion when its activity record cannot be inserted", async () => {
    const companyId = await seedCompany("Audit failure");
    const goalId = await seedGoal(companyId, "Recoverable goal");
    await db.execute(sql`
      create function test_reject_goal_delete_audit() returns trigger language plpgsql as $$
      begin raise exception 'fixture activity write failure'; end;
      $$
    `);
    try {
      await db.execute(sql`
        create trigger test_reject_goal_delete_audit before insert on activity_log
        for each row when (new.action = 'goal.deleted')
        execute function test_reject_goal_delete_audit()
      `);
      try {
        await deleteGoal(companyId, goalId).expect(500);
        expect(await db.select().from(goals).where(eq(goals.id, goalId))).toHaveLength(1);
        expect(await deletionEvents(goalId)).toEqual([]);
      } finally {
        await db.execute(sql`drop trigger test_reject_goal_delete_audit on activity_log`);
      }
    } finally {
      await db.execute(sql`drop function test_reject_goal_delete_audit()`);
    }

    await deleteGoal(companyId, goalId).expect(200);
    expect(await deletionEvents(goalId)).toHaveLength(1);
  });

  function expectUnprocessable(error: unknown, unknownGoalId: string) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
    expect((error as Error).message).toContain(unknownGoalId);
  }

  it("creates and links a project to a goal of the same company", async () => {
    const companyId = await seedCompany("Valid Co");
    const goalId = await seedGoal(companyId, "Ship it");
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Rocket", goalIds: [goalId] });
    expect(created.goalIds).toEqual([goalId]);
  });

  it("rejects a create whose goal id does not exist, before any insert", async () => {
    const companyId = await seedCompany("Missing Goal Co");
    const projects = projectService(db);
    const ghost = "db7da378-99a6-43ea-964f-000000000000";

    const failure = await projects
      .create(companyId, { name: "Rocket", goalIds: [ghost] })
      .then(() => null, (error: unknown) => error);
    expectUnprocessable(failure, ghost);

    const rows = await db.select({ id: projectsTable.id }).from(projectsTable);
    expect(rows).toHaveLength(0);
  });

  it("rejects the legacy single goalId field the same way", async () => {
    const companyId = await seedCompany("Legacy Field Co");
    const projects = projectService(db);
    const ghost = "db7da378-99a6-43ea-964f-111111111111";

    const failure = await projects
      .create(companyId, { name: "Rocket", goalId: ghost })
      .then(() => null, (error: unknown) => error);
    expectUnprocessable(failure, ghost);
  });

  it("rejects another company's goal on create — the FK only proves existence", async () => {
    const companyId = await seedCompany("Home Co");
    const otherCompanyId = await seedCompany("Other Co");
    const foreignGoalId = await seedGoal(otherCompanyId, "Not yours");
    const projects = projectService(db);

    const failure = await projects
      .create(companyId, { name: "Rocket", goalIds: [foreignGoalId] })
      .then(() => null, (error: unknown) => error);
    expectUnprocessable(failure, foreignGoalId);
  });

  it("ignores the legacy goalId when an explicit empty goalIds list wins resolution", async () => {
    // goalIds and goalId may arrive together; the resolved set (goalIds
    // first) is canonical for persistence too. Before this rule, an empty
    // list skipped validation while the raw legacy id was still written —
    // unvalidated, and unchecked for ownership.
    const companyId = await seedCompany("Conflicting Fields Co");
    const otherCompanyId = await seedCompany("Conflicting Other Co");
    const foreignGoalId = await seedGoal(otherCompanyId, "Should not link");
    const projects = projectService(db);

    const created = await projects.create(companyId, {
      name: "Rocket",
      goalIds: [],
      goalId: foreignGoalId,
    });
    expect(created.goalIds).toEqual([]);

    const [row] = await db
      .select({ goalId: projectsTable.goalId })
      .from(projectsTable)
      .where(eq(projectsTable.id, created.id));
    expect(row.goalId).toBeNull();
  });

  it("rejects an update to an unknown or foreign goal and leaves links unchanged", async () => {
    const companyId = await seedCompany("Update Co");
    const otherCompanyId = await seedCompany("Update Other Co");
    const goodGoalId = await seedGoal(companyId, "Good goal");
    const foreignGoalId = await seedGoal(otherCompanyId, "Foreign goal");
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Rocket", goalIds: [goodGoalId] });

    const failure = await projects
      .update(created.id, { goalIds: [foreignGoalId] })
      .then(() => null, (error: unknown) => error);
    expectUnprocessable(failure, foreignGoalId);

    const fetched = await projects.getById(created.id);
    expect(fetched?.goalIds).toEqual([goodGoalId]);
  });
});
