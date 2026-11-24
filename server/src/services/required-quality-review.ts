import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { assets, documents, issueAttachments, issueDocuments, issueThreadInteractions, type Db } from "@groktopus/db";
import { requiredQualityReviewSchema, type IssueExecutionReviewTargetBinding, type IssueExecutionReviewTargetReference, type RequiredQualityReview, type RequestConfirmationTarget, type QualityReviewBinding } from "@groktopus/shared";
import { forbidden, unprocessable } from "../errors.js";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Opt-in only. Reviewer eligibility (reviewPolicy) is deliberately a separate rule. */
export function requiredQualityReview(policy: unknown): RequiredQualityReview | null {
  const value = record(policy).requiredQualityReview;
  return value == null ? null : requiredQualityReviewSchema.parse(value);
}

export function qualityReviewRequirementHash(requirement: RequiredQualityReview): string {
  return createHash("sha256").update(JSON.stringify({ version: requirement.version,
    deliverables: [...requirement.deliverables].sort((a, b) => a.key.localeCompare(b.key)) })).digest("hex");
}

/** Agents may add a requirement, but only an authenticated human may change/remove an accepted one. */
export function assertQualityReviewPolicyMutation(input: {
  previousPolicy: unknown; nextPolicy: unknown; actorUserId?: string | null; actorAgentId?: string | null;
}) {
  const previous = requiredQualityReview(input.previousPolicy);
  if (!previous) return;
  const next = requiredQualityReview(input.nextPolicy);
  if (next && qualityReviewRequirementHash(previous) === qualityReviewRequirementHash(next)) return;
  if (input.actorUserId && !input.actorAgentId) return;
  throw forbidden("Only a human may change the required quality review", { code: "required_quality_review_policy_protected" });
}

/** An idempotent/deduplicated create must not silently discard the requested gate. */
export function assertQualityReviewPolicyReuse(requestedPolicy: unknown, existingPolicy: unknown) {
  const requested = requiredQualityReview(requestedPolicy);
  if (!requested) return;
  const existing = requiredQualityReview(existingPolicy);
  if (!existing || qualityReviewRequirementHash(requested) !== qualityReviewRequirementHash(existing)) {
    throw unprocessable("Existing task has a different required quality review", { code: "required_quality_review_mismatch" });
  }
}

export function bindQualityReview(requirement: RequiredQualityReview | null, binding: QualityReviewBinding,
  target: RequestConfirmationTarget | null | undefined, issueId: string): QualityReviewBinding {
  if (!requirement?.deliverables.some(item => item.key === binding.key))
    throw unprocessable("Quality review must name a required deliverable on this task");
  if (!target || !["issue_document", "issue_attachment"].includes(target.type) ||
      (target.type === "issue_document" && target.key === "plan") ||
      (target.type !== "custom" && target.issueId && target.issueId !== issueId))
    throw unprocessable("Quality review requires an exact output document revision or attachment on this task, not a plan or custom target");
  return { key: binding.key, requirementHash: qualityReviewRequirementHash(requirement) };
}

export async function currentQualityReviewTarget(db: Db, companyId: string, issueId: string, target: unknown, lock = false): Promise<boolean> {
  const value = record(target);
  if (value.issueId && value.issueId !== issueId) return false;
  if (value.type === "issue_document" && typeof value.key === "string" && value.key !== "plan") {
    let query = db.select({ revisionId: documents.latestRevisionId }).from(issueDocuments)
      .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, companyId)))
      .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, value.key))).limit(1);
    const [row] = await (lock ? query.for("update", { of: documents }) : query);
    return Boolean(row && row.revisionId === value.revisionId);
  }
  if (value.type === "issue_attachment" && typeof value.attachmentId === "string") {
    const query = db.select({ assetId: assets.id, sha256: assets.sha256 }).from(issueAttachments)
      .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, companyId)))
      .where(and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.issueId, issueId), eq(issueAttachments.id, value.attachmentId))).limit(1);
    const [row] = await (lock ? query.for("update", { of: [issueAttachments, assets] }) : query);
    return Boolean(row && row.assetId === value.assetId && row.sha256 === value.sha256);
  }
  return false;
}

/**
 * Capture the exact required output targets for an opt-in execution-stage signoff.
 * This prepares immutable evidence only; callers must validate it again under the
 * transaction that admits the signoff.
 */
export async function captureRequiredQualityReviewBinding(db: Db,
  issue: { id: string; companyId: string; executionPolicy?: unknown }, lock = false): Promise<IssueExecutionReviewTargetBinding | null> {
  const policy = record(issue.executionPolicy);
  if (record(policy.reviewTargetBinding).source !== "required_quality_review") return null;
  const requirement = requiredQualityReview(issue.executionPolicy);
  if (!requirement) return null;
  const requirementHash = qualityReviewRequirementHash(requirement);
  const deliverables: IssueExecutionReviewTargetBinding["deliverables"] = [];
  for (const slot of requirement.deliverables) {
    const interactionQuery = db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
      sql`((${issueThreadInteractions.kind} = 'request_confirmation' AND ${issueThreadInteractions.payload}->'qualityReview'->>'key' = ${slot.key}) OR
        (${issueThreadInteractions.kind} = 'request_item_verdicts' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${issueThreadInteractions.payload}->'items') item WHERE item->'qualityReview'->>'key' = ${slot.key})))`,
    )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(1);
    const [row] = await (lock ? interactionQuery.for("update") : interactionQuery);
    if (!row) return null;
    const payload = record(row.payload);
    const matching = row.kind === "request_item_verdicts"
      ? (Array.isArray(payload.items) ? payload.items : []).filter((item: any) => item.qualityReview?.key === slot.key)
      : [payload];
    if (matching.length !== 1) return null;
    const item = record(matching[0]);
    const qualityBinding = record(item.qualityReview);
    const target = record(item.target);
    if (qualityBinding.requirementHash !== requirementHash ||
        !["issue_document", "issue_attachment"].includes(String(target.type)) ||
        !await currentQualityReviewTarget(db, issue.companyId, issue.id, target, lock)) return null;
    const targetReference: IssueExecutionReviewTargetReference = target.type === "issue_document"
      ? { type: "issue_document", ...(typeof target.issueId === "string" ? { issueId: target.issueId } : {}),
        key: String(target.key), revisionId: String(target.revisionId) }
      : { type: "issue_attachment", ...(typeof target.issueId === "string" ? { issueId: target.issueId } : {}),
        attachmentId: String(target.attachmentId), assetId: String(target.assetId), sha256: String(target.sha256) };
    deliverables.push({ key: slot.key, label: slot.label, target: targetReference });
  }
  return { version: 1, requirementHash, deliverables };
}

/** Validate and snapshot an opted-in execution approval while the issue row is locked. */
export async function captureRequiredQualityReviewDecisionBinding(db: Db, input: {
  issue: { id: string; companyId: string; executionPolicy?: unknown };
  previousPolicy: unknown;
  nextPolicy: unknown;
}): Promise<IssueExecutionReviewTargetBinding | null> {
  const optedIn = (policy: unknown) => record(record(policy).reviewTargetBinding).source === "required_quality_review";
  if (!optedIn(input.previousPolicy) && !optedIn(input.nextPolicy) && !optedIn(input.issue.executionPolicy)) return null;
  const requested = requiredQualityReview(input.nextPolicy);
  const current = requiredQualityReview(input.issue.executionPolicy);
  if (!optedIn(input.nextPolicy) || !optedIn(input.issue.executionPolicy) || !requested || !current ||
      qualityReviewRequirementHash(requested) !== qualityReviewRequirementHash(current)) {
    throw unprocessable("Required quality review requirements changed while the decision was being admitted", {
      code: "required_quality_review_stale",
    });
  }
  const review = await readRequiredQualityReview(db, input.issue, true);
  if (!review.satisfied) {
    throw unprocessable("Required human quality review is not approved for the current outputs", {
      code: "required_quality_review_incomplete", missing: review.missing,
    });
  }
  const binding = await captureRequiredQualityReviewBinding(db, input.issue, true);
  if (!binding || binding.requirementHash !== qualityReviewRequirementHash(current)) {
    throw unprocessable("Required quality review target changed before the decision was recorded", {
      code: "required_quality_review_stale",
    });
  }
  return binding;
}

export interface RequiredQualityReviewState {
  required: boolean;
  satisfied: boolean;
  missing: Array<{ key: string; label: string; reason: "missing" | "pending" | "not_approved" | "stale"; interactionId?: string }>;
}

/** At most ten indexed task-local lookups. No model claims, labels, plans or file presence count as approval. */
export async function readRequiredQualityReview(db: Db, issue: { id: string; companyId: string; executionPolicy?: unknown }, lock = false): Promise<RequiredQualityReviewState> {
  const requirement = requiredQualityReview(issue.executionPolicy);
  if (!requirement) return { required: false, satisfied: true, missing: [] };
  const fingerprint = qualityReviewRequirementHash(requirement);
  const missing: RequiredQualityReviewState["missing"] = [];
  for (const slot of requirement.deliverables) {
    const interactionQuery = db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
      sql`((${issueThreadInteractions.kind} = 'request_confirmation' AND ${issueThreadInteractions.payload}->'qualityReview'->>'key' = ${slot.key}) OR
        (${issueThreadInteractions.kind} = 'request_item_verdicts' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${issueThreadInteractions.payload}->'items') item WHERE item->'qualityReview'->>'key' = ${slot.key})))`,
    )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(1);
    const [row] = await (lock ? interactionQuery.for("update") : interactionQuery);
    if (!row) { missing.push({ ...slot, reason: "missing" }); continue; }
    const payload = record(row.payload), result = record(row.result);
    const matchingItems = row.kind === "request_item_verdicts"
      ? (Array.isArray(payload.items) ? payload.items : []).filter((candidate: any) => candidate.qualityReview?.key === slot.key) : [payload];
    if (matchingItems.length !== 1) { missing.push({ ...slot, reason: "not_approved", interactionId: row.id }); continue; }
    const item = matchingItems[0];
    const verdict = row.kind === "request_item_verdicts"
      ? (Array.isArray(result.items) ? result.items : []).find((candidate: any) => candidate.id === item?.id) : null;
    const humanApproved = row.effectiveResolverPolicy === "human_only" && (row.kind === "request_confirmation"
      ? row.status === "accepted" && result.outcome === "accepted" && Boolean(row.resolvedByUserId) && !row.resolvedByAgentId
      : ["pending", "answered"].includes(row.status) && result.outcome === "resolved" && verdict?.verdict === "approve" && Boolean(verdict.resolvedByUserId) && !verdict.resolvedByAgentId);
    const reason = item?.qualityReview?.requirementHash !== fingerprint ? "stale"
      : !humanApproved ? row.status === "pending" && !verdict ? "pending" : "not_approved"
      : !await currentQualityReviewTarget(db, issue.companyId, issue.id, item.target, lock) ? "stale" : null;
    if (reason) missing.push({ ...slot, reason, interactionId: row.id });
  }
  return { required: true, satisfied: missing.length === 0, missing };
}

export async function assertRequiredQualityReviewComplete(db: Db, issue: { id: string; companyId: string; executionPolicy?: unknown }, lock = false) {
  const state = await readRequiredQualityReview(db, issue, lock);
  if (!state.satisfied) throw unprocessable("Required human quality review is not approved for the current outputs", {
    code: "required_quality_review_incomplete", missing: state.missing,
  });
}

export const REQUIRED_QUALITY_REVIEW_GUIDANCE = `When the agreed brief requires human quality review, preserve it in suggest_tasks or create_task as requiredQualityReview: {version:1, deliverables:[{key:"copy",label:"Blog copy"},{key:"visual",label:"Supporting visual"}]}, using only the requested outputs. This is a quality gate, never permission to publish. On execution, read executionPolicy.requiredQualityReview. For each required key, save the output and request_human_input with a confirmation payload.qualityReview:{key}, or item_verdicts items each with qualityReview:{key} and target. Targets must be exact current output document revisions or attachmentId/assetId/sha256 from registered deliverables; plans and suggestions do not qualify. Use top-level resolverPolicy:"human_only" and continuationPolicy:"wake_assignee". Put supersedeOnUserComment:false inside payload, alongside qualityReview and target. For example: {interactionKind:"confirmation",idempotencyKey:"copy-review-v1",title:"Review copy",prompt:"Approve this draft?",resolverPolicy:"human_only",continuationPolicy:"wake_assignee",payload:{version:1,qualityReview:{key:"copy"},target:{type:"issue_document",key:"copy",revisionId:"<saved revision UUID>"},supersedeOnUserComment:false}}. Never drop payload or its bindings after a validation error; correct the argument placement and retry. Wait on that existing review; a rejected or deferred output needs revision and a fresh bound review. Preserve approval of unchanged outputs. Do not report done until every required output has canonical human approval. Keep review questions and context short and decision-relevant; opaque IDs/hashes belong only in structured targets, never the visible prose. Link returned documentHref/contentPath/downloadPath, never local filesystem paths. Quality approval does not authorize publication or external delivery.`;
