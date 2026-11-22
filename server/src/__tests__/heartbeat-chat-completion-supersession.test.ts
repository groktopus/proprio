import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, authUsers, chatCompletionDeliveries, chatTaskHandoffs, companies, companyMemberships, createDb,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@groktopus/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createHeartbeatAgentStatus } from "../services/heartbeat/agent-status.js";
import * as chatCompletionDelivery from "../services/chat-completion-delivery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const { CHAT_COMPLETION_WAKE_REASON } = chatCompletionDelivery;
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("Agent Chat supersession through heartbeat", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const adapterType = "codex_local";
  const execute = vi.fn(async (_input: { runId: string }) => ({
    exitCode: 0, signal: null, timedOut: false, resultJson: {},
  }));
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("proprio-superseded-chat-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({ type: adapterType, supportsLocalAgentJwt: false, execute,
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
  }, 90_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end();
    await database?.cleanup();
  });

  async function queuedSupersession() {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Chat owner", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Chat supersession",
      issuePrefix: `C${userId.slice(0, 8)}`, defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalId: userId,
      principalType: "user", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Chat agent", adapterType,
      status: "idle", lifecycleState: "ready", runtimeConfig: { heartbeat: { maxConcurrentRuns: 2, wakeOnDemand: true } } }).returning();
    const [chat] = await db.insert(issues).values({ companyId: company.id, title: "Chat", status: "in_progress",
      assigneeAgentId: agent.id, responsibleUserId: userId, conversationAgentId: agent.id, conversationUserId: userId,
      conversationState: "active", conversationSessionGeneration: 2 }).returning();
    const contextSnapshot = { issueId: chat.id, taskId: chat.id, wakeReason: CHAT_COMPLETION_WAKE_REASON,
      conversationSessionGeneration: 1, conversationMode: true, chatCompletionDeliveryIds: [randomUUID()] };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id,
      source: "automation", triggerDetail: "system", status: "queued", reason: CHAT_COMPLETION_WAKE_REASON,
      requestedByActorType: "system", requestedByActorId: "chat_completion_delivery", payload: { issueId: chat.id } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "queued",
      issueId: chat.id, scopeKind: "issue", invocationSource: "automation", triggerDetail: "system",
      responsibleUserId: userId, wakeupRequestId: wake.id, contextSnapshot }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    await db.update(issues).set({ executionRunId: run.id, executionLockedAt: new Date() }).where(eq(issues.id, chat.id));
    return { company, agent, chat, run, wake, userId };
  }

  async function assertQuietSettlement(f: Awaited<ReturnType<typeof queuedSupersession>>) {
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({
      status: "succeeded", errorCode: "chat_completion_superseded", error: null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id)))[0])
      .toMatchObject({ status: "skipped", runId: f.run.id, error: null });
    expect(execute.mock.calls.some(([input]) => input.runId === f.run.id)).toBe(false);
    expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.run.id),
      eq(heartbeatRunEvents.eventType, "error")))).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, f.chat.id)))[0].executionRunId).not.toBe(f.run.id);
  }

  it("promotes a real user message parked behind the obsolete completion", async () => {
    const f = await queuedSupersession();
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.chat.id,
      authorUserId: f.userId, body: "A new user message" }).returning();
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
      source: "automation", triggerDetail: "system", status: "deferred_issue_execution", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: f.userId, payload: { issueId: f.chat.id, mutation: "comment",
        commentId: comment.id, _proprioWakeContext: { issueId: f.chat.id, taskId: f.chat.id, wakeCommentId: comment.id,
          wakeCommentIds: [comment.id], wakeReason: "issue_commented", source: "issue.comment",
          conversationSessionGeneration: 2, conversationMode: true } } }).returning();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await assertQuietSettlement(f);
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect(promoted.runId).toBeTruthy();
    expect(promoted.runId).not.toBe(f.run.id);
    const [replacement] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, promoted.runId!));
    expect(replacement.contextSnapshot).toMatchObject({ wakeCommentIds: [comment.id], conversationSessionGeneration: 2 });
  });

  it.each([
    { errorCode: "provider_quota", keepIdleOnFailure: true, expectedStatus: "idle" },
    { errorCode: "setup_failed", keepIdleOnFailure: false, expectedStatus: "error" },
  ])("preserves the settled agent projection for $errorCode", async ({ errorCode, keepIdleOnFailure, expectedStatus }) => {
    const f = await queuedSupersession();
    const message = "Genuine run failure";
    const [failure] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.agent.id, status: "failed", error: message, errorCode,
      finishedAt: new Date(), createdAt: f.run.createdAt,
    }).returning();
    await createHeartbeatAgentStatus(db).finalizeAgentStatus(f.agent.id, "failed", message, { keepIdleOnFailure });
    const [before] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(before).toMatchObject({ status: expectedStatus,
      errorReason: keepIdleOnFailure ? null : message, lastHeartbeatAt: expect.any(Date) });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    await assertQuietSettlement(f);
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]).toEqual(before);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failure.id)))[0]).toEqual(failure);
  });

  async function addCurrentDelivery(f: Awaited<ReturnType<typeof queuedSupersession>>) {
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Completed task",
      status: "done", completedAt: new Date() }).returning();
    await db.insert(chatTaskHandoffs).values({ taskId: task.id, companyId: f.company.id,
      conversationId: f.chat.id, agentId: f.agent.id, sessionGeneration: 2 });
    const [delivery] = await db.insert(chatCompletionDeliveries).values({ taskId: task.id,
      companyId: f.company.id, status: "queued", statusVersion: task.statusVersion, targetRunId: f.run.id }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.run.contextSnapshot,
      conversationSessionGeneration: 2, chatCompletionDeliveryIds: [delivery.id] } }).where(eq(heartbeatRuns.id, f.run.id));
    return delivery;
  }

  async function holdCompletion(f: Awaited<ReturnType<typeof queuedSupersession>>, stage: "preflight" | "admitted") {
    let enter!: () => void;
    let proceed!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const release = new Promise<void>(resolve => { proceed = resolve; });
    const original = chatCompletionDelivery.prepareChatCompletionTurn;
    const hook = vi.spyOn(chatCompletionDelivery, "prepareChatCompletionTurn").mockImplementation(async (connection, run) => {
      if (run.id !== f.run.id) return original(connection, run);
      const prepared = stage === "admitted" ? await original(connection, run) : undefined;
      enter();
      await release;
      return prepared ?? original(connection, run);
    });
    try {
      await heartbeat.resumeQueuedRunsForAgent(f.company.id, f.agent.id);
      await Promise.race([entered, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Completion did not reach requested stage")), 3000);
        void entered.then(() => clearTimeout(timer));
      })]);
    } catch (error) {
      proceed();
      await heartbeat.drainActiveRunExecutions();
      hook.mockRestore();
      throw error;
    }
    return async () => {
      proceed();
      try { await heartbeat.drainActiveRunExecutions(); } finally { hook.mockRestore(); }
    };
  }

  async function startGenuineSibling(f: Awaited<ReturnType<typeof queuedSupersession>>) {
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.agent.id));
    const [sibling] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.agent.id, status: "running",
    }).returning();
    return async (errorCode: string, keepIdleOnFailure: boolean) => {
      const message = "Genuine overlapping run failure";
      await db.update(heartbeatRuns).set({ status: "failed", error: message, errorCode, finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, sibling.id));
      await createHeartbeatAgentStatus(db).finalizeAgentStatus(f.agent.id, "failed", message, { keepIdleOnFailure });
      return (await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0];
    };
  }

  it.each([
    { errorCode: "provider_quota", keepIdleOnFailure: true, expectedStatus: "idle", timing: "stale on claim" },
    { errorCode: "setup_failed", keepIdleOnFailure: false, expectedStatus: "error", timing: "stale on claim" },
    { errorCode: "provider_quota", keepIdleOnFailure: true, expectedStatus: "idle", timing: "invalidated after finalizer" },
    { errorCode: "setup_failed", keepIdleOnFailure: false, expectedStatus: "error", timing: "invalidated after finalizer" },
  ])("preserves $errorCode through completion preflight ($timing)", async ({ errorCode, keepIdleOnFailure, expectedStatus, timing }) => {
    const f = await queuedSupersession();
    const delivery = timing === "invalidated after finalizer" ? await addCurrentDelivery(f) : undefined;
    const fail = await startGenuineSibling(f);
    const release = await holdCompletion(f, "preflight");
    let during;
    try {
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].status).toBe("running");
      during = await fail(errorCode, keepIdleOnFailure);
      if (delivery) await db.update(chatCompletionDeliveries).set({ status: "superseded" })
        .where(eq(chatCompletionDeliveries.id, delivery.id));
    } finally {
      await release();
    }
    await assertQuietSettlement(f);
    const [after] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(after).toMatchObject({ status: expectedStatus,
      errorReason: keepIdleOnFailure ? null : "Genuine overlapping run failure", lastHeartbeatAt: expect.any(Date) });
    expect(after).toEqual(during);
  });

  it("counts an admitted completion as a genuine running sibling", async () => {
    const f = await queuedSupersession();
    await addCurrentDelivery(f);
    const fail = await startGenuineSibling(f);
    const release = await holdCompletion(f, "admitted");
    try {
      const [admitted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      expect(admitted).toMatchObject({ status: "running",
        contextSnapshot: { chatCompletionUpdates: [expect.objectContaining({ status: "done" })] } });
      expect(await fail("setup_failed", false)).toMatchObject({ status: "running", errorReason: null });
    } finally {
      await release();
    }
  });
});
