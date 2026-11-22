import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_PROVIDERS, LOCKED_PROVIDERS, PROVIDER_WORKSPACE } from "../typecheck-test-programs.mjs";
import { linkExcludedPlugins } from "../link-plugin-dev-sdk.mjs";
import { providersWithTests } from "../test-sandbox-providers.mjs";

export function providerPlan(scope) {
  if (!["locked", "shared"].includes(scope)) throw new Error("Expected --scope locked or --scope shared");
  const providers = SANDBOX_PROVIDERS.filter(directory => LOCKED_PROVIDERS.includes(directory) === (scope === "locked"));
  return { providers, installs: scope === "locked" ? providers : [PROVIDER_WORKSPACE] };
}

export function requireExecutedTests(report, directory) {
  if (!(report.numPassedTests > 0) || report.numFailedTests !== 0 || report.success !== true)
    throw new Error(`Provider tests did not pass with executed cases: ${directory}`);
}

export function qualifyProviders(root, scope) {
  const plan = providerPlan(scope);
  const run = (args, directory) => {
    const result = spawnSync("pnpm", args, { cwd: path.join(root, directory), stdio: "inherit", shell: process.platform === "win32" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Provider dependency check failed: ${directory}: pnpm ${args.join(" ")}`);
  };
  for (const directory of plan.installs) run(["install", ...(scope === "locked" ? ["--ignore-workspace"] : []),
    "--frozen-lockfile", "--ignore-scripts", "--config.confirmModulesPurge=false"], directory);
  linkExcludedPlugins();
  const tests = new Set(providersWithTests({ root, providers: plan.providers }));
  const reports = mkdtempSync(path.join(tmpdir(), "proprio-provider-dependencies-"));
  const failures = [];
  const check = (operation) => {
    try { operation(); } catch (error) { failures.push(error); console.error(error); }
  };
  try {
    for (const directory of plan.providers) {
      check(() => run(["run", "typecheck"], directory));
      check(() => run(["run", "build"], directory));
      if (tests.has(directory)) check(() => {
        const reportPath = path.join(reports, `${path.basename(directory)}.json`);
        run(["run", "test", "--reporter=json", `--outputFile=${reportPath}`], directory);
        const report = JSON.parse(readFileSync(reportPath, "utf8"));
        requireExecutedTests(report, directory);
        console.log(`${directory}: ${report.numPassedTests} tests passed; ${report.numPendingTests ?? 0} skipped`);
      });
    }
  } finally { rmSync(reports, { recursive: true, force: true }); }
  if (failures.length) throw new AggregateError(failures, "Sandbox provider dependency qualification failed");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--scope") throw new Error("Usage: node scripts/ci/qualify-sandbox-provider-dependencies.mjs --scope locked|shared");
  qualifyProviders(fileURLToPath(new URL("../../", import.meta.url)), process.argv[3]);
}
