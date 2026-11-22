import assert from "node:assert/strict";
import test from "node:test";
import { providerPlan, requireExecutedTests } from "./qualify-sandbox-provider-dependencies.mjs";

test("standalone Daytona lock ownership stays separate from the shared provider workspace", () => {
  const locked = providerPlan("locked"), shared = providerPlan("shared");
  assert.deepEqual(locked.providers, ["packages/plugins/sandbox-providers/daytona"]);
  assert.deepEqual(locked.installs, locked.providers);
  assert.deepEqual(shared.installs, ["scripts/typecheck-sandbox-providers"]);
  assert.ok(!shared.providers.includes(locked.providers[0]));
  assert.ok(shared.providers.includes("packages/plugins/sandbox-providers/cloudflare/bridge-template"));
  assert.throws(() => providerPlan("unknown"), /Expected --scope/);
});

test("provider reports require actual executed passes and reject failures or all-skipped suites", () => {
  requireExecutedTests({ success: true, numPassedTests: 1, numFailedTests: 0 }, "provider");
  for (const report of [{ success: true, numPassedTests: 0, numFailedTests: 0 },
    { success: false, numPassedTests: 1, numFailedTests: 1 }, {}])
    assert.throws(() => requireExecutedTests(report, "provider"), /did not pass with executed cases/);
});
