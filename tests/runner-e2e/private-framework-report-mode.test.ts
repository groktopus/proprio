import { afterEach, expect, it, vi } from "vitest";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it.each([
  [undefined, undefined, ["list", "blob", "junit", "html"]],
  ["/tmp/owned/preflight.json", undefined, ["list", "blob", "junit", "html"]],
  [undefined, "v1", ["list", "blob", "junit", "html"]],
  ["/tmp/owned/preflight.json", "v1", ["list", "json", "junit"]],
] as const)("selects supported private reporter mode for preflight=%s/TestOps=%s", async (preflight, testops, expected) => {
  const source = { PROPRIO_RUNNER_E2E_PRIVATE_PREFLIGHT: preflight, PROPRIO_CHAT_COMPLETION_TESTOPS: testops };
  expect(buildRunnerE2EProcessEnvironment(source, []).PROPRIO_CHAT_COMPLETION_TESTOPS).toBe(testops);
  for (const [key, value] of Object.entries({ ...source, PROPRIO_RUNNER_E2E_PORT: "3104", PROPRIO_RUNNER_E2E_TEMP_ROOT: "/tmp/owned", PROPRIO_RUNNER_E2E_PRIVATE_DIR: "/tmp/owned/private",
    PROPRIO_HOME: "/tmp/owned/home", PROPRIO_CONFIG: "/tmp/owned/config.json", PROPRIO_INSTANCE_ID: "synthetic", PROPRIO_AGENT_JWT_SECRET: "synthetic", PROPRIO_DECISION_SIGNING_SECRET: "synthetic", PROPRIO_TOOL_ACTION_SIGNING_SECRET: "synthetic", BETTER_AUTH_SECRET: "synthetic" })) vi.stubEnv(key, value);
  const { default: config } = await import("./playwright.config.js");
  expect((config.reporter as Array<[string]>).map(row => row[0])).toEqual(expected);
});
