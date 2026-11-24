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

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value)
  ? value as JsonRecord : {};
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const uuid = (value: unknown): string | null => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;

/**
 * Read a completion-evidence receipt only when the run was admitted for the
 * currently accepted case-handoff revision. Legacy runs and ordinary native
 * runs deliberately return null and retain their existing recovery receipt.
 */
export async function readAcceptedCaseHandoffCompletionEvidence(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  decisionId: string;
  reasonCode: string;
}) {
  const [run] = await input.db.select({ agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot,
    completionContractId: heartbeatRuns.completionContractId, nativeIssueId: heartbeatRuns.nativeIssueId,
    companyId: heartbeatRuns.companyId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.nativeIssueId, input.issueId),
  )).limit(1);
  const handoffId = uuid(record(run?.contextSnapshot).caseHandoffId);
  if (!run || !handoffId) return null;

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
  const [current] = await input.db.select({ handoff: caseHandoffs, case: cases, assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId }).from(caseHandoffs)
    .innerJoin(cases, and(eq(cases.id, caseHandoffs.caseId), eq(cases.companyId, caseHandoffs.companyId)))
    .innerJoin(issues, and(eq(issues.id, caseHandoffs.issueId), eq(issues.companyId, caseHandoffs.companyId)))
    .where(and(eq(caseHandoffs.id, handoffId), eq(caseHandoffs.companyId, input.companyId),
      eq(caseHandoffs.issueId, input.issueId), eq(caseHandoffs.toAgentId, run.agentId)))
    .limit(1);
  const handoff = current?.handoff;
  if (!result || !assessedContract || !handoff || !current || run.completionContractId !== assessedContract.id
      || result.completionContractId !== assessedContract.id
      || current.case.workIssueId !== input.issueId || current.case.handoffVersion !== handoff.version
      || current.assigneeAgentId !== run.agentId || current.assigneeUserId !== null
      || handoff.state !== "delivered") return null;

  const offer = record(handoff.offerContract);
  const revision = record(offer.requirementRevision);
  const recipientDecision = record(handoff.recipientDecision);
  const acceptedRequirementRevisionId = uuid(revision.id);
  if (recipientDecision.outcome !== "accepted"
      || recipientDecision.actorType !== "agent"
      || recipientDecision.actorId !== run.agentId
      || recipientDecision.handoffVersion !== handoff.version
      || !acceptedRequirementRevisionId
      || recipientDecision.requirementRevisionId !== acceptedRequirementRevisionId
      || recipientDecision.requirementsDigest !== offer.requirementsDigest) return null;
  const [acceptedRequirementRevision] = await input.db.select().from(completionContracts).where(and(
    eq(completionContracts.id, acceptedRequirementRevisionId), eq(completionContracts.companyId, input.companyId),
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
    caseHandoff: { id: handoff.id, version: handoff.version, state: handoff.state,
      acceptedRequirementRevision: { id: acceptedRequirementRevision.id, revision: acceptedRequirementRevision.revision,
        canonicalSha256: acceptedRequirementRevision.canonicalSha256 },
      requirementsDigest: offer.requirementsDigest, recipientAgentId: run.agentId,
      prerequisiteCount: Array.isArray(offer.prerequisites) ? offer.prerequisites.length : 0 },
    decision: { id: input.decisionId, recoveryCause: input.reasonCode, statusDecisionReasonCode: decision.reasonCode },
    assessment: { id: assessment.id, resultId: result.id, assessedContractId: assessedContract.id,
      assessedContractRevision: { id: assessedContract.id, revision: assessedContract.revision,
        canonicalSha256: assessedContract.canonicalSha256 },
      criteriaNeedingWork },
  };
}
