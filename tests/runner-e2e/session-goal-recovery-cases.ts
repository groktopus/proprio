import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { StoryCheck } from "./everyday-observations.js";
import type { RunnerTaskFixture } from "./types.js";

export const SESSION_GOAL_RECOVERY_SUITE = "session-goal-recovery";
export const SESSION_GOAL_RECOVERY_BUDGET_CENTS = 1_000;
export const SESSION_GOAL_RECOVERY_TOKEN_BUDGET = 6_000;
export const SESSION_GOAL_RECOVERY_WAIT_SECONDS = 35;

export function structuredGoalObjective(nonce: string): string {
  return [
    `Build a tiny dependency-free Python deliverable for receipt ${nonce}.`,
    `Milestone 1: write goal-checkpoint.json with exactly {"nonce":"${nonce}","milestone":"checkpoint"} and create milestones.jsonl with exactly one line checkpoint:${nonce}. Save both before continuing.`,
    `After that checkpoint, run one foreground Python sleep for ${SESSION_GOAL_RECOVERY_WAIT_SECONDS} seconds. Do not finish or replace the checkpoint during the wait. Continue in the same task after the wait and any controller restart.`,
    `Milestone 2 depends on milestone 1: create verify_goal.py that reads goal-checkpoint.json, validates the exact nonce and checkpoint milestone, and prints GOAL_OUTPUT:${nonce}. Append exactly one line verified:${nonce} to milestones.jsonl; never duplicate or rewrite milestone 1. Run the script and save its exact output as goal-output.txt.`,
    `Create goal-recovery-deliverable.zip containing exactly goal-checkpoint.json, milestones.jsonl, verify_goal.py, and goal-output.txt. Preserve the checkpoint bytes. Finish only after the script and output are verified.`,
  ].join("\n\n");
}

export const sessionGoalRecoveryTask: RunnerTaskFixture = {
  id: "structured-goal-recovery",
  label: "Recover a structured session goal after controller restart",
  groups: ["session-goal-recovery"],
  explicitGroup: "session-goal-recovery",
  workMode: "standard",
  flow: "everyday_workflow",
  expectedRunCount: 3,
  minimumExpectedRunCount: 2,
  automaticRetryPolicy: "single_attempt",
  requiredCredentials: ["CODEX_AUTH_JSON"],
  attemptTimeoutMs: { local: 7 * 60_000, daytona: 0 },
  turnTimeoutMs: 4 * 60_000,
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Structured goal recovery ${nonce}`,
  buildPrompt: nonce => `Wait for the controller to install the structured session goal for this task before creating or changing any files. Once that goal is active, complete it exactly as specified: ${structuredGoalObjective(nonce)} Keep the first execution active through the checkpoint and wait so the qualification fixture can restart the controller. Do not claim success before the verified archive exists.`,
  buildVisibleMarker: nonce => `GOAL_OUTPUT:${nonce}`,
  buildMatchers: () => [],
};

export function sessionGoalRecoveryDefinitionDigest(): string {
  const hash = createHash("sha256");
  for (const file of [
    "catalog.ts", "session-goal-recovery-cases.ts", "session-goal-recovery-flow.ts",
    "session-goal-recovery-artifact.py", "everyday-flow.ts", "runner.spec.ts",
    "live-fixtures.ts", "controller-outage.ts", "controller-replacement.ts",
  ]) hash.update(file).update(readFileSync(new URL(`./${file}`, import.meta.url)));
  return hash.digest("hex");
}

export interface SessionGoalRecoveryGradeInput {
  expectedObjective: string;
  checkpoint: { presentBeforeFault: boolean; sha256BeforeFault: string | null; sha256AfterRecovery: string | null; milestoneLines: string[] };
  fault: { persisted: boolean; valid: boolean; startedAt: string | null; checkpointAt: string | null; cacheDiscarded: boolean };
  goalBefore: { objective: string | null; status: string | null; tokenBudget: number | null; tokensUsed: number; iterations: number };
  goalAfter: { objective: string | null; status: string | null; tokenBudget: number | null; tokensUsed: number; iterations: number };
  task: { status: string; latestRunStatus: string; hasPostFaultExecution: boolean };
  provider: { latestGoalStatus: string | null; observationCount: number };
  artifact: { downloaded: boolean; checkpointValid: boolean; checkpointSha256: string | null; milestonesValid: boolean; executablePassed: boolean; output: string | null };
}

export function gradeSessionGoalRecovery(evidence: SessionGoalRecoveryGradeInput): StoryCheck[] {
  const check = (id: string, passed: boolean, detail: string): StoryCheck => ({ id, passed, detail });
  const hash = (value: string | null) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const nonce = evidence.expectedObjective.match(/receipt ([^.]*)/)?.[1] ?? "";
  const milestoneOrder = evidence.checkpoint.milestoneLines.length === 2
    && evidence.checkpoint.milestoneLines[0] === `checkpoint:${nonce}`
    && evidence.checkpoint.milestoneLines[1] === `verified:${nonce}`;
  const continuity = evidence.goalBefore.objective === evidence.expectedObjective
    && evidence.goalBefore.status === "active"
    && evidence.goalAfter.objective === evidence.expectedObjective
    && evidence.goalBefore.tokenBudget === SESSION_GOAL_RECOVERY_TOKEN_BUDGET
    && evidence.goalAfter.tokenBudget === evidence.goalBefore.tokenBudget
    && evidence.goalAfter.tokensUsed >= evidence.goalBefore.tokensUsed
    && evidence.goalAfter.iterations >= evidence.goalBefore.iterations;
  const faultOrdering = Boolean(evidence.fault.startedAt && evidence.fault.checkpointAt
    && Number.isFinite(Date.parse(evidence.fault.startedAt)) && Number.isFinite(Date.parse(evidence.fault.checkpointAt))
    && Date.parse(evidence.fault.checkpointAt) <= Date.parse(evidence.fault.startedAt));
  return [
    check("goal-recovery-checkpoint-before-fault", evidence.checkpoint.presentBeforeFault && hash(evidence.checkpoint.sha256BeforeFault)
      && evidence.checkpoint.sha256BeforeFault === evidence.checkpoint.sha256AfterRecovery,
    "The first milestone was durably saved before the fault and its bytes survived recovery."),
    check("goal-recovery-fault-receipt", evidence.fault.persisted && evidence.fault.valid && evidence.fault.cacheDiscarded && faultOrdering,
      "A persisted controller fault receipt proves the interruption happened after the verified checkpoint."),
    check("goal-recovery-objective-budget-continuity", continuity,
      "The same objective and token budget survive recovery, with usage and iteration counters not regressing."),
    check("goal-recovery-exactly-once-milestones", milestoneOrder,
      "The dependent checkpoint and verification milestones each have exactly one effect in order."),
    check("goal-recovery-deliverable-executable", evidence.artifact.downloaded && evidence.artifact.checkpointValid
      && evidence.artifact.checkpointSha256 === evidence.checkpoint.sha256BeforeFault
      && evidence.artifact.milestonesValid && evidence.artifact.executablePassed
      && evidence.artifact.output === `GOAL_OUTPUT:${nonce}`,
      "The downloaded deliverable preserves the checkpoint and passes an isolated executable output check."),
    check("goal-recovery-provider-task-projection-agree", evidence.provider.observationCount > 0
      && evidence.provider.latestGoalStatus === "complete" && evidence.goalAfter.status === "complete"
      && evidence.task.status === "done" && evidence.task.latestRunStatus === "succeeded",
      "Provider goal observations, the public goal projection, the task and its final run agree on completion."),
    check("goal-recovery-resumed-after-fault", evidence.task.hasPostFaultExecution,
      "Execution resumed after the persisted controller fault receipt."),
  ];
}
