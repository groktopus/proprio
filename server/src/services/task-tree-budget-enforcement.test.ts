import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, budgetPolicies, budgetReservations, companies, costEvents, createDb, heartbeatRuns, issues, type Db } from "@groktopus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { reserveRunBudget } from "./budget-reservations.js";
import { computeObservedSpend } from "./budget-exposure.js";
import { budgetService, flushBudgetEvaluationWork } from "./budgets.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("task-tree budget admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("task-tree-budget-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Task tree budget", issuePrefix: `T${companyId.slice(0, 5)}` });
    const makeAgent = async (name: string) => {
      const [agent] = await db.insert(agents).values({ companyId, name, role: "engineer", status: "idle", adapterType: "process" }).returning();
      return agent!;
    };
    const makeIssue = async (title: string, parentId: string | null = null) => {
      const [issue] = await db.insert(issues).values({ companyId, title, parentId }).returning();
      return issue!;
    };
    const makeRun = async (agentId: string, issueId: string, status: "queued" | "running" = "queued") => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "assignment", status }).returning();
      return run!;
    };
    const makePolicy = async (scopeId: string, options: { amount: number; reservationCents: string }) => {
      const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "task_tree", scopeId, metric: "billed_cents",
        windowKind: "lifetime", amount: options.amount, reservationCents: options.reservationCents,
        hardStopEnabled: true, unpricedUsagePolicy: "block", notifyEnabled: false }).returning();
      return policy!;
    };
    return { companyId, makeAgent, makeIssue, makeRun, makePolicy };
  }

  it("serializes sibling reservations, leaves unrelated work eligible, and includes the held estimate", async () => {
    const f = await fixture();
    const firstAgent = await f.makeAgent("First worker"), secondAgent = await f.makeAgent("Second worker");
    const root = await f.makeIssue("Shared outcome");
    const siblingA = await f.makeIssue("Build", root.id), siblingB = await f.makeIssue("Review", root.id);
    await f.makePolicy(root.id, { amount: 100, reservationCents: "80" });
    const firstRun = await f.makeRun(firstAgent.id, siblingA.id), secondRun = await f.makeRun(secondAgent.id, siblingB.id);

    const results = await Promise.allSettled([
      reserveRunBudget(db, f.companyId, firstRun.id, null),
      reserveRunBudget(db, f.companyId, secondRun.id, null),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const blocked = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(blocked.reason).toMatchObject({ status: 409, message: "Available budget is reserved by unfinished runs" });
    const treePolicy = (await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, root.id)))[0]!;
    const winningRun = results[0]!.status === "fulfilled" ? firstRun : secondRun;
    await db.update(heartbeatRuns).set({ status: "running", costAccountingPending: true,
      usageJson: { provider: "unknown", billingType: "unknown", usageBasis: "per_run" } }).where(eq(heartbeatRuns.id, winningRun.id));
    const observed = await computeObservedSpend(db, treePolicy);
    expect(observed.effectiveHeldCents).toBe("80.0000000");
    const anotherSibling = await f.makeIssue("Another sibling", root.id);
    const anotherRun = await f.makeRun(firstAgent.id, anotherSibling.id);
    await expect(reserveRunBudget(db, f.companyId, anotherRun.id, null)).rejects.toMatchObject({ status: 409 });

    const unrelatedRoot = await f.makeIssue("Separate outcome");
    const unrelatedTask = await f.makeIssue("Independent task", unrelatedRoot.id);
    const unrelatedRun = await f.makeRun(secondAgent.id, unrelatedTask.id);
    await expect(reserveRunBudget(db, f.companyId, unrelatedRun.id, null)).resolves.toMatchObject({ reused: false });
  });

  it("enforces overlapping tree budgets and charges one hold to both scopes", async () => {
    const f = await fixture();
    const agent = await f.makeAgent("Worker");
    const outer = await f.makeIssue("Outer root");
    const inner = await f.makeIssue("Nested root", outer.id);
    const task = await f.makeIssue("Nested work", inner.id);
    const sibling = await f.makeIssue("Sibling work", outer.id);
    const outerPolicy = await f.makePolicy(outer.id, { amount: 100, reservationCents: "60" });
    const innerPolicy = await f.makePolicy(inner.id, { amount: 80, reservationCents: "70" });
    const first = await f.makeRun(agent.id, task.id);
    const second = await f.makeRun(agent.id, sibling.id);

    await expect(reserveRunBudget(db, f.companyId, first.id, null)).resolves.toMatchObject({ amountCents: "70.0000000" });
    await expect(computeObservedSpend(db, outerPolicy)).resolves.toMatchObject({ effectiveHeldCents: "70.0000000" });
    await expect(computeObservedSpend(db, innerPolicy)).resolves.toMatchObject({ effectiveHeldCents: "70.0000000" });
    await expect(reserveRunBudget(db, f.companyId, second.id, null)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId))).toHaveLength(1);
  });

  it("attributes settled spend to the captured tree after the task is reparented", async () => {
    const f = await fixture();
    const agent = await f.makeAgent("Worker");
    const originalRoot = await f.makeIssue("Original outcome"), newRoot = await f.makeIssue("New outcome");
    const task = await f.makeIssue("Task", originalRoot.id);
    const run = await f.makeRun(agent.id, task.id, "running");
    const policy = await f.makePolicy(originalRoot.id, { amount: 500, reservationCents: "100" });
    await reserveRunBudget(db, f.companyId, run.id, null);
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: agent.id, issueId: task.id, heartbeatRunId: run.id,
      provider: "test", biller: "test", billingType: "metered_api", costStatus: "priced", model: "test-model", costCents: 45,
      occurredAt: new Date() });
    await db.update(heartbeatRuns).set({ status: "succeeded", costAccountingPending: false, costAccountedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await db.update(budgetReservations).set({ state: "settled", settledAt: new Date() })
      .where(and(eq(budgetReservations.companyId, f.companyId), eq(budgetReservations.runId, run.id)));
    await db.update(issues).set({ parentId: newRoot.id }).where(eq(issues.id, task.id));

    await expect(computeObservedSpend(db, policy)).resolves.toMatchObject({ ledgerCents: "45.0000000", totalExact: "45.0000000" });
    const newTreePolicy = await f.makePolicy(newRoot.id, { amount: 500, reservationCents: "100" });
    await expect(computeObservedSpend(db, newTreePolicy)).resolves.toMatchObject({ ledgerCents: "0.0000000", totalExact: "0.0000000" });

    const nextRun = await f.makeRun(agent.id, task.id);
    await reserveRunBudget(db, f.companyId, nextRun.id, null);
    const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nextRun.id));
    expect(next!.taskLineageJson).toEqual({ version: 1, pathIssueIds: [task.id, newRoot.id] });
  });

  it("reevaluates the matching historical tree after queued cost changes", async () => {
    const f = await fixture();
    const agent = await f.makeAgent("Worker");
    const root = await f.makeIssue("Shared outcome"), task = await f.makeIssue("Build", root.id);
    const run = await f.makeRun(agent.id, task.id, "running");
    const policy = await f.makePolicy(root.id, { amount: 50, reservationCents: "0" });
    await reserveRunBudget(db, f.companyId, run.id, null);
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: agent.id, issueId: task.id,
      heartbeatRunId: run.id, provider: "test", biller: "test", billingType: "metered_api", costStatus: "priced",
      model: "test-model", costCents: 60, occurredAt: new Date() });
    await expect(computeObservedSpend(db, policy)).resolves.toMatchObject({ totalExact: "60.0000000" });

    await budgetService(db).evaluateAffectedScopes(f.companyId, agent.id, null);
    await expect(flushBudgetEvaluationWork(db, { companyId: f.companyId })).resolves.toBe(2);

    const [updatedPolicy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    expect(updatedPolicy!.enforcementVersion).toBeGreaterThan(0);
    expect(company!.status).toBe("active");
  });
});
