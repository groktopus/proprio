import { and, desc, eq, sql } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@groktopus/db";
import { caseHandoffRecoveryHistorySchema, type CaseHandoffRecoveryHistory } from "@groktopus/shared";
import { z } from "zod";
import { readAcceptedCaseHandoffOffer } from "./case-handoff-offer-authority.js";
import { projectCaseCompletionRecoveryAction } from "./issue-recovery-actions.js";
import { readCaseCompletionRecoveryAttempts } from "./native-runtime/case-handoff-completion-evidence.js";
import type { CaseHandoffRow } from "./case-handoffs.js";

const entrySchema = caseHandoffRecoveryHistorySchema.shape.entries.element;
const receiptSchema = z.object({
  assessment: z.object({
    assessedContractRevision: z.object({ revision: entrySchema.shape.assessedRevision }),
    criteriaNeedingWork: entrySchema.shape.criteria,
  }),
});

export async function readCaseHandoffRecoveryHistory(db: Db, handoff: CaseHandoffRow): Promise<CaseHandoffRecoveryHistory> {
  const offer = readAcceptedCaseHandoffOffer(handoff);
  if (!offer) return { entries: [] };

  const receipt = sql`${issueRecoveryActions.evidence}->'caseHandoffCompletion'`;
  const rows = await db.select({
    id: issueRecoveryActions.id, status: issueRecoveryActions.status,
    ownerType: issueRecoveryActions.ownerType, ownerAgentId: issueRecoveryActions.ownerAgentId,
    ownerUserId: issueRecoveryActions.ownerUserId,
    nextAction: issueRecoveryActions.nextAction, attemptCount: issueRecoveryActions.attemptCount,
    maxAttempts: issueRecoveryActions.maxAttempts, outcome: issueRecoveryActions.outcome,
    resolutionNote: issueRecoveryActions.resolutionNote,
    runId: sql<string | null>`${issueRecoveryActions.evidence}->>'runId'`,
    decisionId: sql<string | null>`${issueRecoveryActions.evidence}->>'decisionId'`,
    receipt,
    recoveryBudget: sql`${issueRecoveryActions.evidence}->'recoveryBudget'`,
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
  for (const { receipt: persisted, runId, decisionId, recoveryBudget, ...row } of rows) {
    const parsed = receiptSchema.safeParse(persisted);
    if (!parsed.success) continue;
    const evidence = { runId, decisionId, caseHandoffCompletion: persisted, recoveryBudget };
    const projected = projectCaseCompletionRecoveryAction({ evidence, attemptCount: row.attemptCount });
    const { assessment } = parsed.data;
    const entry = entrySchema.safeParse({
      ...row, nextAction: projected?.nextAction ?? row.nextAction,
      assessedRevision: assessment.assessedContractRevision.revision, criteria: assessment.criteriaNeedingWork,
      attempts: readCaseCompletionRecoveryAttempts(evidence).slice(-3).flatMap(attempt => {
        const decoded = entrySchema.shape.attempts.element.safeParse(attempt);
        return decoded.success ? [decoded.data] : [];
      }),
    });
    if (entry.success) entries.push(entry.data);
  }
  return { entries };
}
