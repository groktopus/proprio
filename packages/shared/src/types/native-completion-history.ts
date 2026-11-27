import { z } from "zod";

/** A safe, task-scoped projection of the immutable native completion lineage. */
export const nativeCompletionEvidenceKindSchema = z.enum(["event", "work_product", "approval", "interaction", "attachment", "case_handoff", "unknown"]);
export const nativeCompletionEvidenceOutcomeSchema = z.enum(["accepted", "missing", "rejected", "unverifiable"]);
const nativeCompletionEvidenceSchema = z.object({
  kind: nativeCompletionEvidenceKindSchema,
  outcome: nativeCompletionEvidenceOutcomeSchema,
  visibility: z.enum(["available", "restricted", "missing", "unverifiable"]),
  reasonCode: z.string(),
  label: z.string(),
  recordId: z.string().optional(),
  title: z.string().optional(),
});
export const nativeCompletionHistorySchema = z.array(z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  runId: z.string(),
  contract: z.object({
    id: z.string(), revision: z.number(), policyVersion: z.string(), risk: z.string(), completionAuthority: z.string(),
    incompleteCriteriaPolicy: z.string(), criteria: z.array(z.object({ id: z.string(), requirement: z.string() })),
    supersedesContractId: z.string().nullable(),
  }).nullable(),
  result: z.object({ id: z.string(), disposition: z.string().nullable(), summary: z.string().nullable(), schemaStatus: z.string(), createdAt: z.string().datetime() }).nullable(),
  assessment: z.object({
    id: z.string(), policyVersion: z.string(), triggerKind: z.string(), summary: z.string().nullable(), reportedDisposition: z.string().nullable(),
    allCriteriaSatisfied: z.boolean().nullable(), verificationPassed: z.boolean().nullable(),
    criterionAssessments: z.array(z.object({ criterionId: z.string(), claimStatus: z.literal(["satisfied", "not_satisfied", "unknown", null]).nullable(),
      outcome: nativeCompletionEvidenceOutcomeSchema, reasonCode: z.string(), evidence: z.array(nativeCompletionEvidenceSchema) })),
    verificationAssessments: z.array(z.object({ commandOrCheck: z.string(), claimStatus: z.enum(["passed", "failed", "not_run"]),
      outcome: nativeCompletionEvidenceOutcomeSchema, reasonCode: z.string(), reportedReasonCode: z.string().nullable(), detail: z.string().nullable(), evidence: nativeCompletionEvidenceSchema.nullable() })),
    priorDecisionId: z.string().nullable(), supersedesAssessmentId: z.string().nullable(),
  }).nullable(),
  decision: z.object({ id: z.string(), applicationState: z.string(), fromStatus: z.string(), toStatus: z.string(), reasonCode: z.string(),
    statusAction: z.string().nullable(), policyVersion: z.string(), supersedesDecisionId: z.string().nullable(),
    createdAt: z.string().datetime(), appliedAt: z.string().datetime().nullable() }).nullable(),
  lineageGaps: z.array(z.enum(["contract", "result", "decision"])),
}));

export type NativeCompletionEvidenceKind = z.infer<typeof nativeCompletionEvidenceKindSchema>;
export type NativeCompletionEvidenceOutcome = z.infer<typeof nativeCompletionEvidenceOutcomeSchema>;
export type NativeCompletionEvidenceReference = z.infer<typeof nativeCompletionEvidenceSchema>;
export type NativeCompletionHistoryEntry = z.infer<typeof nativeCompletionHistorySchema>[number];
type NativeCompletionAssessment = NonNullable<NativeCompletionHistoryEntry["assessment"]>;
export type NativeCompletionCriterionAssessment = NativeCompletionAssessment["criterionAssessments"][number];
export type NativeCompletionVerificationAssessment = NativeCompletionAssessment["verificationAssessments"][number];
