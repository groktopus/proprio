import { agentWakeupRequests, heartbeatRuns, statusDecisions, statusDecisionEffects, type Db } from "@groktopus/db";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isStrictUuid } from "../../uuid.js";
import { record } from "./evidence-json.js";
import { boundRunIssueIdSql } from "../run-task-binding.js";
import { NATIVE_RUN_FAILED_RETRY_CAUSE } from "./status-arbiter.js";

/** Recover run provenance from a committed continuation, never from
 * provider-supplied source IDs or the mere presence of related task data. */
export async function readNativeContinuationSource(
  db: Pick<Db, "select">,
  binding: { companyId: string; issueId: string; runId: string; completionRecovery?: true },
): Promise<string | null> {
  const source = alias(heartbeatRuns, "continuation_source");
  const dispatch = alias(agentWakeupRequests, "continuation_dispatch");
  const sources = await db.select({ runId: source.id }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.companyId, binding.companyId),
      or(isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.runId, heartbeatRuns.id)),
      eq(agentWakeupRequests.agentId, heartbeatRuns.agentId),
      eq(agentWakeupRequests.reason, "issue_status_changed"),
      eq(agentWakeupRequests.status, "coalesced"),
      eq(agentWakeupRequests.requestedByActorType, "system"),
      eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${binding.issueId}`,
      sql`${heartbeatRuns.contextSnapshot}->>'nativeStatusWakeIntentId' = ${agentWakeupRequests.id}::text`,
    ))
    .innerJoin(dispatch, and(
      eq(dispatch.companyId, binding.companyId), eq(dispatch.agentId, heartbeatRuns.agentId),
      eq(dispatch.runId, heartbeatRuns.id), eq(dispatch.reason, "issue_status_changed"),
      binding.completionRecovery ? eq(heartbeatRuns.wakeupRequestId, dispatch.id) : undefined,
      eq(dispatch.requestedByActorType, "system"),
      sql`${dispatch.requestedByActorId} = 'native-status-wake-dispatch:' || ${agentWakeupRequests.id}::text`,
      eq(dispatch.idempotencyKey, agentWakeupRequests.idempotencyKey),
      or(inArray(dispatch.status, ["queued", "claimed", "completed", "coalesced"]),
        binding.completionRecovery
          ? and(eq(dispatch.status, "cancelled"), eq(heartbeatRuns.status, "cancelled")) : undefined),
      sql`${dispatch.payload}->>'issueId' = ${binding.issueId}`,
    ))
    .innerJoin(statusDecisionEffects, and(
      eq(statusDecisionEffects.companyId, binding.companyId), eq(statusDecisionEffects.issueId, binding.issueId),
      eq(statusDecisionEffects.targetType, "agent_wakeup_request"),
      sql`${statusDecisionEffects.targetId} = ${agentWakeupRequests.id}::text`,
      eq(statusDecisionEffects.deliveryState, "delivered"),
      or(and(
        eq(statusDecisionEffects.effectKind, "enqueue_continuation"),
        sql`${statusDecisionEffects.payload}->>'continuationKind' = 'same_agent'`,
        sql`${agentWakeupRequests.payload}->>'continuationKind' = 'same_agent'`,
      ), binding.completionRecovery ? undefined : and(
        // The one automatic retry after a failed turn answers the same chat.
        eq(statusDecisionEffects.effectKind, "schedule_retry"),
        sql`${agentWakeupRequests.payload}->>'retryCause' = ${NATIVE_RUN_FAILED_RETRY_CAUSE}`,
      )),
    ))
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.id, statusDecisionEffects.decisionId), eq(statusDecisions.companyId, binding.companyId),
      eq(statusDecisions.issueId, binding.issueId), eq(statusDecisions.applicationState, "applied"),
      or(and(
        eq(statusDecisions.reasonCode, binding.completionRecovery ? "completion_evidence_incomplete" : "live_continuation_registered"),
        binding.completionRecovery
          ? sql`${agentWakeupRequests.payload}->>'continuationIdempotencyKey' = 'native-completion-incomplete'`
          : undefined,
        sql`${agentWakeupRequests.idempotencyKey} = 'native-status:' || ${statusDecisions.id}::text || ':continuation'`,
      ), binding.completionRecovery ? undefined : and(
        eq(statusDecisions.reasonCode, "run_failed_partial_evidence_preserved"),
        sql`${agentWakeupRequests.idempotencyKey} = 'native-status:' || ${statusDecisions.id}::text || ':retry'`,
      )),
      sql`${agentWakeupRequests.payload}->>'nativeDecisionId' = ${statusDecisions.id}::text`,
    ))
    .innerJoin(source, and(
      eq(source.id, statusDecisions.runId), eq(source.companyId, binding.companyId),
      eq(source.nativeIssueId, binding.issueId), eq(source.runtimeMode, "native"),
      eq(source.agentId, heartbeatRuns.agentId), ne(source.id, heartbeatRuns.id),
      sql`${source.responsibleUserId} is not distinct from ${heartbeatRuns.responsibleUserId}`,
    ))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(boundRunIssueIdSql(), binding.issueId)))
    .groupBy(source.id).limit(2);
  return sources.length === 1 ? sources[0]!.runId : null;
}

/** Read the admitted handoff or its one server-issued completion correction.
 * Other native continuation provenance is for conversation delivery. */
export async function readCaseHandoffIdForNativeRun(
  db: Pick<Db, "select">,
  binding: { companyId: string; issueId: string; runId: string; contextSnapshot: unknown },
): Promise<string | null> {
  const context = record(binding.contextSnapshot);
  if (isStrictUuid(context.caseHandoffId)) return context.caseHandoffId;
  if (context.caseHandoffId != null || !isStrictUuid(context.nativeStatusWakeIntentId)) return null;
  const sourceRunId = await readNativeContinuationSource(db, { companyId: binding.companyId, issueId: binding.issueId,
    runId: binding.runId, completionRecovery: true });
  if (!sourceRunId) return null;
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, sourceRunId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.nativeIssueId, binding.issueId))).limit(1);
  const handoffId = record(source?.contextSnapshot).caseHandoffId;
  return isStrictUuid(handoffId) ? handoffId : null;
}
