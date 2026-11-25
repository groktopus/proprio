import { and, eq } from "drizzle-orm";
import { completionContracts, documents, heartbeatRuns, issueDocuments, type caseHandoffs, type issues, type Db } from "@groktopus/db";
import type { CaseWorkflowTransition } from "@groktopus/shared";
import { HttpError, conflict } from "../errors.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { lockCompletionContractRevision } from "./native-runtime/completion-contracts.js";

type CaseHandoffRow = typeof caseHandoffs.$inferSelect;
type IssueRow = Pick<typeof issues.$inferSelect, "title" | "description">;
export class CaseHandoffRequirementsSuperseded extends HttpError {
  constructor(message: string) {
    super(409, message, { code: "case_handoff_requirements_superseded" });
  }
}

interface CaseHandoffRequirementSnapshot {
  taskTitle: string;
  taskDescription: string | null;
  phase: string;
  instructions: string;
  expectedDeliverable: string;
  prerequisites: string[];
  requirementRevision: { id: string; revision: number; canonicalSha256: string };
  workflowTransition: CaseWorkflowTransition | null;
  workflowPromptDigest: string | null;
}

/** Stable digest for recipient decisions and later corrective-revision binding. */
export function computeCaseHandoffRequirementsDigest(input: CaseHandoffRequirementSnapshot): string {
  return nativeSha256(input);
}

export async function assertOfferRequirementsCurrent(tx: Db, row: CaseHandoffRow, issue: IssueRow) {
  const offer = row.offerContract;
  if (!offer) return;
  const contractState = await lockCompletionContractRevision(tx, { companyId: row.companyId, issueId: row.issueId,
    contractId: offer.requirementRevision.id });
  if (contractState === "busy") {
    throw conflict("The offer's completion contract is being revised", {
      code: "case_handoff_admission_wait", reason: "completion_contract_busy",
    });
  }
  if (contractState === "superseded") throw new CaseHandoffRequirementsSuperseded("The offer's completion contract is no longer current");
  const [contract] = await tx.select({ revision: completionContracts.revision,
    canonicalSha256: completionContracts.canonicalSha256 }).from(completionContracts).where(and(
      eq(completionContracts.id, offer.requirementRevision.id), eq(completionContracts.companyId, row.companyId),
      eq(completionContracts.issueId, row.issueId),
    )).limit(1);
  const [sourceRun] = row.sourceRunId ? await tx.select({ runtimeMode: heartbeatRuns.runtimeMode,
    completionContractId: heartbeatRuns.completionContractId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, row.sourceRunId), eq(heartbeatRuns.companyId, row.companyId),
    )).limit(1) : [];
  if (!contract || !sourceRun || sourceRun.runtimeMode !== "native"
      || sourceRun.completionContractId !== offer.requirementRevision.id ||
      contract.revision !== offer.requirementRevision.revision || contract.canonicalSha256 !== offer.requirementRevision.canonicalSha256) {
    throw new CaseHandoffRequirementsSuperseded("Versioned offer requirement revision changed. Record a new offer.");
  }
  const [workflowDocument] = await tx.select({ latestRevisionId: documents.latestRevisionId }).from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId)).where(and(
      eq(issueDocuments.issueId, row.issueId), eq(issueDocuments.key, "workflow"), eq(documents.companyId, row.companyId),
    )).for("share", { of: documents });
  const expectedWorkflowRevision = row.assignmentAppliedAt
    ? row.workflowTransition?.documentRevisionId ?? null
    : row.baseWorkflowDocumentRevisionId;
  if ((workflowDocument?.latestRevisionId ?? null) !== expectedWorkflowRevision) {
    throw new CaseHandoffRequirementsSuperseded("Versioned offer workflow changed. Record a new offer.");
  }
  const digest = computeCaseHandoffRequirementsDigest({ taskTitle: issue.title, taskDescription: issue.description,
    phase: row.phase, instructions: row.instructions, expectedDeliverable: offer.expectedDeliverable,
    prerequisites: offer.prerequisites, requirementRevision: offer.requirementRevision,
    workflowTransition: row.workflowTransition && { ...row.workflowTransition, documentRevisionId: row.baseWorkflowDocumentRevisionId },
    workflowPromptDigest: row.workflowPrompt === null ? null : nativeSha256(row.workflowPrompt) });
  if (digest !== offer.requirementsDigest) throw new CaseHandoffRequirementsSuperseded("Versioned offer requirements changed. Record a new offer.");
}

/** Read the persisted recipient acceptance shared by admission and recovery. */
export function readAcceptedCaseHandoffOffer(row: CaseHandoffRow) {
  const offer = row.offerContract;
  const decision = row.recipientDecision;
  if (offer?.schema !== "proprio.case-handoff-offer.v1"
      || typeof offer.requirementsDigest !== "string" || !/^[0-9a-f]{64}$/.test(offer.requirementsDigest)
      || !offer.requirementRevision?.id
      || decision?.outcome !== "accepted"
      || decision.actorType !== "agent" || decision.actorId !== row.toAgentId
      || decision.handoffVersion !== row.version || decision.requirementRevisionId !== offer.requirementRevision.id
      || decision.requirementsDigest !== offer.requirementsDigest) return null;
  return offer;
}

export async function assertAcceptedOfferIsCurrent(tx: Db, row: CaseHandoffRow, issue: IssueRow) {
  if (!row.offerContract) return;
  if (!readAcceptedCaseHandoffOffer(row)) throw conflict("The recipient must accept the current handoff offer.");
  await assertOfferRequirementsCurrent(tx, row, issue);
}
