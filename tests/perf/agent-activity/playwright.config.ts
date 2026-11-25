import path from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.PROPRIO_PERF_BASE_URL;
const storageState = process.env.PROPRIO_PERF_STORAGE_STATE;
if (!baseURL) throw new Error("PROPRIO_PERF_BASE_URL is required for the authenticated agent-activity cross-check");
const target = new URL(baseURL);
if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
  throw new Error("PROPRIO_PERF_BASE_URL must be an origin without credentials, query, or hash");
}
if (!storageState) throw new Error("PROPRIO_PERF_STORAGE_STATE is required for the authenticated agent-activity cross-check");

export default defineConfig({
  testDir: ".",
  testMatch: "submit-to-first-visible.spec.ts",
  timeout: 60_000,
  workers: 1,
  use: { baseURL, storageState: path.resolve(storageState), browserName: "chromium", headless: true },
  reporter: [["list"]],
});
