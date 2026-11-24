import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { expect, type Page } from "@playwright/test";
import type { RunnerApi } from "./api.js";
import { pollUntil } from "./api.js";
import { validControllerOutageReceipt } from "./controller-outage.js";
import type { ControllerReplacementReceipt } from "./controller-replacement.js";
import { SESSION_GOAL_RECOVERY_TOKEN_BUDGET, structuredGoalObjective } from "./session-goal-recovery-cases.js";
import { gradeSessionGoalRecovery, type SessionGoalRecoveryGradeInput } from "./session-goal-recovery-cases.js";
import { storyArtifactDownloadLink } from "./story-artifact.js";
import type { StoryCheck } from "./everyday-observations.js";
import { collectRunEvents } from "./run-observations.js";

interface Row extends Record<string, any> {}

export interface SessionGoalRecoveryInput {
  page: Page;
  api: RunnerApi;
  issue: Row;
  companyId: string;
  agentId: string;
  nonce: string;
  workspacePath: string;
  privateDir: string;
  deadlineAt: number;
  restart(): Promise<ControllerReplacementReceipt | void>;
  allowInterrupted(runId: string): void;
  settled(): Promise<void>;
  openParent(): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
  note(action: string, detail?: unknown): void;
}

interface GoalCheckpoint {
  bytes: Buffer;
  milestones: string[];
  sha256: string;
  capturedAt: string;
}

async function readCheckpoint(workspacePath: string, nonce: string): Promise<GoalCheckpoint | null> {
  try {
    const [bytes, log] = await Promise.all([
      readFile(path.join(workspacePath, "goal-checkpoint.json")),
      readFile(path.join(workspacePath, "milestones.jsonl"), "utf8"),
    ]);
    const parsed = JSON.parse(bytes.toString("utf8"));
    const milestones = log.split(/\r?\n/).filter(Boolean);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 2
      || parsed.nonce !== nonce || parsed.milestone !== "checkpoint"
      || milestones.length !== 1 || milestones[0] !== `checkpoint:${nonce}`) return null;
    return { bytes, milestones, sha256: createHash("sha256").update(bytes).digest("hex"), capturedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

async function readGoal(api: RunnerApi, issueId: string, agentId: string): Promise<Row> {
  return api.get<Row>(`/api/issues/${issueId}/runner-goal?agentId=${encodeURIComponent(agentId)}`);
}

export function normalizeIssueRunRows(rows: readonly Row[]): Array<Row & { id: string }> {
  return rows.map(row => {
    const id = typeof row.runId === "string" ? row.runId : row.id;
    if (typeof id !== "string" || !id) throw new Error("issue_run_projection_missing_run_id");
    return { ...row, id };
  });
}

async function readIssueRuns(api: RunnerApi, issueId: string): Promise<Array<Row & { id: string }>> {
  return normalizeIssueRunRows(await api.get<Row[]>(`/api/issues/${issueId}/runs`));
}

export function isSessionGoalControllerReady(value: {
  goal: Row;
  activeRun: Row | null | undefined;
  events: readonly Row[];
}): boolean {
  const terms = sessionGoalControllerReadinessTerms(value);
  return terms.runProjectionBound && terms.nativeMode && terms.supportsSet
    && terms.sessionReceipt && terms.turnReceipt;
}

export function sessionGoalControllerReadinessTerms(value: {
  goal: Row;
  activeRun: Row | null | undefined;
  events: readonly Row[];
}) {
  const runId = value.activeRun?.id;
  const hasRunEvent = (eventType: string) => typeof runId === "string" && value.events.some(event => {
    const envelope = event.payload?.prpEvent;
    return envelope?.runId === runId && envelope.sourceKind === "runner" && envelope.eventType === eventType;
  });
  return {
    runProjectionBound: typeof runId === "string" && value.activeRun?.status === "running"
      && value.goal.activeRunId === runId,
    nativeMode: value.activeRun?.runtimeMode === "native",
    supportsSet: value.goal.capability?.availability === "available"
      && Array.isArray(value.goal.capability.actions) && value.goal.capability.actions.includes("set"),
    sessionReceipt: hasRunEvent("session.started") || hasRunEvent("session.resumed"),
    turnReceipt: hasRunEvent("turn.started"),
  };
}

async function runArtifactOracle(archivePath: string, nonce: string, deadlineAt: number) {
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ["PATH", "SYSTEMROOT", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "HOME"].includes(key)));
  const output = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? "python3", [
      path.join(import.meta.dirname, "session-goal-recovery-artifact.py"), archivePath, nonce,
    ], { env: childEnv, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, Math.min(45_000, deadlineAt - Date.now())));
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.length > 32_768) child.kill("SIGKILL");
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("session_goal_artifact_oracle_unavailable")); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === null || stdout.length > 32_768) reject(new Error("session_goal_artifact_oracle_failed"));
      else resolve({ stdout, code });
    });
  });
  let value: Row;
  try { value = JSON.parse(output.stdout) as Row; } catch { throw new Error("session_goal_artifact_oracle_invalid_receipt"); }
  if (!Array.isArray(value.checks) || value.checks.some((row: Row) => typeof row.id !== "string" || typeof row.passed !== "boolean")) {
    throw new Error("session_goal_artifact_oracle_invalid_receipt");
  }
  if ((output.code === 0) !== (value.passed === true) || value.passed !== value.checks.every((row: Row) => row.passed)) {
    throw new Error("session_goal_artifact_oracle_exit_mismatch");
  }
  return value;
}

export async function runSessionGoalRecovery(input: SessionGoalRecoveryInput): Promise<StoryCheck[]> {
  const objective = structuredGoalObjective(input.nonce);
  const checkpointPath = path.join(input.workspacePath, "goal-checkpoint.json");
  let lastReadinessKey: string | null = null;
  let lastReadiness: ReturnType<typeof sessionGoalControllerReadinessTerms> | null = null;
  // Task creation starts the first native run immediately. Do not issue the
  // fixture's initial goal create while that run is still bootstrapping: before
  // its session is bound, the control action can be interpreted as a wake and
  // start a second executor against the same isolated Codex home. Wait for the
  // public projection to bind the active run, then steer that live session.
  const ready = await pollUntil({
    label: "live session-goal controller bound before goal creation",
    deadlineAt: input.deadlineAt,
    intervalMs: 500,
    load: async () => {
      const [goal, runs] = await Promise.all([
        readGoal(input.api, input.issue.id, input.agentId),
        readIssueRuns(input.api, input.issue.id),
      ]);
      const activeRun = runs.find((run: Row) => run.id === goal.activeRunId && run.status === "running");
      const events = activeRun
        ? await collectRunEvents<Row>((afterSeq, limit) => input.api.get(
            `/api/heartbeat-runs/${activeRun.id}/events?afterSeq=${afterSeq}&limit=${limit}`,
          )).catch(() => [])
        : [];
      const value = { goal, runs, activeRun, events };
      const terms = sessionGoalControllerReadinessTerms(value);
      const key = JSON.stringify(terms);
      if (key !== lastReadinessKey) {
        lastReadinessKey = key;
        lastReadiness = terms;
        input.note("session-goal-readiness", terms);
      }
      return value;
    },
    accept: isSessionGoalControllerReady,
    reject: value => value.runs.some((run: Row) => ["failed", "timed_out", "cancelled", "succeeded"].includes(String(run.status)))
      ? `Initial native run ended before its goal controller became available (${JSON.stringify(lastReadiness)})` : undefined,
  });
  const beforeProjection = ready.goal;
  if (beforeProjection.capability?.availability !== "available"
    || !Array.isArray(beforeProjection.capability.actions) || !beforeProjection.capability.actions.includes("set")
    || !ready.activeRun?.id) {
    throw new Error("session_goal_profile_not_available");
  }
  const requestId = randomUUID();
  const accepted = await input.api.post<Row>(`/api/issues/${input.issue.id}/runner-goal/actions`, {
    requestId, agentId: input.agentId, expectedRevision: beforeProjection.revision, action: "create",
    objective, tokenBudget: SESSION_GOAL_RECOVERY_TOKEN_BUDGET,
  });
  if (!accepted || !["accepted", "completed"].includes(String(accepted.status))) {
    throw new Error("session_goal_action_not_accepted");
  }
  input.note("structured-goal-accepted", { requestId, status: accepted.status });

  const boundary = await pollUntil({
    label: "active structured goal with durable first milestone",
    deadlineAt: input.deadlineAt,
    intervalMs: 500,
    load: async () => {
      const [goal, issue, runs, checkpoint] = await Promise.all([
        readGoal(input.api, input.issue.id, input.agentId),
        input.api.get<Row>(`/api/issues/${input.issue.id}`),
        readIssueRuns(input.api, input.issue.id),
        readCheckpoint(input.workspacePath, input.nonce),
      ]);
      return { goal, issue, runs, checkpoint };
    },
    accept: value => value.goal.goal?.objective === objective && value.goal.goal?.status === "active"
      && value.goal.goal?.tokenBudget === SESSION_GOAL_RECOVERY_TOKEN_BUDGET
      && typeof value.goal.activeRunId === "string" && value.runs.some((run: Row) => run.id === value.goal.activeRunId && run.status === "running")
      && value.checkpoint !== null,
    reject: value => value.goal.goal?.status === "complete"
      ? "Provider claimed the structured goal complete before the durable first checkpoint"
      : ["failed", "timed_out", "cancelled"].includes(String(value.issue.status))
        ? `Task reached ${value.issue.status} before the durable checkpoint` : undefined,
  });
  const initialGoal = boundary.goal.goal as Row;
  const activeRun = boundary.runs.find((run: Row) => run.id === boundary.goal.activeRunId)!;
  const checkpointBefore = boundary.checkpoint!;
  const checkpointAt = new Date().toISOString();
  const checkpointEvidence = {
    schema: "proprio.e2e.session-goal-recovery-checkpoint.v1",
    issueId: input.issue.id,
    runId: activeRun.id,
    capturedAt: checkpointAt,
    relativePath: "goal-checkpoint.json",
    sha256: checkpointBefore.sha256,
    bytes: checkpointBefore.bytes.length,
    milestoneCount: checkpointBefore.milestones.length,
    tokenBudget: initialGoal.tokenBudget,
    tokensUsed: initialGoal.tokensUsed,
    iterations: initialGoal.iterations,
  };
  await input.evidence("structured-goal-checkpoint-before-fault.json", checkpointEvidence);
  input.note("durable-goal-checkpoint", checkpointEvidence);

  input.allowInterrupted(activeRun.id);
  const fault = await input.restart();
  if (!validControllerOutageReceipt(fault)) throw new Error("session_goal_fault_receipt_missing_or_invalid");
  const faultEvidence = {
    schema: fault.schema,
    requestId: fault.requestId,
    signal: fault.signal,
    holdMs: fault.holdMs,
    previousPid: fault.previousPid,
    replacementPid: fault.replacementPid,
    startedAt: fault.startedAt,
    stoppedAfterMs: fault.stoppedAfterMs,
    replacementStartedAfterMs: fault.replacementStartedAfterMs,
    readyAfterMs: fault.readyAfterMs,
    cacheDiscarded: fault.cacheDiscarded,
    checkpointAt,
    checkpointSha256: checkpointBefore.sha256,
  };
  if (faultEvidence.cacheDiscarded !== true || faultEvidence.previousPid === faultEvidence.replacementPid
    || Date.parse(faultEvidence.startedAt) < Date.parse(checkpointAt)) {
    throw new Error("session_goal_fault_receipt_did_not_follow_checkpoint");
  }
  await input.evidence("structured-goal-controller-fault-receipt.json", faultEvidence);
  input.note("goal-recovery-fault-receipt-persisted", faultEvidence);

  const recovered = await pollUntil({
    label: "structured goal resumes after controller replacement",
    deadlineAt: input.deadlineAt,
    intervalMs: 750,
    load: async () => {
      const [goal, runs] = await Promise.all([
        readGoal(input.api, input.issue.id, input.agentId),
        readIssueRuns(input.api, input.issue.id),
      ]);
      return { goal, runs };
    },
    accept: value => value.goal.goal?.objective === objective
      && value.goal.goal?.tokenBudget === SESSION_GOAL_RECOVERY_TOKEN_BUDGET
      && value.goal.goal?.tokensUsed >= initialGoal.tokensUsed
      && value.goal.goal?.iterations >= initialGoal.iterations
      && (value.goal.goal?.status === "active" || value.goal.goal?.status === "complete")
      && value.runs.some((run: Row) => run.status === "running" || run.status === "succeeded"),
  });
  const goalAfterReadback = recovered.goal.goal as Row;
  input.note("goal-recovery-readback", { status: goalAfterReadback.status, tokenBudget: goalAfterReadback.tokenBudget,
    tokensUsed: goalAfterReadback.tokensUsed, iterations: goalAfterReadback.iterations });

  await input.settled();
  await input.openParent();
  const finalGoalProjection = await readGoal(input.api, input.issue.id, input.agentId);
  const finalIssue = await input.api.get<Row>(`/api/issues/${input.issue.id}`);
  const finalRuns = await readIssueRuns(input.api, input.issue.id);
  const latestRun = finalRuns.filter(run => run.agentId === input.agentId)
    .sort((a, b) => Date.parse(String(b.finishedAt ?? b.createdAt)) - Date.parse(String(a.finishedAt ?? a.createdAt)))[0];
  if (!latestRun) throw new Error("session_goal_final_run_missing");

  const finalCheckpointBytes = await readFile(checkpointPath);
  const checkpointAfter = createHash("sha256").update(finalCheckpointBytes).digest("hex");
  const milestones = (await readFile(path.join(input.workspacePath, "milestones.jsonl"), "utf8"))
    .split(/\r?\n/).filter(Boolean);
  const attachments = await input.api.get<Row[]>(`/api/issues/${input.issue.id}/attachments`);
  const attachment = attachments.find(row => String(row.originalFilename ?? row.filename) === "goal-recovery-deliverable.zip");
  let artifactEvidence: SessionGoalRecoveryGradeInput["artifact"] = {
    downloaded: false, checkpointValid: false, checkpointSha256: null, milestonesValid: false, executablePassed: false, output: null,
  };
  if (attachment) {
    const link = storyArtifactDownloadLink(input.page, String(attachment.id));
    await expect(link).toBeVisible({ timeout: 30_000 });
    await mkdir(input.privateDir, { recursive: true, mode: 0o700 });
    const archivePath = path.join(input.privateDir, "goal-recovery-deliverable.zip");
    const [download] = await Promise.all([input.page.waitForEvent("download", { timeout: 30_000 }), link.click()]);
    await download.saveAs(archivePath);
    const oracle = await runArtifactOracle(archivePath, input.nonce, input.deadlineAt);
    artifactEvidence = {
      downloaded: true,
      checkpointValid: oracle.checks.some((check: Row) => check.id === "checkpoint-exact" && check.passed),
      checkpointSha256: typeof oracle.checkpointSha256 === "string" ? oracle.checkpointSha256 : null,
      milestonesValid: oracle.checks.some((check: Row) => check.id === "milestones-exactly-once" && check.passed),
      executablePassed: oracle.checks.some((check: Row) => check.id === "executable-output" && check.passed),
      output: typeof oracle.output === "string" ? oracle.output : null,
    };
    await input.evidence("structured-goal-deliverable-oracle.json", {
      schema: "proprio.e2e.session-goal-recovery-artifact-oracle.v1",
      archiveSha256: createHash("sha256").update(await readFile(archivePath)).digest("hex"),
      checks: oracle.checks,
      output: artifactEvidence.output,
    });
  }

  const chronologicalRuns = finalRuns.filter(run => run.agentId === input.agentId)
    .sort((a, b) => Date.parse(String(a.startedAt ?? a.createdAt)) - Date.parse(String(b.startedAt ?? b.createdAt)));
  const observations: Array<{ status: string; tokenBudget: number | null; tokensUsed: number; runAt: number; seq: number }> = [];
  for (const run of chronologicalRuns) {
    const rows = await collectRunEvents<Row>((afterSeq, limit) =>
      input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    const runAt = Date.parse(String(run.startedAt ?? run.createdAt));
    for (const row of rows) {
      const event = row.payload?.prpEvent;
      const goal = event?.payload?.goal;
      if (typeof event?.eventType !== "string" || !event.eventType.startsWith("session.goal.")
        || goal?.objective !== objective || typeof goal?.status !== "string") continue;
      observations.push({ status: goal.status, tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
        tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0, runAt, seq: row.seq });
    }
  }
  observations.sort((a, b) => a.runAt - b.runAt || a.seq - b.seq);
  const latestObservation = observations.at(-1);
  const gradeInput: SessionGoalRecoveryGradeInput = {
    expectedObjective: objective,
    checkpoint: { presentBeforeFault: true, sha256BeforeFault: checkpointBefore.sha256,
      sha256AfterRecovery: checkpointAfter, milestoneLines: milestones },
    fault: { persisted: true, valid: validControllerOutageReceipt(fault), startedAt: fault.startedAt,
      checkpointAt, cacheDiscarded: fault.cacheDiscarded === true },
    goalBefore: { objective: initialGoal.objective, status: initialGoal.status, tokenBudget: initialGoal.tokenBudget,
      tokensUsed: initialGoal.tokensUsed ?? 0, iterations: initialGoal.iterations ?? 0 },
    goalAfter: { objective: finalGoalProjection.goal?.objective ?? null, status: finalGoalProjection.goal?.status ?? null,
      tokenBudget: finalGoalProjection.goal?.tokenBudget ?? null, tokensUsed: finalGoalProjection.goal?.tokensUsed ?? 0,
      iterations: finalGoalProjection.goal?.iterations ?? 0 },
    task: { status: finalIssue.status, latestRunStatus: latestRun.status,
      hasPostFaultExecution: finalRuns.some(run => run.agentId === input.agentId
        && Date.parse(String(run.startedAt ?? run.createdAt)) >= Date.parse(fault.startedAt))
        || finalRuns.some(run => run.agentId === input.agentId && run.status === "succeeded"
          && Date.parse(String(run.finishedAt ?? "")) >= Date.parse(fault.startedAt) + Number(fault.readyAfterMs ?? 0)) },
    provider: { latestGoalStatus: latestObservation?.status ?? null, observationCount: observations.length },
    artifact: artifactEvidence,
  };
  const checks = gradeSessionGoalRecovery(gradeInput);
  await input.evidence("structured-goal-recovery-grade.json", { schema: "proprio.e2e.session-goal-recovery-grade.v1", evidence: gradeInput, checks });
  if (checks.some(check => !check.passed)) throw new Error(`Structured goal recovery checks failed: ${checks.filter(check => !check.passed).map(check => check.id).join(", ")}`);
  return checks;
}
