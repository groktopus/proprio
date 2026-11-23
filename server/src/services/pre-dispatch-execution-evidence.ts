import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@groktopus/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

export function isPreDispatchResourceWait(run: Pick<typeof heartbeatRuns.$inferSelect,
  "runtimeMode" | "status" | "errorCode" | "resultJson">): boolean {
  const evidence = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  return run.runtimeMode === "legacy" && run.status === "cancelled" && evidence?.providerWorkStarted === false &&
    (run.errorCode === "workspace_busy" && evidence.kind === "workspace_wait" ||
      run.errorCode === "agent_directory_busy" && evidence.kind === "agent_directory_wait" ||
      ["ai_connection_busy", "ai_connection_pool_exhausted", "provider_limit_wait"].includes(run.errorCode ?? "") &&
      evidence.kind === "ai_connection_wait");
}

export function isAgentDirectoryPreparationWait(run: Pick<typeof heartbeatRuns.$inferSelect,
  "runtimeMode" | "status" | "errorCode" | "resultJson">): boolean {
  const evidence = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  const cancellation = run.resultJson?.cancellation as Record<string, unknown> | undefined;
  return run.runtimeMode === "legacy" && run.status === "cancelled" && run.errorCode === "agent_directory_busy"
    && evidence?.kind === "agent_directory_wait" && evidence.providerWorkStarted === false
    && cancellation?.source === "control_plane" && cancellation.expected === true;
}

export function agentDirectoryPreparationWaitPredicate() {
  return sql`(${heartbeatRuns.runtimeMode} = 'legacy' and ${heartbeatRuns.status} = 'cancelled'
    and ${heartbeatRuns.errorCode} = 'agent_directory_busy'
    and ${heartbeatRuns.resultJson}#>>'{executionRecovery,kind}' = 'agent_directory_wait'
    and ${heartbeatRuns.resultJson}#>'{executionRecovery,providerWorkStarted}' = 'false'::jsonb
    and ${heartbeatRuns.resultJson}#>>'{cancellation,source}' = 'control_plane'
    and ${heartbeatRuns.resultJson}#>'{cancellation,expected}' = 'true'::jsonb)`;
}

export function executionStartedEventPredicate() {
  return or(isNotNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType,
    ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, "harness.ready", "session.started",
      "session.resumed", "session.updated", "turn.started", "provider.event", "provider.rpc_result", "tool.execution.started"]));
}

export const RETAINED_RUNNER_PROFILE_KEYS = [
  "nativeExecutionInput", "nativeWorkspaceSync", "remoteWorkspace", "nativeWorkspaceFinalizationOwner", "sessionCheckpoint",
] as const;

type RunEvidenceScope = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">;

export function candidateRunScopes(runs: readonly RunEvidenceScope[]) {
  return sql`select id, "companyId" from jsonb_to_recordset(${JSON.stringify(runs.map(({ id, companyId }) => ({ id, companyId })))}::jsonb)
    as candidate(id uuid, "companyId" uuid)`;
}

export async function hasStartupExecutionEvidence(db: Db, runs: readonly RunEvidenceScope[]) {
  if (!runs.length) return false;
  const [row] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    sql`(${heartbeatRunEvents.runId}, ${heartbeatRunEvents.companyId}) in (${candidateRunScopes(runs)})`,
    executionStartedEventPredicate(),
  )).limit(1);
  return Boolean(row);
}

/** Both dispatch cancellation policies require this same retained-evidence
 * proof. Each caller still owns its terminal status and admission receipt. */
export function noRetainedExecutionPredicate() {
  return and(
    isNull(heartbeatRuns.startedAt), isNull(heartbeatRuns.runtimeModeResolvedAt),
    isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt),
    isNull(heartbeatRuns.nativeIssueId), isNull(heartbeatRuns.nativeSessionId), isNull(heartbeatRuns.sessionIdAfter),
    isNull(heartbeatRuns.controllerBootId), isNull(heartbeatRuns.controllerLeaseExpiresAt), isNull(heartbeatRuns.executionStage),
    sql`coalesce(${heartbeatRuns.resultJson}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'`,
    sql`coalesce(${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema', '') <> ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
    sql`not (coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ?| array[${sql.join(RETAINED_RUNNER_PROFILE_KEYS.map(key => sql`${key}::text`), sql`, `)}])`,
    sql`not exists (select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId} and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${environmentLeases}
      where ${environmentLeases.companyId} = ${heartbeatRuns.companyId} and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${heartbeatRunEvents}
      where ${and(eq(heartbeatRunEvents.companyId, heartbeatRuns.companyId),
        eq(heartbeatRunEvents.runId, heartbeatRuns.id), executionStartedEventPredicate())})`,
  );
}
