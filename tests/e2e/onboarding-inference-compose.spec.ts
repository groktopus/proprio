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

  await page.reload();
  expect(await (await page.request.get(`${base}/api/agents/${draft.id}?companyId=${company.id}`)).json()).toMatchObject({
    id: draft.id, pauseReason: "setup", adapterConfig: { model: "gpt-5-codex" },
  });
});
