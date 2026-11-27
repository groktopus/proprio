import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, caseHandoffs, cases, completionContracts, companies, createDb, heartbeatRuns,
  issues, issueRecoveryActions, nativeRunResults, statusDecisions, workAssessments } from "@groktopus/db";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { readAcceptedCaseHandoffCompletionEvidence } from "./case-handoff-completion-evidence.js";

describe("accepted case-handoff completion recovery evidence", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("proprio-handoff-completion-evidence-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), sourceAgentId = randomUUID(), issueId = randomUUID(), caseId = randomUUID();
    const runId = randomUUID(), contractId = randomUUID(), assessedContractId = randomUUID(), handoffId = randomUUID();
    const resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    const canonicalSha256 = `sha256:${"a".repeat(64)}`, requirementsDigest = "b".repeat(64);
    await db.insert(companies).values({ id: companyId, name: "Recovery evidence", issuePrefix: `E${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Recipient", adapterType: "proprio_runner", status: "active" },
      { id: sourceAgentId, companyId, name: "Sender", adapterType: "proprio_runner", status: "idle" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Complete accepted handoff", status: "in_progress",
      workMode: "standard", assigneeAgentId: agentId });
    const contractJson = { revision: "1", objective: "Deliver the artifact", criteria: [
      { id: "artifact", requirement: "Publish the artifact" }, { id: "tests", requirement: "Run the test suite" },
    ] };
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "proprio.run-result.v1", policyVersion: "test-policy", risk: "low", completionAuthority: "agent",
      incompleteCriteriaPolicy: "preserve", contractJson, canonicalSha256, createdByActorType: "agent", createdByActorId: agentId });
    await db.insert(completionContracts).values({ id: assessedContractId, companyId, issueId, revision: 2,
      schemaVersion: "proprio.run-result.v1", policyVersion: "test-policy", risk: "low", completionAuthority: "agent",
      incompleteCriteriaPolicy: "preserve", contractJson: { ...contractJson, revision: "2" }, canonicalSha256: `sha256:${"c".repeat(64)}`,
      createdByActorType: "agent", createdByActorId: agentId });
    await db.insert(cases).values({ id: caseId, companyId, handoffVersion: 2, caseNumber: 1, identifier: `C-${caseId.slice(0, 8)}`,
      caseType: "task", title: "Artifact delivery", workIssueId: issueId });
    const offerContract = { schema: "proprio.case-handoff-offer.v1" as const, expectedDeliverable: "Deliver artifact", prerequisites: ["Private prerequisite"],
      requirementRevision: { id: contractId, revision: 1, canonicalSha256 }, requirementsDigest,
      taskBrief: { title: "Complete accepted handoff", description: null } };
    await db.insert(caseHandoffs).values({ id: handoffId, companyId, caseId, issueId, version: 2, fromAgentId: sourceAgentId,
      destinationKind: "agent", toAgentId: agentId, phase: "delivery", instructions: "Deliver the artifact", actorType: "agent",
      actorId: sourceAgentId, wakeupRequestId: randomUUID(), idempotencyKey: `handoff-${handoffId}`, inputFingerprint: "fingerprint",
      offerContract, recipientDecision: { outcome: "accepted", actorType: "agent", actorId: agentId, handoffVersion: 2,
        requirementRevisionId: contractId, requirementsDigest, decidedAt: new Date().toISOString() }, state: "delivered" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", nativeIssueId: issueId,
      completionContractId: assessedContractId, status: "failed", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId, caseHandoffId: handoffId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: assessedContractId,
      serverFingerprint: "fingerprint", schemaStatus: "accepted", resultJson: {}, canonicalSha256: "result-hash" });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId, contractId: assessedContractId, resultId,
      triggerKind: "native_result", triggerRef: resultId, triggerCapability: "server_native_finalizer", triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "test-policy",
      assessmentJson: { criterionAssessments: [
        { criterionId: "artifact", outcome: "accepted", reasonCode: "criterion_evidence_accepted", evidenceRefs: [] },
        { criterionId: "tests", outcome: "missing", reasonCode: "criterion_evidence_missing", evidenceRefs: [
          { ref: "event:5", outcome: "missing", reasonCode: "event_missing" },
        ] },
      ] }, inputDigest: `digest-${assessmentId}` });
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId, assessmentId, decisionVersion: 1,
      policyVersion: "test-policy", fromStatus: "in_progress", toStatus: "in_progress", reasonCode: "completion_evidence_incomplete",
      decisionJson: {}, decisionDigest: `decision-${decisionId}`, applicationState: "applied" });
    return { companyId, agentId, issueId, runId, handoffId, decisionId, contractId, assessedContractId };
  }

  it("binds only outstanding criteria to the accepted revision and recipient", async () => {
    const f = await fixture();
    const receipt = await readAcceptedCaseHandoffCompletionEvidence({ db, ...f });
    expect(receipt).toMatchObject({
      schema: "proprio.case-handoff-completion-recovery.v1",
      caseHandoff: { id: f.handoffId, version: 2, recipientAgentId: f.agentId, prerequisiteCount: 1,
        acceptedRequirementRevision: { id: f.contractId, revision: 1 } },
      decision: { statusDecisionReasonCode: "completion_evidence_incomplete" },
      assessment: { resultId: expect.any(String),
        assessedContractRevision: { id: f.assessedContractId, revision: 2 }, criteriaNeedingWork: [{ criterionId: "tests", requirement: "Run the test suite",
        outcome: "missing", reasonCode: "criterion_evidence_missing", evidence: [
          { outcome: "missing", reasonCode: "event_missing" },
        ] }] },
    });
    expect(JSON.stringify(receipt)).not.toContain("event:5");
    expect(JSON.stringify(receipt)).not.toContain("Private prerequisite");

    await db.update(caseHandoffs).set({ recipientDecision: { outcome: "accepted", actorType: "agent", actorId: randomUUID(),
      handoffVersion: 2, requirementRevisionId: f.contractId, requirementsDigest: "b".repeat(64), decidedAt: new Date().toISOString() } })
      .where(eq(caseHandoffs.id, f.handoffId));
    await expect(readAcceptedCaseHandoffCompletionEvidence({ db, ...f })).resolves.toBeNull();

    await db.update(caseHandoffs).set({ recipientDecision: { outcome: "accepted", actorType: "agent", actorId: f.agentId,
      handoffVersion: 2, requirementRevisionId: f.contractId, requirementsDigest: "b".repeat(64), decidedAt: new Date().toISOString() } })
      .where(eq(caseHandoffs.id, f.handoffId));
    await db.update(cases).set({ handoffVersion: 3 }).where(eq(cases.workIssueId, f.issueId));
    await expect(readAcceptedCaseHandoffCompletionEvidence({ db, ...f })).resolves.toBeNull();
    await db.update(cases).set({ handoffVersion: 2 }).where(eq(cases.workIssueId, f.issueId));
    await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board-owner" }).where(eq(issues.id, f.issueId));
    await expect(readAcceptedCaseHandoffCompletionEvidence({ db, ...f })).resolves.toBeNull();
    await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.issueId));
    await db.update(cases).set({ status: "cancelled" }).where(eq(cases.workIssueId, f.issueId));
    await expect(readAcceptedCaseHandoffCompletionEvidence({ db, ...f })).resolves.toBeNull();
    await db.update(cases).set({ status: "draft" }).where(eq(cases.workIssueId, f.issueId));
    await db.update(caseHandoffs).set({ state: "cancelled" }).where(eq(caseHandoffs.id, f.handoffId));
    await expect(readAcceptedCaseHandoffCompletionEvidence({ db, ...f })).resolves.toBeNull();
  });

  it("preserves accepted recovery across unbound failures and reassesses one saved run without charging twice", async () => {
    const f = await fixture();
    const receipt = (await readAcceptedCaseHandoffCompletionEvidence({ db, ...f }))!;
    const recovery = issueRecoveryActionService(db);
    const input = {
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog" as const,
      cause: "completion_evidence_incomplete", fingerprint: "accepted-handoff-fingerprint",
      ownerType: "agent" as const, ownerAgentId: f.agentId, maxAttempts: 3, nextAction: "Review the assessment.",
    };
    const first = await recovery.upsertSourceScoped({ ...input,
      caseCompletionAttempt: { runId: f.runId, decisionId: f.decisionId, receipt },
    });
    const unbound = await recovery.upsertSourceScoped({ ...input, fingerprint: "unbound-follow-up",
      caseCompletionAttempt: { runId: randomUUID(), decisionId: randomUUID(), receipt: null },
    });
    expect(unbound).toEqual(first);
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, f.decisionId));
    const [assessment] = await db.select().from(workAssessments).where(eq(workAssessments.id, decision!.assessmentId));
    const reassessmentId = randomUUID();
    await db.insert(workAssessments).values({ ...assessment!, id: reassessmentId,
      inputDigest: `new-prior-state-${reassessmentId}`, supersedesAssessmentId: assessment!.id });
    const decisionId = randomUUID();
    await db.insert(statusDecisions).values({ ...decision!, id: decisionId, assessmentId: reassessmentId,
      decisionVersion: decision!.decisionVersion + 1, decisionDigest: `reconsidered-${decisionId}`, supersedesDecisionId: decision!.id });
    const reconsidered = (await readAcceptedCaseHandoffCompletionEvidence({ db, ...f, decisionId }))!;
    const updated = await recovery.upsertSourceScoped({ ...input,
      caseCompletionAttempt: { runId: f.runId, decisionId, receipt: reconsidered },
    });
    expect(updated).toMatchObject({ id: first.id, attemptCount: 1 });
    const [stored] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, first.id));
    expect(stored?.evidence).toMatchObject({ decisionId, caseHandoffCompletion: { attempts: [{
      runId: f.runId, decisionId, resultId: receipt.assessment.resultId, assessmentId: reassessmentId,
    }] } });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).map(row => row.id))
      .toEqual(expect.arrayContaining([f.decisionId, decisionId]));
    expect(updated.evidence).not.toHaveProperty("caseHandoffCompletion");
  });

  it("recomputes Case attempt lineage if another writer wins the recovery row", async () => {
    const f = await fixture();
    const receipt = (await readAcceptedCaseHandoffCompletionEvidence({ db, ...f }))!;
    const recovery = issueRecoveryActionService(db);
    const earlier = { runId: randomUUID(), decisionId: randomUUID() };
    const competing = { runId: randomUUID(), decisionId: randomUUID() };
    const input = {
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog" as const,
      cause: "completion_evidence_incomplete", fingerprint: "accepted-handoff-fingerprint",
      ownerType: "agent" as const, ownerAgentId: f.agentId, maxAttempts: 3, nextAction: "Review the assessment.",
    };
    const first = await recovery.upsertSourceScoped({ ...input, evidence: {
      ...earlier, caseHandoffCompletion: { ...receipt, attempts: [earlier] },
    } });
    const transaction = db.transaction.bind(db);
    const injectCompetingWrite = vi.spyOn(db, "transaction").mockImplementationOnce(async (write, options) => {
      await db.update(issueRecoveryActions).set({ attemptCount: 2, evidence: {
        ...competing, caseHandoffCompletion: { ...receipt, attempts: [earlier, competing] },
      } }).where(eq(issueRecoveryActions.id, first.id));
      return transaction(write, options);
    });
    try {
      const updated = await recovery.upsertSourceScoped({ ...input,
        caseCompletionAttempt: { runId: f.runId, decisionId: f.decisionId, receipt },
      });
      expect(updated).toMatchObject({ id: first.id, attemptCount: 3, status: "escalated", ownerType: "board" });
    } finally {
      injectCompetingWrite.mockRestore();
    }
    const [saved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, first.id));
    expect(saved?.evidence).toMatchObject({ caseHandoffCompletion: { attempts: [
      earlier, competing, { runId: f.runId, decisionId: f.decisionId },
    ] } });
  });

  it("requires a nonempty bound digest for the accepted offer and decision", async () => {
    const f = await fixture();
    const [row] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId));
    await db.update(caseHandoffs).set({
      offerContract: { ...row!.offerContract!, requirementsDigest: "" },
      recipientDecision: { ...row!.recipientDecision!, requirementsDigest: "" },
    }).where(eq(caseHandoffs.id, f.handoffId));

    await expect(readAcceptedCaseHandoffCompletionEvidence({ db, ...f })).resolves.toBeNull();
  });
});
