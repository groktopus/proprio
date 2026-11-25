import { caseHandoffs, cases, type Db } from "@groktopus/db";
import { and, eq } from "drizzle-orm";
import type { PrpStructuredRunResult } from "../../vendor/proprio-runner/index.js";
import { pendingCaseHandoffForRun } from "../heartbeat/case-handoff-lifecycle.js";

import { readAcceptedCaseHandoffOffer } from "../case-handoff-offer-authority.js";
import { record } from "./evidence-json.js";
import { readCaseHandoffIdForNativeRun } from "./native-continuation-delivery.js";

/** Called under the issue lock. Return null for ordinary and pre-versioned
 * runs, or false when an admitted versioned handoff lost authority. */
export async function nativeCaseHandoffStatusAuthorityIsCurrent(db: Pick<Db, "select">, input: {
  companyId: string;
  issue: { id: string; assigneeAgentId: string | null; assigneeUserId: string | null };
  runId: string;
  runAgentId: string | null;
  runWakeupRequestId: string | null;
  contextSnapshot: unknown;
}): Promise<boolean | null> {
  const handoffId = await readCaseHandoffIdForNativeRun(db, { companyId: input.companyId, issueId: input.issue.id,
    runId: input.runId, contextSnapshot: input.contextSnapshot });
  if (!handoffId) return record(input.contextSnapshot).caseHandoffId == null ? null : false;
  if (!input.runAgentId) return false;
  const scope = and(eq(caseHandoffs.id, handoffId), eq(caseHandoffs.companyId, input.companyId),
    eq(caseHandoffs.issueId, input.issue.id), eq(caseHandoffs.toAgentId, input.runAgentId));
  // Case cancellation and handoff mutation take the Case lock before the
  // handoff lock. Keep both rows stable until status commitment settles.
  const [caseRow] = await db.select({ id: cases.id, status: cases.status, workIssueId: cases.workIssueId,
    handoffVersion: cases.handoffVersion }).from(cases)
    .innerJoin(caseHandoffs, and(eq(caseHandoffs.caseId, cases.id), eq(caseHandoffs.companyId, cases.companyId)))
    .where(scope).limit(1).for("share", { of: cases });
  if (!caseRow) return false;
  const [handoff] = await db.select().from(caseHandoffs).where(and(scope, eq(caseHandoffs.caseId, caseRow.id)))
    .limit(1).for("share");
  if (!handoff) return false;
  if (handoff.offerContract === null) return null;
  const deliveryCurrent = handoff.state === "delivered"
    || (handoff.state === "pending_dispatch" && input.runWakeupRequestId === handoff.wakeupRequestId);
  return handoff.destinationKind === "agent" && deliveryCurrent
    && caseRow.status !== "cancelled" && caseRow.workIssueId === input.issue.id
    && caseRow.handoffVersion === handoff.version
    && input.issue.assigneeAgentId === input.runAgentId && input.issue.assigneeUserId === null
    && readAcceptedCaseHandoffOffer(handoff) !== null;
}

/** Server-issued semantic yield. The provider does not need a second finish call. */
export async function nativeCaseHandoffResult(db: Db, input: {
  runId: string; issueId: string;
  completionContract: { revision: string; criteria: Array<{ id: string }> };
}): Promise<PrpStructuredRunResult | null> {
  const handoff = await pendingCaseHandoffForRun(db, input.runId);
  if (!handoff || handoff.issueId !== input.issueId) return null;
  const ref = `case-handoff:${handoff.id}`;
  const awaitingDecision = handoff.state === "offered";
  return {
    schema: "proprio.run_result.v1", reportedWorkDisposition: "yielded",
    summary: awaitingDecision ? "The handoff offer awaits a recipient decision." : "Work handed off.",
    completionClaim: { contractRevision: input.completionContract.revision, objectiveSatisfied: false,
      criteria: input.completionContract.criteria.map(criterion => ({ criterionId: criterion.id, status: "unknown", evidenceRefs: [ref] })),
      remainingWork: [{ description: awaitingDecision ? "The recipient must decide whether to accept the offer." : "The next agent continues the same task.", blocksCompletion: true }] },
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
