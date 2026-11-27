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

  await page.reload();
  expect(await (await page.request.get(`${base}/api/agents/${draft.id}?companyId=${company.id}`)).json()).toMatchObject({
    id: draft.id, pauseReason: "setup", adapterConfig: { model: "gpt-5-codex" },
  });
});
