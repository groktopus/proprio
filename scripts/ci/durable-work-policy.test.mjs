import assert from "node:assert/strict";
import test from "node:test";
import { changedPaths, evidenceSubject, qualificationDecision } from "./durable-work-policy.mjs";

const head = "a".repeat(40);
const related = ["packages/db/src/migrate.ts"];
const automatic = { head, manual: false };
const pass = [{ name: "durable-work / source-and-runner", conclusion: "success" }];

test("binds automated evidence to the exact PR workflow head", () => {
  const run = { path: ".github/workflows/stability-smoke.yml", event: "pull_request", head_sha: head };
  assert.deepEqual(evidenceSubject(run), automatic);
  assert.equal(evidenceSubject({ ...run, path: ".github/workflows/droid-review.yml" }), null);
  assert.equal(evidenceSubject({ ...run, head_sha: "bad input" }), null);
});

test("accepts changed workflow evidence only from default-branch qualification", () => {
  const run = { path: ".github/workflows/linux-source-qualification.yml", event: "workflow_dispatch",
    head_branch: "main", display_title: `PR 21 source qualification ${head}`,
    head_repository: { full_name: "groktopus/proprio" } };
  const subject = evidenceSubject(run);
  assert.deepEqual(subject, { head, number: 21, manual: true });
  assert.equal(evidenceSubject({ ...run, head_branch: "proposed-workflow" }), null);
  assert.equal(evidenceSubject({ ...run, head_repository: { full_name: "outside/proprio" } }), null);
  const workflow = [".github/workflows/linux-source-qualification.yml"];
  assert.equal(qualificationDecision(workflow, automatic, pass), null);
  assert.equal(qualificationDecision(workflow, subject, [{ name: "source-and-runner", conclusion: "success" }]).state, "success");
  assert.equal(qualificationDecision([
    "scripts/ci/durable-work-release-evidence.mjs",
    "scripts/ci/durable-work-release-evidence.test.mjs",
  ], automatic, pass), null);
});

test("requires one passing qualification for an applicable diff", () => {
  assert.equal(qualificationDecision(related, automatic, pass).state, "success");
  for (const jobs of [[], [...pass, ...pass], [{ ...pass[0], conclusion: "skipped" }], [{ ...pass[0], conclusion: "failure" }]]) {
    assert.equal(qualificationDecision(related, automatic, jobs).state, "failure");
  }
  assert.equal(qualificationDecision(["ui/src/pages/Inbox.tsx"], automatic, []).state, "success");
});

test("routes both sides of a file rename", () => {
  const files = [{ filename: "doc/file.md", previous_filename: "packages/db/src/migrate.ts" }];
  assert.equal(qualificationDecision(changedPaths(files), automatic, []).state, "failure");
});
