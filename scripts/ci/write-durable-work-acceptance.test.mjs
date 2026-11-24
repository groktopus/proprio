import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { qualificationReportPath, requiredCases, summarizeQualificationCases } from "./linux-source-qualification-cases.mjs";
import { writeDurableWorkAcceptance } from "./write-durable-work-acceptance.mjs";

const browserTitle = "the recovered task output remains visible after browser reload";
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

function fixture(t, { migration = false, removedMigration = false, skippedTitle = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-durable-evidence-"));
  const temp = path.join(root, "reports");
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  const migrationPath = path.join(root, "packages/db/src/migrations/0503_fixture.sql");
  if (removedMigration) {
    fsMkdir(path.dirname(migrationPath));
    writeFileSync(migrationPath, "SELECT 1;\n");
  }
  const baseSha = commit(root, "base");
  writeFileSync(path.join(root, "README.md"), "candidate\n");
  if (migration) {
    fsMkdir(path.dirname(migrationPath));
    writeFileSync(migrationPath, "SELECT 1;\n");
  }
  if (removedMigration) renameSync(migrationPath, `${migrationPath}.disabled`);
  const migrationChanged = migration || removedMigration;
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
      "migration-active-run-recovery": migrationChanged ? {
        outcome: "passed", previousReleaseSha: baseSha, schemaCandidateSha: sourceSha,
        elapsedRecoveryMs: 921, observedDataLoss: 0,
      } : { outcome: "not_applicable" },
    },
  });
  for (const [name, files] of Object.entries(requiredCases)) {
    const vitest = { testResults: Object.entries(files).map(([file, titles]) => ({
      name: path.join(root, file),
      assertionResults: titles.map(title => ({ title, fullName: title, status: title === skippedTitle ? "skipped" : "passed" })),
    })) };
    fsMkdir(temp);
    writeFileSync(qualificationReportPath(temp, name), JSON.stringify(vitest));
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

test("requires migration recovery evidence when SQL is renamed to a non-SQL path", async t => {
  const f = fixture(t, { removedMigration: true });
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

test("summary shows skipped and missing required cases explicitly", t => {
  const skippedTitle = requiredCases.runner["packages/proprio-runner/src/live/runnerd-restart-continuation.test.ts"][0];
  const f = fixture(t, { skippedTitle });
  rmSync(qualificationReportPath(f.temp, "integration"));
  const summary = summarizeQualificationCases(f.temp);
  assert.ok(summary.includes(`- skipped · ${skippedTitle}`));
  assert.match(summary, /- incomplete · runs Rust runnerd/);
  assert.match(summary, /- passed · restores ordinary-table/);
});
