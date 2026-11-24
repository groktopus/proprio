import { toolActionRequests, toolCallEvents, toolInvocations } from "@groktopus/db";
import type { ToolActionRequest, ToolCallEvent, ToolInvocation, ToolPolicyEvaluationSnapshot, ToolPolicyRunProvenance } from "@groktopus/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function policySnapshot(value: unknown): ToolPolicyEvaluationSnapshot | null {
  if (!isRecord(value) || typeof value.policyId !== "string" ||
    !(value.policyType === "allow" || value.policyType === "block" || value.policyType === "require_approval" || value.policyType === "rate_limit" || value.policyType === "trust_rule") ||
    typeof value.priority !== "number" || !Number.isInteger(value.priority) ||
    typeof value.revisionUpdatedAt !== "string" ||
    typeof value.revisionFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.revisionFingerprint) ||
    typeof value.decisionReason !== "string" || value.decisionReason.length > 100 ||
    typeof value.evaluatedAt !== "string") return null;
  return {
    policyId: value.policyId,
    policyType: value.policyType,
    priority: value.priority,
    revisionUpdatedAt: value.revisionUpdatedAt,
    revisionFingerprint: value.revisionFingerprint,
    decisionReason: value.decisionReason,
    evaluatedAt: value.evaluatedAt,
  };
}

export function toToolPolicyRunProvenance(row: typeof toolInvocations.$inferSelect): ToolPolicyRunProvenance {
  const stored = row.policyExplanation?.explicitMatchedPolicies;
  const snapshots = Array.isArray(stored) ? stored.map(policySnapshot) : null;
  const parsedPolicies = snapshots?.filter((snapshot): snapshot is ToolPolicyEvaluationSnapshot => snapshot !== null) ?? [];
  const storedMatchedIds = Array.isArray(row.matchedPolicyIds)
    ? row.matchedPolicyIds.filter((id): id is string => typeof id === "string") : [];
  const snapshotIds = new Set(parsedPolicies.map(policy => policy.policyId));
  const recorded = snapshots !== null && snapshots.every(snapshot => snapshot !== null)
    && storedMatchedIds.every(id => snapshotIds.has(id));
  const policies = recorded ? snapshots as ToolPolicyEvaluationSnapshot[] : [];
  return {
    captureStatus: recorded ? "recorded" : "unknown",
    matchedPolicyIds: [...new Set([
      ...storedMatchedIds,
      ...policies.map(policy => policy.policyId),
    ])],
    policies,
  };
}

export function toToolInvocation(
  row: typeof toolInvocations.$inferSelect,
): ToolInvocation {
  return {
    id: row.id,
    companyId: row.companyId,
    idempotencyKey: row.idempotencyKey,
    actorType: row.actorType as ToolInvocation["actorType"],
    actorId: row.actorId,
    agentId: row.agentId,
    issueId: row.issueId,
    runId: row.runId,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    catalogEntryId: row.catalogEntryId,
    toolName: row.toolName,
    argumentsHash: row.argumentsHash,
    argumentsSummary: row.argumentsSummary ?? null,
    policyDecision: row.policyDecision,
    matchedPolicyIds: row.matchedPolicyIds,
    approvalState: row.approvalState,
    status: row.status,
    upstreamRequestId: row.upstreamRequestId,
    resultHash: row.resultHash,
    resultSummary: row.resultSummary ?? null,
    resultSizeBytes: row.resultSizeBytes,
    resultArtifactId: row.resultArtifactId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toToolActionRequest(
  row: typeof toolActionRequests.$inferSelect,
): ToolActionRequest {
  return {
    id: row.id,
    companyId: row.companyId,
    invocationId: row.invocationId,
    issueId: row.issueId,
    interactionId: row.interactionId,
    approvalId: row.approvalId,
    status: row.status,
    canonicalArgumentsHash: row.canonicalArgumentsHash,
    canonicalArgumentsSummary: row.canonicalArgumentsSummary,
    signedArguments: row.signedArguments,
    previewMarkdown: row.previewMarkdown,
    requestedByAgentId: row.requestedByAgentId,
    requestedByUserId: row.requestedByUserId,
    resolvedByAgentId: row.resolvedByAgentId,
    resolvedByUserId: row.resolvedByUserId,
    decidedByAgentId: row.decidedByAgentId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toToolCallEvent(
  row: typeof toolCallEvents.$inferSelect,
): ToolCallEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    eventType: row.eventType,
    actorType: row.actorType as ToolCallEvent["actorType"],
    actorId: row.actorId,
    agentId: row.agentId,
    runId: row.runId,
    issueId: row.issueId,
    applicationId: row.applicationId,
    connectionId: row.connectionId,
    catalogEntryId: row.catalogEntryId,
    invocationId: row.invocationId,
    actionRequestId: row.actionRequestId,
    runtimeSlotId: row.runtimeSlotId,
    toolName: row.toolName,
    decision: row.decision,
    matchedPolicyIds: row.matchedPolicyIds,
    reasonCode: row.reasonCode,
    outcome: row.outcome,
    latencyMs: row.latencyMs,
    argumentsSummary: row.argumentsSummary ?? null,
    requestHash: row.requestHash,
    requestSummary: row.requestSummary ?? null,
    resultHash: row.resultHash,
    resultSummary: row.resultSummary ?? null,
    resultSizeBytes: row.resultSizeBytes,
    redactionPlan: row.redactionPlan ?? null,
    rateLimitState: row.rateLimitState ?? null,
    metadata: row.metadata ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}

export function userFallbackName(userId: string): string {
  if (userId === "local-board") return "Board";
  return userId;
}

export function denialReasonForDecision(
  invocation: typeof toolInvocations.$inferSelect,
  latestAuditEvent: typeof toolCallEvents.$inferSelect | null,
) {
  if (
    invocation.status === "denied" ||
    invocation.status === "rate_limited" ||
    invocation.status === "failed" ||
    invocation.status === "timed_out"
  ) {
    return (
      invocation.errorMessage ??
      invocation.errorCode ??
      latestAuditEvent?.reasonCode ??
      null
    );
  }
  if (
    latestAuditEvent?.outcome === "denied" ||
    latestAuditEvent?.outcome === "failure" ||
    latestAuditEvent?.outcome === "timeout"
  ) {
    return latestAuditEvent.errorMessage ?? latestAuditEvent.reasonCode ?? null;
  }
  return null;
}
