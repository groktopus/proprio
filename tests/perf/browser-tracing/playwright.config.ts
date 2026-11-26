import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const port = Number(process.env.PROPRIO_BROWSER_TRACING_PORT ?? 3237);
const collectorPort = Number(process.env.PROPRIO_BROWSER_TRACING_COLLECTOR_PORT ?? 3238);
const mode = process.env.PROPRIO_BROWSER_TRACING_MODE ?? "enabled";
const baseURL = `http://127.0.0.1:${port}`;
const proprioHome = fs.mkdtempSync(path.join(os.tmpdir(), "proprio-browser-tracing-home-"));
const instanceId = "playwright-browser-tracing";
const configPath = path.join(proprioHome, "instances", instanceId, "config.json");

if (!["enabled", "disabled", "unsampled", "sink-failure"].includes(mode)) {
  throw new Error(`Unknown PROPRIO_BROWSER_TRACING_MODE=${mode}`);
}

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 90_000,
  workers: 1,
  use: { baseURL, browserName: "chromium", headless: true },
  webServer: {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    command: "NODE_ENV=production pnpm --filter @groktopus/ui build --outDir ../server/ui-dist --emptyOutDir && NODE_ENV=production node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts onboard --yes --run",
    url: `${baseURL}/api/ready`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PROPRIO_UI_DEV_MIDDLEWARE: "false",
      PORT: String(port),
      PROPRIO_API_URL: baseURL,
      PROPRIO_HOME: proprioHome,
      PROPRIO_INSTANCE_ID: instanceId,
      PROPRIO_CONFIG: configPath,
      PROPRIO_AGENT_JWT_SECRET: "playwright-browser-tracing-agent-secret",
      PROPRIO_TOOL_ACTION_SIGNING_SECRET: "playwright-browser-tracing-tool-secret",
      PROPRIO_BIND: "loopback",
      PROPRIO_DEPLOYMENT_MODE: "local_trusted",
      PROPRIO_DEPLOYMENT_EXPOSURE: "private",
      PROPRIO_BROWSER_TRACES_SELF_HOSTED_ENABLED: mode === "disabled" ? undefined : "1",
      PROPRIO_BROWSER_TRACES_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
      PROPRIO_BROWSER_TRACES_SAMPLE_RATE: mode === "unsampled" ? "0.5" : "1",
      PROPRIO_BROWSER_TRACING_BUILD_ID: process.env.PROPRIO_BROWSER_TRACING_BUILD_ID ?? "local",
    },
  },
  outputDir: path.resolve(import.meta.dirname, `../../../test-results/browser-tracing/${mode}`),
  reporter: [["list"]],
});
