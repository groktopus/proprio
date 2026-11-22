import { randomUUID } from "node:crypto";
import { companies, createDb, goals, projects } from "@groktopus/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyService } from "../services/companies.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("company deletion with a project goal", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("proprio-company-project-goal-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await db?.$client.end({ timeout: 1 });
    } finally {
      await tempDb?.cleanup();
    }
  });

  it("deletes the referencing project before its goal and leaves another company intact", async () => {
    const database = db!;
    async function seedCompany(issuePrefix: string) {
      const companyId = randomUUID();
      const goalId = randomUUID();
      const projectId = randomUUID();
      await database.insert(companies).values({ id: companyId, name: issuePrefix, issuePrefix });
      await database.insert(goals).values({ id: goalId, companyId, title: "Fixture goal" });
      await database.insert(projects).values({ id: projectId, companyId, goalId, name: "Fixture project" });
      return { companyId, goalId, projectId };
    }

    const target = await seedCompany("DEL");
    const unrelated = await seedCompany("KEEP");

    await expect(companyService(database).remove(target.companyId)).resolves.toMatchObject({ id: target.companyId });
    await expect(database.select().from(companies).where(eq(companies.id, target.companyId))).resolves.toHaveLength(0);
    await expect(database.select().from(projects).where(eq(projects.id, target.projectId))).resolves.toHaveLength(0);
    await expect(database.select().from(goals).where(eq(goals.id, target.goalId))).resolves.toHaveLength(0);
    await expect(database.select().from(companies).where(eq(companies.id, unrelated.companyId))).resolves.toHaveLength(1);
    await expect(database.select().from(goals).where(eq(goals.id, unrelated.goalId))).resolves.toHaveLength(1);
    await expect(database.select().from(projects).where(eq(projects.id, unrelated.projectId))).resolves.toMatchObject([
      { companyId: unrelated.companyId, goalId: unrelated.goalId },
    ]);
  });
});
