import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect, type APIResponse } from "@playwright/test";
import { createDb, closeRegisteredClients, completionContracts, heartbeatRuns, nativeRunResults,
  statusDecisions, workAssessments } from "../../packages/db/src/index.ts";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test("Activity distinguishes a completion claim from evidence assessment and redacts another task's artifact", async ({ page, request }) => {
  test.setTimeout(90_000);
  const config = JSON.parse(await readFile(process.env.PROPRIO_E2E_SERVER_CONFIG!, "utf8"));
  const databaseUrl = config.database.mode === "postgres" ? config.database.connectionString
    : `postgres://proprio:proprio@127.0.0.1:${(await readFile(
      `${config.database.embeddedPostgresDataDir}/postmaster.pid`, "utf8")).split("\n")[3]}/proprio`;
  const db = createDb(databaseUrl);

  try {
    const company = await json(await request.post("/api/companies", {
      data: { name: `Completion history browser ${Date.now()}` },
    }));
    const [agent] = await json(await request.get(`/api/companies/${company.id}/agents`));
    const task = await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: "Review completion evidence", description: "Inspect the recorded native completion decision.", status: "in_progress" },
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
    await db.insert(workAssessments).values({ id: assessmentId, companyId: company.id, issueId: task.id, runId,
      contractId, resultId, triggerKind: "native_result", triggerRef: resultId,
      triggerCapability: "server_native_finalizer", triggerActorCompanyId: company.id,
      priorIssueStatus: "in_progress", priorStatusVersion: 1, policyVersion: "browser-assessor-v1",
      assessmentJson: { summary: "The claim is not supported by all readable evidence.", reportedDisposition: "done",
        allCriteriaSatisfied: false, verificationPassed: false,
        criterionAssessments: [{ criterionId: "artifact", claimStatus: "satisfied", outcome: "missing",
          reasonCode: "criterion_evidence_incomplete", evidenceRefs: [
            { ref: `work_product:${visibleProduct.id}`, kind: "work_product", outcome: "accepted",
              reasonCode: "work_product_authoritatively_accepted", durableRecordId: visibleProduct.id },
            { ref: `work_product:${restrictedProduct.id}`, kind: "work_product", outcome: "accepted",
              reasonCode: "work_product_authoritatively_accepted", durableRecordId: restrictedProduct.id },
          ] }],
        verificationAssessments: [{ commandOrCheck: "Run the focused checks", claimStatus: "passed", outcome: "missing",
          reasonCode: "verification_evidence_missing", detail: "No check receipt was recorded.",
          evidenceRef: { ref: "event:42", kind: "event", outcome: "accepted", reasonCode: "run_event_missing", durableRecordId: null } }],
      }, inputDigest: `browser-assessment-${assessmentId}` });
    await db.insert(statusDecisions).values({ id: decisionId, companyId: company.id, issueId: task.id, runId,
      assessmentId, decisionVersion: 1, policyVersion: "browser-assessor-v1", fromStatus: "in_progress", toStatus: "done",
      reasonCode: "completion_evidence_incomplete", decisionJson: { statusAction: "keep_open", toStatus: "done",
        reasonCode: "completion_evidence_incomplete" }, decisionDigest: `browser-decision-${decisionId}`,
      applicationState: "proposed" });

    const experimental = await json(await request.get("/api/instance/settings/experimental"));
    if (!experimental.enableClassicTaskInterface) {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: true } }));
    }

    const historyResponse = await request.get(`/api/issues/${task.identifier}/completion-history`);
    const history = await json(historyResponse);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      contract: { completionAuthority: "server_arbiter", criteria: [{ requirement: "Deliver the reviewed artifact" }] },
      result: { summary: "I delivered and verified the artifact." },
      assessment: { allCriteriaSatisfied: false, verificationPassed: false,
        criterionAssessments: [{ claimStatus: "satisfied", outcome: "missing" }],
        verificationAssessments: [{ claimStatus: "passed", outcome: "missing" }] },
      decision: { applicationState: "proposed", reasonCode: "completion_evidence_incomplete" },
    });
    const evidence = history[0].assessment.criterionAssessments[0].evidence;
    expect(evidence[0]).toMatchObject({ visibility: "available", recordId: visibleProduct.id, title: "Accepted same-task artifact" });
    expect(evidence[1]).toMatchObject({ visibility: "restricted", label: "Supporting record is outside this task's readable scope." });
    expect(evidence[1]).not.toHaveProperty("recordId");
    expect(evidence[1]).not.toHaveProperty("ref");
    expect(JSON.stringify(history)).not.toContain(restrictedProduct.id);
    expect(JSON.stringify(history)).not.toContain("Other-task private artifact");
    expect(await json(await request.get(`/api/issues/${task.id}`))).toMatchObject({ status: "in_progress" });

    await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
    const activityTab = page.getByRole("tab", { name: "Activity", exact: true });
    await expect(activityTab).toBeVisible();
    await activityTab.click();

    const completionHistory = page.getByRole("region", { name: "Native completion history" });
    await expect(completionHistory).toBeVisible();
    await expect(completionHistory.getByText("Agent claim satisfied")).toBeVisible();
    await expect(completionHistory.getByText("Policy assessment missing")).toBeVisible();
    await expect(completionHistory.getByText("Evidence verification failed")).toBeVisible();
    await expect(completionHistory.getByRole("region", { name: "Status decision" })
      .getByText(/proposed · in progress → done · completion evidence incomplete · policy browser assessor v1/)).toBeVisible();
    await expect(completionHistory.getByText("Work product: Accepted same-task artifact")).toBeVisible();
    await expect(completionHistory.getByText("Supporting record is outside this task's readable scope.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(restrictedProduct.id);
  } finally {
    await closeRegisteredClients(databaseUrl);
  }
});
