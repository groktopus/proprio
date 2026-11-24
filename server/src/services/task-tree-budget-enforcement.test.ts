import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, approvals, budgetIncidents, budgetPolicies, budgetReservations, companies, costEvents, createDb, heartbeatRuns, issues, type Db } from "@groktopus/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { reserveRunBudget } from "./budget-reservations.js";
import { computeObservedSpend } from "./budget-exposure.js";
import { budgetService, flushBudgetEvaluationWork } from "./budgets.js";
import { activityService } from "./activity.js";
import { canActorReadApproval } from "./authorization.js";

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
    expect(next!.taskLineageJson).toEqual({ version: 1, issueId: task.id, pathIssueIds: [task.id, newRoot.id] });
  });

  it("applies overlapping root and child limits using the admitted run's captured ancestry", async () => {
    const f = await fixture();
    const agent = await f.makeAgent("Worker");
    const capturedRoot = await f.makeIssue("Captured root"), currentRoot = await f.makeIssue("Current root");
    const child = await f.makeIssue("Child task", capturedRoot.id);
    await f.makePolicy(capturedRoot.id, { amount: 100, reservationCents: "0" });
    await f.makePolicy(child.id, { amount: 50, reservationCents: "0" });
    await f.makePolicy(currentRoot.id, { amount: 500, reservationCents: "0" });
    const run = await f.makeRun(agent.id, child.id, "running");
    await reserveRunBudget(db, f.companyId, run.id, null);
    await db.update(issues).set({ parentId: currentRoot.id }).where(eq(issues.id, child.id));
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: agent.id, issueId: child.id, heartbeatRunId: run.id,
      provider: "test", biller: "test", billingType: "metered_api", costStatus: "priced", model: "test-model", costCents: 60,
      occurredAt: new Date() });

    const admittedRun = await budgetService(db).evaluateAdmission(f.companyId, agent.id, {
      issueId: child.id, projectId: null, runId: run.id,
    });
    expect(admittedRun.policies.map(policy => policy.scopeId).sort()).toEqual([capturedRoot.id, child.id].sort());
    expect(admittedRun.observations.map(observed => observed.totalExact)).toEqual(["60.0000000", "60.0000000"]);
    expect(admittedRun.block).toMatchObject({ scopeType: "task_tree", scopeId: child.id });
    await expect(budgetService(db).getInvocationBlock(f.companyId, agent.id, {
      issueId: child.id, runId: run.id,
    })).resolves.toMatchObject({ scopeType: "task_tree", scopeId: child.id });

    const freshPreflight = await budgetService(db).evaluateAdmission(f.companyId, agent.id, { issueId: child.id });
    expect(freshPreflight.policies.map(policy => policy.scopeId).sort()).toEqual([currentRoot.id, child.id].sort());
  });

  it("reevaluates the matching historical tree after queued cost changes", async () => {
    const f = await fixture();
    const agent = await f.makeAgent("Worker");
    const root = await f.makeIssue("Shared outcome"), task = await f.makeIssue("Build", root.id);
    await db.update(issues).set({ visibility: "private", assigneeAgentId: agent.id }).where(eq(issues.id, root.id));
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
    const [approval] = await db.select().from(approvals).where(eq(approvals.companyId, f.companyId));
    expect(approval?.payload).toMatchObject({ issueId: root.id, scopeId: root.id, scopeType: "task_tree" });
    vi.stubEnv("PROPRIO_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const owner = { type: "agent" as const, companyId: f.companyId, agentId: agent.id };
      const outsider = { ...owner, agentId: randomUUID() };
      await expect(canActorReadApproval(db, owner, approval!.id)).resolves.toBe(true);
      await expect(canActorReadApproval(db, outsider, approval!.id)).resolves.toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }

  });

  it("filters company-wide budget listings and incidents by readable task roots", async () => {
    const f = await fixture();
    const visibleRoot = await f.makeIssue("Readable outcome"), privateRoot = await f.makeIssue("Private outcome");
    const visiblePolicy = await f.makePolicy(visibleRoot.id, { amount: 100, reservationCents: "0" });
    const privatePolicy = await f.makePolicy(privateRoot.id, { amount: 100, reservationCents: "0" });
    const windowStart = new Date(0), windowEnd = new Date("9999-01-01T00:00:00Z");
    await db.insert(budgetIncidents).values([visiblePolicy, privatePolicy].map(policy => ({
      companyId: f.companyId, policyId: policy.id, scopeType: "task_tree", scopeId: policy.scopeId,
      metric: "billed_cents", windowKind: "lifetime", windowStart, windowEnd, thresholdType: "hard",
      amountLimit: 100, amountObserved: 100,
    })));
    await db.insert(activityLog).values([visiblePolicy, privatePolicy].map(policy => ({
      companyId: f.companyId, actorType: "user", actorId: "board", action: "budget.policy_upserted",
      entityType: "budget_policy", entityId: policy.id,
      details: { scopeType: "task_tree", scopeId: policy.scopeId },
    })));

    const overview = await budgetService(db).overview(f.companyId, { visibleTaskTreeScopeIds: [visibleRoot.id] });
    const activity = await activityService(db).list({ companyId: f.companyId, visibleBudgetTaskTreeScopeIds: [visibleRoot.id] });

    expect(overview.policies.map(policy => policy.scopeId)).toEqual([visibleRoot.id]);
    expect(overview.activeIncidents.map(incident => incident.scopeId)).toEqual([visibleRoot.id]);
    expect(activity.map(row => row.details?.scopeId)).toEqual([visibleRoot.id]);
  });
});
