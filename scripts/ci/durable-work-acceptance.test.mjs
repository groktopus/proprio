import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { requiresDurableWorkAcceptance } from "./durable-work-acceptance.mjs";

test("routes changes that affect update, restore, or run recovery", () => {
  for (const path of [
    "cli/src/commands/update.ts",
    "cli/src/install-store.ts",
    "cli/src/commands/worktree.ts",
    "cli/src/services/service-manager.ts",
    "scripts/build-npm.sh",
    "scripts/e2e-update-migrations.sh",
    "scripts/ci/managed-update-command.mjs",
    "scripts/ci/durable-work-release-evidence.mjs",
    "scripts/ci/durable-work-release-evidence.test.mjs",
    "scripts/ci/write-durable-work-acceptance.mjs",
    "scripts/ci/write-durable-work-acceptance.test.mjs",
    "scripts/ci/browser-task-readback.mjs",
    "scripts/prepare-bundled-package.mjs",
    "packages/db/src/backup-lib.ts",
    "packages/db/src/migrate.ts",
    "packages/db/src/migration-runtime.ts",
    "server/src/services/database-backup-owner.ts",
    "server/src/services/execution-recovery-resolution.ts",
    "server/src/services/native-interruption-continuation.ts",
    "packages/db/src/migrations/9999_fixture.sql",
    "server/src/services/heartbeat/scheduling.ts",
    "server/src/services/runner-goals.ts",
    "packages/proprio-runner/runner/crates/runner-core/src/lib.rs",
    ".github/workflows/linux-source-qualification.yml",
    "scripts/ci/durable-work-release-evidence.mjs",
    "scripts/ci/durable-work-release-evidence.test.mjs",
  ]) {
    assert.equal(requiresDurableWorkAcceptance(["doc/GOAL.md", path]), true, path);
  }
});

test("unrelated docs and board changes skip durable-work qualification", () => {
  assert.equal(requiresDurableWorkAcceptance([]), false);
  assert.equal(requiresDurableWorkAcceptance(["doc/GOAL.md", "ui/src/pages/Inbox.tsx", "packages/proprio-runner/docs/tutorials/replay.md"]), false);
});

test("both routers use the full merge group range and recompute it for a replacement candidate", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "smoke-merge-group-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = (...args) => {
    git("add", "-A");
    git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qm", "fixture", ...args);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const base = commit("--allow-empty");
  writeFileSync(join(cwd, ".nvmrc"), "24\n"); // Both qualification routes apply to this predecessor.
  commit();
  writeFileSync(join(cwd, "README.md"), "unrelated successor\n");
  const group = commit();
  git("checkout", "--detach", "-q", base);
  writeFileSync(join(cwd, "README.md"), "unrelated successor\n");
  const replacement = commit();
  const output = join(cwd, "route-output");

  for (const [script, args] of [["durable-work-acceptance.mjs", ["route"]], ["board-accessibility-routing.mjs", []]]) {
    const scriptPath = fileURLToPath(new URL(script, import.meta.url));
    for (const [candidate, applicable] of [[group, true], [replacement, false]]) {
      writeFileSync(output, "");
      execFileSync(process.execPath, [scriptPath, ...args, candidate, base, "--merge-group"], {
        cwd, env: { ...process.env, GITHUB_OUTPUT: output },
      });
      assert.equal(readFileSync(output, "utf8"), `applicable=${applicable}\n`);
    }
  }
});

test("the smoke workflow gates its verdict on the routing outputs and applicable jobs", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/stability-smoke.yml", import.meta.url), "utf8");
  const routeOutput = "$" + "{{ steps.route.outputs.applicable }}";
  const applicability = "$" + "{{ needs.route-durable-work.outputs.applicable }}";
  const linuxResult = "$" + "{{ needs.durable-work.result }}";
  assert.ok(workflow.includes("applicable: " + routeOutput));
  assert.ok(workflow.includes("APPLICABLE: " + applicability));
  assert.ok(workflow.includes("DURABLE_WORK_RESULT: " + linuxResult));
  assert.ok(workflow.includes("BOARD_ACCESSIBILITY_APPLICABLE: $" + "{{ needs.route-durable-work.outputs.board-accessibility }}"));
  assert.ok(workflow.includes("BOARD_ACCESSIBILITY_RESULT: $" + "{{ needs.board-accessibility.result }}"));
  const gate = workflow.split("- name: Require smoke tests and applicable qualification").at(-1).split("run: |\n")[1];
  assert.ok(gate, "workflow must contain the smoke gate");
  function verdict(applicable, result, overrides = {}) {
    return spawnSync("bash", ["-e", "-c", gate], {
      env: { ...process.env, APPLICABLE: String(applicable), DURABLE_WORK_RESULT: result,
        ROUTING_RESULT: "success", STABILITY_RESULT: "success",
        BOARD_ACCESSIBILITY_APPLICABLE: "false", BOARD_ACCESSIBILITY_RESULT: "skipped", ...overrides },
    }).status;
  }
  const relevant = requiresDurableWorkAcceptance(["packages/db/src/migrate.ts"]);
  const unrelated = requiresDurableWorkAcceptance(["doc/GOAL.md"]);
  assert.equal(verdict(relevant, "success"), 0);
  assert.equal(verdict(unrelated, "skipped"), 0);
  for (const result of ["", "skipped", "cancelled", "failure"]) {
    assert.notEqual(verdict(relevant, result), 0);
  }
  assert.notEqual(verdict("", "skipped"), 0);
  assert.notEqual(verdict(unrelated, "failure"), 0);
  assert.notEqual(verdict(relevant, "success", { ROUTING_RESULT: "failure" }), 0);
  assert.notEqual(verdict(relevant, "success", { STABILITY_RESULT: "failure" }), 0);
  assert.notEqual(verdict(relevant, "success", { STABILITY_RESULT: "cancelled" }), 0);

  function boardVerdict(applicable, result) {
    return verdict(unrelated, "skipped", {
      BOARD_ACCESSIBILITY_APPLICABLE: applicable,
      BOARD_ACCESSIBILITY_RESULT: result,
    });
  }
  assert.equal(boardVerdict("true", "success"), 0);
  assert.equal(boardVerdict("false", "skipped"), 0);
  for (const result of ["", "skipped", "cancelled", "failure"]) {
    assert.notEqual(boardVerdict("true", result), 0);
  }
  assert.notEqual(boardVerdict("", "skipped"), 0);
  assert.notEqual(boardVerdict("false", "failure"), 0);
});
