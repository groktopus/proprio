import { agentSessionGoalActions, agentTaskSessions, agentWakeupRequests, heartbeatRuns, nativeRunFinalizations, type Db } from "@groktopus/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";

// These are the outbox states whose owner may still apply a control. Recovery
// must wait even when the last confirmed provider goal is still active.
export const SESSION_GOAL_RECOVERY_OPEN_CONTROLS = ["pending", "delivering", "delivered", "reconciling"] as const;

type GoalRecoveryScope = {
  companyId: string; issueId: string; agentId: string; adapterType: string;
  sessionId?: string; revision?: number;
};

export async function lockCurrentSessionGoalRecovery(tx: Db, input: GoalRecoveryScope): Promise<string | null> {
  // The caller already owns the issue lock. The session lock serializes
  // observations and controls with admission and the final dispatch gate.
  const [session] = await tx.select({ id: agentTaskSessions.id }).from(agentTaskSessions).where(and(
    input.sessionId === undefined ? undefined : eq(agentTaskSessions.id, input.sessionId),
    input.revision === undefined ? undefined : eq(agentTaskSessions.goalRevision, input.revision),
    eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.taskKey, input.issueId),
    eq(agentTaskSessions.agentId, input.agentId), eq(agentTaskSessions.adapterType, input.adapterType),
    eq(agentTaskSessions.goalStatus, "active"), eq(agentTaskSessions.goalDesiredState, "active"),
  )).for("update").limit(1);
  if (!session) return null;
  const [control] = await tx.select({ id: agentSessionGoalActions.id }).from(agentSessionGoalActions).where(and(
    eq(agentSessionGoalActions.companyId, input.companyId), eq(agentSessionGoalActions.sessionId, session.id),
    inArray(agentSessionGoalActions.status, SESSION_GOAL_RECOVERY_OPEN_CONTROLS),
  )).limit(1);
  return control ? null : session.id;
}

export async function canAdmitSessionGoalRecovery(tx: Db, input: GoalRecoveryScope): Promise<boolean> {
  const sessionId = await lockCurrentSessionGoalRecovery(tx, input);
  if (!sessionId) return false;
  const [state] = await tx.select({
    alreadyOwned: sql<boolean>`exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.companyId} = ${input.companyId}
        and ${inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])}
        and ${or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`)})
      or exists (select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${input.companyId}
        and ${agentWakeupRequests.payload}->>'issueId' = ${input.issueId} and ${agentWakeupRequests.runId} is null
        and (${agentWakeupRequests.status} = 'queued'
          or (${agentWakeupRequests.status} in ('claimed', 'deferred_issue_execution')
            and coalesce(${agentWakeupRequests.claimedAt}, ${agentWakeupRequests.createdAt}) > clock_timestamp() - interval '5 minutes')))
      or exists (select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.companyId} = ${input.companyId}
        and ${nativeRunFinalizations.issueId} = ${input.issueId} and ${nativeRunFinalizations.resultId} is null
        and (${nativeRunFinalizations.recoveryState} in ('awaiting_evidence', 'awaiting_runner_reattach', 'resuming_session', 'bootstrap_incomplete')
          or ${nativeRunFinalizations.phase} = 'retryable_failure'))`,
  }).from(agentTaskSessions).where(eq(agentTaskSessions.id, sessionId));
  return state?.alreadyOwned === false;
}
