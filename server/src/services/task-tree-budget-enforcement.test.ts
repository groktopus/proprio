import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, approvals, authUsers, budgetIncidents, budgetPolicies, budgetReservations, companies, companyMemberships, costEvents, createDb, heartbeatRuns, issueAccessGrants, issues, type Db } from "@groktopus/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { reserveRunBudget } from "./budget-reservations.js";
import { computeObservedSpend } from "./budget-exposure.js";
import { budgetService, flushBudgetEvaluationWork } from "./budgets.js";
import { activityService } from "./activity.js";
import { agentActionAuditService } from "./agent-action-audit.js";
import { attentionService } from "./attention.js";
import { attentionHandledDetails, attentionHandledFor, attentionReceiptService } from "./attention-receipts.js";
import { canReadDecisionSource } from "./decision-queues.js";
import { dashboardService } from "./dashboard.js";
import { lockTaskTreeBudgetConfiguration } from "./budget-admission-controls.js";
import { canActorReadApproval, issueReadSqlCondition } from "./authorization.js";

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

  it("applies overlapping root and child limits using the admitted run's captured ancestry", async () => {
    const f = await fixture();
    const agent = await f.makeAgent("Worker");
    const capturedRoot = await f.makeIssue("Captured root"), currentRoot = await f.makeIssue("Current root");
    const child = await f.makeIssue("Child task", capturedRoot.id);
    const capturedPolicy = await f.makePolicy(capturedRoot.id, { amount: 100, reservationCents: "0" });
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

    await db.update(budgetPolicies).set({ amount: 100 }).where(eq(budgetPolicies.scopeId, child.id));
    await db.update(budgetPolicies).set({ amount: 50 }).where(eq(budgetPolicies.id, capturedPolicy.id));
    await expect(budgetService(db).getInvocationBlock(f.companyId, agent.id, { runId: run.id }))
      .resolves.toMatchObject({ scopeType: "task_tree", scopeId: capturedRoot.id });
    await db.delete(issues).where(eq(issues.id, capturedRoot.id));
    const retained = await budgetService(db).evaluateAdmission(f.companyId, agent.id, { runId: run.id });
    expect(retained.policies.map(policy => policy.scopeId)).toEqual([child.id]);
    expect(retained.block).toBeNull();
    expect((await computeObservedSpend(db, capturedPolicy)).totalExact).toBe("60.0000000");
  });

  it("resolves a legacy queued task key for its current tree before a reservation exists", async () => {
    const f = await fixture();
    const agent = await f.makeAgent("Legacy worker");
    const root = await f.makeIssue("Shared root"), child = await f.makeIssue("Legacy task", root.id);
    const identifier = `T${f.companyId.slice(0, 5).toUpperCase()}-7`;
    await db.update(issues).set({ identifier }).where(eq(issues.id, child.id));
    await f.makePolicy(root.id, { amount: 500, reservationCents: "0" });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: agent.id, status: "queued", contextSnapshot: { taskKey: identifier },
    }).returning();

    const preflight = await budgetService(db).evaluateAdmission(f.companyId, agent.id, { runId: run!.id });
    expect(preflight.policies.map(policy => policy.scopeId)).toEqual([root.id]);
    const [saved] = await db.select({ lineage: heartbeatRuns.taskLineageJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(saved?.lineage).toBeNull();
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
    expect(approval?.payload).toMatchObject({ scopeId: root.id, scopeType: "task_tree" });
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

  it.each(["root access", "board write access"] as const)("rechecks %s after waiting for a budget policy writer", async (revocation) => {
    const f = await fixture();
    const root = await f.makeIssue("Restricted outcome");
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, root.id));
    const policy = await f.makePolicy(root.id, { amount: 100, reservationCents: "0" });
    const userId = `editor-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Budget editor", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId,
      membershipRole: "operator", status: "active" });
    const [grant] = await db.insert(issueAccessGrants).values({
      issueId: root.id, subjectType: "user", subjectId: userId, source: "explicit",
    }).returning();
    let releasePolicy!: () => void;
    let reportPolicyLock!: (pid: number) => void;
    const hold = new Promise<void>(resolve => { releasePolicy = resolve; });
    const locked = new Promise<number>(resolve => { reportPolicyLock = resolve; });
    const policyLock = db.transaction(async tx => {
      await tx.select({ id: budgetPolicies.id }).from(budgetPolicies).where(eq(budgetPolicies.id, policy.id)).for("update");
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      reportPolicyLock(Number(backend.pid));
      await hold;
    });
    const applicationName = `tree-policy-editor-${randomUUID()}`;
    const writingDb = createDb(database.connectionString, { applicationName, maxConnections: 1 });
    const lockPid = await Promise.race([locked, policyLock.then(() => 0)]);
    vi.stubEnv("PROPRIO_ISSUE_PRIVACY_MODE", "enforce");
    const mutation = budgetService(writingDb).upsertPolicy(f.companyId,
      { scopeType: "task_tree", scopeId: root.id, amount: 350, windowKind: "lifetime" },
      userId, { type: "board", userId, source: "session", companyIds: [f.companyId] });
    void mutation.catch(() => undefined);
    try {
      await expect.poll(async () => {
        const [waiting] = await db.execute(sql`select query from pg_stat_activity
          where application_name = ${applicationName} and ${lockPid} = any(pg_blocking_pids(pid))`);
        return waiting?.query;
      }).toMatch(/from "budget_policies".*for update/);
      if (revocation === "root access") {
        await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant!.id));
      } else {
        await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, f.companyId),
          eq(companyMemberships.principalId, userId)));
      }
    } finally {
      releasePolicy();
      await Promise.allSettled([policyLock, mutation]);
      await writingDb.$client.end();
      vi.unstubAllEnvs();
    }
    await expect(mutation).rejects.toMatchObject({ status: revocation === "root access" ? 404 : 403 });
    const [saved] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    expect(saved?.amount).toBe(100);
  });


  it("puts first-time policy activation ahead of waiting sibling admissions and serializes first saves", async () => {
    const f = await fixture();
    const root = await f.makeIssue("Shared outcome");
    const child = await f.makeIssue("Build", root.id);
    const sibling = await f.makeIssue("Review", root.id);
    const first = await f.makeRun((await f.makeAgent("Builder")).id, child.id);
    const second = await f.makeRun((await f.makeAgent("Reviewer")).id, sibling.id);
    const policy = { scopeType: "task_tree" as const, scopeId: root.id, windowKind: "lifetime" as const,
      amount: 100, reservationCents: "80", hardStopEnabled: true };
    const writerConnection = `tree-activate-${randomUUID()}`;
    const admissionsConnection = `tree-reserve-${randomUUID()}`;
    const writer = createDb(database.connectionString, { applicationName: writerConnection, maxConnections: 2 });
    const admissions = createDb(database.connectionString, { applicationName: admissionsConnection, maxConnections: 2 });
    let unlock!: () => void;
    let signalLocked!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const fence = db.transaction(async tx => {
      await lockTaskTreeBudgetConfiguration(tx as unknown as Db, f.companyId, "exclusive");
      signalLocked();
      await held;
    });
    const waitingWrites = async () => {
      const [state] = await db.execute(sql`select count(*)::int as count from pg_stat_activity
        where application_name = ${writerConnection} and wait_event = 'advisory'`);
      return state?.count;
    };
    const attempts: Promise<unknown>[] = [];
    try {
      await Promise.race([locked, fence]);
      attempts.push(budgetService(writer).upsertPolicy(f.companyId, policy, null));
      attempts.push(budgetService(writer).upsertPolicy(f.companyId, policy, null));
      for (const attempt of attempts) void attempt.catch(() => undefined);
      await expect.poll(waitingWrites).toBe(2);
      const reservations = [first, second].map(run => reserveRunBudget(admissions, f.companyId, run.id, null));
      for (const reservation of reservations) void reservation.catch(() => undefined);
      attempts.push(...reservations);
      await expect.poll(async () => {
        const [state] = await db.execute(sql`select count(*)::int as count from pg_stat_activity
          where application_name = ${admissionsConnection} and wait_event = 'advisory'`);
        return state?.count;
      }).toBe(2);
    } finally {
      unlock();
      await Promise.allSettled([fence, ...attempts]);
      await Promise.all([writer.$client.end(), admissions.$client.end()]);
    }
    const [save1, save2, ...reservations] = await Promise.allSettled(attempts);
    expect([save1?.status, save2?.status]).toEqual(["fulfilled", "fulfilled"]);
    expect(reservations.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(reservations.find(result => result.status === "rejected")).toMatchObject({
      reason: { status: 409, message: "Available budget is reserved by unfinished runs" },
    });
    expect(await db.select({ id: budgetPolicies.id }).from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, f.companyId), eq(budgetPolicies.scopeId, root.id)))).toHaveLength(1);
  });

  it("allows exactly one create-only lifetime policy for the same root", async () => {
    const f = await fixture();
    const root = await f.makeIssue("Shared outcome");
    const budgets = budgetService(db);
    const actor = { type: "board" as const, source: "local_implicit" as const };
    await budgets.upsertPolicy(f.companyId, { scopeType: "task_tree", scopeId: root.id,
      windowKind: "calendar_month_utc", amount: 40 }, "local-board", actor);
    const saves = await Promise.allSettled([100, 250].map(amount => budgets.upsertPolicy(f.companyId, {
      scopeType: "task_tree", scopeId: root.id, windowKind: "lifetime", amount, createOnly: true,
    }, "local-board", actor)));
    const saved = saves.filter(result => result.status === "fulfilled");
    expect(saved).toHaveLength(1);
    expect(saves.find(result => result.status === "rejected")).toMatchObject({
      reason: { status: 409, details: { code: "budget_policy_exists" } },
    });
    const overview = await budgets.overview(f.companyId, { actor });
    expect(overview.policies.find(policy => policy.windowKind === "lifetime")?.amount).toBe(saved[0]!.value.amount);
    expect(overview.policies.find(policy => policy.windowKind === "calendar_month_utc")?.amount).toBe(40);
  });

  it("keeps a hidden root's active budget manageable and rejects stale incident decisions", async () => {
    const f = await fixture();
    const root = await f.makeIssue("Archived outcome");
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, root.id));
    const policy = await f.makePolicy(root.id, { amount: 100, reservationCents: "0" });
    const [incident] = await db.insert(budgetIncidents).values({
      companyId: f.companyId, policyId: policy.id, scopeType: "task_tree", scopeId: root.id,
      metric: "billed_cents", windowKind: "lifetime", windowStart: new Date(0), windowEnd: new Date("9999-01-01"),
      thresholdType: "hard", amountLimit: 100, amountObserved: 100,
    }).returning();
    const actor = { type: "board" as const, source: "local_implicit" as const, userId: "local-board" };
    const service = budgetService(db);
    const overview = await service.overview(f.companyId, { actor });
    expect(overview.policies.map(row => row.scopeId)).toEqual([root.id]);
    expect(overview.activeIncidents.map(row => row.id)).toEqual([incident!.id]);
    await expect(service.resolveIncident(f.companyId, incident!.id,
      { action: "raise_budget_and_resume", amount: 550 }, actor.userId, actor.source, { actor })).resolves.toMatchObject({ status: "resolved" });
    await expect(service.resolveIncident(f.companyId, incident!.id,
      { action: "keep_paused" }, actor.userId, actor.source, { actor })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id)))[0]?.amount).toBe(550);
  });

  it("filters legacy override approvals, queue sources and receipts using current root access", async () => {
    const f = await fixture();
    const root = await f.makeIssue("Confidential budget");
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, root.id));
    const policy = await f.makePolicy(root.id, { amount: 100, reservationCents: "0" });
    const recipient = `budget-owner-${randomUUID()}`;
    await db.insert(authUsers).values({ id: recipient, name: "Budget owner", email: `${recipient}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: recipient,
      membershipRole: "operator", status: "active" });
    await db.update(companies).set({ budgetOwnerUserId: recipient }).where(eq(companies.id, f.companyId));
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "budget_override_required", status: "pending",
      payload: { scopeType: "task_tree", scopeId: root.id, policyId: policy.id } }).returning();
    const [incident] = await db.insert(budgetIncidents).values({
      companyId: f.companyId, policyId: policy.id, scopeType: "task_tree", scopeId: root.id, approvalId: approval!.id,
      metric: "billed_cents", windowKind: "lifetime", windowStart: new Date(0), windowEnd: new Date("9999-01-01"),
      thresholdType: "hard", amountLimit: 100, amountObserved: 100,
    }).returning();
    const actor = { type: "board" as const, source: "session" as const, userId: recipient, companyIds: [f.companyId] };
    const source = { sourceKind: "budget_alert" as const, sourceId: incident!.id };
    const forRecipient = await attentionHandledFor(db, f.companyId, source, "different-operator");
    expect(forRecipient?.issueId).toBe(root.id);
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "user", actorId: "different-operator",
      action: "budget.incident_resolved", entityType: "budget_incident", entityId: incident!.id,
      details: { scopeType: "task_tree", scopeId: root.id,
        ...attentionHandledDetails({ ...forRecipient!, issueId: null }, "limit_raised") } });
    vi.stubEnv("PROPRIO_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const summary = await attentionService(db).summary(f.companyId, { actor, userId: recipient });
      expect(summary.countsBySourceKind.approval ?? 0).toBe(0);
      expect(summary.countsBySourceKind.budget_alert ?? 0).toBe(0);
      await expect(canReadDecisionSource(db, actor, f.companyId, "approval", approval!.id)).resolves.toBe(false);
      await expect(canReadDecisionSource(db, actor, f.companyId, "budget_alert", incident!.id)).resolves.toBe(false);
      await expect(attentionReceiptService(db).list(f.companyId, { actor, userId: recipient })).resolves.toEqual([]);

      await db.insert(issueAccessGrants).values({ issueId: root.id, subjectType: "user", subjectId: recipient, source: "explicit" });
      await expect(canReadDecisionSource(db, actor, f.companyId, "approval", approval!.id)).resolves.toBe(true);
      await expect(canReadDecisionSource(db, actor, f.companyId, "budget_alert", incident!.id)).resolves.toBe(true);
      await expect(attentionReceiptService(db).list(f.companyId, { actor, userId: recipient })).resolves.toMatchObject([{ sourceId: incident!.id }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("filters company-wide budget listings and incidents by readable task roots", async () => {
    const f = await fixture();
    const visibleRoot = await f.makeIssue("Readable outcome"), privateRoot = await f.makeIssue("Private outcome");
    const actor = { type: "agent" as const, companyId: f.companyId, agentId: (await f.makeAgent("Reader")).id };
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, privateRoot.id));
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

    vi.stubEnv("PROPRIO_ISSUE_PRIVACY_MODE", "enforce");
    try {
      const overview = await budgetService(db).overview(f.companyId, { actor });
      const readCondition = await issueReadSqlCondition(db, actor);
      const activity = await activityService(db).list({ companyId: f.companyId, readCondition });

      expect(overview.policies.map(policy => policy.scopeId)).toEqual([visibleRoot.id]);
      expect(overview.activeIncidents.map(incident => incident.scopeId)).toEqual([visibleRoot.id]);
      const scoped = await dashboardService(db).summary(f.companyId, { actor: {
        ...actor, source: "agent_key", keyScope: { kind: "skill_test", issueId: visibleRoot.id },
      } });
      expect(scoped.budgets.activeIncidents).toBe(0);
      expect(activity.map(row => row.details?.scopeId)).toEqual([visibleRoot.id]);
      const audit = await agentActionAuditService(db).list({ companyId: f.companyId, actorScope: "all", limit: 1, issueReadCondition: readCondition });
      expect(audit.items.map(row => row.entityId)).toEqual([visiblePolicy.id]);
      expect(audit.nextCursor).toBeNull();

      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "budget-service",
        action: "budget.cancelled_work_continued", entityType: "issue", entityId: visibleRoot.id,
        details: { budgetIncidentId: randomUUID(), interruptedRunId: randomUUID() } });
      const [receipt] = await activityService(db).forIssue(visibleRoot.id);
      expect(receipt?.details).toHaveProperty("interruptedRunId");
      expect(receipt?.details).not.toHaveProperty("budgetIncidentId");

      await db.delete(budgetIncidents).where(eq(budgetIncidents.policyId, visiblePolicy.id));
      await db.delete(budgetPolicies).where(eq(budgetPolicies.id, visiblePolicy.id));
      const retained = await activityService(db).list({ companyId: f.companyId, readCondition });
      expect(retained.filter(row => row.entityType === "budget_policy").map(row => row.details?.scopeId)).toEqual([visibleRoot.id]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
