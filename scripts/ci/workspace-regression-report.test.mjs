import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const summarizer = fileURLToPath(new URL("./summarize-workspace-regression.mjs", import.meta.url));
const source = "1".repeat(40);

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-regression-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    run: (lane, outcome) => spawnSync(process.execPath, [summarizer, root, lane, source, outcome], {
      cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    }),
    summary: () => JSON.parse(readFileSync(path.join(root, "summary.json"), "utf8")),
  };
}

test("retains executed, skipped and retried counts for a complete lane", (t) => {
  const setup = fixture(t);
  mkdirSync(path.join(setup.root, "timings"));
  writeFileSync(path.join(setup.root, "timings/attempt.ndjson"), JSON.stringify({
    kind: "test", status: "passed", retries: 1,
  }) + "\n");
  writeFileSync(path.join(setup.root, "vitest-1.json"), JSON.stringify({
    numTotalTests: 6, numPassedTests: 4, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1, testResults: [],
  }));
  const result = setup.run("server", "success");
  assert.equal(result.status, 0, result.stderr);
  const { executed, skipped, retryPasses, completePass } = setup.summary();
  assert.deepEqual({ executed, skipped, retryPasses, completePass }, { executed: 4, skipped: 2, retryPasses: 1, completePass: true });
});

test("an incomplete lane stays red even when the test command reports success", (t) => {
  const setup = fixture(t);
  const result = setup.run("cli-and-health-baseline", "success");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(setup.summary().completePass, false);
  assert.match(result.stdout, /did not produce a complete passing result/);
});

test("records failing results without treating failed tests as skips", (t) => {
  const setup = fixture(t);
  writeFileSync(path.join(setup.root, "vitest-1.json"), JSON.stringify({
    numTotalTests: 3, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numTodoTests: 0, testResults: [],
  }));
  const result = setup.run("server", "failure");
  assert.equal(result.status, 1, result.stderr);
  const { executed, failed, skipped, retryPasses, completePass } = setup.summary();
  assert.deepEqual({ executed, failed, skipped, retryPasses, completePass }, {
    executed: 2, failed: 1, skipped: 1, retryPasses: null, completePass: false,
  });
});
