import { randomUUID } from "node:crypto";
import { isAcknowledgedOperatorRunStop } from "./acknowledged-native-stop.js";
import { readCaseHandoffIdForNativeRun } from "./native-runtime/native-continuation-delivery.js";
import { boundRunIssueIdSql } from "./run-task-binding.js";
import { assertAgentInteraction } from "./agent-interaction-policy.js";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@groktopus/db";
import { agents, caseAccessSources, caseEvents, caseHandoffs, caseIssueLinks, cases, chatConversations, companies, completionContracts, heartbeatRuns, issues, projects } from "@groktopus/db";
import { CASE_HANDOFF_WITHDRAWAL_HOLD_CAUSE, handoffCaseSchema, isUuidLike, type CaseHandoffOfferContract, type CaseHandoffRecipientDecision, type CaseHandoffRecipientDecisionInput, type CaseHandoffWithdrawalInput, type DoneCaseHandoffInput, type HandoffCaseInput, type HandoffCaseResult } from "@groktopus/shared";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { casesDisabledError } from "./cases-disabled.js";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { withExternalAdmissionGuard, type ExternalAdmissionTransaction } from "../modules/external-agents/index.js";
import { parseNativeExecutionInput } from "../vendor/proprio-runner/index.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { authorizationDeniedDetails, authorizationService, type AuthorizationActor } from "./authorization.js";
import { assertActorCanReadCase, assertActorCanWriteCase, assertCaseTrustedForExecution, canActorReadCase, canActorReceiveCase, caseReadSqlCondition, filterCasesForActor, retainCaseAccessSource } from "./case-access.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { documentService } from "./documents.js";
import { withAuthorizationReadSnapshot } from "./authorization-read-scope.js";
import { readCaseHandoffRecoveryHistory } from "./case-handoff-recovery-history.js";
import { applyCaseWorkflow, captureCaseWorkflow } from "./case-workflows.js";
import type { CurrentCloudOwnerAuthority } from "./cloud-tenant-authority.js";
import { resolveActorSourceTrustForIssue } from "./source-trust.js";
import { nativeRuntimeSupportsCaseOfferDecision } from "./native-runtime/runtime-mode.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { assertAcceptedOfferIsCurrent, assertOfferRequirementsCurrent, CaseHandoffRequirementsSuperseded, computeCaseHandoffRequirementsDigest, readAcceptedCaseHandoffOffer } from "./case-handoff-offer-authority.js";
import { CASE_HANDOFF_CANCELLABLE_STATES as PENDING, CASE_HANDOFF_WITHDRAWN_AFTER_STOP } from "./case-handoff-states.js";
import { completeTerminalCaseHandoffsForIssue, pendingCaseHandoffForRun } from "./heartbeat/case-handoff-lifecycle.js";
import { assertCaseHandoffDispatchAuthority, caseHandoffActorContext, loadCaseHandoffCloudAuthority, lockCaseHandoffAuthorityRun, restoreCaseHandoffActor } from "./case-handoff-authority.js";

export type CaseHandoffRow = typeof caseHandoffs.$inferSelect;
type CaseRow = typeof cases.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

function publicHandoff(row: CaseHandoffRow) {
  const { actorContext: _actorContext, workflowPrompt: _prompt, baseWorkflowDocumentRevisionId: _base, ...publicRow } = row;
  return publicRow;
}

type HandoffListOptions = { limit?: number; before?: string; cursor?: string };

function handoffPageFilter(options: HandoffListOptions) {
  if (options.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (typeof parsed.at !== "string" || !Number.isFinite(new Date(parsed.at).getTime()) ||
        typeof parsed.id !== "string" || !isUuidLike(parsed.id)) throw new Error();
      return sql`(${caseHandoffs.createdAt}, ${caseHandoffs.id}) < (${parsed.at}::timestamptz, ${parsed.id}::uuid)`;
    } catch { throw unprocessable("Invalid handoff cursor"); }
  }
  return options.before ? sql`${caseHandoffs.createdAt} < ${options.before}::timestamptz` : undefined;
}

function handoffNextCursor(row: { createdAt: Date; id: string } | undefined) {
  return row ? Buffer.from(JSON.stringify({ at: row.createdAt.toISOString(), id: row.id })).toString("base64url") : null;
}

function identity(actor: AuthorizationActor) {
  if (actor.type === "agent" && actor.agentId) return { actorType: "agent" as const, actorId: actor.agentId };
  if (actor.type === "board") return { actorType: "user" as const, actorId: actor.userId ?? "board" };
  throw forbidden("Authenticated agent or board access required");
}

function companyAllowed(actor: AuthorizationActor, companyId: string) {
  return actor.type === "agent" ? actor.companyId === companyId
    : actor.type === "board" && (actor.source === "local_implicit" || actor.companyIds?.includes(companyId));
}

async function assertEnabled(db: Db) {
  if (!(await instanceSettingsService(db).getExperimental()).enableCases) throw casesDisabledError();
}

function result(row: CaseHandoffRow, issue: Pick<IssueRow, "id" | "identifier">, actor: AuthorizationActor, replayed: boolean): HandoffCaseResult {
  return { handoffId: row.id, caseId: row.caseId, taskId: issue.id, taskIdentifier: issue.identifier ?? issue.id,
    handoffVersion: row.version, state: row.state, destinationKind: row.destinationKind, completedAt: row.completedAt,
    callerMustYield: row.destinationKind === "agent" && Boolean(row.sourceRunId && row.sourceRunId === actor.runId && row.state !== "cancelled"), replayed };
}

async function event(tx: Db, row: CaseHandoffRow, kind: "handoff_requested" | "handoff_applied" | "handoff_delivered" | "handoff_cancelled" | "handoff_decision_recorded",
  publications: ActivityPublication[], actor?: AuthorizationActor, withdrawalEvidence?: Record<string, unknown>) {
  const decision = kind === "handoff_decision_recorded" ? row.recipientDecision : null;
  const decisionEvidence = decision ? {
    outcome: decision.outcome,
    requirementRevisionId: decision.requirementRevisionId,
    reasonCode: decision.reasonCode ?? null,
    elapsedMs: Math.max(0, new Date(decision.decidedAt).getTime() - row.createdAt.getTime()),
  } : undefined;
  const who = actor ? identity(actor) : { actorType: row.actorType, actorId: row.actorId };
  const runId = actor ? actor.runId ?? null : row.sourceRunId;
  await tx.insert(caseEvents).values({ companyId: row.companyId, caseId: row.caseId, kind,
    actorType: who.actorType, actorUserId: who.actorType === "user" ? who.actorId : null,
    actorAgentId: who.actorType === "agent" ? who.actorId : null, runId,
    payload: { handoffId: row.id, issueId: row.issueId, phase: row.phase, version: row.version, destinationKind: row.destinationKind,
      fromAgentId: row.fromAgentId, toAgentId: row.toAgentId, workflowTransition: row.workflowTransition, ...decisionEvidence, ...withdrawalEvidence } });
  const saved = await persistActivity(tx, { companyId: row.companyId, ...who,
    agentId: who.actorType === "agent" ? who.actorId : null, runId, issueId: row.issueId,
    action: `case.${kind}`, entityType: "case", entityId: row.caseId, responsibleUserIdOverride: row.responsibleUserId,
    details: { handoffId: row.id, issueId: row.issueId, phase: row.phase, version: row.version, state: row.state, destinationKind: row.destinationKind,
      workflowTransition: row.workflowTransition, ...decisionEvidence, ...withdrawalEvidence } });
  publications.push(saved.publication);
}

async function authorizeTask(tx: Db, actor: AuthorizationActor, companyId: string, issue: IssueRow | null, projectId: string | null, toAgentId: string, options: {
  validateRecipient?: boolean;
  invalidRecipientAsUnprocessable?: boolean;
  parentIssueId?: string | null;
} = {}) {
  const parentIssueId = options.parentIssueId ?? issue?.parentId ?? null;
  const resource = { type: "issue" as const, companyId, issueId: issue?.id ?? null, projectId,
    parentIssueId, assigneeAgentId: toAgentId, assigneeUserId: null };
  if (issue) {
    const read = await authorizationService(tx).decide({ actor, action: "issue:read", resource: { ...resource, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId } });
    if (!read.allowed) throw notFound("Task not found");
  }
  const assignment = await authorizationService(tx).decide({ actor, action: "tasks:assign", resource, scope: {
    issueId: issue?.id ?? null, projectId, parentIssueId, assigneeAgentId: toAgentId, assigneeUserId: null,
  } });
  if (!assignment.allowed) throw forbidden(assignment.explanation, authorizationDeniedDetails(assignment));
  if (options.validateRecipient !== false) {
    try {
      await assertAssignableAgent(tx, companyId, toAgentId, { kind: "work" });
    } catch (error) {
      if (options.invalidRecipientAsUnprocessable && error instanceof HttpError && (error.status === 404 || error.status === 409)) {
        throw unprocessable(error.message, error.details);
      }
      throw error;
    }
  }
}

/** Closing a case does not assign work. Retain ordinary task mutation authority. */
async function authorizeTerminalTask(tx: Db, actor: AuthorizationActor, issue: IssueRow) {
  const access = authorizationService(tx);
  const resource = { type: "issue" as const, companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId,
    parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status };
  if (!(await access.decide({ actor, action: "issue:read", resource })).allowed) throw notFound("Task not found");
  if (actor.type === "agent" && (issue.assigneeAgentId !== actor.agentId || issue.assigneeUserId)) {
    const task = issue.identifier ?? issue.id;
    const [owner] = issue.assigneeAgentId && !issue.assigneeUserId ? await tx.select({ name: agents.name }).from(agents)
      .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId))).limit(1) : [];
    throw forbidden(owner
      ? `Agents may complete only their own case work. ${owner.name} (agent ${issue.assigneeAgentId}) owns primary task ${task} and records the terminal handoff. Ask that agent on ${task} to close the case.`
      : `Agents may complete only their own case work. Primary task ${task} has no assigned agent to close the case.`,
    { primaryTaskId: issue.id, assigneeAgentId: issue.assigneeAgentId });
  }
  const mutation = await access.decide({ actor, action: "issue:mutate", resource });
  if (!mutation.allowed) throw forbidden(mutation.explanation, authorizationDeniedDetails(mutation));
}

const TERMINAL_CASE_STATUSES = new Set(["done", "cancelled"]);

/**
 * Direct case writes must not close or reopen a case with a primary task past
 * the authority a terminal handoff requires. Agents need the same ownership of
 * the primary task, and `done` still goes through the handoff so primary-task
 * completion passes its normal gates.
 */
export async function assertCaseStatusWriteAuthority(tx: Db, actor: AuthorizationActor,
  current: { companyId: string; status: string; workIssueId: string | null }, nextStatus: string | undefined) {
  if (actor.type !== "agent" || nextStatus === undefined || nextStatus === current.status || !current.workIssueId) return;
  if (!TERMINAL_CASE_STATUSES.has(nextStatus) && !TERMINAL_CASE_STATUSES.has(current.status)) return;
  const [issue] = await tx.select().from(issues)
    .where(and(eq(issues.id, current.workIssueId), eq(issues.companyId, current.companyId))).limit(1);
  if (!issue) throw notFound("Task not found");
  await authorizeTerminalTask(tx, actor, issue);
  if (nextStatus === "done") {
    throw unprocessable("Close a case that has a primary task with a terminal handoff to done");
  }
}

async function authorizeHandoffControl(tx: Db, actor: AuthorizationActor, row: CaseHandoffRow, issue: IssueRow, validateRecipient = true) {
  if (row.destinationKind === "done") return authorizeTerminalTask(tx, actor, issue);
  if (!row.toAgentId) throw conflict("Agent handoff has no recipient");
  return authorizeTask(tx, actor, row.companyId, issue, issue.projectId, row.toAgentId, { validateRecipient });
}

/** Match ordinary implicit delegation: an unusable default parent falls back to
 * standalone work. A retained private source cannot lose its access edge. */
async function resolveHandoffTaskParent(tx: Db, actor: AuthorizationActor, companyId: string, projectId: string | null,
  toAgentId: string, candidate: IssueRow | null, required: boolean): Promise<IssueRow | null> {
  if (!candidate || candidate.conversationAgentId) {
    if (required) throw forbidden("Retained private source requires an eligible primary task");
    return null;
  }
  const access = authorizationService(tx);
  let allowed = true;
  for (const action of ["issue:read", "issue:mutate"] as const) {
    if (!(await access.decide({ actor, action, resource: { type: "issue", companyId,
      issueId: candidate.id, projectId: candidate.projectId, parentIssueId: candidate.parentId,
      assigneeAgentId: candidate.assigneeAgentId, assigneeUserId: candidate.assigneeUserId, status: candidate.status } })).allowed) {
      allowed = false; break;
    }
  }
  if (allowed && actor.type === "agent" && toAgentId !== actor.agentId &&
    await issueService(tx).findOpenAncestorCreatedByAgent(candidate.id, toAgentId)) allowed = false;
  if (allowed) {
    const scope = { projectId, parentIssueId: candidate.id, assigneeAgentId: toAgentId, assigneeUserId: null };
    allowed = (await access.decide({ actor, action: "tasks:assign", resource: { type: "issue", companyId, issueId: null, ...scope }, scope })).allowed;
  }
  if (allowed) return candidate;
  if (required) throw forbidden("Retained private source task does not allow creating delegated work");
  return null;
}

async function eligible(tx: Db, issue: IssueRow) {
  if (issue.conversationAgentId || (await tx.select({ id: chatConversations.id }).from(chatConversations)
    .where(and(eq(chatConversations.companyId, issue.companyId), eq(chatConversations.issueId, issue.id))).limit(1)).length) {
    throw unprocessable("Case handoffs require an ordinary work task");
  }
  if (issue.workMode !== "standard" || !["todo", "in_progress"].includes(issue.status) || issue.executionState?.status === "pending") {
    throw unprocessable("Resolve task mode, blockers, or review before handing off");
  }
  const readiness = await issueService(tx).getDependencyReadiness(issue.id, tx);
  if (!readiness.isDependencyReady) throw unprocessable("Resolve task dependencies before handing off");
}

/** A case may be stricter than its task. Never copy its content into a wider comment audience. */
async function assertCaseContentsFitTask(tx: Db, caseRow: CaseRow, issue: IssueRow) {
  const retained = await tx.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, caseRow.id));
  for (const source of retained) {
    if (source.sourceKind === "issue" && source.sourceId === issue.id) continue;
    if (source.sourceKind === "project") {
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, source.sourceId), eq(projects.companyId, issue.companyId)));
      if (!project) throw notFound("Case source project not found");
      if (project.visibility === "private" && issue.projectId !== project.id) throw unprocessable("Primary task must preserve the case's private project boundary");
      continue;
    }
    const [sourceIssue] = await tx.select().from(issues).where(and(eq(issues.id, source.sourceId), eq(issues.companyId, issue.companyId)));
    if (!sourceIssue) throw notFound("Case source task not found");
    const [project] = sourceIssue.projectId ? await tx.select().from(projects).where(eq(projects.id, sourceIssue.projectId)) : [];
    if (project?.visibility === "private" && issue.projectId !== sourceIssue.projectId) throw unprocessable("Primary task must preserve the case's private project boundary");
    if (sourceIssue.visibility === "private") {
      if (issue.visibility !== "private") throw unprocessable("Primary task must preserve the case's private task boundary");
      // Match the canonical privacy ancestry: private task/project grants flow
      // down parent edges, never sideways to a sibling sharing root metadata.
      // UNION limits traversal to distinct task identities, including cycles.
      const [ancestry] = await tx.execute<{ inherited: boolean }>(sql`
        WITH RECURSIVE privacy_ancestors AS (
          SELECT p.id, p.company_id, p.privacy_parent_issue_id FROM issues p
          WHERE p.id = ${issue.id} AND p.company_id = ${issue.companyId}
          UNION
          SELECT p.id, p.company_id, p.privacy_parent_issue_id FROM issues p
          JOIN privacy_ancestors child ON p.id = child.privacy_parent_issue_id AND p.company_id = child.company_id
          WHERE p.visibility = 'private' OR EXISTS (
            SELECT 1 FROM projects project WHERE project.id = p.project_id
              AND project.company_id = p.company_id AND project.visibility = 'private'
          )
        )
        SELECT EXISTS (SELECT 1 FROM privacy_ancestors WHERE id = ${sourceIssue.id}) AS inherited
      `);
      if (!ancestry?.inherited) throw unprocessable("Primary task must preserve the case's private task boundary");
    }
  }
}

/** Source runs are fenced even after dispatch; late output cannot complete transferred work. */
export async function getPendingCaseHandoffForRun(db: Db, runId: string) {
  return pendingCaseHandoffForRun(db, runId);
}

export async function assertCaseHandoffRunMutationAllowed(db: Db, runId: string, issueId: string) {
  const handoff = await getPendingCaseHandoffForRun(db, runId);
  if (handoff?.issueId === issueId) throw conflict("This run handed off the task and must end its turn", { code: "case_handoff_yield_required", handoffId: handoff.id });
}

export async function cancelPendingCaseHandoffsForIssue(db: Db, issueId: string, reason: string, actor?: AuthorizationActor, handoffId?: string) {
  const publications: ActivityPublication[] = [];
  const cancel = async (tx: Db) => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, issueId);
    await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
    if (actor?.type === "agent" && actor.runId) await assertAgentRunWriteAllowed(tx, actor.companyId!, { agentId: actor.agentId, runId: actor.runId });
    const rows = await tx.update(caseHandoffs).set({ state: "cancelled", cancelledAt: new Date(), updatedAt: new Date(),
      leaseExpiresAt: null, lastErrorCode: "superseded", lastError: reason }).where(and(eq(caseHandoffs.issueId, issueId), inArray(caseHandoffs.state, PENDING),
        handoffId ? eq(caseHandoffs.id, handoffId) : undefined)).returning();
    for (const row of rows) await event(tx, row, "handoff_cancelled", publications, actor);
    if (rows.length) await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, issueId);
    return rows.length;
  };
  // Works for a Db or an existing transaction supplied by task-control code.
  const count = "transaction" in db ? await db.transaction(tx => cancel(tx as unknown as Db)) : await cancel(db);
  publications.forEach(publishActivity);
  return count;
}

export async function cancelVersionedCaseHandoffs(tx: Db, caseRow: Pick<CaseRow, "id" | "companyId">,
  actor: AuthorizationActor, publications: ActivityPublication[]) {
  const now = new Date();
  const rows = await tx.update(caseHandoffs).set({ state: "cancelled", cancelledAt: now, updatedAt: now,
    leaseExpiresAt: null, lastErrorCode: "superseded", lastError: "Case was cancelled" }).where(and(
    eq(caseHandoffs.companyId, caseRow.companyId), eq(caseHandoffs.caseId, caseRow.id), inArray(caseHandoffs.state, PENDING),
    sql`${caseHandoffs.offerContract} is not null`,
  )).returning();
  for (const row of rows) await event(tx, row, "handoff_cancelled", publications, actor);
}

export function caseHandoffService(db: Db) {
  async function visible(actor: AuthorizationActor, caseId: string, tx = db) {
    if (!isUuidLike(caseId)) throw notFound("Case not found");
    const [row] = await tx.select().from(cases).where(eq(cases.id, caseId));
    if (!row || !companyAllowed(actor, row.companyId)) throw notFound("Case not found");
    await assertActorCanReadCase(tx, actor, row);
    return row;
  }

  async function apply(tx: Db, row: CaseHandoffRow, caseRow: CaseRow, issue: IssueRow, publications: ActivityPublication[], originalActor?: AuthorizationActor, cloudAuthority?: CurrentCloudOwnerAuthority | null) {
    if (row.destinationKind !== "agent" || !row.toAgentId) throw conflict("Only agent handoffs can transfer a task");
    if (row.offerContract && caseRow.status === "cancelled") throw conflict("Case was cancelled");
    if (caseRow.workIssueId !== issue.id || caseRow.handoffVersion !== row.version || issue.statusVersion !== row.expectedIssueStatusVersion || issue.responsibleUserId !== row.responsibleUserId ||
        issue.assigneeAgentId !== row.fromAgentId || issue.assigneeUserId) throw conflict("Handoff was superseded by a newer task decision");
    await assertCaseTrustedForExecution(tx, caseRow);
    await eligible(tx, issue);
    await assertAcceptedOfferIsCurrent(tx, row, issue);
    const sourceAuthorizer = await assertCaseHandoffDispatchAuthority(tx, row, issue, caseRow);
    const assigningActor = originalActor ?? await restoreCaseHandoffActor(tx, row, issue, sourceAuthorizer, cloudAuthority);
    // Acceptance does not reserve permission. Recheck the original principal at
    // the actual transfer, while it still owns/reads the outgoing task.
    try {
      await authorizeTask(tx, assigningActor, row.companyId, issue, issue.projectId, row.toAgentId);
    } catch (error) {
      // The records were just locked and exist. A hidden task is a revocable
      // actor-access hold, not a deleted task that should cancel durable intent.
      if (!originalActor && error instanceof HttpError && error.status === 404) throw forbidden("Handoff original actor can no longer access the task");
      throw error;
    }
    const actor: AuthorizationActor = { type: "agent", agentId: row.toAgentId, companyId: row.companyId, onBehalfOfUserId: row.responsibleUserId };
    await assertAssignableAgent(tx, row.companyId, row.toAgentId, { kind: "work" });
    if (!(await canActorReceiveCase(tx, actor, caseRow, issue.id, row.toAgentId))) throw forbidden("Recipient cannot access the case");
    if (issue.executionRunId && issue.executionRunId !== row.sourceRunId) throw conflict("A newer execution owns this task");
    if (issue.checkoutRunId && issue.checkoutRunId !== row.sourceRunId) throw conflict("A newer checkout owns this task");
    const workflowTransition = await applyCaseWorkflow(tx, row, publications);
    const updated = await issueService(tx).update(issue.id, { assigneeAgentId: row.toAgentId, assigneeUserId: null,
      status: "todo", executionRunId: null, checkoutRunId: null, executionAgentNameKey: null,
      companyGuard: row.companyId, caseHandoffId: row.id, actorAgentId: row.actorType === "agent" ? row.actorId : null,
      actorUserId: row.actorType === "user" ? row.actorId : null }, tx, publications, []);
    if (!updated) throw notFound("Task not found");
    publications.push((await persistActivity(tx, { companyId: row.companyId, actorType: row.actorType, actorId: row.actorId,
      agentId: row.actorType === "agent" ? row.actorId : null, runId: row.sourceRunId, issueId: issue.id,
      action: "issue.reassigned", entityType: "issue", entityId: issue.id,
      details: { previousAssigneeAgentId: issue.assigneeAgentId, previousAssigneeUserId: issue.assigneeUserId,
        assigneeAgentId: row.toAgentId, assigneeUserId: null, changed: issue.assigneeAgentId !== row.toAgentId || Boolean(issue.assigneeUserId),
        caseId: row.caseId, handoffId: row.id, status: updated.status, statusVersion: updated.statusVersion } })).publication);
    await tx.update(cases).set({ phase: row.phase, ...(workflowTransition ? { workflowId: workflowTransition.to.workflowId } : {}),
      updatedAt: new Date() }).where(eq(cases.id, row.caseId));
    const [applied] = await tx.update(caseHandoffs).set({ state: "pending_dispatch", appliedIssueStatusVersion: updated.statusVersion,
      workflowTransition, assignmentAppliedAt: new Date(), updatedAt: new Date() }).where(eq(caseHandoffs.id, row.id)).returning();
    await event(tx, applied!, "handoff_applied", publications);
    return applied!;
  }

  async function acceptTerminal(tx: Db, companyId: string, actor: AuthorizationActor, input: DoneCaseHandoffInput,
    source: typeof heartbeatRuns.$inferSelect | null, sourceIssue: IssueRow | null, fingerprint: string,
    publications: ActivityPublication[]) {
    let caseRow = await visible(actor, input.case.id, tx);
    if (caseRow.companyId !== companyId) throw notFound("Case not found");
    if (!caseRow.workIssueId) throw unprocessable("Terminal handoff requires an existing primary task");
    const primaryId = caseRow.workIssueId;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, primaryId), eq(issues.companyId, companyId))).for("update");
    if (!issue) throw notFound("Task not found");
    await authorizeTerminalTask(tx, actor, issue);
    if (issue.statusVersion !== input.expectedIssueStatusVersion) throw conflict("Task changed; reload before handing off");
    if (issue.assigneeUserId) throw unprocessable("Terminal case handoff requires agent-assigned or unassigned work");
    if (issue.workMode !== "standard" || !["todo", "in_progress", "in_review", "blocked", "done"].includes(issue.status)
      || issue.conversationAgentId || (await tx.select({ id: chatConversations.id }).from(chatConversations)
        .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issue.id))).limit(1)).length) {
      throw unprocessable("Terminal handoff requires an ordinary standard work task");
    }
    if (actor.type === "agent" && ((source && sourceIssue?.id !== issue.id)
      || (issue.executionRunId && issue.executionRunId !== source?.id))) throw conflict("Another execution owns this task");
    [caseRow] = await tx.select().from(cases).where(and(eq(cases.id, caseRow.id), eq(cases.companyId, companyId))).for("update");
    if (!caseRow || caseRow.workIssueId !== primaryId || caseRow.handoffVersion !== input.expectedHandoffVersion) {
      throw conflict("Case routing changed; reload before handing off");
    }
    await assertActorCanReadCase(tx, actor, caseRow);
    await assertCaseTrustedForExecution(tx, caseRow);
    await assertCaseContentsFitTask(tx, caseRow, issue);
    if ((await tx.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(eq(caseHandoffs.caseId, caseRow.id),
      inArray(caseHandoffs.state, PENDING))).limit(1)).length) throw conflict("A handoff is already pending for this case");
    const who = identity(actor);
    const trust = await resolveActorSourceTrustForIssue({ db: tx, issue, actor: { ...who,
      agentId: actor.type === "agent" ? actor.agentId! : null, runId: source?.id ?? null } });
    if (trust) throw forbidden("Low-trust work must use its governed review path before completing case work");
    const comment = await issueService(tx).addComment(issue.id, `Case completion requested\n\n${input.instructions}`, {
      agentId: actor.type === "agent" ? actor.agentId! : undefined,
      userId: actor.type === "board" ? actor.userId ?? undefined : undefined, runId: source?.id,
    }, { sourceTrust: trust ?? undefined }, tx);
    const version = caseRow.handoffVersion + 1;
    const workflow = await captureCaseWorkflow(tx, companyId, caseRow, issue.id, "done");
    await tx.update(cases).set({ handoffVersion: version, updatedAt: new Date() }).where(eq(cases.id, caseRow.id));
    const [row] = await tx.insert(caseHandoffs).values({ id: randomUUID(), companyId, caseId: caseRow.id, issueId: issue.id,
      version, ...workflow, destinationKind: "done", fromAgentId: issue.assigneeAgentId, toAgentId: null, phase: "done",
      instructions: input.instructions, commentId: comment.id, ...who, actorContext: caseHandoffActorContext(actor, companyId), sourceRunId: source?.id ?? null,
      responsibleUserId: issue.responsibleUserId, expectedIssueStatusVersion: issue.statusVersion,
      idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprint, wakeupRequestId: randomUUID(), state: "awaiting_completion",
    }).returning();
    await event(tx, row!, "handoff_requested", publications);
    if (issue.status === "done") await completeTerminalCaseHandoffsForIssue(tx, { companyId, issueId: issue.id, publications });
    const [current] = await tx.select().from(caseHandoffs).where(eq(caseHandoffs.id, row!.id));
    return result(current!, issue, actor, false);
  }

  return {
    async handoff(companyId: string, actor: AuthorizationActor, rawInput: HandoffCaseInput, options: {
      /** Transport-specific execution authority; called only for fresh intent inside the write transaction. */
      beforeAccept?: (tx: Db) => Promise<void>;
      /** Enabled only by the assembled recipient-decision flow. */
      enableVersionedOffers?: boolean;
    } = {}): Promise<HandoffCaseResult> {
      await assertEnabled(db);
      if (!companyAllowed(actor, companyId)) throw notFound("Company not found");
      const who = identity(actor), input = handoffCaseSchema.parse(rawInput);
      const fingerprint = nativeSha256(input);
      const publications: ActivityPublication[] = [];
      const outcome = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        if (input.to !== "done") await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, companyId);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`case-handoff:${companyId}:${who.actorType}:${who.actorId}:${input.idempotencyKey}`}, 0))`);
        const [prior] = await tx.select().from(caseHandoffs).where(and(eq(caseHandoffs.companyId, companyId), eq(caseHandoffs.actorType, who.actorType),
          eq(caseHandoffs.actorId, who.actorId), eq(caseHandoffs.idempotencyKey, input.idempotencyKey))).limit(1);
        if (prior) {
          await visible(actor, prior.caseId, tx);
          if (prior.inputFingerprint !== fingerprint) throw conflict("Idempotency key was used for a different handoff");
          const [issue] = await tx.select().from(issues).where(and(eq(issues.id, prior.issueId), eq(issues.companyId, companyId)));
          if (!issue) throw notFound("Task not found");
          return result(prior, issue, actor, true);
        }
        if (input.to !== "done" && input.offer) {
          if (actor.type === "agent" && input.toAgentId.toLowerCase() === actor.agentId?.toLowerCase()) {
            throw unprocessable("A versioned offer must name a different recipient");
          }
          if (!options.enableVersionedOffers) throw unprocessable("Versioned offers require the recipient-decision pilot");
          if (actor.type !== "agent" || actor.source !== "agent_jwt") {
            throw forbidden("Versioned offers require authenticated source run authority");
          }
        }
        await options.beforeAccept?.(tx);
        let sourceAdapterType: string | null = null;
        let source: typeof heartbeatRuns.$inferSelect | null = null;
        let sourceIssue: IssueRow | null = null;
        if (actor.type === "agent" && actor.runId) {
          [source] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId!))).limit(1);
          if (!source || source.status !== "running") throw conflict("Source run no longer has execution authority");
          const sourceId = source.nativeIssueId ?? source.issueId ?? source.contextSnapshot?.issueId;
          if (typeof sourceId === "string") [sourceIssue] = await tx.select().from(issues).where(and(eq(issues.id, sourceId), eq(issues.companyId, companyId))).for("update");
          const authorizedSource = await assertAgentRunWriteAllowed(tx, companyId, { agentId: actor.agentId, runId: source.id });
          if (!authorizedSource || authorizedSource.status !== "running") throw conflict("Source run no longer has execution authority");
          [source] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId!)));
          if (!source) throw conflict("Source run no longer exists");
          const pinned = source.runnerProfileJson?.nativeExecutionInput as Record<string, unknown> | undefined;
          const provider = pinned?.provider as Record<string, unknown> | undefined;
          if (["openai_dot_mcp", "grok_bot_mcp", "muse_external"].includes(source.driverKind ?? "") || ["openai_dot", "grok_bot", "muse"].includes(String(provider?.kind))) {
            let execution: ReturnType<typeof parseNativeExecutionInput>;
            try { execution = parseNativeExecutionInput(pinned); } catch { throw forbidden("External handoff requires its pinned execution authority"); }
            if (execution.binding.companyId !== companyId || execution.binding.agentId !== actor.agentId || execution.binding.runId !== source.id || execution.binding.issueId !== sourceIssue?.id) throw forbidden("External handoff execution binding changed");
            const { assertExternalNativeRunAuthority } = await import("./native-runtime/external-native-authority.js");
            await withExternalAdmissionGuard(tx as unknown as ExternalAdmissionTransaction, companyId, actor.agentId!, () => assertExternalNativeRunAuthority(tx, execution, tx));
          }
          const [sourceAgent] = await tx.select({ status: agents.status, adapterType: agents.adapterType }).from(agents).where(and(eq(agents.id, actor.agentId!), eq(agents.companyId, companyId)));
          if (!sourceAgent || ["paused", "terminated", "pending_approval", "error"].includes(sourceAgent.status)) throw forbidden("Source agent no longer has execution authority");
          sourceAdapterType = sourceAgent.adapterType;
          if (!sourceIssue || sourceIssue.assigneeAgentId !== actor.agentId || sourceIssue.assigneeUserId || sourceIssue.executionRunId !== source.id) throw conflict("Source run no longer owns its task");
          if (sourceIssue && sourceIssue.workMode !== "standard") throw unprocessable("Case handoff is available in standard work mode");
        }
        if (input.to === "done") return acceptTerminal(tx, companyId, actor, input, source, sourceIssue, fingerprint, publications);
        let caseRow = "id" in input.case ? await visible(actor, input.case.id, tx) : null;
        const priorWorkIssueId = caseRow?.workIssueId ?? null;
        if (caseRow && caseRow.companyId !== companyId) throw notFound("Case not found");
        const targetId = caseRow?.workIssueId ?? input.bindIssueId;
        if (targetId && input.initialDocuments?.length) throw unprocessable("Initial documents require a newly created primary task");
        if (caseRow && targetId && input.workflow_document_text !== undefined) throw unprocessable("Workflow text is only accepted when starting a new workflow task");
        if (!targetId && input.workflow_document_text === undefined && !input.workflowId) throw unprocessable("workflowId or workflow_document_text is required when creating the primary task");
        if (caseRow?.workIssueId && input.bindIssueId) throw unprocessable("The case already has its primary task");
        let issue: IssueRow | null = null;
        if (targetId) {
          [issue] = await tx.select().from(issues).where(and(eq(issues.id, targetId), eq(issues.companyId, companyId))).for("update");
          if (!issue) throw notFound("Task not found");
          if (input.expectedIssueStatusVersion === undefined) throw unprocessable("expectedIssueStatusVersion is required for an existing task");
          if (issue.statusVersion !== input.expectedIssueStatusVersion) throw conflict("Task changed; reload before handing off");
          await eligible(tx, issue);
          if (actor.type === "agent" && (issue.assigneeAgentId !== actor.agentId || issue.assigneeUserId)) throw forbidden("Agents may hand off only their own task");
          if (actor.type === "agent" && issue.executionRunId && issue.executionRunId !== source?.id) throw conflict("Another run owns this task");
          if ("create" in input.case) {
            const mutation = await authorizationService(tx).decide({ actor, action: "issue:mutate", resource: {
              type: "issue", companyId, issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
              assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status,
            } });
            if (!mutation.allowed) throw forbidden(mutation.explanation, authorizationDeniedDetails(mutation));
          }
        }
        // Lock task before case, matching task mutation admission and dispatch.
        if (caseRow) {
          [caseRow] = await tx.select().from(cases).where(and(eq(cases.id, caseRow.id), eq(cases.companyId, companyId))).for("update");
          if (!caseRow || caseRow.handoffVersion !== input.expectedHandoffVersion || caseRow.workIssueId !== priorWorkIssueId) throw conflict("Case routing changed; reload before handing off");
          await assertCaseTrustedForExecution(tx, caseRow);
        }
        let projectId = caseRow?.projectId ?? ("create" in input.case ? input.case.create.projectId ?? null : null);
        let casePrivacyParent: IssueRow | null = null;
        if (caseRow && !issue) {
          const retained = await tx.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, caseRow.id));
          const sourceIssues = retained.filter(item => item.sourceKind === "issue");
          if (sourceIssues.length > 1) {
            const sourceRows = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, sourceIssues.map(item => item.sourceId))));
            const projectIds = [...new Set(sourceRows.map(item => item.projectId).filter((id): id is string => !!id))];
            const sourceProjects = projectIds.length ? await tx.select({ id: projects.id, visibility: projects.visibility }).from(projects)
              .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds))) : [];
            if (sourceRows.length !== sourceIssues.length || sourceRows.some(item => item.visibility !== "open") ||
              sourceProjects.length !== projectIds.length || sourceProjects.some(item => item.visibility !== "open")) {
              throw unprocessable("A case with multiple private task boundaries needs an existing eligible primary task");
            }
          } else if (sourceIssues[0]) {
            [casePrivacyParent] = await tx.select().from(issues).where(and(eq(issues.id, sourceIssues[0].sourceId), eq(issues.companyId, companyId)));
            if (!casePrivacyParent) throw notFound("Case source task not found");
            if (projectId && projectId !== casePrivacyParent.projectId) throw unprocessable("Case project and retained task boundary must agree before starting work");
            projectId = casePrivacyParent.projectId;
          }
          if (retained.some(item => item.sourceKind === "project" && item.sourceId !== projectId)) throw unprocessable("Case has incompatible retained project boundaries");
        }
        if (!projectId && !issue && sourceIssue && !sourceIssue.conversationAgentId && !casePrivacyParent) projectId = sourceIssue.projectId;
        if (projectId) {
          const decision = await authorizationService(tx).decide({ actor, action: "project:read", resource: { type: "project", companyId, projectId } });
          if (!decision.allowed) throw notFound("Project not found");
        }
        const parent = issue ? null : await resolveHandoffTaskParent(tx, actor, companyId, projectId, input.toAgentId,
          casePrivacyParent ?? sourceIssue, casePrivacyParent?.visibility === "private");
        await authorizeTask(tx, actor, companyId, issue, issue?.projectId ?? projectId, input.toAgentId, {
          invalidRecipientAsUnprocessable: true, ...(issue ? {} : { parentIssueId: parent?.id ?? null }),
        });
        await assertAgentInteraction(tx, { companyId, actorAgentId: actor.type === "agent" ? actor.agentId : null,
          operation: "assign", issueId: issue?.id, parentIssueId: parent?.id, targetAgentId: input.toAgentId,
          texts: [JSON.stringify(input)], lock: true });
        if (caseRow && (await tx.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(eq(caseHandoffs.caseId, caseRow.id), inArray(caseHandoffs.state, PENDING))).limit(1)).length) throw conflict("A handoff is already pending for this case");
        if (issue && (await tx.select({ id: cases.id }).from(cases).where(and(eq(cases.workIssueId, issue.id), caseRow ? sql`${cases.id} <> ${caseRow.id}` : sql`true`)).limit(1)).length) throw conflict("Task is already the primary task of another case");
        const id = randomUUID();
        if (!caseRow) {
          const create = "create" in input.case ? input.case.create : null;
          if (!create) throw notFound("Case not found");
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`proprio:cases:${companyId}`}))`);
          const [company] = await tx.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
          if (!company) throw notFound("Company not found");
          const [max] = await tx.select({ number: sql<number>`coalesce(max(${cases.caseNumber}), 0)` }).from(cases).where(eq(cases.companyId, companyId));
          const caseNumber = Number(max?.number ?? 0) + 1;
          [caseRow] = await tx.insert(cases).values({ companyId, ...create, projectId, caseNumber, identifier: `${company.prefix.toUpperCase()}-C${caseNumber}`,
            createdByAgentId: actor.type === "agent" ? actor.agentId : null, createdByUserId: actor.type === "board" ? actor.userId ?? null : null }).returning();
          await tx.insert(caseEvents).values({ companyId, caseId: caseRow!.id, kind: "created", actorType: who.actorType,
            actorUserId: who.actorType === "user" ? who.actorId : null, actorAgentId: actor.type === "agent" ? actor.agentId : null, runId: source?.id });
        }
        if (!issue) {
          const sourceTrust = await resolveActorSourceTrustForIssue({ db: tx, issue: { id: randomUUID(), companyId, projectId }, actor: {
            ...who, agentId: actor.type === "agent" ? actor.agentId! : null, runId: source?.id ?? null,
          } });
          // Cases have no artifact-promotion surface: a contained run cannot turn
          // quarantined instructions into ordinary successor authority.
          if (sourceTrust) throw forbidden("Low-trust work must use its governed review path before starting case work");
          issue = await issueService(tx).create(companyId, { title: caseRow!.title, description: caseRow!.summary ?? caseRow!.title,
            projectId, parentId: parent?.id ?? null, status: "todo", workMode: "standard", assigneeAgentId: input.toAgentId,
            createdByAgentId: actor.type === "agent" ? actor.agentId : null, createdByUserId: actor.type === "board" ? actor.userId ?? null : null,
            actorRunId: source?.id ?? null, actorResponsibleUserId: actor.onBehalfOfUserId ?? actor.userId ?? null,
            workspaceSelectionActor: actor, originRunId: source?.id ?? null, idempotencyKey: `case-handoff:${id}`, allowDuplicate: true,
          }, tx);
          publications.push((await persistActivity(tx, { companyId, ...who, agentId: actor.type === "agent" ? actor.agentId : null,
            runId: source?.id ?? null, issueId: issue.id, action: "issue.created", entityType: "issue", entityId: issue.id,
            details: { identifier: issue.identifier, title: issue.title, parentId: issue.parentId,
              assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status, source: "case_handoff" } })).publication);
        }
        if (input.workflow_document_text !== undefined || input.initialDocuments?.length) {
          const sourceTrust = await resolveActorSourceTrustForIssue({ db: tx, issue, actor: { ...who,
            agentId: actor.type === "agent" ? actor.agentId! : null, runId: source?.id ?? null } });
          if (sourceTrust) throw forbidden("Low-trust work must use its governed review path before writing workflow documents");
          const initialDocuments = [...(input.workflow_document_text === undefined ? [] : [{ key: "workflow", title: "Workflow", body: input.workflow_document_text }]), ...(input.initialDocuments ?? [])];
          for (const initial of initialDocuments) {
            const saved = await documentService(tx).upsertIssueDocument({ issueId: issue.id, ...initial, format: "markdown",
              baseRevisionId: null, createdByAgentId: actor.type === "agent" ? actor.agentId : null,
              createdByUserId: actor.type === "board" ? actor.userId ?? null : null, createdByRunId: source?.id ?? null,
              sourceTrust, lockedDocumentStrategy: "conflict" }, { initialTaskCreation: !targetId });
            publications.push((await persistActivity(tx, { companyId, ...who, agentId: actor.type === "agent" ? actor.agentId : null,
              runId: source?.id ?? null, issueId: issue.id, action: "issue.document_created", entityType: "issue", entityId: issue.id,
              details: { key: saved.document.key, documentId: saved.document.id, title: saved.document.title,
                format: saved.document.format, revisionNumber: saved.document.latestRevisionNumber, source: "case_handoff" } })).publication);
          }
        }
        if (caseRow!.workIssueId && caseRow!.workIssueId !== issue.id) throw conflict("Primary task cannot be replaced");
        if (input.bindIssueId && sourceIssue && sourceIssue.id !== issue.id) await retainCaseAccessSource(tx, {
          companyId, caseId: caseRow!.id, sourceKind: "issue", sourceId: sourceIssue.id,
        });
        await assertCaseContentsFitTask(tx, caseRow!, issue);
        await retainCaseAccessSource(tx, { companyId, caseId: caseRow!.id, sourceKind: "issue", sourceId: issue.id });
        await tx.insert(caseIssueLinks).values({ companyId, caseId: caseRow!.id, issueId: issue.id, role: "work", createdByRunId: source?.id }).onConflictDoNothing();
        if (!(await canActorReceiveCase(tx, actor, caseRow!, issue.id, input.toAgentId))) throw forbidden("Recipient cannot access the case");
        const trust = await resolveActorSourceTrustForIssue({ db: tx, issue, actor: { ...who, agentId: actor.type === "agent" ? actor.agentId! : null, runId: source?.id ?? null } });
        if (trust) throw forbidden("Low-trust work must use its governed review path before handing off");
        const comment = await issueService(tx).addComment(issue.id, `Handoff to ${input.phase}\n\n${input.instructions}`, {
          agentId: actor.type === "agent" ? actor.agentId! : undefined, userId: actor.type === "board" ? actor.userId ?? undefined : undefined, runId: source?.id,
        }, { sourceTrust: trust ?? undefined }, tx);
        const sourceRunId = issue.executionRunId ?? issue.checkoutRunId;
        const workflow = await captureCaseWorkflow(tx, companyId, caseRow!, issue.id, input.phase, input.workflowId);
        if ((workflow.workflowPrompt?.length ?? 0) + (input.initialDocuments ?? []).reduce((total, doc) => total + doc.body.length, 0) > 200_000) {
          throw unprocessable("Workflow and initial document bodies must total at most 200000 characters");
        }
        let offerContract: CaseHandoffOfferContract | null = null;
        if (input.offer) {
          if (caseRow!.status === "cancelled") throw conflict("Case was cancelled");
          if (actor.type !== "agent" || !source || source.runtimeMode !== "native" || !source.completionContractId ||
              !sourceIssue || issue.id !== sourceIssue.id || sourceRunId !== source.id) {
            throw unprocessable("Versioned offers require an active native source task with a completion contract");
          }
          if (sourceAdapterType !== "proprio_runner") {
            throw unprocessable("Versioned offers require a native Proprio source");
          }
          const [contract] = await tx.select().from(completionContracts).where(and(
            eq(completionContracts.id, source.completionContractId), eq(completionContracts.companyId, companyId),
            eq(completionContracts.issueId, issue.id),
          )).limit(1);
          if (!contract) throw unprocessable("Versioned offers require the source task's current completion contract");
          const [recipient] = await tx.select({ id: agents.id, companyId: agents.companyId, status: agents.status,
            adapterType: agents.adapterType, adapterConfig: agents.adapterConfig, runtimeConfig: agents.runtimeConfig }).from(agents).where(and(
            eq(agents.id, input.toAgentId), eq(agents.companyId, companyId),
          )).limit(1);
          if (!recipient || recipient.adapterType !== "proprio_runner") {
            throw unprocessable("Versioned offers require a native Proprio recipient");
          }
          const settings = await instanceSettingsService(tx).getExperimental();
          if (!nativeRuntimeSupportsCaseOfferDecision(recipient, issue.id, settings)) {
            throw unprocessable("The recipient's native runtime does not support the offer decision API");
          }
          if (!await canActorReadCase(tx, { type: "agent", agentId: input.toAgentId, companyId,
            onBehalfOfUserId: issue.responsibleUserId ?? actor.onBehalfOfUserId,
            authorizingUserId: actor.authorizingUserId }, caseRow!)) {
            throw forbidden("Versioned offer recipients must already be able to read the case");
          }
          const requirementRevision = { id: contract.id, revision: contract.revision, canonicalSha256: contract.canonicalSha256 };
          const snapshot = {
            taskTitle: issue.title, taskDescription: issue.description, phase: input.phase, instructions: input.instructions,
            expectedDeliverable: input.offer.expectedDeliverable, prerequisites: input.offer.prerequisites,
            requirementRevision, workflowTransition: workflow.workflowTransition,
            workflowPromptDigest: workflow.workflowPrompt === null ? null : nativeSha256(workflow.workflowPrompt),
          };
          offerContract = {
            schema: "proprio.case-handoff-offer.v1", ...input.offer, requirementRevision,
            requirementsDigest: computeCaseHandoffRequirementsDigest(snapshot),
            taskBrief: { title: snapshot.taskTitle, description: snapshot.taskDescription },
          };
        }
        const version = caseRow!.handoffVersion + 1;
        [caseRow] = await tx.update(cases).set({ workIssueId: issue.id, handoffVersion: version, updatedAt: new Date() }).where(eq(cases.id, caseRow!.id)).returning();
        const [saved] = await tx.insert(caseHandoffs).values({ id, companyId, caseId: caseRow!.id, issueId: issue.id, version, ...workflow,
          offerContract,
          fromAgentId: issue.assigneeAgentId, toAgentId: input.toAgentId, phase: input.phase, instructions: input.instructions,
          commentId: comment.id, ...who, actorContext: caseHandoffActorContext(actor, companyId), sourceRunId, responsibleUserId: issue.responsibleUserId, expectedIssueStatusVersion: issue.statusVersion,
          idempotencyKey: input.idempotencyKey, inputFingerprint: fingerprint, wakeupRequestId: randomUUID(),
          state: offerContract ? "offered" : sourceRunId ? "awaiting_release" : "pending_dispatch",
        }).returning();
        let row = saved!;
        await event(tx, row, "handoff_requested", publications);
        if (!offerContract && !sourceRunId) row = await apply(tx, row, caseRow!, issue, publications, actor);
        if (!offerContract) await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, row.id);
        return result(row, issue, actor, false);
      });
      publications.forEach(publishActivity);
      return outcome;
    },

    async listRecipientOffers(actor: AuthorizationActor, companyId: string, options: HandoffListOptions = {}) {
      if (actor.type !== "agent" || !actor.agentId || actor.companyId !== companyId) {
        throw forbidden("Only agents can list their own handoff offers");
      }
      await assertEnabled(db);
      const limit = Math.min(100, Math.max(1, options.limit ?? 25));
      const rows = await db.select({ id: caseHandoffs.id, caseId: cases.id, handoffVersion: caseHandoffs.version,
        createdAt: caseHandoffs.createdAt }).from(caseHandoffs)
        .innerJoin(cases, and(eq(cases.id, caseHandoffs.caseId), eq(cases.companyId, caseHandoffs.companyId),
          eq(cases.workIssueId, caseHandoffs.issueId), eq(cases.handoffVersion, caseHandoffs.version)))
        .where(and(eq(caseHandoffs.companyId, companyId), eq(caseHandoffs.toAgentId, actor.agentId),
          eq(caseHandoffs.state, "offered"), ne(cases.status, "cancelled"), handoffPageFilter(options),
          await caseReadSqlCondition(db, actor)))
        .orderBy(desc(caseHandoffs.createdAt), desc(caseHandoffs.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const readable = new Set((await filterCasesForActor(db, actor, page.map(row => ({ id: row.caseId })))).map(row => row.id));
      return {
        items: page.filter(row => readable.has(row.caseId)).map(({ id, ...row }) => ({ handoffId: id, ...row })),
        nextCursor: handoffNextCursor(rows.length > limit ? page.at(-1) : undefined),
      };
    },

    async list(actor: AuthorizationActor, caseId: string, options: HandoffListOptions = {}) {
      await assertEnabled(db); await visible(actor, caseId);
      const limit = Math.min(100, Math.max(1, options.limit ?? 25));
      const rows = await db.select().from(caseHandoffs).where(and(eq(caseHandoffs.caseId, caseId), handoffPageFilter(options)))
        .orderBy(desc(caseHandoffs.createdAt), desc(caseHandoffs.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const ids = [...new Set(page.flatMap(row => [row.toAgentId, row.fromAgentId].filter((id): id is string => !!id)))];
      const names = ids.length ? new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids))).map(item => [item.id, item.name])) : new Map<string, string>();
      let canControl = false;
      const active = page.find(row => PENDING.includes(row.state as typeof PENDING[number]));
      if (active) {
        const [issue] = await db.select().from(issues).where(eq(issues.id, active.issueId));
        if (issue) {
          try { await authorizeHandoffControl(db, actor, active, issue, false); canControl = true; } catch { /* A readable history need not grant task control. */ }
        }
      }
      return { items: page.map(row => ({ ...publicHandoff(row), toAgentName: row.toAgentId ? names.get(row.toAgentId) ?? null : null, fromAgentName: row.fromAgentId ? names.get(row.fromAgentId) ?? null : null, canControl })),
        nextCursor: handoffNextCursor(rows.length > limit ? page.at(-1) : undefined), canControl };
    },

    async recoveryHistory(actor: AuthorizationActor, caseId: string, handoffId: string) {
      return db.transaction(transaction => withAuthorizationReadSnapshot(async () => {
        const tx = transaction as unknown as Db;
        await assertEnabled(tx);
        const caseRow = await visible(actor, caseId, tx);
        if (!isUuidLike(handoffId)) throw notFound("Handoff not found");
        const [handoff] = await tx.select().from(caseHandoffs).where(and(
          eq(caseHandoffs.companyId, caseRow.companyId), eq(caseHandoffs.caseId, caseId),
          eq(caseHandoffs.id, handoffId),
        )).limit(1);
        if (!handoff) throw notFound("Handoff not found");
        const access = authorizationService(tx);
        const [taskRead, completionRead] = await access.decideReads(actor, [{
          type: "issue", companyId: caseRow.companyId, issueId: handoff.issueId,
        }, { type: "company", companyId: caseRow.companyId }]);
        if (!taskRead?.allowed) throw notFound("Handoff not found");
        if (!completionRead?.allowed) throw forbidden("Completion history is outside this actor's authorization boundary");
        return readCaseHandoffRecoveryHistory(tx, handoff);
      }), { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async recordRecipientDecision(actor: AuthorizationActor, caseId: string, handoffId: string, input: CaseHandoffRecipientDecisionInput) {
      if (actor.type !== "agent" || !actor.agentId || !actor.companyId) throw forbidden("Only the named recipient agent can decide an offer");
      if (!isUuidLike(handoffId)) throw notFound("Handoff not found");
      const { agentId, companyId } = actor;
      await assertEnabled(db);
      const publications: ActivityPublication[] = [];
      const decided = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await visible(actor, caseId, tx);
        const scope = and(eq(caseHandoffs.companyId, companyId), eq(caseHandoffs.caseId, caseId), eq(caseHandoffs.id, handoffId));
        const [snapshot] = await tx.select().from(caseHandoffs).where(scope);
        if (!snapshot || snapshot.toAgentId !== agentId) throw notFound("Handoff not found");

        const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId),
          eq(issues.id, snapshot.issueId))).for("update");
        if (!issue) throw notFound("Task not found");
        await lockCaseHandoffAuthorityRun(tx, snapshot, issue);
        if (actor.runId) await assertAgentRunWriteAllowed(tx, companyId, { agentId, runId: actor.runId });
        const [caseRow] = await tx.select().from(cases).where(and(eq(cases.companyId, companyId), eq(cases.id, caseId))).for("update");
        const [row] = await tx.select().from(caseHandoffs).where(scope).for("update");
        if (!caseRow || !row || row.toAgentId !== agentId || !await canActorReadCase(tx, actor, caseRow)
          || !await canActorReceiveCase(tx, actor, caseRow, issue.id, agentId)) {
          throw notFound("Handoff not found");
        }
        await assertActorCanWriteCase(tx, actor, caseRow);
        if (caseRow.status === "cancelled") throw conflict("Case was cancelled");
        if (!row.offerContract || input.expectedHandoffVersion !== row.version
          || input.requirementRevisionId !== row.offerContract.requirementRevision.id) {
          throw conflict("The handoff offer revision changed. Read the current offer.");
        }
        const reasonCode = input.outcome === "accepted" ? undefined : input.reasonCode;
        const message = input.outcome === "accepted" ? undefined : input.message;
        if (row.recipientDecision) {
          if (row.recipientDecision.outcome === input.outcome && row.recipientDecision.reasonCode === reasonCode
            && row.recipientDecision.message === message) return row;
          throw conflict("A decision is already recorded for this handoff offer.");
        }
        if (row.state !== "offered" || caseRow.handoffVersion !== row.version || caseRow.workIssueId !== issue.id
          || issue.assigneeAgentId !== row.fromAgentId || issue.assigneeUserId || issue.statusVersion !== row.expectedIssueStatusVersion) {
          throw conflict("This handoff offer is no longer current. Read the current task and handoff.");
        }
        try {
          await assertOfferRequirementsCurrent(tx, row, issue);
        } catch (error) {
          if (!(error instanceof CaseHandoffRequirementsSuperseded)) throw error;
          const [retired] = await tx.update(caseHandoffs).set({ state: "cancelled", cancelledAt: new Date(), updatedAt: new Date(),
            lastErrorCode: "superseded", lastError: error.message }).where(scope).returning();
          if (retired) await event(tx, retired, "handoff_cancelled", publications);
          return { superseded: error };
        }
        const accepted = input.outcome === "accepted";
        if (accepted) {
          await assertCaseTrustedForExecution(tx, caseRow);
          await assertAssignableAgent(tx, companyId, agentId, { kind: "work" });
          await assertCaseHandoffDispatchAuthority(tx, row, issue, caseRow);
        }
        const now = new Date();
        const recipientDecision: CaseHandoffRecipientDecision = {
          outcome: input.outcome, actorType: "agent", actorId: agentId,
          handoffVersion: row.version, requirementRevisionId: input.requirementRevisionId,
          requirementsDigest: row.offerContract.requirementsDigest, decidedAt: now.toISOString(),
          ...(reasonCode ? { reasonCode } : {}), ...(message ? { message } : {}),
        };
        if (accepted) await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, row.id);
        const [updated] = await tx.update(caseHandoffs).set({
          recipientDecision, updatedAt: now,
          ...(accepted ? { state: "awaiting_release" as const, nextAttemptAt: now } : {
            state: "cancelled" as const, cancelledAt: now,
          }),
        }).where(and(scope, eq(caseHandoffs.state, "offered"), sql`${caseHandoffs.recipientDecision} is null`)).returning();
        if (!updated) throw conflict("A decision is already recorded for this handoff offer.");
        await event(tx, updated, "handoff_decision_recorded", publications, actor);
        return updated;
      });
      publications.forEach(publishActivity);
      if ("superseded" in decided) throw decided.superseded;
      const { id, version, state, recipientDecision } = decided;
      if (!recipientDecision) throw new Error("Committed handoff decision is missing its receipt");
      const { message: _message, ...decisionReceipt } = recipientDecision;
      return { id, version, state, recipientDecision: decisionReceipt };
    },

    async retry(actor: AuthorizationActor, caseId: string, handoffId: string) {
      if (!isUuidLike(handoffId)) throw notFound("Handoff not found");
      await assertEnabled(db); const caseRow = await visible(actor, caseId);
      const [row] = await db.select().from(caseHandoffs).where(and(eq(caseHandoffs.id, handoffId), eq(caseHandoffs.caseId, caseRow.id)));
      if (!row) throw notFound("Handoff not found");
      const [issue] = await db.select().from(issues).where(eq(issues.id, row.issueId));
      if (!issue) throw notFound("Task not found");
      await authorizeHandoffControl(db, actor, row, issue);
      if (row.state === "offered") return publicHandoff(row); // Recipient decision owns this state; never enqueue execution delivery.
      if (row.destinationKind === "done") return publicHandoff(row); // Completion is owned by the ordinary task completion path.
      if (!PENDING.includes(row.state as typeof PENDING[number])) return publicHandoff(row);
      let publication: ActivityPublication | null = null;
      const retried = await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, row.id);
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, row.issueId)).for("update");
        if (actor.type === "agent" && actor.runId) await assertAgentRunWriteAllowed(tx as unknown as Db, row.companyId, { agentId: actor.agentId, runId: actor.runId });
        const [updated] = await tx.update(caseHandoffs).set({ nextAttemptAt: new Date(), lastError: null, lastErrorCode: null, updatedAt: new Date() })
          .where(and(eq(caseHandoffs.id, row.id), inArray(caseHandoffs.state, PENDING))).returning();
        if (updated) publication = (await persistActivity(tx as unknown as Db, { companyId: row.companyId, ...identity(actor),
          agentId: actor.type === "agent" ? actor.agentId : null, runId: actor.runId, issueId: row.issueId,
          action: "case.handoff_retry_requested", entityType: "case", entityId: row.caseId, details: { handoffId: row.id } })).publication;
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, row.id); return updated ?? row;
      });
      if (publication) publishActivity(publication);
      return publicHandoff(retried);
    },

    async cancel(actor: AuthorizationActor, caseId: string, handoffId: string) {
      if (!isUuidLike(handoffId)) throw notFound("Handoff not found");
      const caseRow = await visible(actor, caseId); // Cancellation remains available while disabled.
      const [row] = await db.select().from(caseHandoffs).where(and(eq(caseHandoffs.id, handoffId), eq(caseHandoffs.caseId, caseRow.id)));
      if (!row) throw notFound("Handoff not found");
      const [issue] = await db.select().from(issues).where(eq(issues.id, row.issueId));
      if (!issue) throw notFound("Task not found");
      await authorizeHandoffControl(db, actor, row, issue, false);
      if (PENDING.includes(row.state as typeof PENDING[number])) await cancelPendingCaseHandoffsForIssue(db, issue.id, "Cancelled by operator", actor, row.id);
      return db.select().from(caseHandoffs).where(eq(caseHandoffs.id, row.id)).then(rows => publicHandoff(rows[0]!));
    },

    async withdrawDelivered(actor: AuthorizationActor, caseId: string, handoffId: string, input: CaseHandoffWithdrawalInput) {
      if (actor.type !== "board") throw forbidden("Only a board operator can withdraw delivered work");
      if (!isUuidLike(handoffId) || !isUuidLike(input.stoppedRunId)) throw notFound("Handoff not found");
      const stoppedRunId = input.stoppedRunId.toLowerCase();
      const caseSnapshot = await visible(actor, caseId);
      const publications: ActivityPublication[] = [];
      const withdrawn = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const scope = and(eq(caseHandoffs.companyId, caseSnapshot.companyId), eq(caseHandoffs.caseId, caseSnapshot.id),
          eq(caseHandoffs.id, handoffId));
        const [snapshot] = await tx.select().from(caseHandoffs).where(scope).limit(1);
        if (!snapshot) throw notFound("Handoff not found");
        const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, snapshot.companyId),
          eq(issues.id, snapshot.issueId))).for("update");
        if (!issue) throw notFound("Task not found");
        await lockCaseHandoffAuthorityRun(tx, snapshot, issue);
        const [caseRow] = await tx.select().from(cases).where(and(eq(cases.companyId, snapshot.companyId),
          eq(cases.id, snapshot.caseId))).for("update");
        const [row] = await tx.select().from(caseHandoffs).where(scope).for("update");
        if (!caseRow || !row) throw notFound("Handoff not found");
        await assertActorCanReadCase(tx, actor, caseRow);
        await assertActorCanWriteCase(tx, actor, caseRow);
        await authorizeTerminalTask(tx, actor, issue);
        if (row.state === "cancelled" && row.lastErrorCode === CASE_HANDOFF_WITHDRAWN_AFTER_STOP
            && row.version === input.expectedHandoffVersion) {
          const [receipt] = await tx.select({ id: caseEvents.id }).from(caseEvents).where(and(
            eq(caseEvents.companyId, row.companyId), eq(caseEvents.caseId, row.caseId), eq(caseEvents.kind, "handoff_cancelled"),
            sql`${caseEvents.payload}->>'handoffId' = ${row.id}`,
            sql`${caseEvents.payload}->>'stoppedRunId' = ${stoppedRunId}`,
          )).limit(1);
          if (receipt) return row;
        }
        if (row.state !== "delivered" || row.destinationKind !== "agent" || !row.toAgentId
            || row.version !== input.expectedHandoffVersion || caseRow.handoffVersion !== row.version
            || caseRow.workIssueId !== issue.id || issue.assigneeAgentId !== row.toAgentId || issue.assigneeUserId !== null
            || ["done", "cancelled"].includes(issue.status)) {
          throw conflict("The delivered handoff or its task owner changed. Read the current Case and task before withdrawing it.",
            { code: "case_handoff_withdrawal_stale", expectedHandoffVersion: input.expectedHandoffVersion });
        }
        if (!readAcceptedCaseHandoffOffer(row)) {
          throw conflict("Only an accepted versioned handoff can be withdrawn through this control.", { code: "case_handoff_withdrawal_not_versioned" });
        }
        const runScope = and(eq(heartbeatRuns.companyId, row.companyId), eq(boundRunIssueIdSql(), issue.id));
        const [stoppedRun] = await tx.select().from(heartbeatRuns).where(and(runScope,
          eq(heartbeatRuns.id, stoppedRunId), eq(heartbeatRuns.agentId, row.toAgentId), eq(heartbeatRuns.status, "cancelled")))
          .for("share").limit(1);
        const stoppedHandoffId = stoppedRun && await isAcknowledgedOperatorRunStop(tx, stoppedRun) ? await readCaseHandoffIdForNativeRun(tx, {
          companyId: row.companyId, issueId: issue.id, runId: stoppedRun.id, contextSnapshot: stoppedRun.contextSnapshot,
        }) : null;
        if (!stoppedRun || stoppedHandoffId !== row.id) {
          throw conflict("Stop the recipient run and wait for its acknowledged Stop receipt before withdrawing this handoff.",
            { code: "case_handoff_withdrawal_stop_required", runId: stoppedRunId });
        }
        if ((issue.executionRunId && issue.executionRunId !== stoppedRun.id)
            || (issue.checkoutRunId && issue.checkoutRunId !== stoppedRun.id)) {
          throw conflict("A different run is now admitted for this task. Stop or reassign it before withdrawing the handoff.",
            { code: "case_handoff_withdrawal_run_changed", runId: issue.executionRunId ?? issue.checkoutRunId });
        }
        // Compare timestamps in PostgreSQL, preserving sub-millisecond order.
        const stoppedPosition = tx.select({ createdAt: heartbeatRuns.createdAt, id: heartbeatRuns.id })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, stoppedRun.id));
        const [supersedingRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          runScope, ne(heartbeatRuns.id, stoppedRun.id),
          or(inArray(heartbeatRuns.status, ["queued", "running"]),
            sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (${stoppedPosition})`),
        )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
        if (supersedingRun) throw conflict("A different run is active or ran after this Stop. Review the current task execution.",
          { code: "case_handoff_withdrawal_run_changed", runId: supersedingRun.id });

        const now = new Date();
        const [updated] = await tx.update(caseHandoffs).set({ state: "cancelled", cancelledAt: now, leaseExpiresAt: null,
          lastErrorCode: CASE_HANDOFF_WITHDRAWN_AFTER_STOP, lastError: "Withdrawn by board after acknowledged Stop", updatedAt: now })
          .where(and(scope, eq(caseHandoffs.state, "delivered"), eq(caseHandoffs.version, input.expectedHandoffVersion))).returning();
        if (!updated) throw conflict("The delivered handoff changed while the withdrawal was being recorded.", { code: "case_handoff_withdrawal_stale" });
        const audit = { disposition: "delivered_proposal_withdrawn", stopProof: "acknowledged_operator_stop",
          stoppedRunId: stoppedRun.id, nextOwner: "board", nextAction: "Inspect stopped work and any workspace or external effects. Resolve this recovery hold before assigning the task or creating a replacement handoff." };
        await event(tx, updated, "handoff_cancelled", publications, actor, audit);
        const blockedIssue = await issueService(tx).update(issue.id, { status: "blocked",
          unblockDescriptor: { owner: "board", action: audit.nextAction }, companyGuard: row.companyId,
          actorUserId: actor.userId ?? null }, tx, publications, []);
        if (!blockedIssue) throw notFound("Task not found");
        await issueRecoveryActionService(tx).upsertSourceScoped({
          companyId: row.companyId, sourceIssueId: issue.id, kind: "active_run_watchdog",
          cause: CASE_HANDOFF_WITHDRAWAL_HOLD_CAUSE, ownerType: "board",
          fingerprint: nativeSha256({ handoffId: row.id, stoppedRunId: stoppedRun.id }),
          evidence: { runId: stoppedRun.id }, nextAction: audit.nextAction, supersedeOnIdentityChange: true,
        });
        return updated;
      });
      publications.forEach(publishActivity);
      return publicHandoff(withdrawn);
    },

    /** Call only after the runtime's authoritative settlement predicate succeeds. */
    async applyPending(handoffId: string) {
      await assertEnabled(db);
      const [authoritySnapshot] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, handoffId));
      const cloudAuthority = authoritySnapshot?.state === "awaiting_release" ? await loadCaseHandoffCloudAuthority(authoritySnapshot) : null;
      const publications: ActivityPublication[] = [];
      const applied = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, handoffId);
        const [snapshot] = await tx.select().from(caseHandoffs).where(eq(caseHandoffs.id, handoffId));
        if (!snapshot || snapshot.state !== "awaiting_release") return snapshot ?? null;
        const [issue] = await tx.select().from(issues).where(eq(issues.id, snapshot.issueId)).for("update");
        if (issue) await lockCaseHandoffAuthorityRun(tx, snapshot, issue);
        const [caseRow] = await tx.select().from(cases).where(eq(cases.id, snapshot.caseId)).for("update");
        const [row] = await tx.select().from(caseHandoffs).where(eq(caseHandoffs.id, handoffId)).for("update");
        if (!row || row.state !== "awaiting_release") return row ?? null;
        if (!issue || !caseRow) throw notFound("Case work no longer exists");
        const updated = await apply(tx, row, caseRow, issue, publications, undefined, cloudAuthority);
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, row.id);
        return updated;
      });
      publications.forEach(publishActivity); return applied;
    },
    async authorizePendingDispatch(handoffId: string) {
      await assertEnabled(db);
      await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const [snapshot] = await tx.select().from(caseHandoffs).where(eq(caseHandoffs.id, handoffId));
        if (!snapshot || snapshot.state !== "pending_dispatch") throw conflict("Handoff is no longer pending dispatch");
        const [issue] = await tx.select().from(issues).where(eq(issues.id, snapshot.issueId)).for("update");
        if (!issue) throw notFound("Task not found");
        await lockCaseHandoffAuthorityRun(tx, snapshot, issue);
        const [caseRow] = await tx.select().from(cases).where(eq(cases.id, snapshot.caseId)).for("update");
        const [row] = await tx.select().from(caseHandoffs).where(eq(caseHandoffs.id, handoffId)).for("update");
        if (!caseRow || !row || row.state !== "pending_dispatch" || caseRow.workIssueId !== issue.id || caseRow.handoffVersion !== row.version ||
          row.appliedIssueStatusVersion !== issue.statusVersion || issue.assigneeAgentId !== row.toAgentId || issue.responsibleUserId !== row.responsibleUserId) throw conflict("Handoff was superseded by a newer task decision");
        if (row.offerContract && caseRow.status === "cancelled") throw conflict("Case was cancelled");
        await assertCaseTrustedForExecution(tx, caseRow);
        await assertAcceptedOfferIsCurrent(tx, row, issue);
        await assertCaseHandoffDispatchAuthority(tx, row, issue, caseRow);
      });
    },
    visible,
  };
}

export { event as recordCaseHandoffEvent };
