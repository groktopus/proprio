import { z } from "zod";
import { issueDocumentKeySchema, issueRecoveryActionReadModelSchema, upsertIssueDocumentSchema } from "./validators/issue.js";

/** Preserve the author's workflow text; blank text cannot define a workflow. */
export const caseWorkflowDocumentTextSchema = z.string().min(1).max(200_000).regex(/\S/, "Workflow document text must not be blank")
  .describe("Workflow Markdown. Recommend both a fenced Mermaid stateDiagram-v2 map and prose explaining every transition: its trigger or condition, required evidence or outputs, destination agent, human wait/resume rules, and bounded correction or escalation behavior. Match diagram state IDs to phase names and define named transition outcomes in prose. Stored verbatim as the task's workflow document; diagram labels are advisory, not executable guards.");

/** Kickoff inputs become ordinary documents on the newly created primary task. */
export const caseInitialDocumentSchema = z.object({
  key: z.preprocess((value) => typeof value === "string" ? value.trim().toLowerCase() : value, issueDocumentKeySchema
    .refine(key => key !== "workflow", "The workflow document key is reserved; use workflow_document_text")),
  title: z.string().trim().min(1).max(200),
  body: upsertIssueDocumentSchema.shape.body,
}).strict();
export const caseInitialDocumentsSchema = z.array(caseInitialDocumentSchema).max(20).superRefine((documents, ctx) => {
  const keys = new Set<string>();
  let bodyCharacters = 0;
  for (const [index, document] of documents.entries()) {
    if (keys.has(document.key)) ctx.addIssue({ code: "custom", path: [index, "key"], message: "Document keys must be unique after normalization" });
    keys.add(document.key);
    bodyCharacters += document.body.length;
  }
  if (bodyCharacters > 200_000) ctx.addIssue({ code: "custom", message: "Initial document bodies must total at most 200000 characters" });
});
export type CaseInitialDocument = z.infer<typeof caseInitialDocumentSchema>;

export const CASE_HANDOFF_STATES = ["offered", "awaiting_release", "pending_dispatch", "delivered", "awaiting_completion", "completed", "cancelled"] as const;
export type CaseHandoffState = typeof CASE_HANDOFF_STATES[number];
export type CaseHandoffDestinationKind = "agent" | "done";

const wellFormedHandoffText = (value: string) => !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value);
const handoffReceiptText = (maxLength: number) => z.string().trim().min(1).max(maxLength)
  .refine(wellFormedHandoffText, "Text must use valid Unicode and contain no NUL characters");
const handoffOfferText = (maxLength: number) => z.string().min(1)
  .refine(value => [...value].length <= maxLength, `Text must contain at most ${maxLength} Unicode characters`)
  .refine(wellFormedHandoffText, "Text must use valid Unicode and contain no NUL characters")
  .pipe(z.string().trim().min(1));
const caseHandoffOfferSchema = z.object({
  expectedDeliverable: handoffOfferText(8_000),
  prerequisites: z.array(handoffOfferText(2_000)).max(20).default([]),
}).strict();
type CaseHandoffOfferInput = z.infer<typeof caseHandoffOfferSchema>;
export interface CaseHandoffOfferContract extends CaseHandoffOfferInput {
  schema: "proprio.case-handoff-offer.v1";
  requirementRevision: { id: string; revision: number; canonicalSha256: string };
  requirementsDigest: string;
  taskBrief: { title: string; description: string | null };
}

export interface CaseHandoffRecipientDecision {
  outcome: "accepted" | "clarification" | "declined";
  actorType: "agent";
  actorId: string;
  handoffVersion: number;
  requirementRevisionId: string;
  requirementsDigest: string;
  decidedAt: string;
  reasonCode?: string;
  message?: string;
}

export const caseHandoffRecoveryHistorySchema = z.object({
  entries: z.array(issueRecoveryActionReadModelSchema.pick({
    id: true, status: true, ownerType: true, ownerAgentId: true, ownerUserId: true, nextAction: true,
    attemptCount: true, maxAttempts: true, outcome: true, resolutionNote: true,
  }).extend({
    assessedRevision: z.number().int().positive(),
    criteria: z.array(z.object({
      criterionId: z.string(),
      requirement: z.string().nullable(),
      outcome: z.string().nullable(),
      reasonCode: z.string().nullable(),
      evidence: z.array(z.object({ outcome: z.string().nullable(), reasonCode: z.string().nullable() })),
    })),
    attempts: z.array(z.object({
      runId: z.string().uuid(),
      decisionId: z.string().uuid(),
      reasonCode: z.string(),
    })),
  })),
});
export type CaseHandoffRecoveryHistory = z.infer<typeof caseHandoffRecoveryHistorySchema>;

export const agentCaseHandoffSchema = z.object({
  to: z.never().optional(),
  idempotencyKey: z.string().trim().min(1).max(240),
  case: z.union([
    z.object({ id: z.string().guid() }).strict(),
    z.object({ create: z.object({
      caseType: z.string().trim().min(1).max(120),
      title: z.string().trim().min(1).max(500),
      summary: z.string().max(8_000).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      projectId: z.string().guid().nullable().optional(),
    }).strict() }).strict(),
  ]),
  toAgentId: z.string().guid(),
  phase: z.string().trim().min(1).max(120),
  instructions: z.string().min(1).max(20_000),
  expectedHandoffVersion: z.number().int().nonnegative().optional(),
  expectedIssueStatusVersion: z.number().int().nonnegative().optional(),
  bindIssueId: z.string().guid().optional(),
  initialDocuments: caseInitialDocumentsSchema.optional(),
  workflow_document_text: caseWorkflowDocumentTextSchema.optional(),
  workflowId: z.string().guid().nullable().optional(),
  offer: caseHandoffOfferSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if ("id" in input.case && input.expectedHandoffVersion === undefined) {
    ctx.addIssue({ code: "custom", path: ["expectedHandoffVersion"], message: "Required for an existing case" });
  }
  if (input.offer && "create" in input.case && !input.bindIssueId) {
    ctx.addIssue({ code: "custom", path: ["bindIssueId"], message: "An offer must reuse the source run's task" });
  }
  if (input.bindIssueId && input.expectedIssueStatusVersion === undefined) {
    ctx.addIssue({ code: "custom", path: ["expectedIssueStatusVersion"], message: "Required when binding an existing task" });
  }
  if (input.bindIssueId && input.initialDocuments?.length) {
    ctx.addIssue({ code: "custom", path: ["initialDocuments"], message: "Initial documents require a newly created primary task" });
  }
  if (input.workflowId !== undefined && input.workflow_document_text !== undefined) {
    ctx.addIssue({ code: "custom", path: ["workflowId"], message: "Provide workflowId or workflow_document_text, not both" });
  }
  if ("create" in input.case && input.workflow_document_text === undefined && !input.workflowId) {
    ctx.addIssue({ code: "custom", path: ["workflow_document_text"], message: "Required when creating a case" });
  }
  if ("id" in input.case && input.bindIssueId && input.workflow_document_text !== undefined) {
    ctx.addIssue({ code: "custom", path: ["workflow_document_text"], message: "Workflow text cannot be supplied when binding an existing case to a task" });
  }
  const totalBodyCharacters = (input.workflow_document_text?.length ?? 0)
    + (input.initialDocuments ?? []).reduce((total, document) => total + document.body.length, 0);
  if (totalBodyCharacters > 200_000) {
    ctx.addIssue({ code: "custom", path: ["initialDocuments"], message: "Workflow and initial document bodies must total at most 200000 characters" });
  }
});
export const doneCaseHandoffSchema = z.object({
  to: z.literal("done"),
  idempotencyKey: z.string().trim().min(1).max(240),
  case: z.object({ id: z.string().guid() }).strict(),
  phase: z.literal("done").default("done"),
  instructions: z.string().min(1).max(20_000),
  expectedHandoffVersion: z.number().int().nonnegative(),
  expectedIssueStatusVersion: z.number().int().nonnegative(),
}).strict();
export const handoffCaseSchema = z.union([agentCaseHandoffSchema, doneCaseHandoffSchema]);
export type AgentCaseHandoffInput = z.infer<typeof agentCaseHandoffSchema>;
export type DoneCaseHandoffInput = z.infer<typeof doneCaseHandoffSchema>;
export type HandoffCaseInput = z.input<typeof handoffCaseSchema>;

const decisionTarget = {
  expectedHandoffVersion: z.number().int().positive(),
  requirementRevisionId: z.string().guid().toLowerCase(),
};
const decisionMessage = { message: handoffReceiptText(4_000) };

export const caseHandoffRecipientDecisionSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...decisionTarget,
    outcome: z.literal("accepted"),
  }).strict(),
  z.object({
    ...decisionTarget,
    outcome: z.literal("clarification"),
    reasonCode: z.enum(["missing_prerequisite", "unclear_requirements", "missing_evidence", "other"]),
    ...decisionMessage,
  }).strict(),
  z.object({
    ...decisionTarget,
    outcome: z.literal("declined"),
    reasonCode: z.enum(["unavailable", "missing_capability", "outside_scope", "other"]),
    ...decisionMessage,
  }).strict(),
]);
export type CaseHandoffRecipientDecisionInput = z.infer<typeof caseHandoffRecipientDecisionSchema>;

export const caseHandoffWithdrawalSchema = z.object({
  expectedHandoffVersion: decisionTarget.expectedHandoffVersion,
  stoppedRunId: z.string().guid(),
}).strict();
export type CaseHandoffWithdrawalInput = z.infer<typeof caseHandoffWithdrawalSchema>;

export type HandoffCaseResult = {
  handoffId: string;
  caseId: string;
  taskId: string;
  taskIdentifier: string;
  handoffVersion: number;
  destinationKind: CaseHandoffDestinationKind;
  state: CaseHandoffState;
  completedAt: Date | string | null;
  callerMustYield: boolean;
  replayed: boolean;
};
export interface CaseHandoff {
  workflowTransition: CaseWorkflowTransition | null;
  id: string;
  companyId: string;
  caseId: string;
  issueId: string;
  version: number;
  fromAgentId: string | null;
  destinationKind: CaseHandoffDestinationKind;
  toAgentId: string | null;
  phase: string;
  instructions: string;
  commentId: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string;
  sourceRunId: string | null;
  responsibleUserId: string | null;
  expectedIssueStatusVersion: number | null;
  appliedIssueStatusVersion: number | null;
  wakeupRequestId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  offerContract: CaseHandoffOfferContract | null;
  recipientDecision: CaseHandoffRecipientDecision | null;
  state: CaseHandoffState;
  attemptCount: number;
  nextAttemptAt: Date | string;
  leaseExpiresAt: Date | string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAt: Date | string;
  assignmentAppliedAt: Date | string | null;
  deliveredAt: Date | string | null;
  completedAt: Date | string | null;
  cancelledAt: Date | string | null;
  updatedAt: Date | string;
}

export interface CaseWorkflowTransition {
  from: { workflowId: string | null; name: string | null; phase: string | null };
  to: { workflowId: string | null; name: string | null; phase: string };
  documentRevisionId: string | null;
}
