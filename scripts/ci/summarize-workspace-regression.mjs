import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [directory, lane, source, outcome] = process.argv.slice(2);
if (!directory || !lane || !/^[0-9a-f]{40}$/.test(source ?? "") || !outcome) {
  throw new Error("Usage: summarize-workspace-regression.mjs <reports-dir> <lane> <sha> <job-outcome>");
}
mkdirSync(directory, { recursive: true });
const reports = readdirSync(directory).filter((name) => /^vitest-\d+\.json$/.test(name));
const counts = { passed: 0, failed: 0, skipped: 0, incomplete: 0 };
const requiredSuites = {
  "cli/src/__tests__/install-command.test.ts": null,
  "cli/src/__tests__/update-command.test.ts": null,
  "server/src/__tests__/health.test.ts": null,
};

for (const reportName of reports) {
  try {
    const report = JSON.parse(readFileSync(path.join(directory, reportName), "utf8"));
    const values = [report.numPassedTests, report.numFailedTests, report.numPendingTests, report.numTodoTests, report.numTotalTests];
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0) || !Array.isArray(report.testResults)) {
      throw new Error("Malformed Vitest report");
    }
    counts.passed += report.numPassedTests;
    counts.failed += report.numFailedTests;
    counts.skipped += report.numPendingTests + report.numTodoTests;
    counts.incomplete += Math.max(0, report.numTotalTests - values.slice(0, 4).reduce((a, b) => a + b, 0));
    for (const suite of report.testResults) {
      const name = path.relative(process.cwd(), suite.name).split(path.sep).join("/");
      if (!Object.hasOwn(requiredSuites, name)) continue;
      requiredSuites[name] = {
        status: suite.status,
        passed: suite.assertionResults.filter(test => test.status === "passed").length,
      };
    }
  } catch (error) {
    counts.incomplete += 1;
    console.error(`${reportName}: ${error.message}`);
  }
}

let retryPasses = null;
const timingDir = path.join(directory, "timings");
if (existsSync(timingDir)) {
  retryPasses = 0;
  for (const name of readdirSync(timingDir).filter(name => name.endsWith(".ndjson"))) {
    for (const line of readFileSync(path.join(timingDir, name), "utf8").trim().split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.kind === "test" && event.status === "passed" && event.retries > 0) retryPasses += 1;
    }
  }
}

const executed = counts.passed + counts.failed;
const baselineIncomplete = lane === "cli-and-health-baseline" &&
  Object.values(requiredSuites).some(suite => suite?.status !== "passed" || suite.passed === 0);
const incomplete = outcome !== "success" || executed === 0 || counts.incomplete > 0 ||
  retryPasses === null || baselineIncomplete;
const result = {
  source, lane, stepOutcome: outcome, reports: reports.length, executed,
  ...counts, completePass: !incomplete && counts.failed === 0, retryPasses, requiredSuites,
};
writeFileSync(path.join(directory, "summary.json"), JSON.stringify(result, null, 2) + "\n");
const markdown = [
  `### ${lane} at \`${source}\``,
  "",
  "| Test step | Executed | Passed | Failed | Skipped or todo | Unresolved cases | Passed on retry |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  `| ${outcome} | ${executed} | ${counts.passed} | ${counts.failed} | ${counts.skipped} | ${counts.incomplete} | ${retryPasses ?? "unknown"} |`,
  "",
  ...Object.entries(requiredSuites).filter(([, result]) => result).map(([file, result]) => `- \`${file}\` · ${result.status} · ${result.passed} passed`),
  "",
  incomplete ? "Lane did not produce a complete passing result. Counts include only retained Vitest reports." : "All lane invocations completed.",
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
else console.log(markdown);
if (!result.completePass) process.exitCode = 1;
