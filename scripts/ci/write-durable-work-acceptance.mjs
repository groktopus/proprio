import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertQualificationCases, requiredCases } from "./linux-source-qualification-cases.mjs";

const shaPattern = /^[0-9a-f]{40}$/;
const browserCase = "the recovered task output remains visible after browser reload";

function readReport(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertBrowserCase(report, title) {
  const matches = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      if (spec.title !== title) continue;
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) matches.push(result.status);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  assert.deepEqual(matches, ["passed"], `Expected one passing browser case; got ${JSON.stringify(matches)}`);
}

function hasSqlMigrationDelta(baseSha, sourceSha, root) {
  const paths = execFileSync("git", ["diff", "--name-only", "--no-renames", baseSha, sourceSha, "--", "packages/db/src/migrations"], { encoding: "utf8", cwd: root })
    .split("\n").filter(path => path.endsWith(".sql"));
  return paths.length > 0;
}

export async function writeDurableWorkAcceptance({ env = process.env, root = process.cwd() } = {}) {
  assert.equal(env.GITHUB_REPOSITORY, "groktopus/proprio");
  const sourceSha = env.EXPECTED_HEAD;
  const baseSha = env.E2E_UPDATE_BASE_REF;
  assert.match(sourceSha ?? "", shaPattern, "Expected an exact tested source SHA");
  assert.match(baseSha ?? "", shaPattern, "Expected an exact previous-release base SHA");
  assert.notEqual(sourceSha, baseSha);
  assert.match(env.GITHUB_RUN_ID ?? "", /^[0-9]+$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[0-9]+$/);
  const evidenceUrl = `https://github.com/groktopus/proprio/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const temp = env.RUNNER_TEMP;
  assert.ok(temp, "RUNNER_TEMP is required");
  const report = name => readReport(join(temp, name));
  const lifecycle = report("durable-work-lifecycle.json");
  assert.equal(lifecycle.sourceSha, sourceSha);
  assert.equal(lifecycle.baseSha, baseSha);
  assert.equal(lifecycle.cases?.["managed-update-rollback"]?.outcome, "passed");

  for (const name of Object.keys(requiredCases)) assertQualificationCases(temp, name);
  assertBrowserCase(report("durable-work-browser.json"), browserCase);

  const migrationChanged = hasSqlMigrationDelta(baseSha, sourceSha, root);
  const migration = lifecycle.cases?.["migration-active-run-recovery"];
  if (migrationChanged) {
    assert.equal(migration?.outcome, "passed", "A SQL migration delta requires active-run recovery evidence");
    assert.equal(migration.previousReleaseSha, baseSha);
    assert.equal(migration.schemaCandidateSha, sourceSha);
    assert.ok(Number.isInteger(migration.elapsedRecoveryMs) && migration.elapsedRecoveryMs >= 0);
    assert.equal(migration.observedDataLoss, 0);
  } else {
    assert.equal(migration?.outcome, "not_applicable", "No SQL migration delta exists between this base and source SHA");
  }

  const cases = {
    "managed-update-rollback": { outcome: "passed", evidenceUrls: [evidenceUrl] },
    "backup-restore-fresh-target": { outcome: "passed", evidenceUrls: [evidenceUrl] },
    "migration-active-run-recovery": {
      outcome: migrationChanged ? "passed" : "not_applicable",
      evidenceUrls: [evidenceUrl],
      ...(migrationChanged ? {
        previousReleaseSha: migration.previousReleaseSha,
        schemaCandidateSha: migration.schemaCandidateSha,
        elapsedRecoveryMs: migration.elapsedRecoveryMs,
        observedDataLoss: migration.observedDataLoss,
      } : {}),
    },
    "interruption-restart-cancel-disk-pressure": { outcome: "passed", evidenceUrls: [evidenceUrl] },
    "browser-task-readback": { outcome: "passed", evidenceUrls: [evidenceUrl] },
  };
  const qualification = { schema: "proprio.durable-work-qualification/v1", sourceSha, baseSha, cases };
  const output = join(temp, "durable-work-acceptance", "durable-work-acceptance.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(qualification, null, 2)}\n`, { mode: 0o600 });
  return { output, qualification };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { output, qualification } = await writeDurableWorkAcceptance();
  console.log(`Wrote ${output} for ${qualification.sourceSha} (${Object.keys(qualification.cases).length} cases).`);
}
