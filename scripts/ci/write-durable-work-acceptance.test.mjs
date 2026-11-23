import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeDurableWorkAcceptance } from "./write-durable-work-acceptance.mjs";

const browserTitle = "the recovered task output remains visible after browser reload";
const required = new Map([
  ["packages/db/src/backup-lib.test.ts", ["restores ordinary-table CHECK, exclusion and NULLS NOT DISTINCT constraints with pg_dump"]],
  ["server/src/services/native-runtime/native-safe-replacement.test.ts", [
    "preserves saved work and a queued request at a controlled recovery boundary (verified)",
    "cancels a durable native retry even when its previous provider is already failed",
  ]],
  ["packages/proprio-runner/src/live/runnerd-restart-continuation.test.ts", [
    "adopts the in-flight turn when a restart lands just after turn.start (t77)",
    "finalizes the durable proposed result when the runner and provider die before the turn terminal",
  ]],
  ["server/src/services/native-runtime/proprio-runner-real-server.integration.test.ts", ["runs Rust runnerd through Proprio PRP and reads the real bound task"]],
  ["server/src/services/native-runtime/native-codex-runner.integration.test.ts", ["returns a durable result and resumes the provider session on the next run"]],
  ["server/src/services/native-runtime/native-sandbox-disk-full.test.ts", ["names the full disk and stops instead of retrying the same work"]],
  ["server/src/services/workspace-recovery-disk-full.test.ts", ["ends recovery at the first full-disk save with a named cause and a Retry that saves and applies the accepted result without a new turn"]],
]);

function commit(root, message) {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Qualification Test", "-c", "user.email=qualification@example.invalid", "commit", "-m", message], { cwd: root, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function writeJson(file, value) {
  const fullPath = path.join(file.root, file.name);
  fsMkdir(path.dirname(fullPath));
  writeFileSync(fullPath, `${JSON.stringify(value)}\n`);
}

function fsMkdir(directory) {
  mkdirSync(directory, { recursive: true });
}

function fixture(t, { migration = false, skippedTitle = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-durable-evidence-"));
  const temp = path.join(root, "reports");
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  const baseSha = commit(root, "base");
  writeFileSync(path.join(root, "README.md"), "candidate\n");
  if (migration) {
    const migrationPath = path.join(root, "packages/db/src/migrations/0503_fixture.sql");
    fsMkdir(path.dirname(migrationPath));
    writeFileSync(migrationPath, "SELECT 1;\n");
  }
  const sourceSha = commit(root, "candidate");
  const env = {
    GITHUB_REPOSITORY: "groktopus/proprio",
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "2",
    EXPECTED_HEAD: sourceSha,
    E2E_UPDATE_BASE_REF: baseSha,
    RUNNER_TEMP: temp,
  };
  writeJson({ root: temp, name: "durable-work-lifecycle.json" }, {
    sourceSha,
    baseSha,
    cases: {
      "managed-update-rollback": { outcome: "passed" },
      "migration-active-run-recovery": migration ? {
        outcome: "passed", previousReleaseSha: baseSha, schemaCandidateSha: sourceSha,
        elapsedRecoveryMs: 921, observedDataLoss: 0,
      } : { outcome: "not_applicable" },
    },
  });
  const vitest = { testResults: [...required].map(([file, titles]) => ({
    name: path.join(root, file),
    assertionResults: titles.map(title => ({ title, fullName: title, status: title === skippedTitle ? "skipped" : "passed" })),
  })) };
  for (const name of ["durable-work-restore.json", "durable-work-controller.json", "durable-work-runner.json", "durable-work-integration.json"]) {
    writeJson({ root: temp, name }, vitest);
  }
  writeJson({ root: temp, name: "durable-work-browser.json" }, {
    suites: [{ specs: [{ title: browserTitle, tests: [{ results: [{ status: "passed" }] }] }] }],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env, sourceSha, baseSha, temp };
}

test("writes one exact-head report and marks a no-migration case not applicable", async t => {
  const f = fixture(t);
  const { output, qualification } = await writeDurableWorkAcceptance({ env: f.env, root: f.root });
  assert.deepEqual(Object.keys(qualification.cases), [
    "managed-update-rollback", "backup-restore-fresh-target", "migration-active-run-recovery",
    "interruption-restart-cancel-disk-pressure", "browser-task-readback",
  ]);
  assert.equal(qualification.schema, "proprio.durable-work-qualification/v1");
  assert.equal(qualification.sourceSha, f.sourceSha);
  assert.equal(qualification.baseSha, f.baseSha);
  assert.equal(qualification.cases["migration-active-run-recovery"].outcome, "not_applicable");
  assert.deepEqual(qualification.cases["browser-task-readback"].evidenceUrls, [
    "https://github.com/groktopus/proprio/actions/runs/123456789/attempts/2",
  ]);
  assert.equal(readFileSync(output, "utf8"), `${JSON.stringify(qualification, null, 2)}\n`);
});

test("requires migration recovery measurements when the exact source range adds SQL migrations", async t => {
  const f = fixture(t, { migration: true });
  const { qualification } = await writeDurableWorkAcceptance({ env: f.env, root: f.root });
  const migration = qualification.cases["migration-active-run-recovery"];
  assert.equal(migration.outcome, "passed");
  assert.equal(migration.previousReleaseSha, f.baseSha);
  assert.equal(migration.schemaCandidateSha, f.sourceSha);
  assert.equal(migration.elapsedRecoveryMs, 921);
  assert.equal(migration.observedDataLoss, 0);
});

test("rejects skipped required evidence instead of publishing a passing case", async t => {
  const f = fixture(t, { skippedTitle: "runs Rust runnerd through Proprio PRP and reads the real bound task" });
  await assert.rejects(writeDurableWorkAcceptance({ env: f.env, root: f.root }), /Required test did not pass exactly once/);
});
