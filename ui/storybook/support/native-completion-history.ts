import type { NativeCompletionHistoryEntry } from "@groktopus/shared";

const createdAt = "2026-05-01T12:00:00.000Z";

export const completionHistoryFixture: NativeCompletionHistoryEntry[] = [{
  id: "assessment-review",
  createdAt,
  runId: "run-review",
  contract: {
    id: "contract-review", revision: 2, policyVersion: "completion-policy-v2", risk: "standard",
    completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
    criteria: [{ id: "receipt", requirement: "Attach the reviewed test receipt" }],
    supersedesContractId: null,
  },
  result: { id: "result-review", disposition: "done", summary: "The implementation is ready for review.", schemaStatus: "accepted", createdAt },
  assessment: {
    id: "assessment-review", policyVersion: "arbiter-v1", triggerKind: "native_result",
    summary: "The artifact is available and the verification receipt is missing.",
    reportedDisposition: "done", allCriteriaSatisfied: false, verificationPassed: false,
    criterionAssessments: [{
      criterionId: "receipt", claimStatus: "satisfied", outcome: "missing", reasonCode: "criterion_evidence_missing",
      evidence: [
        { kind: "work_product", outcome: "accepted", visibility: "available", reasonCode: "work_product_authoritatively_accepted",
          label: "Work product: Reviewed implementation", title: "Reviewed implementation", recordId: "reviewed-implementation" },
        { kind: "approval", outcome: "unverifiable", visibility: "restricted", reasonCode: "evidence_access_restricted",
          label: "Supporting record is outside this task's readable scope." },
      ],
    }],
    verificationAssessments: [{
      commandOrCheck: "Run focused checks", claimStatus: "not_run", outcome: "missing",
      reasonCode: "verification_not_run", reportedReasonCode: "dependency_missing",
      detail: "The test fixture is unavailable.", evidence: null,
    }],
    priorDecisionId: null, supersedesAssessmentId: null,
  },
  decision: {
    id: "decision-review", applicationState: "proposed", fromStatus: "in_progress", toStatus: "in_progress",
    reasonCode: "completion_evidence_incomplete", statusAction: "in_progress", policyVersion: "arbiter-v1",
    supersedesDecisionId: null, createdAt, appliedAt: null,
  },
  lineageGaps: [],
}];
