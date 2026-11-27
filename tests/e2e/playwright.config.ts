import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Use a dedicated port so e2e tests always start their own server in local_trusted mode,
// even when the dev server is running on :3100 in authenticated mode.
const PORT = Number(process.env.PROPRIO_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PROPRIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "proprio-e2e-home-"));
const PROPRIO_INSTANCE_ID = "playwright-e2e";
const PROPRIO_CONFIG = path.join(PROPRIO_HOME, "instances", PROPRIO_INSTANCE_ID, "config.json");
const PROPRIO_AGENT_JWT_SECRET = process.env.PROPRIO_AGENT_JWT_SECRET ?? "playwright-e2e-agent-jwt-secret";
const PROPRIO_DECISION_SIGNING_SECRET =
  process.env.PROPRIO_DECISION_SIGNING_SECRET ?? "playwright-e2e-decision-signing-secret";
const PROPRIO_TOOL_ACTION_SIGNING_SECRET =
  process.env.PROPRIO_TOOL_ACTION_SIGNING_SECRET ?? "playwright-e2e-tool-action-signing-secret";
const PLAYWRIGHT_CHANNEL = process.env.PROPRIO_PLAYWRIGHT_CHANNEL;

process.env.PROPRIO_HOME = PROPRIO_HOME;
process.env.PROPRIO_CONFIG = PROPRIO_CONFIG;
// Worker processes reload this config; retain the main process's server path
// for specs that seed historical database state in the throwaway instance.
process.env.PROPRIO_E2E_SERVER_CONFIG ??= PROPRIO_CONFIG;
// Specs that mint agent JWTs in-process (via createLocalAgentJwt) must derive
// the same per-instance signing key as the webServer, or verification fails
// with a 401 instead of authenticating as the agent.
process.env.PROPRIO_INSTANCE_ID = PROPRIO_INSTANCE_ID;
process.env.PROPRIO_AGENT_JWT_SECRET = PROPRIO_AGENT_JWT_SECRET;
process.env.PROPRIO_DECISION_SIGNING_SECRET = PROPRIO_DECISION_SIGNING_SECRET;
process.env.PROPRIO_TOOL_ACTION_SIGNING_SECRET = PROPRIO_TOOL_ACTION_SIGNING_SECRET;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // These suites use their own controller or multi-user configuration.
  testIgnore: ["in-feed-native/**", "multi-user.spec.ts", "multi-user-authenticated.spec.ts",
    "**/execution-recovery/mixed-case-handoff.spec.ts"],
  timeout: 60_000,
  retries: 0,
  // All specs share one throwaway server, and several toggle instance-level
  // state (the `enableConferenceRoomChat` experimental flag) that changes
  // which UI variant renders. Run files serially so a flag flip in one spec
  // can't change the wizard/thread under another spec mid-flight.
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
  // The webServer directive bootstraps a throwaway instance and then starts it.
  // `onboard --yes --run` works in a non-interactive temp PROPRIO_HOME.
  webServer: {
    cwd: path.resolve(import.meta.dirname, "../.."),
    // Exercise the shipped UI. Source-checkout onboarding otherwise enables
    // Vite middleware: every reload traverses thousands of modules, including
    // service-worker-intercepted requests, before React can even start.
    // Build the server's first-choice static directory so a prior package build
    // cannot shadow the UI under test with stale server/ui-dist assets.
    command: "pnpm --filter @groktopus/ui build --outDir ../server/ui-dist --emptyOutDir && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts onboard --yes --run",
    url: `${BASE_URL}/api/health`,
    // Always boot a dedicated throwaway instance for e2e so browser tests
    // never attach to the developer's active Proprio home/server.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PROPRIO_UI_DEV_MIDDLEWARE: "false",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${path.resolve(import.meta.dirname, "fixtures/agent-chat-github.mjs")} --import=${path.resolve(import.meta.dirname, "fixtures/ai-connection-provider.mjs")}`,
      PORT: String(PORT),
      PROPRIO_OPEN_ON_LISTEN: "false",
      PROPRIO_API_URL: BASE_URL,
      PROPRIO_HOME,
      PROPRIO_INSTANCE_ID,
      PROPRIO_CONFIG,
      PROPRIO_AGENT_JWT_SECRET,
      PROPRIO_DECISION_SIGNING_SECRET,
      PROPRIO_TOOL_ACTION_SIGNING_SECRET,
      PROPRIO_BIND: "loopback",
      PROPRIO_DEPLOYMENT_MODE: "local_trusted",
      PROPRIO_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: "./test-results",
  reporter: [
    ["list"], ["html", { open: "never", outputFolder: "./playwright-report" }],
    ...(process.env.GITHUB_ACTIONS === "true"
      ? [[path.resolve(import.meta.dirname, "../../scripts/ci/oversized-test-files-playwright.mjs")] as [string]]
      : []),
    ...(process.env.PROPRIO_CI_PROFILE === "true"
      ? [[path.resolve(import.meta.dirname, "../../scripts/ci-profile/playwright-reporter.mjs")] as [string]]
      : []),
  ],
});
