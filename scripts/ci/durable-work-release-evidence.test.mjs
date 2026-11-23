import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  readDurableWorkReleaseEvidence,
  requiredReleaseCases,
  validateDurableWorkReleaseManifest,
  verifyDurableWorkSourceRelease,
} from "./durable-work-release-evidence.mjs";

const sourceSha = "a".repeat(40);
const baseSha = "b".repeat(40);

function manifest(overrides = {}) {
  const cases = Object.fromEntries(requiredReleaseCases.map(id => [id, {
    outcome: "passed",
    evidenceUrls: [`https://github.com/groktopus/proprio/actions/runs/55/attempts/2#${id}`],
  }]));
  cases["migration-active-run-recovery"] = {
    ...cases["migration-active-run-recovery"],
    previousReleaseSha: baseSha,
    schemaCandidateSha: sourceSha,
    elapsedRecoveryMs: 1250,
    observedDataLoss: 0,
  };
  return { schema: "proprio.durable-work-qualification/v1", sourceSha, baseSha, cases, ...overrides };
}

function fixture({ report = manifest(), runOverrides = {}, jobOverrides = {}, artifactOverrides = {}, currentRunOverrides = {} } = {}) {
  const run = {
    id: 55, workflow_id: 77, path: ".github/workflows/linux-source-qualification.yml",
    repository: { full_name: "groktopus/proprio" }, head_repository: { full_name: "groktopus/proprio" },
    head_sha: sourceSha, head_branch: "main", event: "workflow_dispatch",
    display_title: `Source qualification ${sourceSha} from ${baseSha}`, run_attempt: 2,
    status: "completed", conclusion: "success", ...runOverrides,
  };
  const job = {
    id: 88, name: "source-and-runner", status: "completed", conclusion: "success",
    head_sha: sourceSha, run_id: 55, run_attempt: 2, ...jobOverrides,
  };
  const artifact = { id: 99, name: "durable-work-acceptance", expired: false, ...artifactOverrides };
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path.endsWith("/actions/workflows/linux-source-qualification.yml")) return { id: 77, path: ".github/workflows/linux-source-qualification.yml" };
    if (path.includes("/runs?")) return { total_count: 1, workflow_runs: [run] };
    if (path.includes("/jobs?")) return { jobs: [job] };
    if (path.includes("/artifacts?")) return { total_count: 1, artifacts: [artifact] };
    if (path.endsWith("/actions/runs/55")) return { ...run, ...currentRunOverrides };
    throw new Error(`unexpected API request: ${path}`);
  };
  const downloadArtifact = async (_runId, _name, directory) => {
    await writeFile(join(directory, "durable-work-acceptance.json"), JSON.stringify(report));
  };
  return { api, downloadArtifact, calls };
}

test("accepts complete retained evidence bound to the exact source and previous release", async () => {
  const f = fixture();
  const result = await readDurableWorkReleaseEvidence({ sourceSha, baseSha, ...f });
  assert.deepEqual([result.runId, result.attempt, result.jobId, result.artifactId], [55, 2, 88, 99]);
  assert.ok(f.calls.some(path => path.includes("/attempts/2/jobs")));
});

test("release changes skip only when none match the durable-work route", async () => {
  let called = false;
  const result = await verifyDurableWorkSourceRelease({ sourceSha, baseSha,
    changedPaths: ["doc/GOAL.md", "ui/src/pages/Inbox.tsx"],
    api: async () => { called = true; throw new Error("must not read evidence for unrelated changes"); },
  });
  assert.equal(result.applicable, false);
  assert.equal(called, false);

  const relevant = await verifyDurableWorkSourceRelease({ sourceSha, baseSha,
    changedPaths: ["packages/db/src/migrations/0502_stormy_sumo.sql"], ...fixture(),
  });
  assert.equal(relevant.applicable, true);
});

test("fails closed for wrong source, attempt, job, artifact, or required case outcome", async t => {
  const cases = [
    ["wrong source", { runOverrides: { display_title: `Source qualification ${"c".repeat(40)} from ${baseSha}` } }],
    ["wrong previous release", { runOverrides: { display_title: `Source qualification ${sourceSha} from ${"c".repeat(40)}` } }],
    ["wrong workflow", { runOverrides: { workflow_id: 78 } }],
    ["wrong workflow path", { runOverrides: { path: ".github/workflows/other.yml" } }],
    ["wrong repository", { runOverrides: { repository: { full_name: "outside/proprio" } } }],
    ["wrong branch", { runOverrides: { head_branch: "release" } }],
    ["wrong event", { runOverrides: { event: "pull_request" } }],
    ["run rerun during artifact read", { currentRunOverrides: { run_attempt: 3 } }],
    ["failed latest run", { runOverrides: { conclusion: "failure" } }],
    ["job from another attempt", { jobOverrides: { run_attempt: 1 } }],
    ["wrong named job", { jobOverrides: { name: "smoke" } }],
    ["expired artifact", { artifactOverrides: { expired: true } }],
    ["missing required case", { report: manifest({ cases: Object.fromEntries(Object.entries(manifest().cases).filter(([id]) => id !== "browser-task-readback")) }) }],
    ["skipped required case", { report: manifest({ cases: { ...manifest().cases, "backup-restore-fresh-target": { outcome: "skipped", evidenceUrls: ["https://github.com/groktopus/proprio/actions/runs/55"] } } }) }],
    ["artifact for another base", { report: manifest({ baseSha: "c".repeat(40) }) }],
    ["evidence URL on another host", { report: manifest({ cases: { ...manifest().cases,
      "browser-task-readback": { outcome: "passed", evidenceUrls: ["https://github.com.example/groktopus/proprio/actions/runs/55/attempts/2"] } } }) }],
    ["evidence link for another run", { report: manifest({ cases: { ...manifest().cases,
      "browser-task-readback": { outcome: "passed", evidenceUrls: ["https://github.com/groktopus/proprio/actions/runs/56/attempts/2"] } } }) }],
    ["evidence link for another attempt", { report: manifest({ cases: { ...manifest().cases,
      "browser-task-readback": { outcome: "passed", evidenceUrls: ["https://github.com/groktopus/proprio/actions/runs/55/attempts/1"] } } }) }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async () => {
      await assert.rejects(readDurableWorkReleaseEvidence({ sourceSha, baseSha, ...fixture(options) }));
    });
  }
});

test("active-run migration evidence includes exact revisions, elapsed time, and zero observed loss", () => {
  const cases = [
    manifest({ cases: { ...manifest().cases, "migration-active-run-recovery": { ...manifest().cases["migration-active-run-recovery"], previousReleaseSha: sourceSha } } }),
    manifest({ cases: { ...manifest().cases, "migration-active-run-recovery": { ...manifest().cases["migration-active-run-recovery"], schemaCandidateSha: baseSha } } }),
    manifest({ cases: { ...manifest().cases, "migration-active-run-recovery": { ...manifest().cases["migration-active-run-recovery"], elapsedRecoveryMs: -1 } } }),
    manifest({ cases: { ...manifest().cases, "migration-active-run-recovery": { ...manifest().cases["migration-active-run-recovery"], observedDataLoss: 1 } } }),
  ];
  for (const value of cases) assert.throws(() => validateDurableWorkReleaseManifest(value, {
    sourceSha, baseSha, runId: 55, attempt: 2, migrationRequired: true,
  }));
});

test("requires an explicit not-applicable migration case only when no migration SQL changed", () => {
  const value = manifest({ cases: { ...manifest().cases, "migration-active-run-recovery": {
    outcome: "not_applicable", evidenceUrls: ["https://github.com/groktopus/proprio/actions/runs/55/attempts/2"],
  } } });
  assert.doesNotThrow(() => validateDurableWorkReleaseManifest(value, {
    sourceSha, baseSha, runId: 55, attempt: 2, migrationRequired: false,
  }));
  assert.throws(() => validateDurableWorkReleaseManifest(value, {
    sourceSha, baseSha, runId: 55, attempt: 2, migrationRequired: true,
  }));
});

