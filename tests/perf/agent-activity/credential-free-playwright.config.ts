import { defineConfig } from "@playwright/test";

const baseURL = process.env.PROPRIO_PERF_BASE_URL;
if (!baseURL) throw new Error("PROPRIO_PERF_BASE_URL is required for the credential-free agent-activity cross-check");
const target = new URL(baseURL);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password || target.search || target.hash) {
  throw new Error("PROPRIO_PERF_BASE_URL must be a credential-free 127.0.0.1 loopback origin without query or hash");
}

export default defineConfig({
  testDir: ".",
  testMatch: "credential-free-submit-cross-check.spec.ts",
  outputDir: "test-results/agent-activity/playwright",
  timeout: 90_000,
  workers: 1,
  use: { baseURL, browserName: "chromium", headless: true },
  reporter: [["list"]],
});
