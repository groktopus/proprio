import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  type Db,
} from "@groktopus/db";
import { getAgentWorkEligibility, ISSUE_BLOCKER_STALLED_WAKE_REASON } from "@groktopus/shared";
import { crashPoint } from "@groktopus/shared/crash-points";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { automaticRunCreationHeldUntil } from "./automatic-run-brake.js";

const MAX_DEPENDENCY_DEPTH = 12;
const MAX_DEPENDENCY_NODES = 200;
const MAX_DEPENDENCY_PATHS = 64;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const PENDING_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];
const OPEN_RECOVERY_STATUSES = ["active", "escalated"];
const TERMINAL_STATUSES = ["done", "cancelled"];

export type ParentDependencyWakeStatus = "not_requested" | "queued" | "running" | "deferred" | "refused" | "exhausted" | "completed";
export type ParentDependencyDiagnosis = {
  state: "no_execution_path" | "active" | "external_wait";
  dependencyPath: Array<{ issueId: string; identifier: string | null; title: string; status: string }>;
  cause: { kind: string; issueId: string | null; recoveryActionId?: string };
  nextOwner: { type: "agent" | "user" | "board"; id?: string; name?: string };
  nextAction: string;
  wake: { idempotencyKey: string; status: ParentDependencyWakeStatus; wakeupRequestId?: string };
  canInvestigate: boolean;
};

type EnqueueWakeup = (agentId: string, opts: {
  source: "automation" | "on_demand";
  triggerDetail: "system" | "manual";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "user" | "system";
  requestedByActorId: string | null;
  contextSnapshot: Record<string, unknown>;
  issueStateGuard: { statuses: string[]; assigneeAgentId: string };
  allowRunCoalescing: false;
}) => Promise<unknown | null>;

export type ParentDependencyDiagnosisAuditEvent = {
  action: "issue.dependency_diagnosis.requested";
  details: {
    idempotencyKey: string;
    outcome: "pending" | "queued" | "refused" | "deferred" | "exhausted";
    dependencyPathDigest: string;
    assigneeAgentId: string;
    source: "automatic" | "user";
    attempt: number;
  };
};

type IssueRow = Pick<typeof issues.$inferSelect, "id" | "companyId" | "identifier" | "title" | "status" | "updatedAt"
  | "statusVersion" | "assigneeAgentId" | "assigneeUserId" | "hiddenAt" | "unblockDescriptor" | "monitorNextCheckAt"
  | "executionState" | "executionPolicy" | "blockedTransitionAt" | "parentId">;

type GraphEdge = { parent: string; blocker: string };
type PathFacts = {
  active: Set<string>;
  waits: Map<string, { kind: string; action: string; actionId?: string; owner: ParentDependencyDiagnosis["nextOwner"] }>;
  agentNames: Map<string, string>;
  agents: Array<Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "status" | "reportsTo" | "lifecycleState" | "lifecycleHolds" | "pauseReason">>;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function keyFor(input: { parent: IssueRow; path: IssueRow[]; edges: GraphEdge[]; state: ParentDependencyDiagnosis["state"];
  cause: ParentDependencyDiagnosis["cause"] }) {
  const digest = createHash("sha256").update(stableJson({
    version: 1,
    parentId: input.parent.id,
    assigneeAgentId: input.parent.assigneeAgentId,
    state: input.state,
    path: input.path.map((issue) => ({ id: issue.id, status: issue.status, statusVersion: issue.statusVersion })),
    edges: input.edges.filter(edge => input.path.some(issue => issue.id === edge.blocker)
      && input.path.some(issue => issue.id === edge.parent) || edge.parent === input.parent.id && input.path.some(issue => issue.id === edge.blocker))
      .sort((a, b) => a.parent.localeCompare(b.parent) || a.blocker.localeCompare(b.blocker)),
    cause: input.cause,
  })).digest("hex");
  // The key is opaque: descendant issue ids never appear in the durable key.
  return `${ISSUE_BLOCKER_STALLED_WAKE_REASON}:diagnosis:${digest}`;
}

function mapWakeStatus(row: { id: string; status: string; runStatus: string | null; error?: string | null } | undefined): ParentDependencyWakeStatus {
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
  const [row] = await db.select({ id: activityLog.id, details: activityLog.details }).from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.dependency_diagnosis.requested"),
      sql`${activityLog.details}->>'idempotencyKey' = ${idempotencyKey}`))
    .orderBy(desc(activityLog.createdAt)).limit(1);
  return row ? { id: row.id, details: object(row.details) } : undefined;
}

async function updateDiagnosisClaim(db: Db, companyId: string, issueId: string, idempotencyKey: string,
  update: Record<string, unknown>) {
  const claim = await readDiagnosisClaim(db, companyId, issueId, idempotencyKey);
  if (!claim) return;
  await db.update(activityLog).set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify(update)}::jsonb` })
    .where(eq(activityLog.id, claim.id));
}

async function readIssue(db: Db, companyId: string, issueId: string) {
  const [row] = await db.select({
    id: issues.id, companyId: issues.companyId, identifier: issues.identifier, title: issues.title,
    status: issues.status, updatedAt: issues.updatedAt, statusVersion: issues.statusVersion,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
    hiddenAt: issues.hiddenAt, unblockDescriptor: issues.unblockDescriptor,
    monitorNextCheckAt: issues.monitorNextCheckAt, executionState: issues.executionState,
    executionPolicy: issues.executionPolicy, blockedTransitionAt: issues.blockedTransitionAt,
    parentId: issues.parentId,
  }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  return row as IssueRow | undefined;
}

async function readGraph(db: Db, companyId: string, parentId: string) {
  const parent = await readIssue(db, companyId, parentId);
  if (!parent) return null;
  const nodes = new Map<string, IssueRow>([[parent.id, parent]]);
  const edges: GraphEdge[] = [];
  let frontier = [parent.id];
  for (let depth = 0; depth < MAX_DEPENDENCY_DEPTH && frontier.length && nodes.size < MAX_DEPENDENCY_NODES; depth += 1) {
    const rows = await db.select({ parent: issueRelations.relatedIssueId, blocker: issues.id,
      id: issues.id, companyId: issues.companyId, identifier: issues.identifier, title: issues.title,
      status: issues.status, updatedAt: issues.updatedAt, statusVersion: issues.statusVersion,
      assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
      hiddenAt: issues.hiddenAt, unblockDescriptor: issues.unblockDescriptor,
      monitorNextCheckAt: issues.monitorNextCheckAt, executionState: issues.executionState,
      executionPolicy: issues.executionPolicy, blockedTransitionAt: issues.blockedTransitionAt,
      parentId: issues.parentId,
    }).from(issueRelations).innerJoin(issues, and(eq(issues.companyId, issueRelations.companyId), eq(issues.id, issueRelations.issueId)))
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, frontier), notInArray(issues.status, TERMINAL_STATUSES), isNull(issues.hiddenAt)))
      .orderBy(issues.id);
    const next: string[] = [];
    for (const row of rows) {
      edges.push({ parent: row.parent, blocker: row.blocker });
      if (!nodes.has(row.id) && nodes.size < MAX_DEPENDENCY_NODES) {
        nodes.set(row.id, row as IssueRow);
        next.push(row.id);
      }
    }
    frontier = next;
  }
  return { parent, nodes, edges };
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
      if (path.includes(blockerId)) continue;
      const next = [...path, blockerId];
      const blockers = blockersByIssue.get(blockerId) ?? [];
      if (!blockers.length) paths.push(next.map(id => nodes.get(id)!).filter(Boolean));
      else visit(blockerId, next);
    }
  };
  visit(parentId, []);
  return { paths, truncated };
}

async function readPathFacts(db: Db, companyId: string, issueIds: string[]): Promise<PathFacts> {
  if (!issueIds.length) return { active: new Set<string>(), waits: new Map(), agentNames: new Map(), agents: [] };
  const [runs, wakes, actions, interactions, approvalRows, agentsRows] = await Promise.all([
    db.select({ issueId: sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`, id: heartbeatRuns.id })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        inArray(sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`, issueIds))),
    db.select({ issueId: sql<string>`${agentWakeupRequests.payload}->>'issueId'`, id: agentWakeupRequests.id })
      .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, PENDING_WAKE_STATUSES),
        inArray(sql<string>`${agentWakeupRequests.payload}->>'issueId'`, issueIds))),
    db.select({ issueId: issueRecoveryActions.sourceIssueId, id: issueRecoveryActions.id, kind: issueRecoveryActions.kind,
      cause: issueRecoveryActions.cause, ownerType: issueRecoveryActions.ownerType, ownerAgentId: issueRecoveryActions.ownerAgentId,
      ownerUserId: issueRecoveryActions.ownerUserId, nextAction: issueRecoveryActions.nextAction, status: issueRecoveryActions.status,
      outcome: issueRecoveryActions.outcome, updatedAt: issueRecoveryActions.updatedAt })
      .from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, issueIds),
        or(inArray(issueRecoveryActions.status, OPEN_RECOVERY_STATUSES),
          and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"), eq(issueRecoveryActions.ownerType, "board")))))
      .orderBy(desc(issueRecoveryActions.updatedAt)),
    db.select({ issueId: issueThreadInteractions.issueId, id: issueThreadInteractions.id })
      .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.issueId, issueIds),
        eq(issueThreadInteractions.status, "pending"))),
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
    waits.set(action.issueId, { kind: action.cause, action: action.nextAction || "Review the recovery action and decide the next step.",
      actionId: action.id, owner });
  }
  for (const row of [...interactions, ...approvalRows]) if (!waits.has(row.issueId)) {
    waits.set(row.issueId, { kind: "human_action", action: "Respond to the open question or approval before this dependency can continue.", owner: { type: "board" } });
  }
  return { active, waits, agentNames: new Map(agentsRows.map(row => [row.id, row.name])), agents: agentsRows };
}

function classifyPath(path: IssueRow[], facts: Awaited<ReturnType<typeof readPathFacts>>, parent: IssueRow, now: Date,
  blockersByIssue: Map<string, string[]>): { state: ParentDependencyDiagnosis["state"]; path: IssueRow[];
    cause: ParentDependencyDiagnosis["cause"]; nextOwner: ParentDependencyDiagnosis["nextOwner"]; nextAction: string } | null {
  if (!path.length) return null;
  for (let index = 0; index < path.length; index += 1) {
    const node = path[index]!;
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

async function parentGate(db: Db, companyId: string, parent: IssueRow, facts: PathFacts, now: Date): Promise<
  { owner: ParentDependencyDiagnosis["nextOwner"]; action: string } | null> {
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
  const [latestRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${parent.id}`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  const heldUntil = await automaticRunCreationHeldUntil(db, companyId, { issueId: parent.id, sourceRunId: latestRun?.id ?? null });
  if (heldUntil) return { owner: { type: "board" }, action: `Automatic work is held until ${heldUntil.toISOString()}.` };
  return null;
}

async function readWakeReceipt(db: Db, companyId: string, idempotencyKey: string) {
  const [row] = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId,
    runStatus: heartbeatRuns.status, error: agentWakeupRequests.error }).from(agentWakeupRequests)
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, agentWakeupRequests.companyId), eq(heartbeatRuns.id, agentWakeupRequests.runId)))
    .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)))
    .orderBy(desc(agentWakeupRequests.createdAt)).limit(1);
  return row ? { id: row.id, status: row.status, runStatus: row.runStatus, error: row.error } : undefined;
}

export async function readParentDependencyDiagnosis(db: Db, input: { companyId: string; issueId: string; now?: Date }): Promise<ParentDependencyDiagnosis | null> {
  const graph = await readGraph(db, input.companyId, input.issueId);
  if (!graph) return null;
  const { paths, truncated } = dependencyPaths(graph.parent.id, graph.nodes, graph.edges);
  if (!paths.length) return null;
  const ids = [...new Set(paths.flat().map(row => row.id))];
  const facts = await readPathFacts(db, input.companyId, [...ids, graph.parent.id]);
  const now = input.now ?? new Date();
  // A fully active required path does not create a diagnosis. Prefer the first
  // stalled path; if every unresolved path already has an owner, report the
  // first named external wait instead.
  const blockersByIssue = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = blockersByIssue.get(edge.parent) ?? [];
    list.push(edge.blocker);
    blockersByIssue.set(edge.parent, list);
  }
  const classified = paths.map(path => classifyPath(path, facts, graph.parent, now, blockersByIssue)).filter(Boolean) as NonNullable<ReturnType<typeof classifyPath>>[];
  const result = truncated
    ? { state: "external_wait" as const, path: paths[0]!, cause: { kind: "dependency_graph_bound", issueId: null },
      nextOwner: { type: "board" as const }, nextAction: "The required dependency graph exceeds the automatic diagnosis bound. Review the dependency chain and choose the next action." }
    : classified.find(row => row.state === "no_execution_path")
      ?? classified.find(row => row.state === "external_wait")
      ?? classified[0];
  if (!result) return null;
  const key = keyFor({ parent: graph.parent, path: result.path, edges: graph.edges, state: result.state, cause: result.cause });
  const [wake, claim] = await Promise.all([
    readWakeReceipt(db, input.companyId, key), readDiagnosisClaim(db, input.companyId, graph.parent.id, key),
  ]);
  const wakeStatus = wake ? mapWakeStatus(wake) : claim
    ? claim.details.outcome === "refused" ? "refused"
      : claim.details.outcome === "deferred" ? "deferred"
        : claim.details.outcome === "exhausted" ? "exhausted"
          : claim.details.outcome === "queued" ? "queued" : "queued"
    : "not_requested";
  const gate = result.state === "no_execution_path" ? await parentGate(db, input.companyId, graph.parent, facts, now) : null;
  const wakeGateAction = wakeStatus === "refused" || wakeStatus === "exhausted"
    ? wake?.error ? `The diagnostic continuation was refused: ${wake.error}`
      : claim?.details.message ? String(claim.details.message) : "The diagnostic continuation was refused by execution admission. Review the current parent gates before retrying."
    : null;
  return {
    state: result.state,
    dependencyPath: result.path.map(row => ({ issueId: row.id, identifier: row.identifier, title: row.title, status: row.status })),
    cause: result.cause,
    nextOwner: gate?.owner ?? result.nextOwner,
    nextAction: gate?.action ?? wakeGateAction ?? result.nextAction,
    wake: { idempotencyKey: key, status: wakeStatus, ...(wake ? { wakeupRequestId: wake.id } : {}) },
    canInvestigate: result.state === "no_execution_path" && !gate,
  };
}

async function claimDiagnosis(db: Db, input: { companyId: string; issueId: string; diagnosis: ParentDependencyDiagnosis;
  assigneeAgentId: string; source: "automatic" | "user"; actorId: string | null }) {
  const publications: ActivityPublication[] = [];
  const details: ParentDependencyDiagnosisAuditEvent["details"] = {
    idempotencyKey: input.diagnosis.wake.idempotencyKey,
    outcome: "pending",
    dependencyPathDigest: input.diagnosis.wake.idempotencyKey,
    assigneeAgentId: input.assigneeAgentId,
    source: input.source,
    attempt: 1,
  };
  const claimed = await db.transaction(async tx => {
    const [parent] = await tx.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status,
      statusVersion: issues.statusVersion, assigneeUserId: issues.assigneeUserId, hiddenAt: issues.hiddenAt })
      .from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    if (!parent || parent.assigneeAgentId !== input.assigneeAgentId || parent.assigneeUserId || parent.hiddenAt
      || TERMINAL_STATUSES.includes(parent.status)) return false;
    const current = await readParentDependencyDiagnosis(tx as unknown as Db, { companyId: input.companyId, issueId: input.issueId });
    if (!current || current.state !== "no_execution_path" || current.wake.idempotencyKey !== input.diagnosis.wake.idempotencyKey) return false;
    const existing = await readDiagnosisClaim(tx as unknown as Db, input.companyId, input.issueId, input.diagnosis.wake.idempotencyKey);
    if (existing) {
      const attempt = Number(existing.details.attempt ?? 1);
      const outcome = existing.details.outcome;
      if (outcome === "queued" || outcome === "completed" || outcome === "exhausted") return false;
      if ((outcome === "refused" || outcome === "deferred") && Date.parse(String(existing.details.nextAttemptAt ?? "")) > Date.now()) return false;
      if ((outcome === "refused" || outcome === "deferred") && attempt >= 3) {
        await tx.update(activityLog).set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify({ outcome: "exhausted", message: "Automatic diagnosis wake admission was refused three times." })}::jsonb` })
          .where(eq(activityLog.id, existing.id));
        return false;
      }
      await tx.update(activityLog).set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify({ outcome: "pending", attempt: attempt + 1, nextAttemptAt: null })}::jsonb` })
        .where(eq(activityLog.id, existing.id));
      return true;
    }
    await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: input.source === "user" ? "user" : "system",
      actorId: input.actorId ?? "parent_dependency_diagnosis", agentId: input.assigneeAgentId, runId: null,
      action: "issue.dependency_diagnosis.requested", entityType: "issue", entityId: input.issueId,
      details }, publications);
    return true;
  });
  for (const publication of publications) publishActivity(publication);
  return { claimed, event: { action: "issue.dependency_diagnosis.requested" as const, details } };
}

export async function requestParentDependencyDiagnosis(db: Db, input: {
  companyId: string;
  issueId: string;
  idempotencyKey: string;
  actorId: string;
  enqueueWakeup: EnqueueWakeup;
}): Promise<{ accepted: boolean; message: string; auditEvent?: ParentDependencyDiagnosisAuditEvent }> {
  const diagnosis = await readParentDependencyDiagnosis(db, input);
  if (!diagnosis || diagnosis.state !== "no_execution_path" || diagnosis.wake.idempotencyKey !== input.idempotencyKey) {
    return { accepted: false, message: "The dependency state changed. Refresh the task and review its current next action." };
  }
  const existingWake = await readWakeReceipt(db, input.companyId, diagnosis.wake.idempotencyKey);
  if (existingWake) return { accepted: !["refused", "exhausted"].includes(mapWakeStatus(existingWake)),
    message: "The diagnostic continuation is already recorded." };
  if (!diagnosis.canInvestigate) return { accepted: false, message: diagnosis.nextAction };
  const [parent] = await db.select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!parent?.assigneeAgentId) return { accepted: false, message: "The task no longer has an agent assignee." };
  const claim = await claimDiagnosis(db, { companyId: input.companyId, issueId: input.issueId, diagnosis,
    assigneeAgentId: parent.assigneeAgentId, source: "user", actorId: input.actorId });
  if (!claim.claimed) return { accepted: false, message: "The task assignment changed. Refresh the task before requesting an investigation." };
  const existingWakeAfterClaim = await readWakeReceipt(db, input.companyId, diagnosis.wake.idempotencyKey);
  if (existingWakeAfterClaim) return { accepted: !["refused", "exhausted"].includes(mapWakeStatus(existingWakeAfterClaim)),
    message: "The diagnostic continuation is already recorded.", auditEvent: claim.event };
  crashPoint("issue.dependency_diagnosis.after_claim_before_wake");
  let wake: unknown | null;
  try { wake = await input.enqueueWakeup(parent.assigneeAgentId, {
    source: "on_demand", triggerDetail: "manual", reason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
    payload: { issueId: input.issueId, dependencyDiagnosis: true, dependencyDiagnosisKey: diagnosis.wake.idempotencyKey,
      livenessContinuationInstruction: "A required dependency has no active execution or named recovery path. Inspect the authorized dependency context, continue independent work, or propose a replacement. Leave unresolved dependencies intact until the board approves a change." },
    idempotencyKey: diagnosis.wake.idempotencyKey,
    requestedByActorType: "user", requestedByActorId: input.actorId,
    contextSnapshot: { issueId: input.issueId, taskId: input.issueId, wakeReason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
      dependencyDiagnosis: true, dependencyDiagnosisKey: diagnosis.wake.idempotencyKey,
      livenessContinuationInstruction: "A required dependency has no active execution or named recovery path. Inspect the authorized dependency context, continue independent work, or propose a replacement. Leave unresolved dependencies intact until the board approves a change." },
    issueStateGuard: { statuses: ["todo", "in_progress", "blocked", "in_review"], assigneeAgentId: parent.assigneeAgentId },
    allowRunCoalescing: false,
  }); } catch {
    await updateDiagnosisClaim(db, input.companyId, input.issueId, diagnosis.wake.idempotencyKey,
      { outcome: "deferred", nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), message: "Wake admission did not settle; it will be retried." });
    return { accepted: false, message: "Wake admission did not settle. The request will be retried.", auditEvent: claim.event };
  }
  if (!wake) {
    await updateDiagnosisClaim(db, input.companyId, input.issueId, diagnosis.wake.idempotencyKey,
      { outcome: "refused", nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString(), message: "The current execution gates refused the wake." });
    return { accepted: false, message: "The diagnostic continuation was refused by the current execution gates.", auditEvent: claim.event };
  }
  await updateDiagnosisClaim(db, input.companyId, input.issueId, diagnosis.wake.idempotencyKey, { outcome: "queued" });
  return { accepted: true, message: "The assignee was asked to investigate the dependency.", auditEvent: claim.event };
}

export async function reconcileParentDependencyDiagnosis(db: Db, input: {
  companyId: string; issueId: string; enqueueWakeup: EnqueueWakeup; now?: Date;
}): Promise<{ accepted: boolean; message: string; diagnosis: ParentDependencyDiagnosis | null }> {
  const diagnosis = await readParentDependencyDiagnosis(db, input);
  if (!diagnosis || diagnosis.state !== "no_execution_path" || !diagnosis.canInvestigate) {
    return { accepted: false, message: "No automatic dependency diagnosis is due.", diagnosis };
  }
  const parent = await readIssue(db, input.companyId, input.issueId);
  if (!parent?.assigneeAgentId) return { accepted: false, message: "The parent assignee is unavailable.", diagnosis };
  const [latestRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  const heldUntil = await automaticRunCreationHeldUntil(db, input.companyId, { issueId: input.issueId, sourceRunId: latestRun?.id ?? null });
  if (heldUntil && heldUntil.getTime() > (input.now ?? new Date()).getTime()) return { accepted: false, message: "Parent execution is held.", diagnosis };
  const treeControl = issueTreeControlService(db);
  if ((await treeControl.listActivePauseHeldIssueIds(input.companyId, [input.issueId])).has(input.issueId)) return { accepted: false, message: "Parent execution is paused.", diagnosis };
  const claim = await claimDiagnosis(db, { companyId: input.companyId, issueId: input.issueId, diagnosis,
    assigneeAgentId: parent.assigneeAgentId, source: "automatic", actorId: null });
  if (!claim.claimed) return { accepted: false, message: "The parent assignment changed.", diagnosis };
  const existingWake = await readWakeReceipt(db, input.companyId, diagnosis.wake.idempotencyKey);
  if (existingWake) return { accepted: true, message: "Diagnostic wake already recorded.", diagnosis };
  crashPoint("issue.dependency_diagnosis.after_claim_before_wake");
  let wake: unknown | null;
  try { wake = await input.enqueueWakeup(parent.assigneeAgentId, {
    source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
    payload: { issueId: input.issueId, dependencyDiagnosis: true, dependencyDiagnosisKey: diagnosis.wake.idempotencyKey,
      livenessContinuationInstruction: "A required dependency has no active execution or named recovery path. Inspect the authorized dependency context, continue independent work, or propose a replacement. Leave unresolved dependencies intact until the board approves a change." },
    idempotencyKey: diagnosis.wake.idempotencyKey, requestedByActorType: "system", requestedByActorId: null,
    contextSnapshot: { issueId: input.issueId, taskId: input.issueId, wakeReason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
      dependencyDiagnosis: true, dependencyDiagnosisKey: diagnosis.wake.idempotencyKey,
      livenessContinuationInstruction: "A required dependency has no active execution or named recovery path. Inspect the authorized dependency context, continue independent work, or propose a replacement. Leave unresolved dependencies intact until the board approves a change." },
    issueStateGuard: { statuses: ["todo", "in_progress", "blocked", "in_review"], assigneeAgentId: parent.assigneeAgentId },
    allowRunCoalescing: false,
  }); } catch {
    await updateDiagnosisClaim(db, input.companyId, input.issueId, diagnosis.wake.idempotencyKey,
      { outcome: "deferred", nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), message: "Wake admission did not settle; it will be retried." });
    return { accepted: false, message: "Wake admission did not settle. The request will be retried.", diagnosis };
  }
  await updateDiagnosisClaim(db, input.companyId, input.issueId, diagnosis.wake.idempotencyKey, wake ? { outcome: "queued" }
    : { outcome: "refused", nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString(), message: "The current execution gates refused the wake." });
  return { accepted: Boolean(wake), message: wake ? "Diagnostic wake queued." : "Diagnostic wake was refused by execution admission.", diagnosis };
}

export async function verifyParentDependencyDiagnosisWake(db: Db, input: {
  companyId: string; issueId: string; contextSnapshot: Record<string, unknown> | null | undefined;
  runId?: string | null;
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
  const current = await readParentDependencyDiagnosis(db, input);
  return current?.state === "no_execution_path" && current.wake.idempotencyKey === context.dependencyDiagnosisKey
    && current.dependencyPath.length > 0;
}
