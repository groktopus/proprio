import { and, desc, eq, sql } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@groktopus/db";
import { caseHandoffRecoveryHistorySchema, type CaseHandoffRecoveryHistory } from "@groktopus/shared";
import { z } from "zod";
import type { CaseHandoffRow } from "./case-handoffs.js";

const entrySchema = caseHandoffRecoveryHistorySchema.shape.entries.element;
const receiptSchema = z.object({
  decision: z.object({ id: entrySchema.shape.decisionId, statusDecisionReasonCode: z.string() }),
  assessment: z.object({
    id: entrySchema.shape.assessmentId,
    assessedContractId: z.string().uuid(),
    assessedContractRevision: z.object({ revision: entrySchema.shape.assessedRevision }),
    criteriaNeedingWork: entrySchema.shape.criteria,
  }),
  attempts: entrySchema.shape.attempts.optional(),
});

export async function readCaseHandoffRecoveryHistory(db: Db, handoff: CaseHandoffRow): Promise<CaseHandoffRecoveryHistory> {
  const offer = handoff.offerContract;
  const accepted = handoff.recipientDecision;
  if (!offer || accepted?.outcome !== "accepted" || accepted.handoffVersion !== handoff.version ||
      accepted.requirementRevisionId !== offer.requirementRevision.id || accepted.requirementsDigest !== offer.requirementsDigest ||
      accepted.actorId !== handoff.toAgentId) return { entries: [] };

  const receipt = sql`${issueRecoveryActions.evidence}->'caseHandoffCompletion'`;
  const rows = await db.select({
    id: issueRecoveryActions.id, status: issueRecoveryActions.status,
    ownerType: issueRecoveryActions.ownerType, ownerAgentId: issueRecoveryActions.ownerAgentId,
    ownerUserId: issueRecoveryActions.ownerUserId, cause: issueRecoveryActions.cause,
    nextAction: issueRecoveryActions.nextAction, attemptCount: issueRecoveryActions.attemptCount,
    maxAttempts: issueRecoveryActions.maxAttempts, outcome: issueRecoveryActions.outcome,
    resolutionNote: issueRecoveryActions.resolutionNote,
    runId: sql<string | null>`${issueRecoveryActions.evidence}->>'runId'`,
    receipt,
  }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, handoff.companyId),
    eq(issueRecoveryActions.sourceIssueId, handoff.issueId),
    eq(issueRecoveryActions.cause, "completion_evidence_incomplete"),
    sql`(${receipt})->>'schema' = 'proprio.case-handoff-completion-recovery.v1'`,
    sql`(${receipt})#>>'{caseHandoff,id}' = ${handoff.id}`,
    sql`(${receipt})#>>'{caseHandoff,version}' = ${String(handoff.version)}`,
    sql`(${receipt})#>>'{caseHandoff,requirementsDigest}' = ${offer.requirementsDigest}`,
    sql`(${receipt})#>>'{caseHandoff,acceptedRequirementRevision,id}' = ${offer.requirementRevision.id}`,
  )).orderBy(desc(issueRecoveryActions.createdAt), desc(issueRecoveryActions.id)).limit(3);

  const entries: CaseHandoffRecoveryHistory["entries"] = [];
  for (const { receipt: persisted, runId, ...row } of rows) {
    const parsed = receiptSchema.safeParse(persisted);
    if (!parsed.success) continue;
    const { decision, assessment, attempts } = parsed.data;
    const legacyAttempt = entrySchema.shape.attempts.element.safeParse({
      runId, decisionId: decision.id, assessmentId: assessment.id,
      assessedContractId: assessment.assessedContractId, reasonCode: decision.statusDecisionReasonCode,
    });
    entries.push({
      ...row, decisionId: decision.id, assessmentId: assessment.id, assessedRevision: assessment.assessedContractRevision.revision,
      criteria: assessment.criteriaNeedingWork,
      attempts: attempts?.slice(-3) ?? (legacyAttempt.success ? [legacyAttempt.data] : []),
    });
  }
  return { entries };
}
