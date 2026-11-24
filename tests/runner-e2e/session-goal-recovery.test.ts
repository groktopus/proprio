import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runnerMatrix, runnerSuites, suiteDefinitionHash } from "./catalog.js";
import { controllerOutageForExecution, validControllerOutageReceipt } from "./controller-outage.js";
import { hasRegisteredArtifactCompletionProof, hasSuccessfulRegistrationReceipt, initialGoalCheckpointRejection, isSessionGoalControllerReady, normalizeIssueRunRows, sessionGoalCompletionToolOrder, sessionGoalControllerReadinessTerms } from "./session-goal-recovery-flow.js";
import { setupGitStreamingWorkspace } from "./daytona-git-streaming.js";
import { readWorkspaceGitSourceRoots } from "../../server/src/services/workspace-git-source-roots.js";
import { configureSessionGoalRecoveryBudget, SESSION_GOAL_RECOVERY_BUDGET_CENTS, SESSION_GOAL_RECOVERY_SUITE, SESSION_GOAL_RECOVERY_TOKEN_BUDGET, gradeSessionGoalRecovery, structuredGoalObjective } from "./session-goal-recovery-cases.js";
import type { SessionGoalRecoveryGradeInput } from "./session-goal-recovery-cases.js";

const nonce = "calibration-124";
const objective = structuredGoalObjective(nonce);
const digest = "a".repeat(64);

function validEvidence(): SessionGoalRecoveryGradeInput {
  return {
    expectedObjective: objective,
    checkpoint: { presentBeforeFault: true, sha256BeforeFault: digest, sha256AfterRecovery: digest,
      milestoneLines: [`checkpoint:${nonce}`, `verified:${nonce}`] },
    fault: { persisted: true, valid: true, startedAt: "2026-11-01T00:00:02.000Z",
      checkpointAt: "2026-11-01T00:00:01.000Z", cacheDiscarded: true },
    goalBefore: { objective, status: "active", tokenBudget: SESSION_GOAL_RECOVERY_TOKEN_BUDGET, tokensUsed: 10, iterations: 1 },
    goalAfter: { objective, status: "complete", tokenBudget: SESSION_GOAL_RECOVERY_TOKEN_BUDGET, tokensUsed: 40, iterations: 2 },
    task: { status: "done", latestRunStatus: "succeeded", hasPostFaultExecution: true },
    provider: { latestGoalStatus: "complete", observationCount: 2 },
    artifact: { downloaded: true, checkpointValid: true, checkpointSha256: digest,
      milestonesValid: true, executablePassed: true, output: `GOAL_OUTPUT:${nonce}` },
  };
}

describe("structured session-goal recovery Product E2E", () => {
  it("requires a registered user download and successful task finish before goal completion", () => {
    const register = objective.indexOf("register_deliverable");
    const finish = objective.indexOf("proprio_finish");
    const complete = objective.indexOf("mark this provider goal complete");
    expect(register).toBeGreaterThan(-1);
    expect(finish).toBeGreaterThan(register);
    expect(complete).toBeGreaterThan(finish);
    expect(objective).toContain("deliverable:<attachmentId>");
    expect(objective).toContain("application/zip");
  });

  it("retains the $10 hard stop while allowing this subscription cell's unpriced usage", async () => {
    const post = vi.fn(async () => ({}));
    await configureSessionGoalRecoveryBudget({ post } as any, "company-1", "agent-1");
    expect(post.mock.calls).toEqual([
      ["/api/companies/company-1/budgets/policies", { scopeType: "company", scopeId: "company-1",
        amount: SESSION_GOAL_RECOVERY_BUDGET_CENTS, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" }],
      ["/api/companies/company-1/budgets/policies", { scopeType: "agent", scopeId: "agent-1",
        amount: SESSION_GOAL_RECOVERY_BUDGET_CENTS, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" }],
    ]);
  });

  it("registers one explicit-only local native Codex subscription cell", () => {
    const suite = runnerSuites.find(row => row.id === SESSION_GOAL_RECOVERY_SUITE)!;
    const cell = runnerMatrix.find(row => row.id === `${SESSION_GOAL_RECOVERY_SUITE}.runner-codex-subscription.local.structured-goal-recovery`)!;
    expect(suite).toMatchObject({ manualOnly: true, expectedMatrixSize: 1 });
    expect(cell).toMatchObject({ profile: { provider: "codex", credential: "CODEX_AUTH_JSON", generation: "native" },
      environment: { id: "local" }, task: { automaticRetryPolicy: "single_attempt", explicitGroup: "session-goal-recovery",
        minimumExpectedRunCount: 1 } });
    expect(controllerOutageForExecution(cell, {})).toEqual({ signal: "SIGKILL", holdMs: 1_000 });
    expect(suiteDefinitionHash(suite)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("seeds the local project workspace as a self-contained Git source", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "session-goal-workspace-"));
    try {
      await setupGitStreamingWorkspace(cwd);
      const source = await readWorkspaceGitSourceRoots(cwd);
      expect(source?.root).toBe(await fs.realpath(cwd));
      expect(source?.objectDirectories).toHaveLength(1);
      expect(source?.metadata.some(row => row.path.endsWith(path.join("objects", "info", "alternates")))).toBe(false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("accepts a recovered, executable, exactly-once result with a persisted fault receipt", () => {
    expect(gradeSessionGoalRecovery(validEvidence()).every(check => check.passed)).toBe(true);
  });

  it("waits for nested startup events correlated to the public active run", () => {
    const observation = {
      goal: { activeRunId: "run-1", capability: { availability: "available", actions: ["set"] } },
      activeRun: { id: "run-1", status: "running", runtimeMode: "native" },
      events: [
        { eventType: "native.event", payload: { prpEvent: { runId: "run-1", sourceKind: "runner", eventType: "session.started" } } },
        { eventType: "native.event", payload: { prpEvent: { runId: "run-1", sourceKind: "runner", eventType: "turn.started" } } },
      ],
    };
    expect(isSessionGoalControllerReady(observation)).toBe(true);
    expect(isSessionGoalControllerReady({ ...observation, events: observation.events.map(event => ({
      ...event, payload: { prpEvent: { ...event.payload.prpEvent, runId: "another-run" } },
    })) })).toBe(false);
    expect(isSessionGoalControllerReady({ ...observation, events: observation.events.map(event => ({ eventType: event.payload.prpEvent.eventType })) })).toBe(false);
  });

  it("normalizes the public issue-runs runId field for readiness and recovery reads", () => {
    const [run] = normalizeIssueRunRows([{ runId: "run-from-public-list", status: "running", runtimeMode: "native" }]);
    expect(run).toMatchObject({ id: "run-from-public-list", runId: "run-from-public-list", status: "running", runtimeMode: "native" });
    const observation = {
      goal: { activeRunId: "run-from-public-list", capability: { availability: "available", actions: ["set"] } },
      activeRun: run,
      events: [
        { payload: { prpEvent: { runId: run.id, sourceKind: "runner", eventType: "session.started" } } },
        { payload: { prpEvent: { runId: run.id, sourceKind: "runner", eventType: "turn.started" } } },
      ],
    };
    expect(isSessionGoalControllerReady(observation)).toBe(true);
  });

  it("requires registration and accepted completion before marking the provider goal complete", () => {
    const events = [
      { seq: 10, payload: { prpEvent: { eventType: "tool.execution.completed", payload: { name: "register_deliverable", status: "completed" } } } },
      { seq: 12, payload: { prpEvent: { eventType: "tool.execution.completed", payload: { name: "proprio_finish", status: "completed" } } } },
      { seq: 13, payload: { prpEvent: { eventType: "session.goal.updated", payload: { goal: { status: "complete" } } } } },
    ];
    expect(sessionGoalCompletionToolOrder(events)).toEqual({ registrationSeq: 10, finishSeq: 12, completeGoalSeq: 13, valid: true });
    expect(sessionGoalCompletionToolOrder(events.map(event => ({ ...event, seq: 20 - event.seq }))).valid).toBe(false);
    expect(sessionGoalCompletionToolOrder(events.filter(event => event.seq !== 12)).valid).toBe(false);
  });

  it("binds completion proof to the same durable registration receipt", () => {
    const receipt = { operationId: "register_deliverable", input: { filename: "goal-recovery-deliverable.zip",
      contentRef: "goal-recovery-deliverable.zip", contentType: "application/zip", title: "goal-recovery-deliverable.zip",
      byteSize: 123, sha256: digest },
    result: { attachmentId: "attachment-1", disposition: "applied", commandId: "deliverable-prepared:attachment-1",
      entityRefs: ["attachment-1", "work-product-1"] } };
    expect(hasSuccessfulRegistrationReceipt({ semanticToolReceipts: { publish: receipt } }, "attachment-1",
      { byteSize: 123, sha256: digest })).toBe(true);
    expect(hasSuccessfulRegistrationReceipt({ semanticToolReceipts: { publish: receipt } }, "attachment-2")).toBe(false);
    expect(hasRegisteredArtifactCompletionProof({ evidence: [{ ref: "deliverable:attachment-1" }],
      artifacts: [{ kind: "artifact", ref: "deliverable:attachment-1" }] }, "attachment-1")).toBe(true);
    expect(hasRegisteredArtifactCompletionProof({ evidence: [{ ref: "deliverable:attachment-1" }], artifacts: [] }, "attachment-1")).toBe(false);
  });

  it.each(["blocked", "limited", "usage_limited", "budget_limited", "exhausted"])(
    "rejects a terminal %s goal before the first checkpoint",
    status => expect(initialGoalCheckpointRejection({ goal: { goal: { status } }, issue: { status: "in_progress" } }))
      .toBe(`Provider goal reached ${status} before the durable first checkpoint`),
  );

  it("reports allowlisted startup readiness terms without exposing event payloads", () => {
    const observation = {
      goal: { activeRunId: "different-run", capability: { availability: "available", actions: ["set"] } },
      activeRun: { id: "run-1", status: "running", runtimeMode: "native" },
      events: [
        { payload: { prpEvent: { runId: "run-1", sourceKind: "runner", eventType: "session.started" } } },
        { payload: { prpEvent: { runId: "run-1", sourceKind: "runner", eventType: "turn.started" } } },
      ],
    };
    expect(sessionGoalControllerReadinessTerms(observation)).toEqual({
      runProjectionBound: false,
      nativeMode: true,
      supportsSet: true,
      sessionReceipt: true,
      turnReceipt: true,
    });
    expect(isSessionGoalControllerReady(observation)).toBe(false);
  });

  it.each([
    ["missing checkpoint", (value: SessionGoalRecoveryGradeInput) => { value.checkpoint.presentBeforeFault = false; }],
    ["duplicate milestone", (value: SessionGoalRecoveryGradeInput) => { value.checkpoint.milestoneLines.push(`verified:${nonce}`); }],
    ["missing fault receipt", (value: SessionGoalRecoveryGradeInput) => { value.fault.persisted = false; }],
    ["initial goal already complete", (value: SessionGoalRecoveryGradeInput) => { value.goalBefore.status = "complete"; }],
    ["premature complete claim", (value: SessionGoalRecoveryGradeInput) => { value.provider.latestGoalStatus = "active"; }],
    ["artifact execution failure", (value: SessionGoalRecoveryGradeInput) => { value.artifact.executablePassed = false; }],
    ["silent stall", (value: SessionGoalRecoveryGradeInput) => { value.task.latestRunStatus = "failed"; value.task.hasPostFaultExecution = false; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const evidence = structuredClone(validEvidence());
    mutate(evidence);
    expect(gradeSessionGoalRecovery(evidence).some(check => !check.passed)).toBe(true);
  });

  it("requires complete controller outage evidence", () => {
    expect(validControllerOutageReceipt({ schema: "proprio.e2e.controller-outage.v1", signal: "SIGKILL", holdMs: 1_000 })).toBe(false);
  });
});
