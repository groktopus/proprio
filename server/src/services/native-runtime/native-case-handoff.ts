import { caseHandoffs, cases, type Db } from "@groktopus/db";
import { and, eq } from "drizzle-orm";
import type { PrpStructuredRunResult } from "../../vendor/proprio-runner/index.js";
import { pendingCaseHandoffForRun } from "../heartbeat/case-handoff-lifecycle.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const uuid = (value: unknown): string | null => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;

/**
 * Return null for legacy/ordinary runs and false when a handoff-bound run has
 * lost current task authority. Called with the issue already locked by the
 * status committer, so handoff application and reassignment serialize here.
 */
export async function nativeCaseHandoffStatusAuthorityIsCurrent(db: Db, input: {
  companyId: string;
  issue: { id: string; assigneeAgentId: string | null; assigneeUserId: string | null };
  runAgentId: string | null;
  runWakeupRequestId: string | null;
  contextSnapshot: unknown;
}): Promise<boolean | null> {
  const context = record(input.contextSnapshot);
  if (!Object.prototype.hasOwnProperty.call(context, "caseHandoffId") || context.caseHandoffId == null) return null;
  const handoffId = uuid(context.caseHandoffId);
  if (!handoffId || !input.runAgentId) return null;
  const [current] = await db.select({ handoff: caseHandoffs, case: cases })
    .from(caseHandoffs)
    .innerJoin(cases, and(eq(cases.id, caseHandoffs.caseId), eq(cases.companyId, caseHandoffs.companyId)))
    .where(and(eq(caseHandoffs.id, handoffId), eq(caseHandoffs.companyId, input.companyId),
      eq(caseHandoffs.issueId, input.issue.id), eq(caseHandoffs.toAgentId, input.runAgentId)))
    .limit(1);
  if (!current) return false;
  const { handoff, case: caseRow } = current;
  const offer = record(handoff.offerContract);
  // Pre-versioned handoffs and board kickoff runs retain their historical
  // status behavior; only the revision-accepted protocol opts into this fence.
  if (offer.schema !== "proprio.case-handoff-offer.v1") return null;
  const recipientDecision = record(handoff.recipientDecision);
  const requirementRevisionId = uuid(record(offer.requirementRevision).id);
  const deliveryCurrent = handoff.state === "delivered"
    || (handoff.state === "pending_dispatch" && input.runWakeupRequestId === handoff.wakeupRequestId);
  return handoff.destinationKind === "agent" && deliveryCurrent
    && caseRow.workIssueId === input.issue.id && caseRow.handoffVersion === handoff.version
    && input.issue.assigneeAgentId === input.runAgentId && input.issue.assigneeUserId === null
    && recipientDecision.outcome === "accepted" && recipientDecision.actorType === "agent"
    && recipientDecision.actorId === input.runAgentId && recipientDecision.handoffVersion === handoff.version
    && offer.requirementsDigest === recipientDecision.requirementsDigest
    && requirementRevisionId !== null && recipientDecision.requirementRevisionId === requirementRevisionId;
}

/** Server-issued semantic yield. The provider does not need a second finish call. */
export async function nativeCaseHandoffResult(db: Db, input: {
  runId: string; issueId: string;
  completionContract: { revision: string; criteria: Array<{ id: string }> };
}): Promise<PrpStructuredRunResult | null> {
  const handoff = await pendingCaseHandoffForRun(db, input.runId);
  if (!handoff || handoff.issueId !== input.issueId) return null;
  const ref = `case-handoff:${handoff.id}`;
  return {
    schema: "proprio.run_result.v1", reportedWorkDisposition: "yielded", summary: "Work handed off.",
    completionClaim: { contractRevision: input.completionContract.revision, objectiveSatisfied: false,
      criteria: input.completionContract.criteria.map(criterion => ({ criterionId: criterion.id, status: "unknown", evidenceRefs: [ref] })),
      remainingWork: [{ description: "The next agent continues the same task.", blocksCompletion: true }] },
    evidence: [{ ref }], verification: [], attentionRequests: [], artifacts: [],
    continuation: { kind: "case_handoff", handoffId: handoff.id, summary: handoff.phase, idempotencyKey: `case-handoff:${handoff.id}` },
  };
}

export async function assertNativeCaseHandoffResult(db: Db, runId: string, issueId: string, result: { continuation?: unknown }) {
  const expected = await pendingCaseHandoffForRun(db, runId);
  const continuation = result.continuation as { kind?: string; handoffId?: string } | undefined;
  if (continuation?.kind === "case_handoff" && (!expected || expected.issueId !== issueId || continuation.handoffId !== expected.id)) {
    // Stop may cancel delivery after a server-issued yield was checkpointed.
    // That historical receipt still permits settling the old run, but cannot
    // deliver work or manufacture a fresh handoff.
    const [cancelled] = continuation.handoffId ? await db.select().from(caseHandoffs).where(and(
      eq(caseHandoffs.id, continuation.handoffId), eq(caseHandoffs.sourceRunId, runId), eq(caseHandoffs.issueId, issueId),
      eq(caseHandoffs.destinationKind, "agent"), eq(caseHandoffs.state, "cancelled"),
    )).limit(1) : [];
    if (cancelled) return cancelled;
    throw new Error("case_handoff continuation requires the exact persisted handoff accepted from this run");
  }
  return expected?.issueId === issueId ? expected : null;
}
