import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRecoveryDeferrals,
  issueRelations,
  issueThreadInteractions,
  issues,
  type Db,
} from "@groktopus/db";
import { DEPENDENCY_DIAGNOSIS_WAKE_KEY_PREFIX, getAgentWorkEligibility, ISSUE_BLOCKER_STALLED_WAKE_REASON, type DependencyDiagnosis } from "@groktopus/shared";
import { crashPoint } from "@groktopus/shared/crash-points";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { CHAT_CONTROL_RECOVERY_STOP_CODE, CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE } from "../chat-control-recovery-stop.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import type { WakeupOptions } from "../heartbeat/run-preparation.js";
import { caseCompletionRecoveryReadFields, projectCaseCompletionRecoveryAction } from "../issue-recovery-actions.js";
import { activeIssueInteractionCondition } from "../issue-question-context.js";
import { listPendingFinalizeBlockerIssueIds } from "../issues.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { automaticRunCreationHeldUntil } from "./automatic-run-brake.js";
import { stableJson } from "./stable-json.js";
import { pendingWakeSql, queuedRunStalledSql } from "./stalled-queued-run-sql.js";

const MAX_DEPENDENCY_DEPTH = 12;
const MAX_DEPENDENCY_NODES = 200;
const MAX_DEPENDENCY_EDGES = 400;
const MAX_DEPENDENCY_PATHS = 64;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const OPEN_RECOVERY_STATUSES = ["active", "escalated"];
const TERMINAL_STATUSES = ["done", "cancelled"];

type ParentDependencyWakeStatus = DependencyDiagnosis["wake"]["status"];
export type ParentDependencyDiagnosis = Omit<DependencyDiagnosis, "state" | "cause" | "nextOwner" | "wake"> & {
  state: Exclude<DependencyDiagnosis["state"], "restricted">;
  cause: DependencyDiagnosis["cause"] & { recoveryActionId?: string };
  nextOwner: DependencyDiagnosis["nextOwner"] & { id?: string };
  wake: DependencyDiagnosis["wake"] & { idempotencyKey: string; wakeupRequestId?: string };
};

type EnqueueWakeup = (agentId: string, opts: WakeupOptions) => Promise<unknown | null>;

export type ParentDependencyDiagnosisAuditEvent = {
  action: "issue.dependency_diagnosis.requested";
  details: {
    idempotencyKey: string;
    outcome: "pending" | "queued" | "refused" | "deferred" | "exhausted";
    assigneeAgentId: string;
    source: "automatic" | "user";
    attempt: number;
  };
};

type IssueRow = Pick<typeof issues.$inferSelect, "id" | "companyId" | "identifier" | "title" | "status"
  | "statusVersion" | "assigneeAgentId" | "assigneeUserId" | "hiddenAt" | "unblockDescriptor" | "monitorNextCheckAt">;

const issueColumns = {
  id: issues.id, companyId: issues.companyId, identifier: issues.identifier, title: issues.title,
  status: issues.status, statusVersion: issues.statusVersion, assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId, hiddenAt: issues.hiddenAt, unblockDescriptor: issues.unblockDescriptor,
  monitorNextCheckAt: issues.monitorNextCheckAt,
};

type DiagnosisAdmission = { runId?: string | null; wakeupRequestId?: string | null };
type DiagnosisInput = { companyId: string; issueId: string; now?: Date };
type GraphEdge = { parent: string; blocker: string };
type PathFacts = {
  active: Set<string>;
  waits: Map<string, { kind: string; action: string; actionId?: string; owner: ParentDependencyDiagnosis["nextOwner"] }>;
  agentNames: Map<string, string>;
  agents: Array<Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "status" | "reportsTo" | "lifecycleState" | "lifecycleHolds" | "pauseReason">>;
  revisions: Map<string, string>;
};


function keyFor(input: { parent: IssueRow; path: IssueRow[]; edges: GraphEdge[]; state: ParentDependencyDiagnosis["state"];
  pathRevisions: Map<string, string>;
  cause: ParentDependencyDiagnosis["cause"] }) {
  const digest = createHash("sha256").update(stableJson({
    version: 1,
    parentId: input.parent.id,
    assigneeAgentId: input.parent.assigneeAgentId,
    state: input.state,
    path: input.path.map((issue) => ({ id: issue.id, status: issue.status, statusVersion: issue.statusVersion })),
    pathRevisions: input.path.map(issue => [issue.id, input.pathRevisions.get(issue.id) ?? "none"]),
    edges: input.edges.filter(edge => input.path.some(issue => issue.id === edge.blocker)
      && input.path.some(issue => issue.id === edge.parent) || edge.parent === input.parent.id && input.path.some(issue => issue.id === edge.blocker))
      .sort((a, b) => a.parent.localeCompare(b.parent) || a.blocker.localeCompare(b.blocker)),
    cause: input.cause,
  })).digest("hex");
  // The key is opaque: descendant issue ids never appear in the durable key.
  return `${DEPENDENCY_DIAGNOSIS_WAKE_KEY_PREFIX}${digest}`;
}

function mapWakeStatus(row: { id: string; status: string; runStatus: string | null } | undefined): ParentDependencyWakeStatus {
  if (!row) return "not_requested";
  if (row.status === "queued" || row.status === "coalesced") return "queued";
  if (row.status === "deferred_issue_execution") return "deferred";
  if (row.status === "claimed" || row.runStatus === "queued" || row.runStatus === "running" || row.runStatus === "scheduled_retry") return "running";
  if (row.status === "completed" || row.runStatus === "succeeded") return "completed";
  if (row.status === "failed") return "exhausted";
  return "refused";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readDiagnosisClaim(db: Db, companyId: string, issueId: string, idempotencyKey: string) {
  const [row] = await db.select({ id: activityLog.id, actorId: activityLog.actorId, details: activityLog.details }).from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.dependency_diagnosis.requested"),
      sql`${activityLog.details}->>'idempotencyKey' = ${idempotencyKey}`))
    .orderBy(desc(activityLog.createdAt)).limit(1);
  return row ? { ...row, details: object(row.details) } : undefined;
}

const DIAGNOSIS_MAX_ATTEMPTS = 3;
const DIAGNOSIS_QUEUE = DELIVERY_QUEUES.assignedWorkInvariant;

function attemptDeadline(details: Record<string, unknown>): Date | null {
  const time = typeof details.nextAttemptAt === "string" ? Date.parse(details.nextAttemptAt) : NaN;
  return Number.isFinite(time) ? new Date(time) : null;
}

async function persistDiagnosisDeadline(db: Db, input: DiagnosisInput, dueAt: Date | null, previousDueAt: Date | null) {
  const scope = and(eq(issueRecoveryDeferrals.queue, DIAGNOSIS_QUEUE),
    eq(issueRecoveryDeferrals.companyId, input.companyId), eq(issueRecoveryDeferrals.issueId, input.issueId));
  if (!dueAt) {
    if (previousDueAt) await db.delete(issueRecoveryDeferrals).where(and(scope, eq(issueRecoveryDeferrals.dueAt, previousDueAt)));
    return;
  }
  await notifyDeliveryWork(db, DIAGNOSIS_QUEUE, JSON.stringify({ companyId: input.companyId, issueId: input.issueId }));
  await db.insert(issueRecoveryDeferrals).values({ queue: DIAGNOSIS_QUEUE, issueId: input.issueId, companyId: input.companyId, dueAt })
    .onConflictDoUpdate({
      target: [issueRecoveryDeferrals.queue, issueRecoveryDeferrals.issueId],
      set: { dueAt: previousDueAt
        ? sql`case when ${issueRecoveryDeferrals.dueAt} = ${previousDueAt.toISOString()}::timestamptz then excluded.due_at
          else least(${issueRecoveryDeferrals.dueAt}, excluded.due_at) end`
        : sql`least(${issueRecoveryDeferrals.dueAt}, excluded.due_at)` },
      setWhere: eq(issueRecoveryDeferrals.companyId, input.companyId),
    });
}

async function settleDiagnosisClaim(db: Db, input: DiagnosisInput & { idempotencyKey: string; attempt: number },
  outcome: "queued" | "deferred" | "refused") {
  const now = input.now ?? new Date();
  const terminal = outcome !== "queued" && input.attempt >= DIAGNOSIS_MAX_ATTEMPTS;
  const retryAt = outcome === "queued" || terminal ? null
    : new Date(now.getTime() + (outcome === "deferred" ? 60_000 : 10 * 60_000));
  const message = terminal ? "Diagnosis wake admission did not succeed after three attempts."
    : outcome === "deferred" ? "Wake admission did not settle; it will be retried."
      : outcome === "refused" ? "The current execution gates refused the wake." : null;
  const update = { outcome: terminal ? "exhausted" : outcome, nextAttemptAt: retryAt?.toISOString() ?? null, message };
  const settled = await db.transaction(async tx => {
    const database = tx as unknown as Db;
    const current = await readDiagnosisClaim(database, input.companyId, input.issueId, input.idempotencyKey);
    if (!current) return false;
    const [settled] = await tx.update(activityLog)
      .set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify(update)}::jsonb` })
      .where(and(eq(activityLog.id, current.id), sql`${activityLog.details}->>'outcome' = 'pending'`,
        sql`${activityLog.details}->>'attempt' = ${String(input.attempt)}`)).returning({ id: activityLog.id });
    if (settled) await persistDiagnosisDeadline(database, input, retryAt, attemptDeadline(current.details));
    return Boolean(settled);
  });
  if (settled) publishActivity({
    companyId: input.companyId,
    payload: { issueId: input.issueId, entityType: "issue", entityId: input.issueId,
      action: "issue.dependency_diagnosis.settled", actorType: "system", actorId: "parent_dependency_diagnosis" },
    pluginEvent: null,
  });
  return retryAt;
}

async function readIssue(db: Db, companyId: string, issueId: string) {
  const [row] = await db.select(issueColumns).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  return row;
}

async function readGraph(db: Db, companyId: string, parentId: string) {
  const parent = await readIssue(db, companyId, parentId);
  if (!parent) return null;
  const nodes = new Map<string, IssueRow>([[parent.id, parent]]);
  const edges: GraphEdge[] = [];
  let frontier = [parent.id];
  let truncated = false;
  for (let depth = 0; depth < MAX_DEPENDENCY_DEPTH && frontier.length && nodes.size < MAX_DEPENDENCY_NODES; depth += 1) {
    const remaining = MAX_DEPENDENCY_EDGES - edges.length;
    const rows = await db.select({ ...issueColumns, parent: issueRelations.relatedIssueId, executionWorkspaceId: issues.executionWorkspaceId })
      .from(issueRelations).innerJoin(issues, and(eq(issues.companyId, issueRelations.companyId), eq(issues.id, issueRelations.issueId)))
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, frontier), or(ne(issues.status, "done"), isNotNull(issues.executionWorkspaceId))))
      .orderBy(issueRelations.relatedIssueId, issueRelations.issueId).limit(remaining + 1);
    if (rows.length > remaining) truncated = true;
    const candidates = rows.slice(0, remaining);
    const pendingFinalize = await listPendingFinalizeBlockerIssueIds(db, companyId, candidates.flatMap(row =>
      row.status === "done" && row.executionWorkspaceId ? [{ blockerIssueId: row.id, executionWorkspaceId: row.executionWorkspaceId }] : []));
    const next: string[] = [];
    for (const row of candidates) {
      if (row.status === "done" && !pendingFinalize.has(row.id)) continue;
      if (!nodes.has(row.id)) {
        if (nodes.size < MAX_DEPENDENCY_NODES) {
          nodes.set(row.id, row);
          if (!TERMINAL_STATUSES.includes(row.status)) next.push(row.id);
        } else {
          truncated = true;
          continue;
        }
      }
      edges.push({ parent: row.parent, blocker: row.id });
    }
    frontier = next;
    if (truncated) break;
  }
  if (frontier.length) truncated = true;
  return { parent, nodes, edges, truncated };
}

function dependencyPaths(parentId: string, nodes: Map<string, IssueRow>, edges: GraphEdge[]) {
  const blockersByIssue = new Map<string, string[]>();
  for (const edge of edges) {
    const list = blockersByIssue.get(edge.parent) ?? [];
    list.push(edge.blocker);
    blockersByIssue.set(edge.parent, list);
  }
  for (const list of blockersByIssue.values()) list.sort();
  const paths: IssueRow[][] = [];
  let truncated = false;
  const visit = (current: string, path: string[]) => {
    if (paths.length >= MAX_DEPENDENCY_PATHS) { truncated = true; return; }
    for (const blockerId of blockersByIssue.get(current) ?? []) {
      if (paths.length >= MAX_DEPENDENCY_PATHS) { truncated = true; return; }
      if (path.includes(blockerId)) { truncated = true; paths.push(path.map(id => nodes.get(id)!).filter(Boolean)); continue; }
      const next = [...path, blockerId];
      const blockers = blockersByIssue.get(blockerId) ?? [];
      if (!blockers.length) paths.push(next.map(id => nodes.get(id)!).filter(Boolean));
      else visit(blockerId, next);
    }
  };
  visit(parentId, []);
  return { paths, truncated, blockersByIssue };
}

async function readPathFacts(db: Db, companyId: string, issueIds: string[], now: Date, admission?: DiagnosisAdmission): Promise<PathFacts> {
  if (!issueIds.length) return { active: new Set<string>(), waits: new Map(), agentNames: new Map(), agents: [], revisions: new Map() };
  const [runs, wakes, actions, interactions, approvalRows, agentsRows] = await Promise.all([
    db.select({ issueId: sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`, id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        sql`not ${queuedRunStalledSql(heartbeatRuns, now)}`,
        inArray(sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`, issueIds),
        admission?.runId ? ne(heartbeatRuns.id, admission.runId) : undefined)),
    db.select({ issueId: sql<string>`${agentWakeupRequests.payload}->>'issueId'`, id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), pendingWakeSql(agentWakeupRequests, now),
        inArray(sql<string>`${agentWakeupRequests.payload}->>'issueId'`, issueIds),
        admission?.wakeupRequestId ? ne(agentWakeupRequests.id, admission.wakeupRequestId) : undefined)),
    db.select({ issueId: issueRecoveryActions.sourceIssueId, id: issueRecoveryActions.id, kind: issueRecoveryActions.kind,
      cause: issueRecoveryActions.cause, ownerType: issueRecoveryActions.ownerType, ownerAgentId: issueRecoveryActions.ownerAgentId,
      ownerUserId: issueRecoveryActions.ownerUserId, nextAction: issueRecoveryActions.nextAction, status: issueRecoveryActions.status,
      outcome: issueRecoveryActions.outcome, updatedAt: issueRecoveryActions.updatedAt, ...caseCompletionRecoveryReadFields })
      .from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, issueIds),
        or(inArray(issueRecoveryActions.status, OPEN_RECOVERY_STATUSES),
          and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"), eq(issueRecoveryActions.ownerType, "board")))))
      .orderBy(desc(issueRecoveryActions.updatedAt)),
    db.select({ issueId: issueThreadInteractions.issueId, id: issueThreadInteractions.id })
      .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.issueId, issueIds),
        eq(issueThreadInteractions.status, "pending"), activeIssueInteractionCondition())),
    db.select({ issueId: issueApprovals.issueId, id: issueApprovals.approvalId })
      .from(issueApprovals).innerJoin(approvals, and(eq(approvals.companyId, issueApprovals.companyId), eq(approvals.id, issueApprovals.approvalId)))
      .where(and(eq(issueApprovals.companyId, companyId), inArray(issueApprovals.issueId, issueIds), eq(approvals.status, "pending"))),
    db.select({ id: agents.id, name: agents.name, companyId: agents.companyId, status: agents.status, reportsTo: agents.reportsTo,
      lifecycleState: agents.lifecycleState, lifecycleHolds: agents.lifecycleHolds, pauseReason: agents.pauseReason })
      .from(agents).where(eq(agents.companyId, companyId)),
  ]);
  const active = new Set([...runs.map(row => row.issueId), ...wakes.map(row => row.issueId)]);
  const waits = new Map<string, { kind: string; action: string; actionId?: string; owner: ParentDependencyDiagnosis["nextOwner"] }>();
  for (const action of actions) {
    if (waits.has(action.issueId)) continue;
    const owner = action.ownerType === "user" && action.ownerUserId
      ? { type: "user" as const, id: action.ownerUserId }
      : action.ownerType === "agent" && action.ownerAgentId
        ? { type: "agent" as const, id: action.ownerAgentId }
        : { type: "board" as const };
    const nextAction = projectCaseCompletionRecoveryAction(action)?.nextAction
      ?? (action.nextAction || "Review the recovery action and decide the next step.");
    waits.set(action.issueId, { kind: action.cause, action: nextAction, actionId: action.id, owner });
  }
  for (const row of [...interactions, ...approvalRows]) if (!waits.has(row.issueId)) {
    waits.set(row.issueId, { kind: "human_action", action: "Respond to the open question or approval before this dependency can continue.", owner: { type: "board" } });
  }
  const revisions = new Map<string, string[]>();
  const addRevision = (issueId: string, revision: string) => revisions.set(issueId, [...(revisions.get(issueId) ?? []), revision]);
  for (const run of runs) addRevision(run.issueId, `run:${run.id}:${run.status}`);
  for (const wake of wakes) addRevision(wake.issueId, `wake:${wake.id}:${wake.status}`);
  for (const action of actions) addRevision(action.issueId, `action:${action.id}:${action.status}:${action.cause}`);
  return { active, waits, agentNames: new Map(agentsRows.map(row => [row.id, row.name])), agents: agentsRows,
    revisions: new Map([...revisions].map(([id, values]) => [id, values.sort().join("|")])) };
}

function classifyPath(path: IssueRow[], facts: Awaited<ReturnType<typeof readPathFacts>>, parent: IssueRow, now: Date,
  blockersByIssue: Map<string, string[]>): { state: ParentDependencyDiagnosis["state"]; path: IssueRow[];
    cause: ParentDependencyDiagnosis["cause"]; nextOwner: ParentDependencyDiagnosis["nextOwner"]; nextAction: string } | null {
  if (!path.length) return null;
  for (let index = 0; index < path.length; index += 1) {
    const node = path[index]!;
    if (node.status === "cancelled") return { state: "external_wait", path: path.slice(0, index + 1),
      cause: { kind: "cancelled_dependency", issueId: node.id }, nextOwner: { type: "board" },
      nextAction: "Ask the board to remove or replace the cancelled required dependency." };
    if (node.status === "done") return { state: "active", path: path.slice(0, index + 1),
      cause: { kind: "workspace_finalization_pending", issueId: node.id }, nextOwner: { type: "board" },
      nextAction: "Wait for the required dependency’s workspace finalization to finish." };
    if (facts.active.has(node.id)) return { state: "active" as const, path: path.slice(0, index + 1),
      cause: { kind: "execution_active", issueId: node.id }, nextOwner: { type: "agent" as const,
        ...(node.assigneeAgentId ? { id: node.assigneeAgentId, name: facts.agentNames.get(node.assigneeAgentId) } : {}) },
      nextAction: "Wait for the required dependency's active run or queued retry to finish." };
    const waiting = facts.waits.get(node.id);
    if (waiting) return { state: "external_wait" as const, path: path.slice(0, index + 1),
      cause: { kind: waiting.kind, issueId: node.id, ...(waiting.actionId ? { recoveryActionId: waiting.actionId } : {}) },
      nextOwner: waiting.owner, nextAction: waiting.action };
    if (node.monitorNextCheckAt && node.monitorNextCheckAt.getTime() > now.getTime()) return { state: "active" as const,
      path: path.slice(0, index + 1), cause: { kind: "scheduled_monitor", issueId: node.id },
      nextOwner: { type: "agent", ...(node.assigneeAgentId ? { id: node.assigneeAgentId, name: facts.agentNames.get(node.assigneeAgentId) } : {}) },
      nextAction: `Wait for the scheduled dependency check at ${node.monitorNextCheckAt.toISOString()}.` };
    if (node.assigneeUserId) return { state: "external_wait" as const, path: path.slice(0, index + 1),
      cause: { kind: "human_assignee", issueId: node.id }, nextOwner: { type: "user", id: node.assigneeUserId },
      nextAction: "The human owner must finish or reassign this dependency." };
    if (node.status === "blocked" && node.unblockDescriptor) {
      const owner = node.unblockDescriptor.owner as { agentId?: string; userId?: string } | "board" | null;
      return { state: "external_wait" as const, path: path.slice(0, index + 1),
        cause: { kind: "declared_block", issueId: node.id },
        nextOwner: owner === "board" ? { type: "board" as const }
          : owner?.userId ? { type: "user" as const, id: owner.userId }
            : { type: "agent" as const, ...(owner?.agentId ? { id: owner.agentId, name: facts.agentNames.get(owner.agentId) } : {}) },
        nextAction: "Resolve the dependency's declared unblock action." };
    }
    if (node.assigneeAgentId) {
      const agent = facts.agents.find(row => row.id === node.assigneeAgentId);
      const eligible = agent && getAgentWorkEligibility({ agent, agents: facts.agents }).invokable
        && !["preparing", "verifying", "resuming"].includes(agent.lifecycleState) && agent.lifecycleHolds.length === 0;
      if (!eligible) return { state: "external_wait" as const, path: path.slice(0, index + 1),
        cause: { kind: "assignee_unavailable", issueId: node.id }, nextOwner: { type: "board" as const },
        nextAction: `Restore or replace the assignee for ${node.identifier ?? node.id}.` };
    }
    // An intermediate task with its own required blockers is a path to inspect,
    // not itself the cause. Continue until the deepest actionable dependency.
    if ((blockersByIssue.get(node.id) ?? []).length > 0) continue;
    return { state: "no_execution_path" as const, path: path.slice(0, index + 1),
      cause: { kind: node.assigneeAgentId ? "assignee_has_no_execution_path" : "unassigned_dependency", issueId: node.id },
      nextOwner: parent.assigneeAgentId ? { type: "agent" as const, id: parent.assigneeAgentId,
        name: facts.agentNames.get(parent.assigneeAgentId) } : { type: "board" as const },
      nextAction: `Inspect the required dependency, continue independent work, or propose an actionable replacement.` };
  }
  return null;
}

export function isOperatorStoppedRun(run: Pick<typeof heartbeatRuns.$inferSelect, "status" | "errorCode" | "resultJson">): boolean {
  return [CHAT_CONTROL_RECOVERY_STOP_CODE, CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE, "operator_interrupted"].includes(run.errorCode ?? "")
    || (run.status === "cancelled" && ["user", "board"].includes(String(object(run.resultJson).cancelledByActorType)));
}

async function parentGate(db: Db, companyId: string, parent: IssueRow, facts: PathFacts, now: Date, admission?: DiagnosisAdmission): Promise<
  { owner: ParentDependencyDiagnosis["nextOwner"]; action: string; retryAt?: Date } | null> {
  if (!parent.assigneeAgentId || parent.assigneeUserId || parent.hiddenAt || !["todo", "in_progress", "blocked"].includes(parent.status)) {
    return { owner: { type: "board" }, action: "Assign the parent task to an active agent before requesting an investigation." };
  }
  const assignee = facts.agents.find(row => row.id === parent.assigneeAgentId);
  if (!assignee || !getAgentWorkEligibility({ agent: assignee, agents: facts.agents }).invokable
    || ["preparing", "verifying", "resuming"].includes(assignee.lifecycleState) || assignee.lifecycleHolds.length > 0) {
    return { owner: { type: "board" }, action: "Restore or replace the parent assignee before requesting an investigation." };
  }
  if (assignee.pauseReason === "budget" || assignee.pauseReason === "budget_exceeded") {
    return { owner: { type: "board" }, action: "Resolve the parent assignee's budget hard stop before requesting an investigation." };
  }
  if (facts.active.has(parent.id)) return { owner: { type: "agent", id: assignee.id, name: assignee.name },
    action: "The parent already has active work. Let that turn finish before requesting another investigation." };
  if (facts.waits.has(parent.id)) return { owner: facts.waits.get(parent.id)!.owner, action: facts.waits.get(parent.id)!.action };
  if (parent.monitorNextCheckAt && parent.monitorNextCheckAt.getTime() > now.getTime()) {
    return { owner: { type: "agent", id: assignee.id, name: assignee.name }, action: "Wait for the parent's scheduled check." };
  }
  const [company] = await db.select({ status: companies.status, pauseReason: companies.pauseReason }).from(companies).where(eq(companies.id, companyId));
  if (company?.pauseReason === "budget" || company?.pauseReason === "budget_exceeded") {
    return { owner: { type: "board" }, action: "Resolve the company budget hard stop before requesting an investigation." };
  }
  if (company?.status === "paused") return { owner: { type: "board" }, action: "Resume the company before requesting an investigation." };
  if ((await issueTreeControlService(db).listActivePauseHeldIssueIds(companyId, [parent.id])).has(parent.id)) {
    return { owner: { type: "board" }, action: "Release the task pause before requesting an investigation." };
  }
  const [[latestRun], [pausedGoal]] = await Promise.all([
    db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      resultJson: sql<typeof heartbeatRuns.$inferSelect.resultJson>`jsonb_build_object('cancelledByActorType', ${heartbeatRuns.resultJson}->'cancelledByActorType')` }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${parent.id}`,
        admission?.runId ? ne(heartbeatRuns.id, admission.runId) : undefined))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1),
    db.select({ id: agentTaskSessions.id }).from(agentTaskSessions)
      .innerJoin(agents, and(eq(agents.companyId, agentTaskSessions.companyId), eq(agents.id, agentTaskSessions.agentId),
        eq(agents.adapterType, agentTaskSessions.adapterType)))
      .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.taskKey, parent.id),
        eq(agentTaskSessions.agentId, assignee.id), ne(agentTaskSessions.goalStatus, "complete"),
        sql`(${agentTaskSessions.goalStatus} <> 'active' or ${agentTaskSessions.goalDesiredState} is distinct from 'active')`)).limit(1),
  ]);
  if (pausedGoal || (latestRun?.agentId === assignee.id && isOperatorStoppedRun(latestRun))) {
    return { owner: { type: "board" }, action: "Resume the stopped parent work before requesting an investigation." };
  }
  const heldUntil = await automaticRunCreationHeldUntil(db, companyId, { issueId: parent.id, sourceRunId: latestRun?.id ?? null });
  if (heldUntil && heldUntil > now) return { owner: { type: "board" }, action: `Automatic work is held until ${heldUntil.toISOString()}.`, retryAt: heldUntil };
  return null;
}

async function readWakeReceipt(db: Db, input: DiagnosisInput & { idempotencyKey: string; assigneeAgentId: string | null }) {
  if (!input.assigneeAgentId) return undefined;
  const [row] = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId,
    runStatus: heartbeatRuns.status }).from(agentWakeupRequests)
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, agentWakeupRequests.companyId), eq(heartbeatRuns.id, agentWakeupRequests.runId)))
    .where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
      eq(agentWakeupRequests.agentId, input.assigneeAgentId), eq(agentWakeupRequests.reason, ISSUE_BLOCKER_STALLED_WAKE_REASON),
      inArray(agentWakeupRequests.requestedByActorType, ["system", "user"]),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      or(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed", "coalesced", "completed"]),
        sql`${agentWakeupRequests.runId} is not null`)))
    .orderBy(desc(agentWakeupRequests.createdAt)).limit(1);
  return row ? { id: row.id, status: row.status, runStatus: row.runStatus } : undefined;
}

async function readDiagnosisState(db: Db, input: DiagnosisInput, admission?: DiagnosisAdmission) {
  const graph = await readGraph(db, input.companyId, input.issueId);
  if (!graph) return null;
  const { paths, truncated: pathLimitReached, blockersByIssue } = dependencyPaths(graph.parent.id, graph.nodes, graph.edges);
  if (!paths.length && !graph.truncated) return null;
  const ids = [...new Set(paths.flat().map(row => row.id))];
  const now = input.now ?? new Date();
  const facts = await readPathFacts(db, input.companyId, [...ids, graph.parent.id], now, admission);
  // A fully active required path does not create a diagnosis. Prefer the first
  // stalled path; if every unresolved path already has an owner, report the
  // first named external wait instead.
  const classified = paths.map(path => classifyPath(path, facts, graph.parent, now, blockersByIssue)).filter(Boolean) as NonNullable<ReturnType<typeof classifyPath>>[];
  const truncated = graph.truncated || pathLimitReached;
  const result = truncated
    ? { state: "external_wait" as const, path: paths[0] ?? [], cause: { kind: "dependency_graph_bound", issueId: null },
      nextOwner: { type: "board" as const }, nextAction: "The required dependency graph exceeds the automatic diagnosis bound. Review the dependency chain and choose the next action." }
    : classified.find(row => row.state === "no_execution_path")
      ?? classified.find(row => row.state === "external_wait")
      ?? classified[0];
  if (!result) return null;
  const key = keyFor({ parent: graph.parent, path: result.path, edges: graph.edges, state: result.state,
    cause: result.cause, pathRevisions: facts.revisions });
  const [wake, claim] = await Promise.all([
    readWakeReceipt(db, { ...input, idempotencyKey: key, assigneeAgentId: graph.parent.assigneeAgentId }), readDiagnosisClaim(db, input.companyId, graph.parent.id, key),
  ]);
  const wakeStatus = wake ? mapWakeStatus(wake) : claim
    ? claim.details.outcome === "refused" ? "refused"
      : claim.details.outcome === "deferred" ? "deferred"
        : claim.details.outcome === "exhausted" ? "exhausted"
          : claim.details.outcome === "queued" ? "queued"
            : claim.details.outcome === "pending" ? "deferred" : "queued"
    : "not_requested";
  const gate = result.state === "no_execution_path" ? await parentGate(db, input.companyId, graph.parent, facts, now, admission) : null;
  const wakeGateAction = wakeStatus === "refused" || wakeStatus === "exhausted"
    ? "The diagnostic continuation could not start. Review the parent task’s execution status for the current next step."
    : null;
  const diagnosis: ParentDependencyDiagnosis = {
    state: result.state,
    dependencyPath: result.path.map(row => ({ issueId: row.id, identifier: row.identifier, title: row.title, status: row.status })),
    cause: result.cause,
    nextOwner: gate?.owner ?? result.nextOwner,
    nextAction: gate?.action ?? wakeGateAction ?? result.nextAction,
    wake: { idempotencyKey: key, status: wakeStatus, ...(wake ? { wakeupRequestId: wake.id } : {}) },
    canInvestigate: result.state === "no_execution_path" && !gate && wakeStatus === "not_requested",
  };
  return { diagnosis, gate, wake, claim, parent: graph.parent };
}

export async function readParentDependencyDiagnosis(db: Db, input: DiagnosisInput): Promise<ParentDependencyDiagnosis | null> {
  return (await readDiagnosisState(db, input))?.diagnosis ?? null;
}

async function claimDiagnosis(db: Db, input: DiagnosisInput & { idempotencyKey: string;
  assigneeAgentId: string; source: "automatic" | "user"; actorId: string | null }) {
  const publications: ActivityPublication[] = [];
  const now = input.now ?? new Date();
  const result = await db.transaction(async tx => {
    const database = tx as unknown as Db;
    const [parent] = await tx.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    if (parent?.assigneeAgentId !== input.assigneeAgentId) return null;
    const current = await readDiagnosisState(database, input);
    if (!current || current.gate || current.wake || current.diagnosis.state !== "no_execution_path"
      || current.diagnosis.wake.idempotencyKey !== input.idempotencyKey) return null;
    const existing = current.claim;
    const previousDueAt = existing ? attemptDeadline(existing.details) : null;
    if (existing && (previousDueAt && previousDueAt > now
      || !["pending", "refused", "deferred"].includes(String(existing.details.outcome)))) return null;
    const previousAttempt = Number(existing?.details.attempt ?? 0);
    const replay = existing?.details.outcome === "pending";
    if (existing && !replay && previousAttempt >= DIAGNOSIS_MAX_ATTEMPTS) {
      const exhausted = { outcome: "exhausted", nextAttemptAt: null,
        message: "Diagnosis wake admission did not succeed after three attempts." };
      await tx.update(activityLog)
        .set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify(exhausted)}::jsonb` })
        .where(eq(activityLog.id, existing.id));
      await persistDiagnosisDeadline(database, input, null, previousDueAt);
      return null;
    }
    // Replaying an interrupted admission keeps the same attempt and wake key.
    const attempt = replay ? previousAttempt : previousAttempt + 1;
    const details: ParentDependencyDiagnosisAuditEvent["details"] = {
      idempotencyKey: input.idempotencyKey, outcome: "pending", assigneeAgentId: input.assigneeAgentId,
      source: existing?.details.source === "user" ? "user" : input.source, attempt,
    };
    const pendingDetails = { ...details, nextAttemptAt: now.toISOString() };
    if (existing) {
      await tx.update(activityLog)
        .set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify(pendingDetails)}::jsonb` })
        .where(eq(activityLog.id, existing.id));
    } else {
      await logActivity(database, { companyId: input.companyId, actorType: input.source === "user" ? "user" : "system",
        actorId: input.actorId ?? "parent_dependency_diagnosis", agentId: input.assigneeAgentId, runId: null,
        action: "issue.dependency_diagnosis.requested", entityType: "issue", entityId: input.issueId,
        details: pendingDetails }, publications);
    }
    // A restart after the claim commits can find this exact issue even with
    // a recent assigned-work full pass and otherwise unchanged issue rows.
    await persistDiagnosisDeadline(database, input, now, previousDueAt);
    return { action: "issue.dependency_diagnosis.requested" as const, details };
  });
  for (const publication of publications) publishActivity(publication);
  return result;
}

async function deliverDiagnosis(db: Db, input: DiagnosisInput & { idempotencyKey: string; assigneeAgentId: string;
  source: "automatic" | "user"; actorId: string | null; enqueueWakeup: EnqueueWakeup }, attempt: number) {
  const persisted = await readWakeReceipt(db, input);
  if (persisted) {
    await settleDiagnosisClaim(db, { ...input, attempt }, "queued");
    return { accepted: true, retryAt: null };
  }
  crashPoint("issue.dependency_diagnosis.after_claim_before_wake");
  let outcome: "queued" | "deferred" | "refused";
  try {
    const wake = await input.enqueueWakeup(input.assigneeAgentId, {
      source: input.source === "user" ? "on_demand" : "automation",
      triggerDetail: input.source === "user" ? "manual" : "system",
      reason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
      payload: { issueId: input.issueId },
      idempotencyKey: input.idempotencyKey,
      requestedByActorType: input.source === "user" ? "user" : "system",
      requestedByActorId: input.actorId,
      contextSnapshot: {
        issueId: input.issueId, taskId: input.issueId, wakeReason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
        dependencyDiagnosis: true, dependencyDiagnosisKey: input.idempotencyKey,
        livenessContinuationInstruction: "A required dependency has no active execution or named recovery path. Inspect the authorized dependency context, continue independent work, or propose a replacement. Leave unresolved dependencies intact until the board approves a change.",
      },
      issueStateGuard: { statuses: ["todo", "in_progress", "blocked"], assigneeAgentId: input.assigneeAgentId },
      allowRunCoalescing: false,
    });
    outcome = wake || await readWakeReceipt(db, input) ? "queued" : "refused";
  } catch {
    outcome = "deferred";
  }
  const retryAt = await settleDiagnosisClaim(db, { ...input, attempt }, outcome);
  return { accepted: outcome === "queued", retryAt };
}

export async function requestParentDependencyDiagnosis(db: Db, input: {
  companyId: string;
  issueId: string;
  idempotencyKey: string;
  actorId: string;
  enqueueWakeup: EnqueueWakeup;
}): Promise<{ accepted: boolean; message: string; auditEvent?: ParentDependencyDiagnosisAuditEvent }> {
  const current = await readDiagnosisState(db, input);
  if (!current || current.diagnosis.state !== "no_execution_path" || current.diagnosis.wake.idempotencyKey !== input.idempotencyKey) {
    return { accepted: false, message: "The dependency state changed. Refresh the task and review its current next action." };
  }
  if (current.wake) return { accepted: !["refused", "exhausted"].includes(mapWakeStatus(current.wake)),
    message: "The diagnostic continuation is already recorded." };
  if (current.claim && ["pending", "deferred", "refused", "queued"].includes(String(current.claim.details.outcome))) {
    return { accepted: true, message: "The diagnostic investigation request is already recorded." };
  }
  const assigneeAgentId = current.parent.assigneeAgentId;
  if (!assigneeAgentId || !current.diagnosis.canInvestigate) return { accepted: false, message: current.diagnosis.nextAction };
  const delivery = { ...input, assigneeAgentId, source: "user" as const };
  const auditEvent = await claimDiagnosis(db, delivery);
  if (!auditEvent) return { accepted: false, message: "The task state changed. Refresh the task before requesting an investigation." };
  const result = await deliverDiagnosis(db, delivery, auditEvent.details.attempt);
  return { accepted: result.accepted, auditEvent,
    message: result.accepted ? "The assignee was asked to investigate the dependency."
      : result.retryAt ? "The wake could not be admitted. The request will be retried."
        : "The diagnostic continuation could not be admitted." };
}

export async function reconcileParentDependencyDiagnosis(db: Db, input: DiagnosisInput & { enqueueWakeup: EnqueueWakeup }) {
  const current = await readDiagnosisState(db, input);
  if (!current || current.diagnosis.state !== "no_execution_path" || !current.parent.assigneeAgentId || current.wake) {
    return { accepted: false, retryAt: null };
  }
  if (current.gate) return { accepted: false, retryAt: current.gate.retryAt ?? null };
  if (current.claim) {
    if (!["pending", "deferred", "refused"].includes(String(current.claim.details.outcome))) {
      return { accepted: false, retryAt: null };
    }
    const dueAt = attemptDeadline(current.claim.details);
    if (dueAt && dueAt > (input.now ?? new Date())) return { accepted: false, retryAt: dueAt };
  }
  const manualClaim = current.claim?.details.source === "user" ? current.claim : null;
  const delivery = { ...input, idempotencyKey: current.diagnosis.wake.idempotencyKey,
    assigneeAgentId: current.parent.assigneeAgentId, source: manualClaim ? "user" as const : "automatic" as const,
    actorId: manualClaim?.actorId ?? null };
  const claim = await claimDiagnosis(db, delivery);
  return claim ? deliverDiagnosis(db, delivery, claim.details.attempt) : { accepted: false, retryAt: null };
}

export async function verifyParentDependencyDiagnosisWake(db: Db, input: {
  companyId: string; issueId: string; contextSnapshot: Record<string, unknown> | null | undefined;
  runId?: string | null;
  wakeupRequestId?: string | null;
}): Promise<boolean> {
  const context = input.contextSnapshot;
  if (context?.dependencyDiagnosis !== true || typeof context.dependencyDiagnosisKey !== "string") return false;
  const retryOfRunId = typeof context.retryOfRunId === "string" ? context.retryOfRunId : null;
  if (retryOfRunId) {
    if (!input.runId) return false;
    const [retry] = await db.select({ retryOfRunId: heartbeatRuns.retryOfRunId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, retryOfRunId)));
    const retryContext = retry?.contextSnapshot && typeof retry.contextSnapshot === "object" ? retry.contextSnapshot as Record<string, unknown> : {};
    const sourceContext = source?.contextSnapshot && typeof source.contextSnapshot === "object" ? source.contextSnapshot as Record<string, unknown> : {};
    if (retry?.retryOfRunId !== retryOfRunId || retryContext.dependencyDiagnosisKey !== context.dependencyDiagnosisKey
      || sourceContext.dependencyDiagnosis !== true || sourceContext.dependencyDiagnosisKey !== context.dependencyDiagnosisKey) return false;
  }
  const current = await readDiagnosisState(db, input, input);
  return current?.diagnosis.state === "no_execution_path" && current.diagnosis.wake.idempotencyKey === context.dependencyDiagnosisKey
    && current.diagnosis.dependencyPath.length > 0 && !current.gate
    && current.claim?.details.assigneeAgentId === current.parent.assigneeAgentId;
}
