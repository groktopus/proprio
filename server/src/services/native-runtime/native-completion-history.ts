import { and, desc, eq, ne, or } from "drizzle-orm";
import type { Db } from "@groktopus/db";
import {
  approvals,
  assets,
  caseHandoffs,
  completionContracts,
  heartbeatRunEvents,
  issueApprovals,
  issueAttachments,
  issueThreadInteractions,
  issueWorkProducts,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@groktopus/db";
import type {
  NativeCompletionCriterionAssessment,
  NativeCompletionEvidenceKind,
  NativeCompletionEvidenceOutcome,
  NativeCompletionEvidenceReference,
  NativeCompletionHistoryEntry,
  NativeCompletionVerificationAssessment,
} from "@groktopus/shared";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const uuid = (value: string) => {
  const match = /(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|\s|\()/i.exec(value);
  return match?.[1] ?? null;
};
const outcome = (value: unknown): NativeCompletionEvidenceOutcome =>
  value === "accepted" || value === "missing" || value === "rejected" || value === "unverifiable" ? value : "unverifiable";
const evidenceKind = (value: unknown): NativeCompletionEvidenceKind =>
  value === "event" || value === "work_product" || value === "approval" || value === "interaction"
    || value === "attachment" || value === "case_handoff" ? value : "unknown";

type EvidenceSource = { ref: string; kind: NativeCompletionEvidenceKind; outcome: NativeCompletionEvidenceOutcome;
  reasonCode: string; durableRecordId: string | null };

async function evidenceReference(db: Db, scope: { companyId: string; issueId: string; runId: string; readableCaseHandoffIds?: ReadonlySet<string> }, source: EvidenceSource): Promise<NativeCompletionEvidenceReference> {
  let recordId: string | null = null;
  let title: string | null = null;
  let existsInCompanyOtherScope = false;
  const parsed = source.kind === "event" ? null : uuid(source.ref);
  if (source.kind === "event") {
    const cursor = Number(/^event:(\d+)$/.exec(source.ref)?.[1]);
    if (Number.isSafeInteger(cursor) && cursor > 0) {
      const [row] = await db.select({ id: heartbeatRunEvents.id })
        .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.runId),
          or(eq(heartbeatRunEvents.seq, cursor), eq(heartbeatRunEvents.sourceSeq, cursor)))).limit(1);
      if (row) recordId = String(row.id);
      else {
        const [otherRun] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
          .where(and(eq(heartbeatRunEvents.companyId, scope.companyId), ne(heartbeatRunEvents.runId, scope.runId),
            or(eq(heartbeatRunEvents.seq, cursor), eq(heartbeatRunEvents.sourceSeq, cursor)))).limit(1);
        existsInCompanyOtherScope = Boolean(otherRun);
      }
    }
  } else if (parsed) {
    if (source.kind === "work_product") {
      const [row] = await db.select({ id: issueWorkProducts.id, issueId: issueWorkProducts.issueId, title: issueWorkProducts.title })
        .from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, scope.companyId), eq(issueWorkProducts.id, parsed))).limit(1);
      if (row?.issueId === scope.issueId) { recordId = row.id; title = row.title; }
      else if (row) existsInCompanyOtherScope = true;
    } else if (source.kind === "approval") {
      const [row] = await db.select({ id: approvals.id, kind: approvals.type })
        .from(issueApprovals).innerJoin(approvals, and(eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, scope.companyId)))
        .where(and(eq(issueApprovals.companyId, scope.companyId), eq(issueApprovals.issueId, scope.issueId), eq(issueApprovals.approvalId, parsed))).limit(1);
      if (row) { recordId = row.id; title = row.kind; }
      else {
        const [otherTask] = await db.select({ id: issueApprovals.approvalId }).from(issueApprovals)
          .where(and(eq(issueApprovals.companyId, scope.companyId), ne(issueApprovals.issueId, scope.issueId), eq(issueApprovals.approvalId, parsed))).limit(1);
        existsInCompanyOtherScope = Boolean(otherTask);
      }
    } else if (source.kind === "interaction") {
      const [row] = await db.select({ id: issueThreadInteractions.id, issueId: issueThreadInteractions.issueId, title: issueThreadInteractions.title })
        .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, scope.companyId), eq(issueThreadInteractions.id, parsed))).limit(1);
      if (row?.issueId === scope.issueId) { recordId = row.id; title = row.title; }
      else if (row) existsInCompanyOtherScope = true;
    } else if (source.kind === "attachment") {
      const [row] = await db.select({ id: issueAttachments.id, issueId: issueAttachments.issueId, filename: assets.originalFilename })
        .from(issueAttachments).innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, scope.companyId)))
        .where(and(eq(issueAttachments.companyId, scope.companyId), eq(issueAttachments.id, parsed))).limit(1);
      if (row?.issueId === scope.issueId) { recordId = row.id; title = row.filename; }
      else if (row) existsInCompanyOtherScope = true;
    } else if (source.kind === "case_handoff") {
      const [row] = await db.select({ id: caseHandoffs.id, issueId: caseHandoffs.issueId, phase: caseHandoffs.phase })
        .from(caseHandoffs).where(and(eq(caseHandoffs.companyId, scope.companyId), eq(caseHandoffs.id, parsed))).limit(1);
      if (row?.issueId === scope.issueId && scope.readableCaseHandoffIds?.has(row.id)) { recordId = row.id; title = row.phase; }
      else if (row?.issueId === scope.issueId) existsInCompanyOtherScope = true;
      else if (row) existsInCompanyOtherScope = true;
    }
  }

  if (recordId) {
    const prefix = source.kind === "work_product" ? "Work product" : source.kind === "approval" ? "Approval"
      : source.kind === "interaction" ? "Interaction" : source.kind === "attachment" ? "Attachment"
        : source.kind === "case_handoff" ? "Case handoff" : source.kind === "event" ? "Run event" : "Evidence";
    return { kind: source.kind, outcome: source.outcome, visibility: "available", reasonCode: source.reasonCode,
      label: title ? `${prefix}: ${title}` : prefix, recordId, ...(title ? { title } : {}) };
  }
  if (existsInCompanyOtherScope) {
    return { kind: source.kind, outcome: source.outcome, visibility: "restricted", reasonCode: source.reasonCode,
      label: "Supporting record is outside this task's readable scope." };
  }
  return { kind: source.kind, outcome: source.outcome,
    visibility: source.kind === "unknown" || source.outcome === "unverifiable" ? "unverifiable" : "missing",
    reasonCode: source.reasonCode,
    label: source.kind === "unknown" || source.outcome === "unverifiable" ? "Evidence reference could not be verified." : "Supporting record is missing." };
}

function evidenceSource(value: unknown): EvidenceSource | null {
  const row = record(value);
  const ref = text(row.ref);
  if (!ref) return null;
  return { ref, kind: evidenceKind(row.kind), outcome: outcome(row.outcome),
    reasonCode: text(row.reasonCode) ?? "evidence_status_unavailable", durableRecordId: text(row.durableRecordId) };
}

function criteria(contractJson: unknown) {
  const source = record(contractJson).criteria;
  if (!Array.isArray(source)) return [];
  return source.map((item, index) => {
    const row = record(item);
    return { id: text(row.id) ?? `criterion-${index + 1}`, requirement: text(row.requirement) ?? "Requirement text unavailable." };
  });
}

/** Read immutable native completion lineage for one already-authorized task. */
export async function readNativeCompletionHistory(db: Db, scope: { companyId: string; issueId: string; readableCaseHandoffIds?: ReadonlySet<string> }): Promise<NativeCompletionHistoryEntry[]> {
  const rows = await db.select({
    assessmentId: workAssessments.id,
    assessmentCreatedAt: workAssessments.createdAt,
    runId: workAssessments.runId,
    assessmentPolicyVersion: workAssessments.policyVersion,
    triggerKind: workAssessments.triggerKind,
    assessmentJson: workAssessments.assessmentJson,
    priorDecisionId: workAssessments.priorDecisionId,
    supersedesAssessmentId: workAssessments.supersedesAssessmentId,
    contractId: completionContracts.id,
    contractRevision: completionContracts.revision,
    contractPolicyVersion: completionContracts.policyVersion,
    contractRisk: completionContracts.risk,
    completionAuthority: completionContracts.completionAuthority,
    incompleteCriteriaPolicy: completionContracts.incompleteCriteriaPolicy,
    contractJson: completionContracts.contractJson,
    supersedesContractId: completionContracts.supersedesContractId,
    resultId: nativeRunResults.id,
    resultJson: nativeRunResults.resultJson,
    resultSchemaStatus: nativeRunResults.schemaStatus,
    resultCreatedAt: nativeRunResults.createdAt,
    decisionId: statusDecisions.id,
    decisionApplicationState: statusDecisions.applicationState,
    decisionFromStatus: statusDecisions.fromStatus,
    decisionToStatus: statusDecisions.toStatus,
    decisionReasonCode: statusDecisions.reasonCode,
    decisionJson: statusDecisions.decisionJson,
    decisionPolicyVersion: statusDecisions.policyVersion,
    supersedesDecisionId: statusDecisions.supersedesDecisionId,
    decisionCreatedAt: statusDecisions.createdAt,
    decisionAppliedAt: statusDecisions.appliedAt,
  }).from(workAssessments)
    .leftJoin(completionContracts, and(eq(completionContracts.companyId, workAssessments.companyId),
      eq(completionContracts.issueId, workAssessments.issueId), eq(completionContracts.id, workAssessments.contractId)))
    .leftJoin(nativeRunResults, and(eq(nativeRunResults.companyId, workAssessments.companyId),
      eq(nativeRunResults.issueId, workAssessments.issueId), eq(nativeRunResults.runId, workAssessments.runId),
      eq(nativeRunResults.id, workAssessments.resultId)))
    .leftJoin(statusDecisions, and(eq(statusDecisions.companyId, workAssessments.companyId),
      eq(statusDecisions.issueId, workAssessments.issueId), eq(statusDecisions.runId, workAssessments.runId),
      eq(statusDecisions.assessmentId, workAssessments.id)))
    .where(and(eq(workAssessments.companyId, scope.companyId), eq(workAssessments.issueId, scope.issueId),
      eq(workAssessments.triggerKind, "native_result")))
    .orderBy(desc(workAssessments.createdAt), desc(workAssessments.id));

  return Promise.all(rows.map(async (row) => {
    const assessmentJson = record(row.assessmentJson);
    const resultEnvelope = record(row.resultJson);
    const resultPayload = record(resultEnvelope.result);
    const criteriaRows = Array.isArray(assessmentJson.criterionAssessments) ? assessmentJson.criterionAssessments : [];
    const verificationRows = Array.isArray(assessmentJson.verificationAssessments) ? assessmentJson.verificationAssessments : [];
    const [criterionAssessments, verificationAssessments] = await Promise.all([
      Promise.all(criteriaRows.map(async (value): Promise<NativeCompletionCriterionAssessment> => {
        const item = record(value);
        const sources = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.map(evidenceSource).filter((entry): entry is EvidenceSource => !!entry) : [];
        return { criterionId: text(item.criterionId) ?? "unknown", claimStatus: item.claimStatus === "satisfied" || item.claimStatus === "not_satisfied" || item.claimStatus === "unknown" ? item.claimStatus : null,
          outcome: outcome(item.outcome), reasonCode: text(item.reasonCode) ?? "assessment_reason_unavailable",
          evidence: await Promise.all(sources.map((source) => evidenceReference(db, { ...scope, runId: row.runId }, source))) };
      })),
      Promise.all(verificationRows.map(async (value): Promise<NativeCompletionVerificationAssessment> => {
        const item = record(value);
        const source = evidenceSource(item.evidenceRef);
        return { commandOrCheck: text(item.commandOrCheck) ?? "Verification", claimStatus: item.claimStatus === "passed" || item.claimStatus === "failed" || item.claimStatus === "not_run" ? item.claimStatus : "not_run",
          outcome: outcome(item.outcome), reasonCode: text(item.reasonCode) ?? "verification_reason_unavailable", detail: text(item.detail),
          evidence: source ? await evidenceReference(db, { ...scope, runId: row.runId }, source) : null };
      })),
    ]);
    const gaps: NativeCompletionHistoryEntry["lineageGaps"] = [];
    if (!row.contractId) gaps.push("contract");
    if (!row.resultId) gaps.push("result");
    if (!row.decisionId) gaps.push("decision");
    const decisionJson = record(row.decisionJson);
    return {
      id: row.assessmentId,
      createdAt: row.assessmentCreatedAt.toISOString(),
      runId: row.runId,
      contract: row.contractId ? { id: row.contractId, revision: row.contractRevision ?? 0,
        policyVersion: row.contractPolicyVersion ?? "unknown", risk: row.contractRisk ?? "unknown",
        completionAuthority: row.completionAuthority ?? "unknown", incompleteCriteriaPolicy: row.incompleteCriteriaPolicy ?? "unknown",
        criteria: criteria(row.contractJson), supersedesContractId: row.supersedesContractId } : null,
      result: row.resultId ? { id: row.resultId, disposition: text(resultPayload.reportedWorkDisposition),
        summary: text(resultPayload.summary), schemaStatus: row.resultSchemaStatus ?? "unknown", createdAt: row.resultCreatedAt?.toISOString() ?? row.assessmentCreatedAt.toISOString() } : null,
      assessment: { id: row.assessmentId, policyVersion: row.assessmentPolicyVersion, triggerKind: row.triggerKind,
        summary: text(assessmentJson.summary), reportedDisposition: text(assessmentJson.reportedDisposition),
        allCriteriaSatisfied: typeof assessmentJson.allCriteriaSatisfied === "boolean" ? assessmentJson.allCriteriaSatisfied : null,
        verificationPassed: typeof assessmentJson.verificationPassed === "boolean" ? assessmentJson.verificationPassed : null,
        criterionAssessments, verificationAssessments, priorDecisionId: row.priorDecisionId, supersedesAssessmentId: row.supersedesAssessmentId },
      decision: row.decisionId ? { id: row.decisionId, applicationState: row.decisionApplicationState ?? "unknown",
        fromStatus: row.decisionFromStatus ?? "unknown", toStatus: row.decisionToStatus ?? "unknown",
        reasonCode: row.decisionReasonCode ?? "unknown", statusAction: text(decisionJson.statusAction),
        policyVersion: row.decisionPolicyVersion ?? "unknown", supersedesDecisionId: row.supersedesDecisionId,
        createdAt: row.decisionCreatedAt?.toISOString() ?? row.assessmentCreatedAt.toISOString(), appliedAt: row.decisionAppliedAt?.toISOString() ?? null } : null,
      lineageGaps: gaps,
    } satisfies NativeCompletionHistoryEntry;
  }));
}
