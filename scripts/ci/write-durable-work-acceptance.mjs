import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertRequiredVitestTests } from "./assert-required-vitest-tests.mjs";

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
  const paths = execFileSync("git", ["diff", "--name-only", baseSha, sourceSha, "--", "packages/db/src/migrations"], { encoding: "utf8", cwd: root })
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

  assertRequiredVitestTests(report("durable-work-restore.json"), {
    "packages/db/src/backup-lib.test.ts": [
      "restores ordinary-table CHECK, exclusion and NULLS NOT DISTINCT constraints with pg_dump",
    ],
  });
  assertRequiredVitestTests(report("durable-work-controller.json"), {
    "server/src/services/native-runtime/native-safe-replacement.test.ts": [
      "preserves saved work and a queued request at a controlled recovery boundary (verified)",
      "cancels a durable native retry even when its previous provider is already failed",
    ],
  });
  assertRequiredVitestTests(report("durable-work-runner.json"), {
    "packages/proprio-runner/src/live/runnerd-restart-continuation.test.ts": [
      "adopts the in-flight turn when a restart lands just after turn.start (t77)",
      "finalizes the durable proposed result when the runner and provider die before the turn terminal",
    ],
  });
  assertRequiredVitestTests(report("durable-work-integration.json"), {
    "server/src/services/native-runtime/proprio-runner-real-server.integration.test.ts": [
      "runs Rust runnerd through Proprio PRP and reads the real bound task",
    ],
    "server/src/services/native-runtime/native-codex-runner.integration.test.ts": [
      "returns a durable result and resumes the provider session on the next run",
    ],
    "server/src/services/native-runtime/native-sandbox-disk-full.test.ts": [
      "names the full disk and stops instead of retrying the same work",
    ],
    "server/src/services/workspace-recovery-disk-full.test.ts": [
      "ends recovery at the first full-disk save with a named cause and a Retry that saves and applies the accepted result without a new turn",
    ],
  });
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
