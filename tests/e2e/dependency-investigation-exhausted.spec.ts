import { test, expect } from "@playwright/test";
import { activityLog, closeRegisteredClients, createDb } from "../../packages/db/src/index.ts";
import { json } from "./http.ts";
import { readTestServerDatabaseUrl } from "./server-database-url.ts";

test("shows an exhausted parent diagnosis after reload", async ({ page, request }) => {
  const databaseUrl = await readTestServerDatabaseUrl();
  const db = createDb(databaseUrl);
  let companyId: string | undefined;

  try {
    const company = await json(await request.post("/api/companies", { data: { name: `Exhausted diagnosis ${Date.now()}` } }));
    companyId = company.id;
    const companyPath = `/api/companies/${company.id}`;
    const parentAgent = await json(await request.post(`${companyPath}/agents`, { data: {
      name: "Dependency investigator", role: "engineer", adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    } }));
    const child = await json(await request.post(`${companyPath}/issues`, { data: { title: "Unassigned dependency", status: "todo" } }));
    const parent = await json(await request.post(`${companyPath}/issues`, { data: {
      title: "Review required dependency", status: "in_progress", assigneeAgentId: parentAgent.id, blockedByIssueIds: [child.id],
    } }));
    const investigationPath = `/api/issues/${parent.id}/dependency-investigation`;
    const before = await json(await request.get(investigationPath));
    expect(before).toMatchObject({ state: "no_execution_path", cause: { kind: "unassigned_dependency", issueId: child.id },
      canInvestigate: true, wake: { status: "not_requested" } });

    // Seed only the durable exhausted receipt. This journey covers operator presentation after exhaustion.
    await db.insert(activityLog).values({ companyId: company.id, actorType: "system", actorId: "playwright-fixture",
      action: "issue.dependency_diagnosis.requested", entityType: "issue", entityId: parent.id, agentId: parentAgent.id,
      details: { idempotencyKey: before.wake.idempotencyKey, dependencyPathDigest: before.wake.idempotencyKey,
        outcome: "exhausted", attempt: 3, source: "user", assigneeAgentId: parentAgent.id,
        message: "Automatic diagnosis wake admission was refused three times." } });

    const diagnosis = await json(await request.get(investigationPath));
    expect(diagnosis).toMatchObject({ wake: { status: "exhausted" }, canInvestigate: false,
      nextOwner: { type: "agent", name: parentAgent.name },
      nextAction: "The diagnostic continuation could not start. Review the parent task’s execution status for the current next step." });
    await page.goto(`/${company.issuePrefix}/issues/${parent.identifier}`);
    const notice = page.getByTestId("dependency-diagnosis-notice");
    await expect(notice.getByTestId("dependency-parent-wake-state")).toHaveText("The parent wake has exhausted its attempts.");
    await expect(notice).toContainText("The diagnostic continuation could not start. Review the parent task’s execution status for the current next step.");
    await expect(notice.getByRole("button", { name: "Ask assignee to investigate" })).toHaveCount(0);
    await page.reload();
    await expect(notice.getByTestId("dependency-parent-wake-state")).toHaveText("The parent wake has exhausted its attempts.");
    await expect(notice).toContainText("The diagnostic continuation could not start. Review the parent task’s execution status for the current next step.");
    await expect(notice.getByRole("button", { name: "Ask assignee to investigate" })).toHaveCount(0);

  } finally {
    try {
      if (companyId) await request.patch(`/api/companies/${companyId}`, { data: { status: "archived" } });
    } finally {
      await closeRegisteredClients(databaseUrl, { scope: "database" });
    }
  }
});
