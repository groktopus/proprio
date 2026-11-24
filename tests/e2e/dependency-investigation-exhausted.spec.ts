import { readFile } from "node:fs/promises";
import { test, expect, type APIResponse } from "@playwright/test";
import { activityLog, closeRegisteredClients, createDb } from "../../packages/db/src/index.ts";

async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.status()} ${body}`).toBe(true);
  return JSON.parse(body);
}

test("shows an exhausted parent diagnosis after reload", async ({ page, request }) => {
  const config = JSON.parse(await readFile(process.env.PROPRIO_E2E_SERVER_CONFIG!, "utf8"));
  const databaseUrl = config.database.mode === "postgres" ? config.database.connectionString
    : `postgres://proprio:proprio@127.0.0.1:${(await readFile(`${config.database.embeddedPostgresDataDir}/postmaster.pid`, "utf8")).split("\n")[3]}/proprio`;
  const db = createDb(databaseUrl);

  try {
    const company = await json(await request.post("/api/companies", { data: { name: `Exhausted diagnosis ${Date.now()}` } }));
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
      nextOwner: { type: "agent", id: parentAgent.id, name: parentAgent.name },
      nextAction: "Automatic diagnosis wake admission was refused three times." });
    await page.goto(`/${company.issuePrefix}/issues/${parent.identifier}`);
    const notice = page.getByTestId("dependency-diagnosis-notice");
    await expect(notice.getByTestId("dependency-parent-wake-state")).toHaveText("The parent wake has exhausted its attempts.");
    await expect(notice).toContainText("Automatic diagnosis wake admission was refused three times.");
    await expect(notice.getByRole("button", { name: "Ask assignee to investigate" })).toHaveCount(0);
    await page.reload();
    await expect(notice.getByTestId("dependency-parent-wake-state")).toHaveText("The parent wake has exhausted its attempts.");
    await expect(notice).toContainText("Automatic diagnosis wake admission was refused three times.");
    await expect(notice.getByRole("button", { name: "Ask assignee to investigate" })).toHaveCount(0);

  } finally {
    await closeRegisteredClients(databaseUrl, { scope: "database" });
  }
});
