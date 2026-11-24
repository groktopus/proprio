/** A safe, task-scoped projection of the immutable native completion lineage. */
export type NativeCompletionEvidenceOutcome = "accepted" | "missing" | "rejected" | "unverifiable";
export type NativeCompletionEvidenceVisibility = "available" | "restricted" | "missing" | "unverifiable";
export type NativeCompletionEvidenceKind =
  | "event"
  | "work_product"
  | "approval"
  | "interaction"
  | "attachment"
  | "case_handoff"
  | "unknown";

export interface NativeCompletionEvidenceReference {
  kind: NativeCompletionEvidenceKind;
  outcome: NativeCompletionEvidenceOutcome;
  visibility: NativeCompletionEvidenceVisibility;
  reasonCode: string;
  /** Human-readable, sanitized label. Raw model-authored refs are never returned. */
  label: string;
  /** Present only when the referenced record is readable in this task's scope. */
  recordId?: string;
  title?: string;
}

export interface NativeCompletionCriterion {
  id: string;
  requirement: string;
}

export interface NativeCompletionCriterionAssessment {
  criterionId: string;
  claimStatus: "satisfied" | "not_satisfied" | "unknown" | null;
  outcome: NativeCompletionEvidenceOutcome;
  reasonCode: string;
  evidence: NativeCompletionEvidenceReference[];
}

export interface NativeCompletionVerificationAssessment {
  commandOrCheck: string;
  claimStatus: "passed" | "failed" | "not_run";
  outcome: NativeCompletionEvidenceOutcome;
  reasonCode: string;
  detail: string | null;
  evidence: NativeCompletionEvidenceReference | null;
}

export interface NativeCompletionHistoryEntry {
  id: string;
  createdAt: string;
  runId: string;
  contract: {
    id: string;
    revision: number;
    policyVersion: string;
    risk: string;
    completionAuthority: string;
    incompleteCriteriaPolicy: string;
    criteria: NativeCompletionCriterion[];
    supersedesContractId: string | null;
  } | null;
  result: {
    id: string;
    disposition: string | null;
    summary: string | null;
    schemaStatus: string;
    createdAt: string;
  } | null;
  assessment: {
    id: string;
    policyVersion: string;
    triggerKind: string;
    summary: string | null;
    reportedDisposition: string | null;
    allCriteriaSatisfied: boolean | null;
    verificationPassed: boolean | null;
    criterionAssessments: NativeCompletionCriterionAssessment[];
    verificationAssessments: NativeCompletionVerificationAssessment[];
    priorDecisionId: string | null;
    supersedesAssessmentId: string | null;
  } | null;
  decision: {
    id: string;
    applicationState: string;
    fromStatus: string;
    toStatus: string;
    reasonCode: string;
    statusAction: string | null;
    policyVersion: string;
    supersedesDecisionId: string | null;
    createdAt: string;
    appliedAt: string | null;
  } | null;
  /** Names of missing links in a partially saved or older lineage. */
  lineageGaps: Array<"contract" | "result" | "decision">;
}
