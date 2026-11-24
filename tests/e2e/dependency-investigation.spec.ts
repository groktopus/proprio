import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.status()} ${body}`).toBe(true);
  return JSON.parse(body);
}

test("asks the parent assignee to investigate and reads its wake after reload", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", { data: { name: "Dependency investigation fixture" } }));
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
  await expect.poll(async () => json(await request.get(investigationPath))).toMatchObject({
    state: "no_execution_path", cause: { kind: "unassigned_dependency", issueId: child.id },
    canInvestigate: true, wake: { status: "not_requested" },
  });
  await page.goto(`/${company.issuePrefix}/issues/${parent.identifier}`);
  const diagnosis = page.getByTestId("dependency-diagnosis-notice");
  await expect(diagnosis.getByRole("link", { name: new RegExp(child.title) })).toBeVisible();
  await expect(diagnosis).toContainText(parentAgent.name);
  await diagnosis.getByRole("button", { name: "Ask assignee to investigate" }).click();
  await expect.poll(async () => json(await request.get(investigationPath)), { timeout: 20_000 }).toMatchObject({
    wake: { status: "completed" }, canInvestigate: false,
  });
  await page.reload();
  await expect(diagnosis.getByTestId("dependency-parent-wake-state")).toHaveText("The parent diagnostic turn completed.");
  await expect(diagnosis.getByRole("button", { name: "Ask assignee to investigate" })).toHaveCount(0);
  const diagnostics = await json(await request.get(`/api/issues/${parent.id}/diagnostics/wakes`));
  expect(diagnostics.events.filter((event: { reason: string }) => event.reason === "issue_blocker_stalled"))
    .toEqual([expect.objectContaining({ kind: "wake_request", status: "completed" })]);
});
