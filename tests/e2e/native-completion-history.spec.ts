import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createDb, closeRegisteredClients, completionContracts, heartbeatRuns, nativeRunResults,
  statusDecisions, workAssessments } from "../../packages/db/src/index.ts";

import { json } from "./http";
import { readTestServerDatabaseUrl } from "./server-database-url";

test("Task properties distinguish a completion claim from evidence assessment and redact another task's artifact", async ({ page, request }) => {
  test.setTimeout(90_000);
  const databaseUrl = await readTestServerDatabaseUrl();
  const db = createDb(databaseUrl);

  try {
    const company = await json(await request.post("/api/companies", {
      data: { name: `Completion history browser ${Date.now()}` },
    }));
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
      data: { name: "Completion history fixture", role: "engineer", adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", ""] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } },
    }));
    const task = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Review completion evidence", description: "Inspect the recorded native completion decision.", status: "in_progress", assigneeAgentId: agent.id },
    }));
    const otherTask = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Separate task evidence", description: "This artifact is outside the reviewed task.", status: "todo" },
    }));
    const visibleProduct = await json(await request.post(`/api/issues/${task.id}/work-products`, {
      data: { type: "pull_request", provider: "github", title: "Accepted same-task artifact", status: "merged" },
    }));
    const restrictedProduct = await json(await request.post(`/api/issues/${otherTask.id}/work-products`, {
      data: { type: "document", provider: "internal", title: "Other-task private artifact", status: "active" },
    }));

    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const decisionId = randomUUID();
    const contractHash = createHash("sha256").update(contractId).digest("hex");
    await db.insert(completionContracts).values({ id: contractId, companyId: company.id, issueId: task.id,
      revision: 1, schemaVersion: "proprio.completion-contract.v1", policyVersion: "browser-completion-policy-v1",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", objective: "Review and verify the artifact", criteria: [
        { id: "artifact", requirement: "Deliver the reviewed artifact" },
      ] }, canonicalSha256: contractHash, createdByActorType: "system", createdByActorId: "native-finalizer" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId: agent.id, scopeKind: "issue",
      issueId: task.id, nativeIssueId: task.id, status: "succeeded", runtimeMode: "native",
      nativeSessionId: randomUUID(), runnerInstanceId: randomUUID(), completionContractId: contractId,
      completionContractSha256: contractHash, contextSnapshot: { issueId: task.id } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId: company.id, issueId: task.id, runId,
      completionContractId: contractId, serverFingerprint: `browser-result-${resultId}`, schemaStatus: "accepted",
      canonicalSha256: createHash("sha256").update(resultId).digest("hex"),
      resultJson: { result: { reportedWorkDisposition: "done", summary: "I delivered and verified the artifact." },
        terminal: { runTerminalState: "succeeded" } } });
    const earlierAssessmentId = randomUUID();
    const earlierDecisionAssessmentId = randomUUID();
    const earlierDecisionId = randomUUID();
    const earlierRows = [
      { id: earlierAssessmentId, summary: "Earlier evidence assessment", createdAt: new Date("2026-05-01T12:00:00Z") },
      { id: earlierDecisionAssessmentId, summary: "Earlier policy decision", createdAt: new Date("2026-05-01T11:00:00Z") },
    ];
    await db.insert(workAssessments).values(earlierRows.map(row => ({
      id: row.id, companyId: company.id, issueId: task.id, runId, contractId, resultId,
      triggerKind: "native_result", triggerRef: resultId, triggerCapability: "server_native_finalizer",
      triggerActorCompanyId: company.id, priorIssueStatus: "in_progress", priorStatusVersion: 1,
      policyVersion: "browser-assessor-v1", assessmentJson: { summary: row.summary },
      inputDigest: `browser-assessment-${row.id}`, createdAt: row.createdAt,
    })));
    await db.insert(statusDecisions).values({
      id: earlierDecisionId, companyId: company.id, issueId: task.id, runId,
      assessmentId: earlierDecisionAssessmentId, decisionVersion: 1, policyVersion: "browser-assessor-v1",
      fromStatus: "in_progress", toStatus: "in_progress", reasonCode: "completion_evidence_incomplete",
      decisionJson: { statusAction: "in_progress" }, decisionDigest: `browser-decision-${earlierDecisionId}`,
      applicationState: "proposed",
    });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: company.id, issueId: task.id, runId,
      contractId, resultId, triggerKind: "native_result", triggerRef: resultId,
      triggerCapability: "server_native_finalizer", triggerActorCompanyId: company.id,
      priorIssueStatus: "in_progress", priorStatusVersion: 1, policyVersion: "browser-assessor-v1",
      priorDecisionId: earlierDecisionId, supersedesAssessmentId: earlierAssessmentId,
      assessmentJson: { summary: "The claim is not supported by all readable evidence.", reportedDisposition: "done",
        allCriteriaSatisfied: false, verificationPassed: false,
        criterionAssessments: [{ criterionId: "artifact", claimStatus: "satisfied", outcome: "missing",
          reasonCode: "criterion_evidence_incomplete", evidenceRefs: [
            { ref: `work_product:${visibleProduct.id}`, kind: "work_product", outcome: "accepted",
              reasonCode: "work_product_authoritatively_accepted", durableRecordId: visibleProduct.id },
            { ref: `work_product:${restrictedProduct.id}`, kind: "work_product", outcome: "missing",
              reasonCode: "work_product_missing", durableRecordId: null },
          ] }],
        verificationAssessments: [{ commandOrCheck: "Run the focused checks", claimStatus: "passed", outcome: "missing",
          reasonCode: "durable_run_event_missing", detail: "No check receipt was recorded.",
          evidenceRef: { ref: "event:42", kind: "event", outcome: "missing", reasonCode: "durable_run_event_missing", durableRecordId: null } }],
      }, inputDigest: `browser-assessment-${assessmentId}` });
    await db.insert(statusDecisions).values({ id: decisionId, companyId: company.id, issueId: task.id, runId,
      assessmentId, decisionVersion: 2, policyVersion: "browser-assessor-v1", fromStatus: "in_progress", toStatus: "in_progress",
      supersedesDecisionId: earlierDecisionId,
      reasonCode: "completion_evidence_incomplete", decisionJson: { statusAction: "in_progress", toStatus: "in_progress",
        reasonCode: "completion_evidence_incomplete" }, decisionDigest: `browser-decision-${decisionId}`,
      applicationState: "proposed" });

    const historyResponse = await request.get(`/api/issues/${task.identifier}/completion-history`);
    const history = await json(historyResponse);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      contract: { completionAuthority: "server_arbiter", criteria: [{ requirement: "Deliver the reviewed artifact" }] },
      result: { summary: "I delivered and verified the artifact." },
      assessment: { allCriteriaSatisfied: false, verificationPassed: false,
        criterionAssessments: [{ claimStatus: "satisfied", outcome: "missing" }],
        verificationAssessments: [{
          claimStatus: "passed", outcome: "missing",
          evidence: { outcome: "missing", visibility: "missing" },
        }] },
      decision: { applicationState: "proposed", toStatus: "in_progress", statusAction: "in_progress", reasonCode: "completion_evidence_incomplete" },
    });
    const evidence = history[0].assessment.criterionAssessments[0].evidence;
    expect(evidence[0]).toMatchObject({ visibility: "available", recordId: visibleProduct.id, title: "Accepted same-task artifact" });
    expect(evidence[1]).toMatchObject({ outcome: "unverifiable", visibility: "restricted", label: "Supporting record is outside this task's readable scope." });
    expect(evidence[1]).not.toHaveProperty("recordId");
    expect(evidence[1]).not.toHaveProperty("ref");
    expect(JSON.stringify(history)).not.toContain(restrictedProduct.id);
    expect(JSON.stringify(history)).not.toContain("Other-task private artifact");
    expect(await json(await request.get(`/api/issues/${task.id}`))).toMatchObject({ status: "in_progress" });

    const historyReads: string[] = [];
    page.on("request", browserRequest => {
      if (browserRequest.url().includes("/completion-history")) historyReads.push(browserRequest.url());
    });
    await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
    await page.getByRole("button", { name: "Show properties" }).click();
    await page.getByRole("option", { name: "Properties", exact: true }).click();
    const historyDisclosure = page.getByText("Completion history", { exact: true });
    await expect(historyDisclosure).toBeVisible();
    expect(historyReads).toEqual([]);
    const authorizedRead = page.waitForResponse(response => response.url().endsWith(`/issues/${task.id}/completion-history`) && response.ok());
    await historyDisclosure.focus();
    await page.keyboard.press("Enter");
    await authorizedRead;

    const completionHistory = page.getByRole("region", { name: "Native completion history" });
    await expect(completionHistory).toBeVisible();
    const latest = completionHistory.getByRole("article").first();
    await expect(latest.getByText(/Requirements revision 1/)).toBeVisible();
    await expect(latest.getByText("Agent claim satisfied")).toBeVisible();
    await expect(latest.getByText("Policy assessment missing")).toBeVisible();
    await expect(latest.getByText("Evidence not verified")).toBeVisible();
    await expect(latest.getByRole("region", { name: "Status decision" })
      .getByText(/proposed · in progress → in progress · completion evidence incomplete · policy browser-assessor-v1/)).toBeVisible();
    await expect(latest.getByText("Work product: Accepted same-task artifact")).toBeVisible();
    await expect(latest.getByText("Supporting record is outside this task's readable scope.")).toBeVisible();

    const beforeJump = page.url();
    for (const pair of [
      { action: "Open earlier decision and evidence", target: "Earlier policy decision" },
      { action: "Open earlier assessment", target: "Earlier evidence assessment" },
    ]) {
      const button = latest.getByRole("button", { name: pair.action, exact: true });
      await button.focus();
      await page.keyboard.press("Enter");
      const target = completionHistory.getByRole("article").filter({ hasText: pair.target });
      await expect(target).toBeFocused();
      await expect(target).toHaveAccessibleName(/Native completion assessment/);
    }
    expect(page.url()).toBe(beforeJump);
    await expect(page.locator("body")).not.toContainText(restrictedProduct.id);
  } finally {
    await closeRegisteredClients(databaseUrl);
  }
});
