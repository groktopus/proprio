import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import type { Db } from "@groktopus/db";
import {
  approvals,
  assets,
  caseHandoffs,
  completionContracts,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueAttachments,
  issueThreadInteractions,
  issueWorkProducts,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@groktopus/db";
import {
  nativeCompletionEvidenceKindSchema,
  nativeCompletionEvidenceOutcomeSchema,
  type NativeCompletionCriterionAssessment,
  type NativeCompletionEvidenceKind,
  type NativeCompletionEvidenceOutcome,
  type NativeCompletionEvidenceReference,
  type NativeCompletionHistoryEntry,
  type NativeCompletionVerificationAssessment,
} from "@groktopus/shared";

import { redactSensitiveText } from "../../redaction.js";
import { authorizationService, canActorReadApproval, type AuthorizationActor } from "../authorization.js";
import { readableCaseHandoffIds } from "../case-access.js";
import { getHeartbeatRunReadDecisions } from "../heartbeat-run-privacy.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";

import { record, text } from "./evidence-json.js";

const uuid = (value: string) => {
  const match = /(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=$|\s|\()/i.exec(value);
  return match?.[1] ?? null;
};
const outcome = (value: unknown): NativeCompletionEvidenceOutcome =>
  nativeCompletionEvidenceOutcomeSchema.safeParse(value).data ?? "unverifiable";
const evidenceKind = (value: unknown): NativeCompletionEvidenceKind =>
  nativeCompletionEvidenceKindSchema.safeParse(value).data ?? "unknown";

type EvidenceSource = { ref: string; kind: NativeCompletionEvidenceKind; outcome: NativeCompletionEvidenceOutcome;
  reasonCode: string; durableRecordId: string | null };

type CompletionHistoryScope = { companyId: string; issueId: string; actor: AuthorizationActor };
type EvidenceReadScope = CompletionHistoryScope & {
  runId: string;
  readableHandoffs: ReadonlySet<string>;
  unavailableCitationIds: Set<string>;
};

async function evidenceReference(db: Db, scope: EvidenceReadScope, source: EvidenceSource): Promise<NativeCompletionEvidenceReference> {
  let recordId: string | null = null;
  let title: string | null = null;
  let existsInCompanyOtherScope = false;
  const parsed = source.kind === "event" ? null : uuid(source.ref);
  if (source.kind === "event") {
    const cursor = Number(/^event:(\d+)$/.exec(source.ref)?.[1]);
    const eventId = Number(/^\d+$/.exec(source.durableRecordId ?? "")?.[0]);
    const eventScope = and(eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.runId));
    if (Number.isSafeInteger(eventId) && eventId > 0) {
      const [row] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
        .where(and(eventScope, eq(heartbeatRunEvents.id, eventId))).limit(1);
      if (row) recordId = String(row.id);
    } else if (!source.durableRecordId && source.outcome !== "missing" && Number.isSafeInteger(cursor) && cursor > 0) {
      // Older assessments may only have a run-local cursor. Resolve it only
      // when it identifies exactly one event within the assessment's run.
      const rows = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
        .where(and(eventScope, or(eq(heartbeatRunEvents.seq, cursor), eq(heartbeatRunEvents.sourceSeq, cursor)))).limit(2);
      if (rows.length === 1) recordId = String(rows[0]!.id);
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
      if (row) {
        if (await canActorReadApproval(db, scope.actor, row.id)) { recordId = row.id; title = row.kind; }
        else existsInCompanyOtherScope = true;
      } else {
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
      const [row] = await db.select({ id: caseHandoffs.id, issueId: caseHandoffs.issueId,
        phase: caseHandoffs.phase, sourceRunId: caseHandoffs.sourceRunId })
        .from(caseHandoffs).where(and(eq(caseHandoffs.companyId, scope.companyId), eq(caseHandoffs.id, parsed))).limit(1);
      if (row?.issueId === scope.issueId && row.sourceRunId === scope.runId && scope.readableHandoffs.has(row.id)) {
        recordId = row.id;
        title = row.phase;
      } else if (row) existsInCompanyOtherScope = true;
    }
  }

  if (recordId) {
    const prefix = source.kind === "work_product" ? "Work product" : source.kind === "approval" ? "Approval"
      : source.kind === "interaction" ? "Interaction" : source.kind === "attachment" ? "Attachment"
        : source.kind === "case_handoff" ? "Case handoff" : source.kind === "event" ? "Run event" : "Evidence";
    return { kind: source.kind, outcome: source.outcome, visibility: "available", reasonCode: source.reasonCode,
      label: title ? `${prefix}: ${title}` : prefix, recordId, ...(title ? { title } : {}) };
  }
  if (parsed) scope.unavailableCitationIds.add(parsed.toLowerCase());
  if (existsInCompanyOtherScope) {
    return { kind: source.kind, outcome: "unverifiable", visibility: "restricted", reasonCode: "evidence_access_restricted",
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
export async function readNativeCompletionHistory(db: Db, scope: CompletionHistoryScope): Promise<NativeCompletionHistoryEntry[]> {
  const rows = await db.select({
    assessmentId: workAssessments.id,
    assessmentCreatedAt: workAssessments.createdAt,
    runId: workAssessments.runId,
    runScopeKind: heartbeatRuns.scopeKind,
    runIssueId: heartbeatRuns.issueId,
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
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, workAssessments.companyId), eq(heartbeatRuns.id, workAssessments.runId)))
    .leftJoin(completionContracts, and(eq(completionContracts.companyId, workAssessments.companyId),
      eq(completionContracts.issueId, workAssessments.issueId), eq(completionContracts.id, workAssessments.contractId)))
    .leftJoin(nativeRunResults, and(eq(nativeRunResults.companyId, workAssessments.companyId),
      eq(nativeRunResults.issueId, workAssessments.issueId), eq(nativeRunResults.runId, workAssessments.runId),
      eq(nativeRunResults.id, workAssessments.resultId)))
    .leftJoin(statusDecisions, and(eq(statusDecisions.companyId, workAssessments.companyId),
      eq(statusDecisions.issueId, workAssessments.issueId), eq(statusDecisions.runId, workAssessments.runId),
      eq(statusDecisions.assessmentId, workAssessments.id)))
    .where(and(eq(workAssessments.companyId, scope.companyId), eq(workAssessments.issueId, scope.issueId),
      inArray(workAssessments.triggerKind, ["native_result", "native_attention"])))
    .orderBy(desc(workAssessments.createdAt), desc(workAssessments.id));

  const runReadDecisions = await getHeartbeatRunReadDecisions(db, authorizationService(db), scope.actor,
    rows.map(row => ({ companyId: scope.companyId, scopeKind: row.runScopeKind, issueId: row.runIssueId })));
  const assessments = rows.filter((_, index) => runReadDecisions[index]).map(row => {
    const assessmentJson = record(row.assessmentJson);
    const criteriaRows = Array.isArray(assessmentJson.criterionAssessments) ? assessmentJson.criterionAssessments : [];
    const verificationRows = Array.isArray(assessmentJson.verificationAssessments) ? assessmentJson.verificationAssessments : [];
    return { row, assessmentJson, criteriaRows, verificationRows };
  });
  const citedHandoffIds = new Set<string>();
  for (const { criteriaRows, verificationRows } of assessments) {
    const citations = [
      ...criteriaRows.flatMap(value => Array.isArray(record(value).evidenceRefs) ? record(value).evidenceRefs as unknown[] : []),
      ...verificationRows.map(value => record(value).evidenceRef),
    ];
    for (const citation of citations) {
      const source = evidenceSource(citation);
      const id = source?.kind === "case_handoff" ? uuid(source.ref) : null;
      if (id) citedHandoffIds.add(id.toLowerCase());
    }
  }
  const readableHandoffs = await readableCaseHandoffIds(db, scope.actor, { ...scope, handoffIds: [...citedHandoffIds] });
  const unavailableCitationIds = new Set<string>();
  const history = await Promise.all(assessments.map(async ({ row, assessmentJson, criteriaRows, verificationRows }) => {
    const evidenceScope = { ...scope, runId: row.runId, readableHandoffs, unavailableCitationIds };
    const resultEnvelope = record(row.resultJson);
    const resultPayload = record(resultEnvelope.result);
    const [criterionAssessments, verificationAssessments] = await Promise.all([
      Promise.all(criteriaRows.map(async (value): Promise<NativeCompletionCriterionAssessment> => {
        const item = record(value);
        const sources = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.map(evidenceSource).filter((entry): entry is EvidenceSource => !!entry) : [];
        return { criterionId: text(item.criterionId) ?? "unknown", claimStatus: item.claimStatus === "satisfied" || item.claimStatus === "not_satisfied" || item.claimStatus === "unknown" ? item.claimStatus : null,
          outcome: outcome(item.outcome), reasonCode: text(item.reasonCode) ?? "assessment_reason_unavailable",
          evidence: await Promise.all(sources.map((source) => evidenceReference(db, evidenceScope, source))) };
      })),
      Promise.all(verificationRows.map(async (value): Promise<NativeCompletionVerificationAssessment> => {
        const item = record(value);
        const source = evidenceSource(item.evidenceRef);
        return { commandOrCheck: text(item.commandOrCheck) ?? "Verification", claimStatus: item.claimStatus === "passed" || item.claimStatus === "failed" || item.claimStatus === "not_run" ? item.claimStatus : "not_run",
          outcome: outcome(item.outcome), reasonCode: text(item.reasonCode) ?? "verification_reason_unavailable",
          reportedReasonCode: text(item.reportedReasonCode), detail: text(item.detail),
          evidence: source ? await evidenceReference(db, evidenceScope, source) : null };
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
  const cleanText = (value: string): string => redactSensitiveText(value).replace(
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi,
    identifier => unavailableCitationIds.has(identifier.toLowerCase()) ? "[REDACTED]" : identifier,
  );
  const redactProjection = (value: unknown): unknown => {
    if (typeof value === "string") return cleanText(value);
    if (Array.isArray(value)) return value.map(redactProjection);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactProjection(item)]));
    }
    return value;
  };
  const redactions = createRunSecretRedactionRegistry(db);
  return (await redactions.redactForRuns(scope.companyId,
    history.map(entry => ({ id: entry.runId, entry: redactProjection(entry) as NativeCompletionHistoryEntry })),
    scope.actor.type === "board" ? scope.actor.userId ?? null : null,
  )).map(({ entry }) => entry);
}
