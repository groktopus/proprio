import { defineConfig } from "@playwright/test";

const baseURL = process.env.SMOKE_BASE_URL;
if (!baseURL) throw new Error("SMOKE_BASE_URL must come from docker-onboard-smoke metadata");

export default defineConfig({
  testDir: ".",
  testMatch: "onboarding-inference-compose.spec.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: { baseURL, browserName: "chromium", headless: true, screenshot: "off", trace: "off" },
  reporter: "list",
  globalTeardown: "./playwright-docker-onboard-teardown.ts",
});
