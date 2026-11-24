import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

test("active process recovery binds durable workspace and delivers one reconciled continuation", () => {
  const source = readFileSync(script, "utf8");
  const activity = readFileSync(path.join(repoRoot, "server", "src", "services", "activity.ts"), "utf8");
  const issues = readFileSync(path.join(repoRoot, "server", "src", "routes", "issues.ts"), "utf8");
  const issueValidator = readFileSync(path.join(repoRoot, "packages", "shared", "src", "validators", "issue.ts"), "utf8");
  const instanceRoute = readFileSync(path.join(repoRoot, "server", "src", "routes", "instance-settings.ts"), "utf8");
  const instanceValidator = readFileSync(path.join(repoRoot, "packages", "shared", "src", "validators", "instance.ts"), "utf8");
  assert.match(activity, /runId: heartbeatRuns\.id/);
  assert.match(issues, /executionWorkspaceId: issue\.executionWorkspaceId/);
  assert.match(issueValidator, /executionWorkspacePreference:[\s\S]*?executionWorkspaceSettings/);
  assert.match(instanceRoute, /"\/instance\/settings\/experimental"[\s\S]*?patchInstanceExperimentalSettingsSchema/);
  assert.match(instanceValidator, /enableIsolatedWorkspaces: z\.boolean\(\)\.default\(false\)/);
  assert.match(source, /\[\.\[\]\]\[0\]\.runId \/\/ empty/);
  assert.match(source, /select\(\.runId == \$id/);
  assert.doesNotMatch(source, /\[\.\[\]\]\[0\]\.id \/\/ empty/);
  assert.match(source, /instance\/settings\/experimental/);
  assert.match(source, /enableIsolatedWorkspaces":true/);
  assert.match(source, /executionWorkspacePreference:"isolated_workspace"/);
  assert.match(source, /executionWorkspaceSettings:\{mode:"isolated_workspace",workspaceStrategy:\{type:"project_primary"\}\}/);
  assert.match(source, /const startupCwd = process\.cwd\(\)/);
  assert.match(source, /const workspace = issue\.currentExecutionWorkspace/);
  assert.match(source, /workspace\.id !== issue\.executionWorkspaceId/);
  assert.match(source, /process\.chdir\(workspace\.cwd\)/);
  assert.match(source, /startupCwd, cwd: process\.cwd\(\), workspaceId: workspace\.id/);
  assert.match(source, /if \(effectAlreadyExists\)[\s\S]*?validateCheckpoint\(\);\s+validateProcessIdentity\(\);/);
  assert.match(source, /writeFileSync\(processIdentity,[\s\S]*?\{ flag: "wx" \}\)/);
  assert.match(source, /while \[ "\$\(date \+%s\)" -lt "\$effect_deadline" \].*\[ "\$\(cat "\$ACTIVE_EFFECT"\)" != "effect" \]/);
  assert.match(source, /provider process cwd and identity match the bound workspace/);
  assert.match(source, /completed effect marker contains exactly one effect/);
  assert.match(source, /\.executionWorkspaceId \/\/ empty/);
  assert.match(source, /executionWorkspaceId from the task binding/);
  assert.match(source, /legacy_execution_requires_reconciliation/);
  assert.match(source, /providerStopped:true,actionOutcome:"mixed"/);
  assert.match(source, /qualification-process\.json/);
  assert.match(source, /ACTIVE_PROCESS_CURRENT_START/);
  assert.match(source, /ACTIVE_PROCESS_STATE.*!= Z/);
  assert.match(source, /provider PID \$ACTIVE_PROCESS_PID with start identity \$ACTIVE_PROCESS_START; startup cwd/);
  assert.match(source, /recovery-actions\?inspectSourceRunId=\$ACTIVE_RUN_ID/);
  assert.match(source, /\.ownerType == "board" and \.kind == "active_run_watchdog" and \.cause == "legacy_execution_requires_reconciliation"/);
  assert.match(source, /\.fingerprint == \("legacy-execution:" \+ \$run\) and \.sourceIssueId == \$issue and \.evidence\.runId == \$run/);
  assert.match(source, /exactly one terminal task attempt exists before reconciliation/);
  assert.match(source, /no live task execution remains before reconciliation/);
  assert.match(source, /completion output is absent before reconciliation/);
  assert.match(source, /exactly one completed provider effect exists before reconciliation/);
  assert.doesNotMatch(source, /evidence\.automaticRecovery\.replay == "blocked"/);
  assert.match(source, /7d non-migration task run remains succeeded and readable/);
  assert.match(source, /if \[ "\$active_run_required" = 1 \]; then\s+jq -e --arg id "\$ACTIVE_RUN_ID"/);
  assert.match(source, /recovery-actions\/resolve/);
  assert.match(source, /continuationDelivery == "pending"/);
  assert.doesNotMatch(source, /api\/issues\/\$ACTIVE_ISSUE_ID\/retry/);
});

test("fixture worker changes into the task workspace and completes the effect marker before delivery", async () => {
  const source = readFileSync(script, "utf8");
  const worker = source.match(/cat > "\$ACTIVE_SCRIPT" <<'NODE'\n(?<body>[\s\S]*?)\nNODE/)?.groups?.body;
  assert.ok(worker, "expected the generated recovery worker script");

  const home = mkdtempSync(path.join(os.tmpdir(), "proprio-update-worker-"));
  const workspace = path.join(home, "execution-workspace");
  const marker = path.join(home, "effect.txt");
  mkdirSync(workspace);
  const comments = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/api/issues/issue-1" && request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ executionWorkspaceId: "workspace-1", currentExecutionWorkspace: { id: "workspace-1", cwd: workspace } }));
      return;
    }
    if (request.url === "/api/issues/issue-1/comments" && request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(comments));
      return;
    }
    if (request.url === "/api/issues/issue-1/comments" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      comments.push(JSON.parse(body));
      response.statusCode = 201;
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const workerFile = path.join(home, "worker.mjs");
    await import("node:fs/promises").then(fs => fs.writeFile(workerFile, worker));
    const output = "Recovered task output: qualification effect completed exactly once.";
    const runWorker = async () => {
      const child = spawn(process.execPath, [workerFile, marker, "issue-1", `http://127.0.0.1:${address.port}`, output, "complete"], {
        cwd: repoRoot,
        env: { ...cleanEnv, PROPRIO_API_KEY: "fixture-token" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { exitCode, stdout, stderr };
    };
    const first = await runWorker();
    assert.equal(first.exitCode, 0, first.stderr || first.stdout);
    assert.equal(readFileSync(marker, "utf8"), "effect\n");
    assert.equal(readFileSync(path.join(workspace, "qualification-checkpoint.txt"), "utf8"), "checkpoint for issue-1\n");
    const identityPath = path.join(workspace, "qualification-process.json");
    const firstIdentityContents = readFileSync(identityPath, "utf8");
    const identity = JSON.parse(firstIdentityContents);
    assert.equal(identity.startupCwd, repoRoot);
    assert.equal(identity.cwd, workspace);
    assert.equal(identity.workspaceId, "workspace-1");
    assert.deepEqual(comments, [{ body: output }]);

    const continuation = await runWorker();
    assert.equal(continuation.exitCode, 0, continuation.stderr || continuation.stdout);
    assert.equal(readFileSync(identityPath, "utf8"), firstIdentityContents, "continuation keeps the original provider process identity");
    assert.deepEqual(comments, [{ body: output }], "continuation delivers the task output once");

    rmSync(path.join(workspace, "qualification-checkpoint.txt"));
    const missingCheckpoint = await runWorker();
    assert.notEqual(missingCheckpoint.exitCode, 0);
    assert.match(missingCheckpoint.stderr, /original task workspace checkpoint is missing or changed/);
    assert.deepEqual(comments, [{ body: output }], "missing checkpoint does not trigger a second delivery");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});

test("recovery task uses the normal todo-then-assign flow and bounds HTTP diagnostics", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /status:\"todo\"/);
  assert.match(source, /assigneeAgentId:\$agent/);
  assert.match(source, /api\/agents\/\$ACTIVE_AGENT_ID\/wakeup/);
  assert.match(source, /qualification_assignment_fallback/);
  assert.match(source, /reusing it without a duplicate wake/);
  assert.match(source, /before timeout \(\$SAFE_RUN_STATE\)/);
  assert.match(source, /terminal state \$SAFE_RUN_FAILURE/);
  assert.match(source, /9f rolled-back base API retains the same task, expected run history, one output, and one effect/);
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
