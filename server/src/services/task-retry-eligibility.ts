import { and, desc, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { CHAT_COMPLETION_SUPERSEDED } from "./chat-completion-delivery.js";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@groktopus/db";

const UNSTARTED_SUPERSEDED_RUN_CODES = ["recovery_no_longer_needed", "issue_closed_before_start", "issue_execution_lock_changed"];

export function taskAttemptCondition(run: { status: SQL | typeof heartbeatRuns.status; startedAt: SQL | typeof heartbeatRuns.startedAt;
  errorCode: SQL | typeof heartbeatRuns.errorCode } = heartbeatRuns) {
  // Chat completion can be superseded after the scheduler records startedAt
  // but before provider dispatch. It must not eclipse real attempts or own Retry.
  return sql`coalesce(${run.errorCode}, '') <> ${CHAT_COMPLETION_SUPERSEDED}
    and not (${run.status} = 'cancelled' and ${run.startedAt} is null
      and coalesce(${run.errorCode}, '') in (
        ${sql.join(UNSTARTED_SUPERSEDED_RUN_CODES.map(code => sql`${code}`), sql`, `)}))`;
}

type TaskBindingColumns = {
  issueId: SQLWrapper;
  nativeIssueId: SQLWrapper;
  contextSnapshot: SQLWrapper;
  taskLineageJson: SQLWrapper;
};

export function legacyRetryTaskIssueId(run: TaskBindingColumns = heartbeatRuns) {
  const contextId = sql`${run.contextSnapshot}->>'issueId'`;
  const lineageId = sql`case when ${run.taskLineageJson}->>'version' = '1' then ${run.taskLineageJson}->'pathIssueIds'->>0 end`;
  const uuidPattern = sql`'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
  return sql<string | null>`coalesce(case when lower(${contextId}) ~ ${uuidPattern} then lower(${contextId}) end,
    case when lower(${lineageId}) ~ ${uuidPattern} then lower(${lineageId}) end)`;
}

export function retryRunTaskIssueId(run: TaskBindingColumns = heartbeatRuns) {
  return sql<string | null>`coalesce(${run.nativeIssueId}::text, ${run.issueId}::text, ${legacyRetryTaskIssueId(run)})`;
}

export function taskRetryRunIssueCondition(issueId: string | SQL<string>, run: TaskBindingColumns = heartbeatRuns) {
  const matchesId = (column: SQLWrapper) => typeof issueId === "string"
    ? sql`${column} = ${issueId}::uuid` : sql`${column}::text = ${issueId}`;
  return or(matchesId(run.nativeIssueId),
    and(isNull(run.nativeIssueId), matchesId(run.issueId)),
    and(isNull(run.nativeIssueId), isNull(run.issueId), eq(legacyRetryTaskIssueId(run), issueId)));
}

export function liveExecutionOwnerCondition(companyId: string, issueId: SQL | string) {
  return sql`${heartbeatRuns.status} in ('queued', 'running') and ${heartbeatRuns.id} = (select ${issues.executionRunId} from ${issues}
    where ${issues.companyId} = ${companyId} and ${issues.id} = ${issueId})`;
}

const REFUSALS_A_CLICK_CANNOT_CHANGE: ReadonlySet<string> = new Set([
  "cancelled_by_operator", "retry_source_changed", "workspace_owner_stop_required", "previous_execution_unverified",
]);

export function heldRetryOffersRetry(reason: string | null | undefined, cleanupSettling = false): boolean {
  if (!reason) return true;
  return !REFUSALS_A_CLICK_CANNOT_CHANGE.has(reason) && (reason !== "cleanup_quarantined" || !cleanupSettling);
}

export async function heldTaskRetryRefusals(db: Pick<Db, "selectDistinctOn">, companyId: string, issueIds: string[]): Promise<Map<string, string>> {
  if (!issueIds.length) return new Map();
  const issueId = sql<string>`${agentWakeupRequests.payload}->>'issueId'`;
  const latest = alias(heartbeatRuns, "latest");
  const rows = await db.selectDistinctOn([issueId], { issueId, sourceRunId: sql<string | null>`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}'`,
    reason: sql<string | null>`${agentWakeupRequests.payload}#>>'{executionWait,reason}'`,
    latestRunId: sql<string | null>`(select latest.id::text from ${heartbeatRuns} latest
      where latest.company_id = ${companyId} and ${taskRetryRunIssueCondition(issueId, latest)}
        and ${taskAttemptCondition({ status: sql`latest.status`, startedAt: sql`latest.started_at`, errorCode: sql`latest.error_code` })}
      order by latest.created_at desc, latest.id desc limit 1)` })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      isNull(agentWakeupRequests.runId), inArray(issueId, issueIds),
      sql`${agentWakeupRequests.payload}#>>'{executionWait,reason}' is not null`))
    .orderBy(issueId, desc(agentWakeupRequests.requestedAt));
  return new Map(rows.flatMap(row => row.reason && row.sourceRunId && row.sourceRunId === row.latestRunId
    ? [[row.issueId, row.reason] as const] : []));
}
