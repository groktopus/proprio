import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

test("authenticated public onboarding keeps a signed-out Codex draft blocked", async ({ page, request }) => {
  const base = process.env.SMOKE_BASE_URL!;
  const adminEmail = process.env.SMOKE_ADMIN_EMAIL!;
  const adminPassword = process.env.SMOKE_ADMIN_PASSWORD!;
  const healthResponse = await request.get("/api/health");
  expect(healthResponse.ok()).toBeTruthy();
  expect(await healthResponse.json()).toMatchObject({ deploymentMode: "authenticated", deploymentExposure: "public" });

  const signedOut = await request.get("/api/companies");
  expect(signedOut.status()).toBe(401);
  await page.goto("/auth");
  await expect(page.getByRole("heading", { name: "Sign in to Proprio" })).toBeVisible();
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });

  const sessionResponse = await page.request.get(`${base}/api/auth/get-session`);
  expect(sessionResponse.ok()).toBeTruthy();
  const chatFlagResponse = await page.request.patch(`${base}/api/instance/settings/experimental`, {
    data: { enableAgentChat: true },
  });
  expect(chatFlagResponse.ok()).toBeTruthy();
  const companyResponse = await page.request.post(`${base}/api/companies`, { data: { name: `Compose inference ${Date.now()}` } });
  expect(companyResponse.ok()).toBeTruthy();
  const company = await companyResponse.json() as { id: string; issuePrefix: string };

  const draftResponse = await page.request.post(`${base}/api/companies/${company.id}/agents`, {
    data: {
      setupId: randomUUID(), name: "Ada", adapterType: "codex_local", runner: "legacy",
      adapterConfig: { model: "gpt-5-codex" }, metadata: { setupAdapterPending: false },
    },
  });
  expect(draftResponse.ok()).toBeTruthy();
  const draft = await draftResponse.json() as { id: string; pauseReason: string; adapterConfig: { model: string } };
  expect(draft).toMatchObject({ pauseReason: "setup", adapterConfig: { model: "gpt-5-codex" } });

  // No Codex credential is installed in the fresh Compose data directory.
  // This calls the real public adapter probe route; it is not intercepted.
  const probe = await page.request.post(`${base}/api/companies/${company.id}/adapters/codex_local/test-environment`, {
    data: { agentId: draft.id, adapterConfig: draft.adapterConfig, runner: "legacy" },
  });
  expect(probe.status()).toBe(422);
  expect((await probe.json()).code).toBe("ai_connection_validation_failed");

  // Opening a conversation is safe before verification. The greeting route
  // must refuse to enqueue work while the setup hold is still present.
  const conversationResponse = await page.request.post(`${base}/api/companies/${company.id}/chats/${draft.id}/onboarding`);
  expect(conversationResponse.ok()).toBeTruthy();
  const conversation = await conversationResponse.json() as { id: string };
  const earlyGreeting = await page.request.post(`${base}/api/companies/${company.id}/chats/${draft.id}/onboarding/greeting`);
  expect(earlyGreeting.status()).toBe(409);
  expect(await earlyGreeting.json()).toMatchObject({ code: "onboarding_agent_not_ready" });
  const earlyRuns = await page.request.get(`${base}/api/issues/${conversation.id}/runs`);
  expect(await earlyRuns.json()).toEqual([]);
  const earlyActivity = await page.request.get(`${base}/api/issues/${conversation.id}/activity`);
  expect((await earlyActivity.json()).filter((event: { action: string }) => event.action === "issue.onboarding_welcome_started")).toHaveLength(0);
  const fixtureLogPath = path.join(process.env.SMOKE_DATA_DIR!, "onboarding-codex-fixture.jsonl");
  await expect.poll(() => {
    try { return readFileSync(fixtureLogPath, "utf8").trim().split("\n").map(line => JSON.parse(line)); }
    catch { return []; }
  }).toEqual([{ event: "probe", credentialPresent: false, model: "gpt-5-codex", fixture: true }]);
  const afterProbe = await page.request.get(`${base}/api/agents/${draft.id}?companyId=${company.id}`);
  expect(afterProbe.ok()).toBeTruthy();
  expect(await afterProbe.json()).toMatchObject({ id: draft.id, pauseReason: "setup", adapterConfig: { model: "gpt-5-codex" } });

  // Resume the same persisted setup record through the real onboarding UI.
  // The synthetic key is accepted only by the mounted CLI fixture; it is not
  // sent to OpenAI and is never written to the fixture log.
  await page.evaluate(({ companyId, companyName, companyPrefix, agentId }) => {
    localStorage.setItem("proprio-onboarding-state", JSON.stringify({
      step: 4, companyName, agentName: "Ada", adapterType: "codex_local", runner: "legacy",
      credentialMode: "api", credentialModeChoice: "api", model: "gpt-5-codex",
      createdCompanyId: companyId, createdCompanyPrefix: companyPrefix,
      createdAgentId: null, setupAgentId: agentId,
    }));
  }, { companyId: company.id, companyName: company.name, companyPrefix: company.issuePrefix, agentId: draft.id });
  await page.goto(`${base}/onboarding`);
  await expect(page.getByRole("heading", { name: "Connect a model", exact: true })).toBeVisible({ timeout: 30_000 });
  const keyInput = page.getByLabel("API key", { exact: true });
  await expect(keyInput).toBeVisible({ timeout: 30_000 });
  await keyInput.fill("sk-controlled-fixture-only");
  const connect = page.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeEnabled();
  const successfulProbe = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().endsWith(`/api/companies/${company.id}/adapters/codex_local/test-environment`));
  await connect.click();
  const successfulProbeResponse = await successfulProbe;
  expect(successfulProbeResponse.ok()).toBeTruthy();
  expect(await successfulProbeResponse.json()).toMatchObject({ status: "pass" });
  await expect.poll(() => {
    try { return readFileSync(fixtureLogPath, "utf8").trim().split("\n").map(line => JSON.parse(line)); }
    catch { return []; }
  }).toEqual([
    { event: "probe", credentialPresent: false, model: "gpt-5-codex", fixture: true },
    { event: "probe", credentialPresent: true, model: "gpt-5-codex", fixture: true },
  ]);
  const repaired = await (await page.request.get(`${base}/api/agents/${draft.id}?companyId=${company.id}`)).json();
  expect(repaired).toMatchObject({ id: draft.id, adapterConfig: { model: "gpt-5-codex" }, runtimeConfig: { aiConnection: { provider: "openai", method: "api_key" } } });
  await page.reload();
  await expect.poll(async () => {
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem("proprio-onboarding-state") ?? "null"));
    return state?.setupAgentId;
  }).toBe(draft.id);
  expect(repaired).toMatchObject({ id: draft.id, lifecycleState: "ready" });
  await page.reload();
  await expect(page.getByRole("button", { name: /Get started/ })).toBeVisible();
  const afterReload = await (await page.request.get(`${base}/api/agents/${draft.id}?companyId=${company.id}`)).json();
  expect(afterReload).toMatchObject({ id: draft.id, lifecycleState: "ready", adapterConfig: { model: "gpt-5-codex" } });

  // Let the normal wizard/chat transition enqueue the first greeting. Repeated
  // calls then model duplicate submit and reload retries; both must resolve to
  // the same queued wake and one visible activity record.
  await page.getByRole("button", { name: /Get started/ }).click();
  await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/chats/${draft.id}$`), { timeout: 30_000 });
  await expect(page.getByTestId("task-chat-composer-add")).toBeVisible({ timeout: 30_000 });
  const readGreetingEvidence = async () => {
    const activityResponse = await page.request.get(`${base}/api/issues/${conversation.id}/activity`);
    const runResponse = await page.request.get(`${base}/api/issues/${conversation.id}/runs`);
    expect(activityResponse.ok()).toBeTruthy();
    expect(runResponse.ok()).toBeTruthy();
    const activities = await activityResponse.json() as Array<{ action: string }>;
    return {
      greetings: activities.filter(event => event.action === "issue.onboarding_welcome_started").length,
      runs: await runResponse.json() as unknown[],
    };
  };
  await expect.poll(async () => (await readGreetingEvidence()).greetings, { timeout: 30_000 }).toBe(1);
  await page.reload();
  await expect(page.getByTestId("task-chat-composer-add")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await readGreetingEvidence()).greetings, { timeout: 30_000 }).toBe(1);
  const duplicateGreetings = await Promise.all([
    page.request.post(`${base}/api/companies/${company.id}/chats/${draft.id}/onboarding/greeting`),
    page.request.post(`${base}/api/companies/${company.id}/chats/${draft.id}/onboarding/greeting`),
  ]);
  for (const response of duplicateGreetings) {
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toMatchObject({ started: true });
  }
  const finalGreetingEvidence = await readGreetingEvidence();
  expect(finalGreetingEvidence.greetings).toBe(1);
  expect(finalGreetingEvidence.runs).toHaveLength(1);
});
