import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues, issueComments } from "@groktopus/db";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentRoutes } from "../routes/agents.ts";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { issueService } from "../services/issues.js";
import { errorHandler } from "../middleware/index.ts";

const support = await getEmbeddedPostgresTestSupport();

it.skipIf(!support.supported).each(["cancelled", "completed"] as const)("preserves the Hermes %s outcome without inventing provider termination through Stop", async (remoteStatus) => {
  const dbFixture = await startEmbeddedPostgresTestDatabase("proprio-hermes-operator-stop-");
  const db = createDb(dbFixture.connectionString);
  const heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PROPRIO_IN_WORKTREE: "false" } });
  const companyId = randomUUID();
  const agentId = randomUUID();
  const person = "fixture-responsible-user";
  const remoteRunId = "fixture-remote-run";
  const calls: Array<{ method: string; path: string; redirect: RequestRedirect | undefined }> = [];
  let observedEventSubscription = false;
  let remoteStopCalled = false;
  let remoteCancellationObserved = false;
  let cleaningUp = false;
  let finishEventSubscription: (() => void) | undefined;
  const completed = () => new Response(
    'event: run.completed\ndata: {"status":"completed"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "hermes-fixture.test") throw new Error(`Unexpected outbound fetch: ${url.hostname}`);
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, redirect: init?.redirect });
    if (method === "POST" && url.pathname === "/v1/runs") return json({ run_id: remoteRunId, status: "running" });
    if (method === "GET" && url.pathname === `/v1/runs/${remoteRunId}/events`) {
      observedEventSubscription = true;
      if (cleaningUp) return completed();
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const cancel = () => reject(new DOMException("aborted", "AbortError"));
        finishEventSubscription = () => {
          signal?.removeEventListener("abort", cancel);
          resolve(completed());
        };
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    if (method === "POST" && url.pathname === `/v1/runs/${remoteRunId}/stop`) {
      remoteStopCalled = true;
      return json({ run_id: remoteRunId, status: "stopping" });
    }
    if (method === "GET" && url.pathname === `/v1/runs/${remoteRunId}`) {
      if (remoteStopCalled) remoteCancellationObserved = true;
      return json({ run_id: remoteRunId, status: remoteStopCalled ? remoteStatus : "running", output: remoteStatus === "completed" ? "The completed reply" : undefined });
    }
    throw new Error(`Unexpected fake gateway fetch: ${method} ${url.pathname}`);
  }));

  try {
    await db.insert(companies).values({ id: companyId, name: "Hermes Stop fixture", issuePrefix: "HERMTEST",
      defaultResponsibleUserId: person, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: person, name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: person,
      status: "active", membershipRole: "admin" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Hermes", role: "engineer", status: "active",
      adapterType: "hermes_gateway", adapterConfig: { apiBaseUrl: "https://hermes-fixture.test", apiKey: "fixture-only-token", timeoutSec: 30 },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    const [issue] = await db.insert(issues).values({ companyId, title: "Trusted synthetic Stop fixture",
      status: "todo", assigneeAgentId: agentId, workMode: "conversation", conversationAgentId: agentId, conversationUserId: person, conversationState: "active" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: person, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false };
      next();
    });
    app.use("/api", agentRoutes(db, {}));
    app.use(errorHandler);

    const run = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id } });
    if (!run) throw new Error("Wake was not accepted");
    await vi.waitFor(() => expect(observedEventSubscription).toBe(true), { timeout: 10_000 });
    await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, issue.id));
    const stop = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({});
    expect(stop.status, JSON.stringify(stop.body)).toBe(409);
    expect(stop.body.error).toContain("provider termination could not be verified");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(calls.filter(call => call.method === "POST")).toEqual([
      { method: "POST", path: "/v1/runs", redirect: "error" },
      { method: "POST", path: `/v1/runs/${remoteRunId}/stop`, redirect: "error" },
    ]);
    expect(remoteCancellationObserved).toBe(true);
    const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(task).toMatchObject({ executionRunId: run.id, checkoutRunId: run.id });
    if (remoteStatus === "completed") {
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
      expect(comments).toEqual(expect.arrayContaining([expect.objectContaining({ body: "The completed reply", authorAgentId: agentId })]));
    }
    expect(stored?.status).toBe(remoteStatus === "completed" ? "succeeded" : "cancelled");
    expect(stored?.resultJson?.executionCancellation).toMatchObject({ state: "requested" });
    expect(stored?.resultJson?.conversationContinuation).toBeUndefined();
    expect(legacyExecutionNeedsReconciliation(stored!)).toBe(true);
    expect(await agentExecutionsHaveStopped(db, [agentId])).toBe(false);
    await expect(issueService(db).addComment(issue.id, "ordinary revoked write", { agentId, runId: run.id }))
      .rejects.toThrow("cannot post a reply");
    await heartbeat.reapOrphanedRuns({ skipRetainedNativeSessionCleanup: true, skipNativeStatusWakeIntents: true });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0])
      .toMatchObject({ executionRunId: run.id, checkoutRunId: run.id });
    expect(calls.filter(call => call.method === "POST" && call.path === "/v1/runs")).toHaveLength(1);
    const followup = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id } });
    expect(followup).toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(calls.filter(call => call.method === "POST" && call.path === "/v1/runs")).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0])
      .toMatchObject({ executionRunId: run.id, checkoutRunId: run.id });
    if (remoteStatus === "completed") {
      await db.update(heartbeatRuns).set({ resultJson: { ...stored!.resultJson,
        freshContinuationSupersededAt: new Date().toISOString() } }).where(eq(heartbeatRuns.id, run.id));
      await expect(issueService(db).addComment(issue.id, "superseded completed reply", { agentId, runId: run.id }, { completionReply: true }))
        .rejects.toThrow("cannot post a reply");
    }
  } finally {
    // A failed assertion must not strand the synthetic agent until its timeout.
    cleaningUp = true;
    finishEventSubscription?.();
    try {
      await heartbeat.drainActiveRunExecutions();
    } finally {
      vi.unstubAllGlobals();
      try {
        await db.$client.end({ timeout: 1 });
      } finally {
        await dbFixture.cleanup();
      }
    }
  }
}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
