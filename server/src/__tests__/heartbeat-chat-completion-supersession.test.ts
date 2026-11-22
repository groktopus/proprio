import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@groktopus/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { CHAT_COMPLETION_WAKE_REASON } from "../services/chat-completion-delivery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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

  it("keeps a real failure authoritative when obsolete work is the last slot to settle", async () => {
    const f = await queuedSupersession();
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "failed",
      error: "Genuine setup failure", errorCode: "setup_failed", finishedAt: new Date(), createdAt: new Date(Date.now() + 1_000) });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await assertQuietSettlement(f);
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]).toMatchObject({
      status: "error", errorReason: "Genuine setup failure",
    });
  });
});
