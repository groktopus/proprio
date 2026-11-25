import { and, eq } from "drizzle-orm";
import type { Db } from "@groktopus/db";
import {
  caseHandoffs,
  cases,
  completionContracts,
  heartbeatRuns,
  issues,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@groktopus/db";

import { readAcceptedCaseHandoffOffer } from "../case-handoff-offer-authority.js";
import { readCaseHandoffIdForNativeRun } from "./native-continuation-delivery.js";
import { record, text } from "./evidence-json.js";

/**
 * Read a completion-evidence receipt only when the run was admitted for the
 * currently accepted case-handoff revision. Legacy runs and ordinary native
 * runs deliberately return null and retain their existing recovery receipt.
 */
export async function readAcceptedCaseHandoffCompletionEvidence(input: {
  db: Pick<Db, "select">;
  companyId: string;
  issueId: string;
  runId: string;
  decisionId: string;
}) {
  const [run] = await input.db.select({ agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot,
    completionContractId: heartbeatRuns.completionContractId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.runtimeMode, "native"),
  )).limit(1);
  if (!run) return null;
  const handoffId = await readCaseHandoffIdForNativeRun(input.db, {
    companyId: input.companyId, issueId: input.issueId, runId: input.runId, contextSnapshot: run.contextSnapshot,
  });
  if (!handoffId) return null;

  const [decision] = await input.db.select({ assessmentId: statusDecisions.assessmentId, reasonCode: statusDecisions.reasonCode }).from(statusDecisions).where(and(
    eq(statusDecisions.id, input.decisionId), eq(statusDecisions.companyId, input.companyId),
    eq(statusDecisions.issueId, input.issueId), eq(statusDecisions.runId, input.runId),
  )).limit(1);
  if (!decision) return null;

  const [assessment] = await input.db.select().from(workAssessments).where(and(
    eq(workAssessments.id, decision.assessmentId), eq(workAssessments.companyId, input.companyId),
    eq(workAssessments.issueId, input.issueId), eq(workAssessments.runId, input.runId),
  )).limit(1);
  if (!assessment) return null;
  const [result] = await input.db.select().from(nativeRunResults).where(and(
    eq(nativeRunResults.id, assessment.resultId), eq(nativeRunResults.companyId, input.companyId),
    eq(nativeRunResults.issueId, input.issueId), eq(nativeRunResults.runId, input.runId),
    eq(nativeRunResults.schemaStatus, "accepted"),
  )).limit(1);
  const [assessedContract] = await input.db.select().from(completionContracts).where(and(
    eq(completionContracts.id, assessment.contractId), eq(completionContracts.companyId, input.companyId),
    eq(completionContracts.issueId, input.issueId),
  )).limit(1);
  if (!result || !assessedContract || run.completionContractId !== assessedContract.id
      || result.completionContractId !== assessedContract.id) return null;
  // Status commitment holds the task lock. Lock the Case before its handoff
  // so cancellation and a newer offer cannot race receipt materialization.
  const [current] = await input.db.select({ caseId: cases.id, version: cases.handoffVersion, status: cases.status,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId }).from(cases)
    .innerJoin(issues, and(eq(issues.id, cases.workIssueId), eq(issues.companyId, cases.companyId)))
    .where(and(eq(cases.workIssueId, input.issueId), eq(cases.companyId, input.companyId)))
    .limit(1).for("share", { of: cases });
  if (!current || current.status === "cancelled" || current.assigneeAgentId !== run.agentId
      || current.assigneeUserId !== null) return null;
  const [handoff] = await input.db.select().from(caseHandoffs).where(and(
    eq(caseHandoffs.id, handoffId), eq(caseHandoffs.companyId, input.companyId), eq(caseHandoffs.caseId, current.caseId),
    eq(caseHandoffs.issueId, input.issueId), eq(caseHandoffs.toAgentId, run.agentId),
    eq(caseHandoffs.version, current.version), eq(caseHandoffs.state, "delivered"),
  )).limit(1).for("share");
  if (!handoff) return null;

  const offer = readAcceptedCaseHandoffOffer(handoff);
  if (!offer) return null;
  const revision = offer.requirementRevision;
  const [acceptedRequirementRevision] = await input.db.select().from(completionContracts).where(and(
    eq(completionContracts.id, revision.id), eq(completionContracts.companyId, input.companyId),
    eq(completionContracts.issueId, input.issueId),
  )).limit(1);
  if (!acceptedRequirementRevision
      || revision.revision !== acceptedRequirementRevision.revision
      || revision.canonicalSha256 !== acceptedRequirementRevision.canonicalSha256) return null;

  const assessmentJson = record(assessment.assessmentJson);
  const allCriterionAssessments = Array.isArray(assessmentJson.criterionAssessments)
    ? assessmentJson.criterionAssessments : [];
  const contractJson = record(assessedContract.contractJson);
  const criteria = Array.isArray(contractJson.criteria) ? contractJson.criteria : [];
  const criteriaById = new Map(criteria.map(value => [text(record(value).id), record(value)]));
  const criteriaNeedingWork = allCriterionAssessments.flatMap(value => {
    const item = record(value);
    const criterionId = text(item.criterionId);
    if (!criterionId || item.outcome === "accepted") return [];
    const criterion = criteriaById.get(criterionId) ?? {};
    const evidence = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.map(ref => {
      const refRecord = record(ref);
      return { outcome: text(refRecord.outcome), reasonCode: text(refRecord.reasonCode) };
    }) : [];
    return [{ criterionId, requirement: text(criterion.requirement), outcome: text(item.outcome),
      reasonCode: text(item.reasonCode), evidence }];
  });

  return {
    schema: "proprio.case-handoff-completion-recovery.v1",
    caseHandoff: { id: handoff.id, version: handoff.version,
      acceptedRequirementRevision: { id: acceptedRequirementRevision.id, revision: acceptedRequirementRevision.revision,
        canonicalSha256: acceptedRequirementRevision.canonicalSha256 },
      requirementsDigest: offer.requirementsDigest, prerequisiteCount: Array.isArray(offer.prerequisites) ? offer.prerequisites.length : 0,
      recipientAgentId: run.agentId },
    decision: { statusDecisionReasonCode: decision.reasonCode },
    assessment: { id: assessment.id, resultId: result.id,
      assessedContractRevision: { id: assessedContract.id, revision: assessedContract.revision,
        canonicalSha256: assessedContract.canonicalSha256 },
      criteriaNeedingWork },
  };
}

/** Case offer details have a stricter visibility boundary than the task card.
 * Keep the full receipt in durable storage, but only project generic task-local
 * gap counts into the task recovery read model. */
export function projectTaskCompletionRecovery(savedEvidence: Record<string, unknown>) {
  const evidence = { ...savedEvidence };
  if (!Object.hasOwn(evidence, "caseHandoffCompletion")) return null;
  const receipt = record(evidence.caseHandoffCompletion);
  delete evidence.caseHandoffCompletion;
  const fallback = "Review the task completion assessment.";
  if (receipt.schema !== "proprio.case-handoff-completion-recovery.v1") return { evidence, nextAction: fallback };
  const caseHandoff = record(receipt.caseHandoff);
  const assessment = record(receipt.assessment);
  const criteria = Array.isArray(assessment.criteriaNeedingWork)
    ? assessment.criteriaNeedingWork.map(record) : [];
  const reason = (item: Record<string, unknown>) => typeof item.reasonCode === "string" ? item.reasonCode : "";
  const unmetCriterionCount = criteria.filter(item => ["criterion_claim_missing", "criterion_reported_not_satisfied", "criterion_claim_not_satisfied"].includes(reason(item))).length;
  const evidenceIssueCount = criteria.filter(item => ["criterion_evidence_missing", "criterion_evidence_rejected", "criterion_evidence_unverifiable"].includes(reason(item))).length;
  const prerequisiteCount = typeof caseHandoff.prerequisiteCount === "number" && Number.isSafeInteger(caseHandoff.prerequisiteCount)
    ? caseHandoff.prerequisiteCount
    : Array.isArray(caseHandoff.prerequisites) ? caseHandoff.prerequisites.length : 0;
  const guidance = [
    receipt.taskRemedy === "publish_task_document" ? "Publish the requested task document with write_document, or attach verified output with register_deliverable." : null,
    prerequisiteCount > 0 ? "Review the prerequisite checklist in the authorized Case view." : null,
    unmetCriterionCount > 0 ? `Complete ${unmetCriterionCount} unmet task criterion${unmetCriterionCount === 1 ? "" : "a"}.` : null,
    evidenceIssueCount > 0 ? `Add or correct evidence for ${evidenceIssueCount} task criterion${evidenceIssueCount === 1 ? "" : "a"}, then retry completion.` : null,
  ].filter((item): item is string => Boolean(item));
  return { evidence, nextAction: guidance.length ? `${fallback} ${guidance.join(" ")}` : fallback };
}
