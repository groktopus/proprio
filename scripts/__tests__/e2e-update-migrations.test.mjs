import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseManagedUpdateInvocation } from "../ci/managed-update-command.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "e2e-update-migrations.sh");
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("PROPRIO_") && !name.startsWith("E2E_UPDATE_")),
);

test("cross-version migration harness has valid shell syntax", () => {
  const result = spawnSync("bash", ["-n", script], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
});

test("failure cleanup removes the service and managed install", () => {
  const source = readFileSync(script, "utf8");
  const cleanup = source.match(/cleanup\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

  assert.ok(cleanup, "expected a cleanup function");
  assert.match(cleanup, /shim service stop/);
  assert.match(cleanup, /shim service uninstall/);
  assert.match(cleanup, /shim uninstall/);
});


test("qualification can run the exact tested CLI against the installed base payload", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /update_cli\(\) \{[\s\S]*?managed-update-command\.mjs/);
  assert.match(source, /CHECK_JSON="\$\(update_cli update --check --json\)"/);
  assert.match(source, /if update_cli update --yes/);
  assert.match(source, /if update_cli update --rollback/);
  assert.match(source, /STORE\/current\/node_modules\/proprio\/dist\/index\.js/);
  assert.match(source, /E2E_MANAGED_EXECUTABLE="\$executable"/);
  assert.match(source, /node --import "\$E2E_BOOTSTRAP_NODE_LOADER"/);
  assert.match(source, /\.mode == "managed"/);
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "linux-source-qualification.yml"), "utf8");
  assert.match(workflow, /E2E_UPDATE_USE_BOOTSTRAP_CLI=1/);
});

test("active process recovery requires board reconciliation before normal Retry", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /legacy_execution_requires_reconciliation/);
  assert.match(source, /providerStopped:true,actionOutcome:"mixed"/);
  assert.match(source, /qualification-process\.json/);
  assert.match(source, /ACTIVE_PROCESS_CURRENT_START/);
  assert.match(source, /ACTIVE_PROCESS_STATE.*!= Z/);
  assert.match(source, /recovery-actions\/resolve/);
  assert.match(source, /idempotencyKey:\$key,observedRunId:\$runId,retryAction:"move_forward"/);
  assert.match(source, /api\/issues\/\$ACTIVE_ISSUE_ID\/retry/);
  assert.match(source, /\.accepted == true/);
});

test("recovery task uses the normal todo-then-assign flow and bounds HTTP diagnostics", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /status:\"todo\"/);
  assert.match(source, /assigneeAgentId:\$agent/);
  assert.match(source, /api\/agents\/\$ACTIVE_AGENT_ID\/wakeup/);
  assert.match(source, /qualification_assignment_fallback/);
  assert.match(source, /refusing to issue a duplicate wake/);
  assert.match(source, /terminal state \$SAFE_RUN_FAILURE/);
  assert.match(source, /--write-out \$'\\n%\{http_code\}'/);
  assert.match(source, /status: \(try \(\$status \| tonumber\) catch 0\)/);
  assert.match(source, /error: \(if \(\$response\.error \| type\) == \"string\" then \$response\.error\[0:200\]/);
  assert.ok(source.includes("{code: (.code // null), path: (.path // null), message:"));
});

test("managed update qualification wrapper accepts only the lifecycle flags", () => {
  assert.deepEqual(parseManagedUpdateInvocation(["update", "--check", "--json"]), { check: true, json: true });
  assert.deepEqual(parseManagedUpdateInvocation(["update", "--yes"]), { yes: true });
  assert.deepEqual(parseManagedUpdateInvocation(["update", "--rollback"]), { rollback: true });
  for (const args of [[], ["status"], ["update", "--check"], ["update", "--check", "--json", "--yes"]]) {
    assert.throws(() => parseManagedUpdateInvocation(args), /Unsupported managed update qualification command/);
  }
});

test("cross-version migration harness requires both refs before side effects", () => {
  for (const testCase of [
    { env: {}, missing: "E2E_UPDATE_BASE_REF" },
    { env: { E2E_UPDATE_BASE_REF: "test/base" }, missing: "E2E_UPDATE_NEXT_REF" },
  ]) {
    const testHome = mkdtempSync(path.join(os.tmpdir(), "proprio-update-migrations-"));
    try {
      const result = spawnSync("bash", [script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: testHome, ...testCase.env },
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${testCase.missing} is required`));
      assert.deepEqual(readdirSync(testHome), [], "validation must run before the harness writes files");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  }
});


test("exact-commit qualification rejects identical or abbreviated refs before side effects", () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "proprio-update-migrations-"));
  try {
    const full = "a".repeat(40);
    for (const next of [full, "abcdef1"]) {
      const result = spawnSync("bash", [script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: testHome, E2E_UPDATE_REQUIRE_PROBE: "0",
          E2E_UPDATE_BASE_REF: full, E2E_UPDATE_NEXT_REF: next },
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /two distinct, full commit SHAs/);
      assert.deepEqual(readdirSync(testHome), []);
    }
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test("active-run migration qualification requires the exact lifecycle mode before side effects", () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "proprio-update-migrations-"));
  try {
    const full = "b".repeat(40);
    for (const env of [
      { E2E_UPDATE_REQUIRE_ACTIVE_RUN: "invalid", E2E_UPDATE_REQUIRE_PROBE: "0" },
      { E2E_UPDATE_REQUIRE_ACTIVE_RUN: "1", E2E_UPDATE_REQUIRE_PROBE: "1" },
    ]) {
      const result = spawnSync("bash", [script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: testHome, E2E_UPDATE_BASE_REF: full,
          E2E_UPDATE_NEXT_REF: "c".repeat(40), ...env },
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /E2E_UPDATE_REQUIRE_ACTIVE_RUN|active-run fixture requires/);
      assert.deepEqual(readdirSync(testHome), [], "validation must run before the harness writes files");
    }
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test("browser readback qualification requires the lifecycle mode and a report path", () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "proprio-update-migrations-"));
  try {
    const env = { ...cleanEnv, HOME: testHome, E2E_UPDATE_REQUIRE_PROBE: "0",
      E2E_UPDATE_BASE_REF: "a".repeat(40), E2E_UPDATE_NEXT_REF: "b".repeat(40) };
    const invalidMode = spawnSync("bash", [script], {
      cwd: repoRoot, encoding: "utf8", env: { ...env, E2E_UPDATE_BROWSER_READBACK: "maybe" },
    });
    assert.equal(invalidMode.status, 2);
    assert.match(invalidMode.stderr, /E2E_UPDATE_BROWSER_READBACK must be 0 or 1/);
    const missingReport = spawnSync("bash", [script], {
      cwd: repoRoot, encoding: "utf8", env: { ...env, E2E_UPDATE_BROWSER_READBACK: "1" },
    });
    assert.equal(missingReport.status, 2);
    assert.match(missingReport.stderr, /requires E2E_UPDATE_BROWSER_REPORT/);
    assert.deepEqual(readdirSync(testHome), []);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test("source CLI qualification requires the reviewed loader before side effects", () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), "proprio-update-migrations-"));
  try {
    const result = spawnSync("bash", [script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...cleanEnv, HOME: testHome, E2E_UPDATE_REQUIRE_PROBE: "0",
        E2E_UPDATE_USE_BOOTSTRAP_CLI: "1", E2E_UPDATE_BASE_REF: "a".repeat(40), E2E_UPDATE_NEXT_REF: "b".repeat(40) },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires E2E_BOOTSTRAP_CLI and E2E_BOOTSTRAP_NODE_LOADER/);
    assert.deepEqual(readdirSync(testHome), []);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});
