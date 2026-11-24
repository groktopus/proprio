import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect, type APIResponse } from "@playwright/test";
import { eq } from "../../server/node_modules/drizzle-orm/index.js";
import { closeRegisteredClients, createDb, caseHandoffs, cases, issueRecoveryActions } from "../../packages/db/src/index.ts";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test("Case recovery history retains the earlier accepted revision and redacts unrelated evidence", async ({ page, request }) => {
  test.setTimeout(90_000);
  const config = JSON.parse(await readFile(process.env.PROPRIO_E2E_SERVER_CONFIG!, "utf8"));
  const databaseUrl = config.database.mode === "postgres" ? config.database.connectionString
    : `postgres://proprio:proprio@127.0.0.1:${(await readFile(`${config.database.embeddedPostgresDataDir}/postmaster.pid`, "utf8")).split("\n")[3]}/proprio`;
  const db = createDb(databaseUrl);

  try {
    const company = await json(await request.post("/api/companies", { data: { name: `Recovery history ${Date.now()}` } }));
    const first = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Recovery owner", role: "engineer", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""] },
      runtimeConfig: { heartbeat: { enabled: false } },
    } }));
    const newer = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Current owner", role: "engineer", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""] },
      runtimeConfig: { heartbeat: { enabled: false } },
    } }));
    const task = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Recover accepted handoff", description: "Review retained recovery evidence.", status: "in_progress", assigneeAgentId: newer.id,
    } }));
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableCases: true } }));
    const record = await json(await request.post(`/api/companies/${company.id}/cases`, { data: {
      caseType: "work", key: `recovery-${Date.now()}`, title: "Recovery review", status: "in_progress", fields: { objective: "Complete the accepted work" },
    } }));
    await json(await request.post(`/api/cases/${record.id}/links`, { data: { issueId: task.id, role: "work" } }));
    await db.update(cases).set({ workIssueId: task.id }).where(eq(cases.id, record.id));

    const requirementId = randomUUID(), newerRequirementId = randomUUID(), priorHandoffId = randomUUID(), currentHandoffId = randomUUID();
    const digest = createHash("sha256").update("accepted-requirements-revision-1").digest("hex");
    const newerDigest = createHash("sha256").update("accepted-requirements-revision-2").digest("hex");
    const offerContract = { schema: "proprio.case-handoff-offer.v1", expectedDeliverable: "Verified report", prerequisites: [],
      requirementRevision: { id: requirementId, revision: 1, canonicalSha256: "a".repeat(64) }, requirementsDigest: digest,
      workflowTransition: null, decisionOwner: { type: "agent", id: first.id }, accountableOwner: { type: "agent", id: first.id } };
    const newerOfferContract = { ...offerContract, expectedDeliverable: "Updated verified report", requirementRevision: {
      id: newerRequirementId, revision: 2, canonicalSha256: "b".repeat(64),
    }, requirementsDigest: newerDigest, decisionOwner: { type: "agent" as const, id: newer.id }, accountableOwner: { type: "agent" as const, id: newer.id } };
    const handoffRow = (id: string, version: number, recipientId: string, acceptedAt: string) => ({
      id, companyId: company.id, caseId: record.id, issueId: task.id, version, fromAgentId: first.id, destinationKind: "agent" as const,
      toAgentId: recipientId, phase: version === 1 ? "Prior accepted commitment" : "Current commitment", instructions: "Review the saved report.",
      actorType: "user" as const, actorId: "local-board", wakeupRequestId: randomUUID(), idempotencyKey: randomUUID(), inputFingerprint: `fingerprint-${id}`,
      state: "delivered" as const, offerContract, recipientDecision: { outcome: "accepted", actorType: "agent", actorId: recipientId,
        handoffVersion: version, requirementRevisionId: requirementId, requirementsDigest: digest, decidedAt: acceptedAt },
      createdAt: new Date(Date.now() - (3 - version) * 60_000), deliveredAt: new Date(),
    });
    await db.insert(caseHandoffs).values([handoffRow(priorHandoffId, 1, first.id, "2026-11-20T10:00:00.000Z"),
      { ...handoffRow(currentHandoffId, 2, newer.id, "2026-11-21T10:00:00.000Z"), offerContract: newerOfferContract,
        recipientDecision: { outcome: "accepted", actorType: "agent", actorId: newer.id, handoffVersion: 2,
          requirementRevisionId: newerRequirementId, requirementsDigest: newerDigest, decidedAt: "2026-11-21T10:00:00.000Z" } }]);

    const runId = randomUUID(), decisionId = randomUUID(), assessmentId = randomUUID();
    const privateTaskId = (await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Private evidence source", status: "todo", visibility: "private",
    } }))).id;
    await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: task.id, kind: "active_run_watchdog",
      status: "cancelled", ownerType: "agent", ownerAgentId: first.id, cause: "completion_evidence_incomplete", fingerprint: randomUUID(),
      nextAction: "PRIVATE_NEXT_ACTION", attemptCount: 2, maxAttempts: 3, outcome: "cancelled", resolutionNote: "Superseded by newer acceptance.",
      evidence: { runId, caseHandoffCompletion: { schema: "proprio.case-handoff-completion-recovery.v1",
        caseHandoff: { id: priorHandoffId, version: 1, requirementsDigest: digest, acceptedRequirementRevision: { id: requirementId } },
        decision: { id: decisionId, statusDecisionReasonCode: "completion_evidence_incomplete" },
        assessment: { id: assessmentId, assessedContractId: requirementId, assessedContractRevision: { revision: 2 },
          criteriaNeedingWork: [{ criterionId: "report", requirement: "Attach the reviewed report", outcome: "missing", reasonCode: "criterion_evidence_missing",
            evidence: [{ outcome: "missing", reasonCode: "event_missing", ref: `private-task:${privateTaskId}:SECRET_BODY` }] }] },
        attempts: [{ runId, decisionId, assessmentId, assessedContractId: requirementId, reasonCode: "completion_evidence_incomplete" }] } },
    });

    const calls: string[] = [];
    page.on("request", req => { if (req.method() === "GET" && req.url().includes("/recovery-history")) calls.push(req.url()); });
    await page.goto(`/${company.issuePrefix}/cases/${record.id}`);
    await expect(page.getByRole("region", { name: "Case work" }).getByText("Current owner", { exact: true })).toBeVisible();
    const handoffs = page.getByRole("region", { name: "Case handoffs" });
    await expect(handoffs.getByText("Prior accepted commitment", { exact: true })).toBeVisible();
    await expect(handoffs.getByText("Current commitment", { exact: true })).toBeVisible();
    const prior = handoffs.locator("li").filter({ hasText: "Prior accepted commitment" });
    await prior.locator("summary").first().click();
    const recovery = prior.getByText("Recovery history", { exact: false });
    await expect(recovery).toBeVisible();
    expect(calls).toHaveLength(0);
    await recovery.click();
    await expect(prior.getByText("Accepted requirements · revision 1", { exact: false })).toBeVisible();
    await expect(prior.getByText("Assessed revision 2", { exact: false })).toBeVisible();
    await expect(prior.getByText("Attach the reviewed report", { exact: true })).toBeVisible();
    await expect(prior.getByRole("link", { name: `Run ${runId.slice(0, 8)}` })).toHaveAttribute("href", `/${company.issuePrefix}/agents/${first.id}/runs/${runId}`);
    await expect(prior.getByText("Superseded by newer acceptance.", { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("PRIVATE_NEXT_ACTION");
    await expect(page.locator("body")).not.toContainText("SECRET_BODY");
    await expect(page.locator("body")).not.toContainText(privateTaskId);
    expect(calls).toHaveLength(1);
    const history = await json(await request.get(`/api/cases/${record.id}/handoffs/${priorHandoffId}/recovery-history`));
    expect(history.entries[0].attempts[0].runId).toBe(runId);
    expect(JSON.stringify(history)).not.toContain("SECRET_BODY");
  } finally {
    await closeRegisteredClients(databaseUrl);
  }
});
