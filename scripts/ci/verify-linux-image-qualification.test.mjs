import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("./verify-linux-image-qualification.mjs", import.meta.url));
const sourceSha = "c".repeat(40);
const digest = `sha256:${"a".repeat(64)}`;
const run = () => ({
  id: 123456,
  path: ".github/workflows/linux-image-release.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  run_attempt: 2,
  head_branch: "main",
  head_sha: sourceSha,
  repository: { full_name: "groktopus/proprio" },
  head_repository: { full_name: "groktopus/proprio" },
});
const jobs = () => [{ name: "Qualify the candidate digest in Compose", status: "completed", conclusion: "success" }];
const metadata = () => ({ "containerimage.digest": digest });

function verify(t, { runValue = run(), jobsValue = jobs(), metadataValue = metadata(), env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "proprio-image-qualification-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = ["run.json", "jobs.json", "build.json"].map(name => path.join(dir, name));
  for (const [index, value] of [runValue, jobsValue, metadataValue].entries()) {
    writeFileSync(paths[index], JSON.stringify(value));
  }
  return spawnSync(process.execPath, [command, ...paths], {
    encoding: "utf8",
    env: {
      ...process.env,
      QUALIFICATION_RUN_ID: "123456",
      QUALIFICATION_ATTEMPT: "2",
      SOURCE_SHA: sourceSha,
      CANDIDATE_DIGEST: digest,
      ...env,
    },
  });
}

test("accepts only a successful exact main qualification attempt and its candidate digest", t => {
  const result = verify(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /123456 attempt 2/);
});

test("rejects qualification evidence from a different source, ref, workflow, run, or attempt", t => {
  const cases = [
    { ...run(), id: 654321 },
    { ...run(), path: ".github/workflows/other.yml" },
    { ...run(), event: "push" },
    { ...run(), status: "in_progress", conclusion: null },
    { ...run(), conclusion: "failure" },
    { ...run(), run_attempt: 1 },
    { ...run(), head_branch: "release" },
    { ...run(), head_sha: "d".repeat(40) },
    { ...run(), head_repository: { full_name: "fork/proprio" } },
  ];
  for (const runValue of cases) assert.notEqual(verify(t, { runValue }).status, 0);
});

test("requires a successful Compose qualification job", t => {
  assert.notEqual(verify(t, { jobsValue: [] }).status, 0);
  assert.notEqual(verify(t, { jobsValue: [{ ...jobs()[0], conclusion: "failure" }] }).status, 0);
});

test("requires the artifact digest to match the selected candidate", t => {
  assert.notEqual(verify(t, { metadataValue: { "containerimage.digest": `sha256:${"b".repeat(64)}` } }).status, 0);
});

test("rejects malformed exact-candidate inputs", t => {
  assert.notEqual(verify(t, { env: { QUALIFICATION_ATTEMPT: "0" } }).status, 0);
  assert.notEqual(verify(t, { env: { SOURCE_SHA: "not-a-sha" } }).status, 0);
  assert.notEqual(verify(t, { env: { CANDIDATE_DIGEST: "latest" } }).status, 0);
});
