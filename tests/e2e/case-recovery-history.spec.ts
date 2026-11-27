import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { eq } from "../../server/node_modules/drizzle-orm/index.js";
import { closeRegisteredClients, createDb, caseHandoffs, cases, heartbeatRuns, issueRecoveryActions } from "../../packages/db/src/index.ts";
import type { CaseHandoffOfferContract, CaseHandoffRecipientDecision } from "@groktopus/shared";

import { json } from "./http";
import { readTestServerDatabaseUrl } from "./server-database-url";

let cleanup: { companyId?: string; enableCases: boolean } | undefined;

test.afterEach(async ({ request }, testInfo) => {
  const state = cleanup;
  cleanup = undefined;
  if (!state) return;
  testInfo.setTimeout(15_000);
  const results = await Promise.allSettled([
    request.patch("/api/instance/settings/experimental", { data: { enableCases: state.enableCases }, timeout: 5_000 }),
    ...(state.companyId ? [request.patch(`/api/companies/${state.companyId}`, { data: { status: "archived" }, timeout: 5_000 })] : []),
  ]);
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`Cleanup ${index}: ${String(result.reason)}`]
    : result.value.ok() ? [] : [`Cleanup ${index}: HTTP ${result.value.status()}`]);
  if (!failures.length) return;
  await testInfo.attach("cleanup-failure", { body: Buffer.from(JSON.stringify({ companyId: state.companyId, failures })), contentType: "application/json" }).catch(() => undefined);
  if (testInfo.status === "passed") throw new Error(failures.join("\n"));
});

test("Case recovery history retains the earlier accepted revision and redacts unrelated evidence", async ({ page, request }) => {
  test.setTimeout(90_000);
  const databaseUrl = await readTestServerDatabaseUrl();
  const db = createDb(databaseUrl);

  try {
    const originalSettings = await json(await request.get("/api/instance/settings/experimental"));
    const cleanupState: { companyId?: string; enableCases: boolean } = { enableCases: originalSettings.enableCases };
    cleanup = cleanupState;
    const company = await json(await request.post("/api/companies", { data: { name: `Recovery history ${Date.now()}` } }));
    cleanupState.companyId = company.id;
    const first = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Recovery owner", role: "engineer", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } }));
    const newer = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Current owner", role: "engineer", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } }));
    const task = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Recover accepted handoff", description: "Review retained recovery evidence.", status: "in_progress", visibility: "open", assigneeAgentId: newer.id,
    } }));
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableCases: true } }));
    const record = await json(await request.post(`/api/companies/${company.id}/cases`, { data: {
      caseType: "work", key: `recovery-${Date.now()}`, title: "Recovery review", status: "in_progress", fields: { objective: "Complete the accepted work" },
    } }));
    await json(await request.post(`/api/cases/${record.id}/links`, { data: { issueId: task.id, role: "work" } }));
    await db.update(cases).set({ workIssueId: task.id, handoffVersion: 2 }).where(eq(cases.id, record.id));

    const requirementId = randomUUID(), newerRequirementId = randomUUID(), priorHandoffId = randomUUID(), currentHandoffId = randomUUID();
    const digest = createHash("sha256").update("accepted-requirements-revision-1").digest("hex");
    const newerDigest = createHash("sha256").update("accepted-requirements-revision-2").digest("hex");
    const offerContract: CaseHandoffOfferContract = { schema: "proprio.case-handoff-offer.v1", expectedDeliverable: "Verified report", prerequisites: [],
      requirementRevision: { id: requirementId, revision: 1, canonicalSha256: "a".repeat(64) }, requirementsDigest: digest,
      taskBrief: { title: task.title, description: task.description ?? null } };
    const newerOfferContract: CaseHandoffOfferContract = { schema: "proprio.case-handoff-offer.v1", expectedDeliverable: "Updated verified report", prerequisites: [],
      requirementRevision: { id: newerRequirementId, revision: 2, canonicalSha256: "b".repeat(64) }, requirementsDigest: newerDigest,
      taskBrief: { title: task.title, description: task.description ?? null } };
    const priorDecision: CaseHandoffRecipientDecision = { outcome: "accepted", actorType: "agent", actorId: first.id,
      handoffVersion: 1, requirementRevisionId: requirementId, requirementsDigest: digest, decidedAt: "2026-11-20T10:00:00.000Z" };
    const currentDecision: CaseHandoffRecipientDecision = { outcome: "accepted", actorType: "agent", actorId: newer.id,
      handoffVersion: 2, requirementRevisionId: newerRequirementId, requirementsDigest: newerDigest, decidedAt: "2026-11-21T10:00:00.000Z" };
    const handoffRow = (id: string, version: number, recipientId: string, offer: CaseHandoffOfferContract,
      decision: CaseHandoffRecipientDecision): typeof caseHandoffs.$inferInsert => ({
      id, companyId: company.id, caseId: record.id, issueId: task.id, version, fromAgentId: first.id, destinationKind: "agent" as const,
      toAgentId: recipientId, phase: version === 1 ? "Prior accepted commitment" : "Current commitment", instructions: "Review the saved report.",
      actorType: "user" as const, actorId: "local-board", wakeupRequestId: randomUUID(), idempotencyKey: randomUUID(), inputFingerprint: `fingerprint-${id}`,
      state: "delivered" as const, offerContract: offer, recipientDecision: decision,
      createdAt: new Date(Date.now() - (3 - version) * 60_000), deliveredAt: new Date(),
    });
    await db.insert(caseHandoffs).values([
      handoffRow(priorHandoffId, 1, first.id, offerContract, priorDecision),
      handoffRow(currentHandoffId, 2, newer.id, newerOfferContract, currentDecision),
    ]);

    const runId = randomUUID(), decisionId = randomUUID(), assessmentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, agentId: first.id, scopeKind: "issue",
      issueId: task.id, status: "succeeded", runtimeMode: "legacy", startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId: task.id } });
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
    const runLink = prior.getByRole("link", { name: `Run ${runId.slice(0, 8)}` });
    await expect(runLink).toHaveAttribute("href", `/${company.issuePrefix}/agents/${first.id}/runs/${runId}`);
    await expect(prior.getByText("Superseded by newer acceptance.", { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("PRIVATE_NEXT_ACTION");
    await expect(page.locator("body")).not.toContainText("SECRET_BODY");
    await expect(page.locator("body")).not.toContainText(privateTaskId);
    // The authorized-history query can cancel and retry as its observer updates.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(url => url.endsWith(`/cases/${record.id}/handoffs/${priorHandoffId}/recovery-history`))).toBe(true);
    const history = await json(await request.get(`/api/cases/${record.id}/handoffs/${priorHandoffId}/recovery-history`));
    expect(history.entries[0].attempts[0].runId).toBe(runId);
    const historyJson = JSON.stringify(history);
    expect(historyJson).not.toContain("SECRET_BODY");
    expect(historyJson).not.toContain("PRIVATE_NEXT_ACTION");
    expect(historyJson).not.toContain(privateTaskId);

    const runResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/heartbeat-runs/${runId}`);
    await runLink.click();
    const loadedRun = await runResponse;
    expect(loadedRun.ok()).toBe(true);
    expect(await loadedRun.json()).toMatchObject({ id: runId, companyId: company.id, agentId: first.id, issueId: task.id });
  } finally {
    await closeRegisteredClients(databaseUrl);
  }
});
