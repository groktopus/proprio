import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues,
  nativeRunFinalizations, type Db } from "@groktopus/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { agentExecutionStopBlocker } from "../../../services/agent-execution-stop.js";
import { PROCESS_START_REQUESTED } from "../../../services/native-local-process-stop.js";
import { canRetryStoppedRun } from "../../../services/cancelled-native-startup.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("historical legacy startup cancellation stop proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const startedAt = new Date("2026-10-23T00:00:00Z");
  const finishedAt = new Date("2026-10-23T00:00:01Z");
  const startupCancellation = { requestedAt: finishedAt.toISOString(), beforeNativeSelection: false,
    errorCode: "continuation_task_ownership_changed" };
  const cancellation = { source: "control_plane", expected: true, initiator: { type: "system" },
    reason: "continuation_task_ownership_changed", recordedAt: finishedAt.toISOString() };
  const resultJson = { startupCancellation, cancellation };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("proprio-startup-cancel-stop-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [company] = await db.insert(companies).values({ name: "Startup proof", issuePrefix: `P${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Legacy adapter",
      adapterType: "claude_local", status: "idle", lifecycleState: "ready" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "on_demand",
      status: "cancelled", errorCode: startupCancellation.errorCode, runtimeMode: "legacy", executionStage: "settled",
      startedAt, finishedAt, runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } }, resultJson,
      ...patch }).returning();
    return { agent, run };
  }

  it.each(["pause", "terminate"] as const)("completes %s after a settled startup cancellation without reopening retry", async transition => {
    const { agent, run } = await fixture();
    const driver = createLifecycleDriver(db, {} as never);
    const work = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: driver.runHost });
    try {
      const lifecycle = createAgentLifecycle(db);
      await (transition === "pause" ? lifecycle.pauseAgent(agent.id) : lifecycle.terminateAgent(agent.id));
      await work.process(agent.id);
      const [current] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(current.lifecycleState).toBe(transition === "pause" ? "paused" : "terminated");
      expect(await canRetryStoppedRun(db, run)).toBe(false);
      const [historical] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(historical).toEqual(run);
    } finally { await work.stop(); }
  });

  it.each([
    ["no startup timestamp", { resultJson: { ...resultJson, startupCancellation: { beforeNativeSelection: false } } }],
    ["invalid startup timestamp", { resultJson: { ...resultJson, startupCancellation: { ...startupCancellation, requestedAt: "invalid" } } }],
    ["startup timestamp after settlement", { resultJson: { ...resultJson, startupCancellation: { ...startupCancellation, requestedAt: "2099-01-01T00:00:00Z" } } }],
    ["provider cancellation", { resultJson: { ...resultJson, cancellation: { ...cancellation, source: "provider" } } }],
    ["provider output", { lastOutputSeq: 1 }],
    ["unrecognized startup data", { resultJson: { ...resultJson, startupCancellation: "cancelled" } }],
    ["outstanding Stop", { resultJson: { ...resultJson, executionCancellation: { state: "requested" } } }],
    ["admitted dispatch without handoff", { usageJson: { budgetDispatch: { admittedAt: startedAt.toISOString() } } }],
    ["handed off dispatch", { usageJson: { budgetDispatch: { handedOffAt: startedAt.toISOString() } } }],
    ["provider work", { resultJson: { ...resultJson, executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } }],
    ["dispatch stage", { executionStage: "dispatching" }],
    ["process identity", { processPid: process.pid }],
    ["live controller", { controllerLeaseExpiresAt: new Date("2099-01-01T00:00:00Z") }],
    ["session identity", { sessionIdAfter: "synthetic-session" }],
    ["restore obligation", { resultJson: { ...resultJson, workspaceRestoreFailure: { reason: "missing_base" } } }],
    ["native launch state", { runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" }, nativeExecutionInput: {} } }],
  ] satisfies Array<[string, Partial<typeof heartbeatRuns.$inferInsert>]>)
    ("still blocks on %s", async (_label, patch) => {
      const { agent } = await fixture(patch);
      expect(await agentExecutionStopBlocker(db, [agent.id])).not.toBeNull();
    });

  it.each(["adapter.invoke", PROCESS_START_REQUESTED, "session.started", "provider.event", "source_event"])
    ("still blocks on a recorded %s event", async eventType => {
      const { agent, run } = await fixture();
      await db.insert(heartbeatRunEvents).values({ companyId: run.companyId, agentId: agent.id, runId: run.id,
        seq: 1, eventType, ...(eventType === "source_event" ? { sourceEventId: "observed-provider-event" } : {}) });
      expect(await agentExecutionStopBlocker(db, [agent.id])).not.toBeNull();
    });

  it.each([
    { provider: "local", status: "active" },
    { provider: "local", status: "released", cleanupStatus: "success", releasedAt: finishedAt },
    { provider: "ssh", status: "released", cleanupStatus: "success", releasedAt: finishedAt },
  ])("still blocks on retained lease evidence: %j", async lease => {
    const { agent, run } = await fixture();
    await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id, ...lease });
    expect(await agentExecutionStopBlocker(db, [agent.id])).not.toBeNull();
  });

  it("still blocks on a native finalization record", async () => {
    const { agent, run } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: run.companyId, title: "Mixed ownership evidence" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, runId: run.id, issueId: issue.id, phase: "observed" });
    expect(await agentExecutionStopBlocker(db, [agent.id])).not.toBeNull();
  });
});
