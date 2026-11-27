import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import {
  agents,
  approvals,
  caseHandoffs,
  cases,
  companies,
  completionContracts,
  heartbeatRuns,
  heartbeatRunEvents,
  issueApprovals,
  issueWorkProducts,
  issues,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@groktopus/db";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { errorHandler } from "../../middleware/index.js";
import { activityRoutes } from "../../routes/activity.js";
import { retainCaseAccessSource } from "../case-access.js";
import { readNativeCompletionHistory } from "./native-completion-history.js";
import { recordNativeAttentionAssessment } from "./work-assessments.js";

describeEmbeddedPostgres("native completion history", () => {
  const ctx = useEmbeddedPostgres("proprio-native-completion-history-");
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const privateIssueId = randomUUID();
  const legacyIssueId = randomUUID();
  const readerId = randomUUID();
  const actor = { type: "agent" as const, companyId, agentId: readerId, source: "agent_key" as const };
  let visibleWorkProductId = "";
  let restrictedWorkProductId = "";

  beforeAll(async () => {
    await ctx.db.insert(companies).values({ id: companyId, name: "Completion history", issuePrefix: "CH" });
    await ctx.db.insert(agents).values([
      { id: agentId, companyId, name: "Worker", adapterType: "codex_local", status: "running" },
      { id: readerId, companyId, name: "Reader", adapterType: "codex_local", status: "idle" },
    ]);
    await ctx.db.insert(issues).values([
      { id: issueId, companyId, title: "Native completion", status: "done", assigneeAgentId: agentId },
      { id: privateIssueId, companyId, title: "Other task", status: "todo", visibility: "private", assigneeAgentId: agentId },
      { id: legacyIssueId, companyId, title: "Older task", status: "todo", assigneeAgentId: agentId },
    ]);
    const otherRunId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({
      id: otherRunId, companyId, agentId, status: "succeeded", scopeKind: "issue", issueId: privateIssueId,
    });
    await ctx.db.insert(heartbeatRunEvents).values({
      companyId, agentId, runId: otherRunId, seq: 34, eventType: "unrelated_other_run_event",
    });
    [visibleWorkProductId] = [randomUUID()];
    restrictedWorkProductId = randomUUID();
    await ctx.db.insert(issueWorkProducts).values([
      { id: visibleWorkProductId, companyId, issueId, type: "pull_request", provider: "github", title: "Merged PR", status: "merged" },
      { id: restrictedWorkProductId, companyId, issueId: privateIssueId, type: "document", provider: "internal", title: "Private other-task artifact", status: "completed" },
    ]);
  });

  async function addCompletion(input: { revision: number; authority: string; reason: string; priorDecisionId?: string | null; supersedesDecisionId?: string | null; evidence?: boolean; boundIssueId?: string }) {
    const taskId = input.boundIssueId ?? issueId;
    const contractId = randomUUID(), runId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    const contractHash = createHash("sha256").update(contractId).digest("hex");
    const previousContract = input.revision > 1
      ? (await ctx.db.select({ id: completionContracts.id }).from(completionContracts)
          .where(and(eq(completionContracts.companyId, companyId), eq(completionContracts.issueId, taskId), eq(completionContracts.revision, input.revision - 1))).limit(1))[0]
      : undefined;
    await ctx.db.insert(completionContracts).values({ id: contractId, companyId, issueId: taskId, revision: input.revision,
      schemaVersion: "proprio.completion-contract.v1", policyVersion: `completion-policy-${input.revision}`, risk: input.authority === "agent_claim_policy" ? "low" : "standard",
      completionAuthority: input.authority, incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: String(input.revision), objective: "Deliver the outcome", criteria: [{ id: "deliver", requirement: "Deliver the outcome" }] },
      canonicalSha256: contractHash, createdByActorType: "system", createdByActorId: "native-finalizer", supersedesContractId: previousContract?.id ?? null });
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "native",
      scopeKind: "issue", issueId: taskId, nativeIssueId: taskId, nativeSessionId: randomUUID(), runnerInstanceId: randomUUID(),
      completionContractId: contractId, completionContractSha256: contractHash, contextSnapshot: { taskId } });
    await ctx.db.insert(nativeRunResults).values({ id: resultId, companyId, issueId: taskId, runId, completionContractId: contractId,
      serverFingerprint: `result-${resultId}`, schemaStatus: "accepted", canonicalSha256: createHash("sha256").update(resultId).digest("hex"),
      resultJson: { result: { reportedWorkDisposition: "done", summary: `Revision ${input.revision} delivered` }, terminal: { runTerminalState: "succeeded" } } });
    const eventEvidence = [];
    if (input.evidence) {
      const [assessed] = await ctx.db.insert(heartbeatRunEvents).values([
        { companyId, agentId, runId, seq: 62, sourceSeq: 33, eventType: "assessment_event" },
        { companyId, agentId, runId, seq: 33, eventType: "unrelated_event" },
      ]).returning({ id: heartbeatRunEvents.id });
      eventEvidence.push({
        ref: "event:33", kind: "event", outcome: "accepted", reasonCode: "control_plane_evidence_accepted", durableRecordId: String(assessed!.id),
      });
    }
    const acceptedWorkProduct = { ref: `work_product:${visibleWorkProductId}`, kind: "work_product", outcome: "accepted",
      reasonCode: "work_product_authoritatively_accepted", durableRecordId: visibleWorkProductId };
    const criterionAssessments = input.evidence ? [{
      criterionId: "deliver", claimStatus: "satisfied", outcome: "accepted", reasonCode: "criterion_evidence_accepted",
      evidenceRefs: [acceptedWorkProduct, ...eventEvidence],
    }] : [];
    const verificationAssessments = input.evidence ? [{
      commandOrCheck: "Review merged PR", claimStatus: "passed", outcome: "accepted", reasonCode: "verification_evidence_accepted",
      evidenceRef: acceptedWorkProduct, reportedReasonCode: null, detail: null,
    }] : [];
    await ctx.db.insert(workAssessments).values({ id: assessmentId, companyId, issueId: taskId, runId, contractId, resultId,
      triggerKind: "native_result", triggerRef: resultId, triggerCapability: "server_native_finalizer", triggerActorCompanyId: companyId,
      priorIssueStatus: input.revision === 1 ? "in_progress" : "done", priorStatusVersion: input.revision - 1,
      priorDecisionId: input.priorDecisionId ?? null, policyVersion: `arbiter-${input.revision}`,
      assessmentJson: { summary: "Server assessment", reportedDisposition: "done", allCriteriaSatisfied: input.evidence ?? false,
        verificationPassed: input.evidence ?? false, criterionAssessments, verificationAssessments }, inputDigest: `assessment-${assessmentId}` });
    await ctx.db.insert(statusDecisions).values({ id: decisionId, companyId, issueId: taskId, runId, assessmentId,
      decisionVersion: input.revision, policyVersion: `arbiter-${input.revision}`, fromStatus: input.revision === 1 ? "in_progress" : "done",
      toStatus: "done", reasonCode: input.reason, decisionJson: { statusAction: "done", toStatus: "done", reasonCode: input.reason },
      decisionDigest: `decision-${decisionId}`, applicationState: "applied", supersedesDecisionId: input.supersedesDecisionId ?? null,
      appliedAt: new Date(Date.UTC(2026, 0, input.revision)) });
    return { contractId, runId, resultId, assessmentId, decisionId, assessedEventId: eventEvidence[0]?.durableRecordId };
  }

  it("joins policy-claim and evidence-backed decisions to exact criteria and keeps prior lineage discoverable", async () => {
    const evidence = await addCompletion({ revision: 1, authority: "server_arbiter", reason: "completion_contract_satisfied", evidence: true });
    const claim = await addCompletion({ revision: 2, authority: "agent_claim_policy", reason: "completion_claim_policy_accepted",
      priorDecisionId: evidence.decisionId, supersedesDecisionId: evidence.decisionId });
    const history = await readNativeCompletionHistory(ctx.db, { companyId, issueId, actor });

    expect(history).toHaveLength(2);
    expect(history.map((item) => item.id)).toEqual([claim.assessmentId, evidence.assessmentId]);
    expect(history[0]).toMatchObject({
      contract: { id: claim.contractId, revision: 2, completionAuthority: "agent_claim_policy", supersedesContractId: evidence.contractId,
        criteria: [{ id: "deliver", requirement: "Deliver the outcome" }] },
      result: { id: claim.resultId, disposition: "done", summary: "Revision 2 delivered" },
      assessment: { id: claim.assessmentId, priorDecisionId: evidence.decisionId },
      decision: { id: claim.decisionId, reasonCode: "completion_claim_policy_accepted", supersedesDecisionId: evidence.decisionId },
    });
    expect(history[1]).toMatchObject({
      contract: { id: evidence.contractId, revision: 1, completionAuthority: "server_arbiter" },
      assessment: { allCriteriaSatisfied: true, verificationPassed: true,
        criterionAssessments: [{ criterionId: "deliver", outcome: "accepted" }] },
      decision: { id: evidence.decisionId, reasonCode: "completion_contract_satisfied" },
    });
    const refs = history[1]!.assessment!.criterionAssessments[0]!.evidence;
    expect(refs[0]).toMatchObject({ visibility: "available", outcome: "accepted", recordId: visibleWorkProductId, title: "Merged PR" });
    expect(refs[1]).toMatchObject({ visibility: "available", outcome: "accepted", recordId: evidence.assessedEventId });
    expect(history.every((item) => item.lineageGaps.length === 0)).toBe(true);
  });

  it("hides retained private Case and approval evidence from the entire HTTP response", async () => {
    const [visibleCase, privateCase] = await ctx.db.insert(cases).values([
      { companyId, caseNumber: 1, identifier: "CH-C1", caseType: "review", title: "Visible Case" },
      { companyId, caseNumber: 2, identifier: "CH-C2", caseType: "review", title: "Private Case" },
    ]).returning();
    await retainCaseAccessSource(ctx.db, { companyId, caseId: visibleCase!.id, sourceKind: "issue", sourceId: issueId });
    await retainCaseAccessSource(ctx.db, { companyId, caseId: privateCase!.id, sourceKind: "issue", sourceId: privateIssueId });
    const decision = await addCompletion({ revision: 3, authority: "server_arbiter", reason: "verification_needed" });
    const [visibleHandoff, privateHandoff] = await ctx.db.insert(caseHandoffs).values(
      [visibleCase!, privateCase!].map((row, index) => ({
        companyId, issueId, caseId: row.id, version: 1, phase: index === 0 ? "Public review stage" : "Hidden review stage",
        instructions: "Review", actorType: "system" as const, actorId: "fixture", sourceRunId: decision.runId,
        wakeupRequestId: randomUUID(), idempotencyKey: row.id, inputFingerprint: row.id,
        destinationKind: "done" as const, state: "completed" as const,
      })),
    ).returning();
    const [approval] = await ctx.db.insert(approvals).values({
      companyId, type: "private_signoff", status: "approved", payload: { sourceIssueId: privateIssueId },
    }).returning();
    await ctx.db.insert(issueApprovals).values({ companyId, issueId, approvalId: approval!.id });
    await ctx.db.update(workAssessments).set({
      assessmentJson: {
        summary: `Approval ${approval!.id} and handoff ${privateHandoff!.id}`,
        criterionAssessments: [{
          criterionId: "deliver", outcome: "missing", evidenceRefs: [
            { ref: `case-handoff:${visibleHandoff!.id}`, kind: "case_handoff", outcome: "accepted" },
            { ref: `case-handoff:${privateHandoff!.id}`, kind: "case_handoff", outcome: "accepted" },
            { ref: `approval:${approval!.id}`, kind: "approval", outcome: "accepted", reasonCode: "approval_approved" },
            { ref: `work_product:${restrictedWorkProductId}`, kind: "work_product", outcome: "missing" },
            { ref: "event:34", kind: "event", outcome: "missing", reasonCode: "durable_run_event_missing" },
          ],
        }],
        verificationAssessments: [{
          commandOrCheck: "Review disputed evidence", claimStatus: "not_run", outcome: "missing",
          reasonCode: "verification_not_run", reportedReasonCode: "missing_credentials",
          detail: `Bearer test1234567890fixture for ${privateHandoff!.id.toUpperCase()}`,
        }],
      },
    }).where(eq(workAssessments.id, decision.assessmentId));
    const app = express();
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", activityRoutes(ctx.db));
    app.use(errorHandler);

    const response = await request(app).get(`/api/issues/${issueId}/completion-history`).expect(200);
    const entry = response.body.find((row: { id: string }) => row.id === decision.assessmentId);
    expect(entry.assessment.criterionAssessments[0].evidence).toEqual([
      expect.objectContaining({ recordId: visibleHandoff!.id, title: "Public review stage", visibility: "available" }),
      expect.objectContaining({ kind: "case_handoff", visibility: "restricted", outcome: "unverifiable" }),
      expect.objectContaining({ kind: "approval", visibility: "restricted", outcome: "unverifiable" }),
      expect.objectContaining({ kind: "work_product", visibility: "restricted", outcome: "unverifiable" }),
      expect.objectContaining({ kind: "event", visibility: "missing", outcome: "missing" }),
    ]);
    expect(entry.assessment.criterionAssessments[0].claimStatus).toBeNull();
    expect(entry.assessment.verificationAssessments[0]).toMatchObject({
      claimStatus: "not_run", reasonCode: "verification_not_run", reportedReasonCode: "missing_credentials",
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    for (const hidden of [privateHandoff!.id, approval!.id, restrictedWorkProductId, "hidden review stage", "private_signoff", "approval_approved", "test1234567890fixture"]) {
      expect(response.text.toLowerCase()).not.toContain(hidden);
    }
  });

  it("keeps a native attention assessment linked to the completion decision it followed", async () => {
    const completion = await addCompletion({ revision: 4, authority: "agent_claim_policy", reason: "completion_claim_policy_accepted" });
    const attention = await recordNativeAttentionAssessment({
      db: ctx.db, companyId, issueId, runId: completion.runId, contractId: completion.contractId, resultId: completion.resultId,
      turnId: null, requestId: randomUUID(), request: { kind: "question" }, routingFacts: {},
      priorIssueStatus: "done", priorStatusVersion: 4, priorDecisionId: completion.decisionId,
      supersedesAssessmentId: completion.assessmentId,
    });

    const history = await readNativeCompletionHistory(ctx.db, { companyId, issueId, actor });
    const entry = history.find(row => row.id === attention.id);
    expect(entry).toMatchObject({
      assessment: { triggerKind: "native_attention", priorDecisionId: completion.decisionId,
        supersedesAssessmentId: completion.assessmentId },
      result: { id: completion.resultId },
    });
  });

  it("omits native results when the underlying run scope is unreadable", async () => {
    const hidden = await addCompletion({
      revision: 5, authority: "server_arbiter", reason: "hidden_runtime_reason", boundIssueId: privateIssueId,
    });

    const history = await readNativeCompletionHistory(ctx.db, { companyId, issueId: privateIssueId, actor });
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain(hidden.runId);
    expect(serialized).not.toContain(hidden.resultId);
    expect(serialized).not.toContain("hidden_runtime_reason");
  });

  it("returns empty history for older tasks with no native lineage", async () => {
    expect(await readNativeCompletionHistory(ctx.db, { companyId, issueId: legacyIssueId, actor })).toEqual([]);
  });
});
