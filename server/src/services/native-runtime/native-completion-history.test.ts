import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import {
  agents,
  companies,
  completionContracts,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@groktopus/db";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { readNativeCompletionHistory } from "./native-completion-history.js";

describeEmbeddedPostgres("native completion history", () => {
  const ctx = useEmbeddedPostgres("proprio-native-completion-history-");
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const privateIssueId = randomUUID();
  let visibleWorkProductId = "";
  let restrictedWorkProductId = "";

  beforeAll(async () => {
    await ctx.db.insert(companies).values({ id: companyId, name: "Completion history", issuePrefix: "CH" });
    await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "codex_local", status: "running" });
    await ctx.db.insert(issues).values([
      { id: issueId, companyId, title: "Native completion", status: "done", assigneeAgentId: agentId },
      { id: privateIssueId, companyId, title: "Other task", status: "todo", assigneeAgentId: agentId },
    ]);
    [visibleWorkProductId] = [randomUUID()];
    restrictedWorkProductId = randomUUID();
    await ctx.db.insert(issueWorkProducts).values([
      { id: visibleWorkProductId, companyId, issueId, type: "pull_request", provider: "github", title: "Merged PR", status: "merged" },
      { id: restrictedWorkProductId, companyId, issueId: privateIssueId, type: "document", provider: "internal", title: "Private other-task artifact", status: "completed" },
    ]);
  });

  async function addCompletion(input: { revision: number; authority: string; reason: string; priorDecisionId?: string | null; supersedesDecisionId?: string | null; evidence?: boolean }) {
    const contractId = randomUUID(), runId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    const contractHash = createHash("sha256").update(contractId).digest("hex");
    const previousContract = input.revision > 1
      ? (await ctx.db.select({ id: completionContracts.id }).from(completionContracts)
          .where(and(eq(completionContracts.companyId, companyId), eq(completionContracts.issueId, issueId), eq(completionContracts.revision, input.revision - 1))).limit(1))[0]
      : undefined;
    await ctx.db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: input.revision,
      schemaVersion: "proprio.completion-contract.v1", policyVersion: `completion-policy-${input.revision}`, risk: input.authority === "agent_claim_policy" ? "low" : "standard",
      completionAuthority: input.authority, incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: String(input.revision), objective: "Deliver the outcome", criteria: [{ id: "deliver", requirement: "Deliver the outcome" }] },
      canonicalSha256: contractHash, createdByActorType: "system", createdByActorId: "native-finalizer", supersedesContractId: previousContract?.id ?? null });
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "native",
      scopeKind: "issue", issueId, nativeIssueId: issueId, nativeSessionId: randomUUID(), runnerInstanceId: randomUUID(),
      completionContractId: contractId, completionContractSha256: contractHash, contextSnapshot: { issueId } });
    await ctx.db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: `result-${resultId}`, schemaStatus: "accepted", canonicalSha256: createHash("sha256").update(resultId).digest("hex"),
      resultJson: { result: { reportedWorkDisposition: "done", summary: `Revision ${input.revision} delivered` }, terminal: { runTerminalState: "succeeded" } } });
    const criterionAssessments = input.evidence ? [{ criterionId: "deliver", claimStatus: "satisfied", outcome: "missing", reasonCode: "criterion_evidence_missing",
      evidenceRefs: [
        { ref: `work_product:${visibleWorkProductId}`, kind: "work_product", outcome: "accepted", reasonCode: "work_product_authoritatively_accepted", durableRecordId: visibleWorkProductId },
        { ref: `work_product:${restrictedWorkProductId}`, kind: "work_product", outcome: "missing", reasonCode: "work_product_missing", durableRecordId: null },
      ] }] : [];
    await ctx.db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId, contractId, resultId,
      triggerKind: "native_result", triggerRef: resultId, triggerCapability: "server_native_finalizer", triggerActorCompanyId: companyId,
      priorIssueStatus: input.revision === 1 ? "in_progress" : "done", priorStatusVersion: input.revision - 1,
      priorDecisionId: input.priorDecisionId ?? null, policyVersion: `arbiter-${input.revision}`,
      assessmentJson: { summary: "Server assessment", reportedDisposition: "done", allCriteriaSatisfied: input.evidence ?? false,
        verificationPassed: input.evidence ?? false, criterionAssessments, verificationAssessments: [] }, inputDigest: `assessment-${assessmentId}` });
    await ctx.db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId, assessmentId,
      decisionVersion: input.revision, policyVersion: `arbiter-${input.revision}`, fromStatus: input.revision === 1 ? "in_progress" : "done",
      toStatus: "done", reasonCode: input.reason, decisionJson: { statusAction: "done", toStatus: "done", reasonCode: input.reason },
      decisionDigest: `decision-${decisionId}`, applicationState: "applied", supersedesDecisionId: input.supersedesDecisionId ?? null,
      appliedAt: new Date(Date.UTC(2026, 0, input.revision)) });
    return { contractId, runId, resultId, assessmentId, decisionId };
  }

  it("joins policy-claim and evidence-backed decisions to exact criteria and keeps prior lineage discoverable", async () => {
    const evidence = await addCompletion({ revision: 1, authority: "server_arbiter", reason: "completion_contract_satisfied", evidence: true });
    const claim = await addCompletion({ revision: 2, authority: "agent_claim_policy", reason: "completion_claim_policy_accepted",
      priorDecisionId: evidence.decisionId, supersedesDecisionId: evidence.decisionId });
    const history = await readNativeCompletionHistory(ctx.db, { companyId, issueId });

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
      assessment: { allCriteriaSatisfied: true, criterionAssessments: [{ criterionId: "deliver", outcome: "missing" }] },
      decision: { id: evidence.decisionId, reasonCode: "completion_contract_satisfied" },
    });
    const refs = history[1]!.assessment!.criterionAssessments[0]!.evidence;
    expect(refs[0]).toMatchObject({ visibility: "available", outcome: "accepted", recordId: visibleWorkProductId, title: "Merged PR" });
    expect(refs[1]).toMatchObject({ visibility: "restricted", outcome: "missing", label: "Supporting record is outside this task's readable scope." });
    expect(refs[1]).not.toHaveProperty("recordId");
    expect(refs[1]).not.toHaveProperty("ref");
    expect(JSON.stringify(history)).not.toContain(restrictedWorkProductId);
    expect(history.every((item) => item.lineageGaps.length === 0)).toBe(true);
  });

  it("returns empty history for older tasks with no native lineage", async () => {
    expect(await readNativeCompletionHistory(ctx.db, { companyId, issueId: privateIssueId })).toEqual([]);
  });
});
