import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repository = "groktopus/proprio";
const prefix = `/repos/${repository}`;
const github = `https://github.com/${repository}`;
const weekMs = 7 * 24 * 60 * 60 * 1000;
const endDate = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const end = new Date(endDate);
if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isFinite(end.getTime()) ||
    end.toISOString().slice(0, 10) !== endDate || process.argv.length > 3) throw new Error("Usage: node scripts/ci/critical-journey-qa.mjs [exclusive-end-date]");
const start = new Date(end.getTime() - weekMs);
const date = value => new Date(value).getTime();
const inWindow = value => Boolean(value) && date(value) >= start.getTime() && date(value) < end.getTime();
const settings = [
  { name: "Install and update", matches: /(?:^|[\/.-])(?:install|onboard|update|managed-service|docker|release-evidence|service-health)(?:[\/.-]|$)/i },
  { name: "Backup and restore", matches: /(?:^|[\/.-])(?:backup|restore|migrat\w*)(?:[\/.-]|$)/i },
  { name: "Execution recovery", matches: /(?:^|[\/.-])(?:runner|heartbeat|settlement|replay|recover\w*|resume)(?:[\/.-]|$)/i },
];
const journeyForFiles = files => settings.filter(({ matches }) => files.some(file => matches.test(file))).map(({ name }) => name);
const metrics = new Map(settings.map(({ name }) => [name, {
  prs: 0, timing: [], cancelled: 0, infrastructure: 0, otherNonpassing: 0, missing: 0, tests: 0, retryPasses: 0, flaky: new Map(), defects: [],
}]));
const run = (args, options = {}) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
const api = endpoint => JSON.parse(run(["api", endpoint]));
function rows(endpoint, selection) {
  return run(["api", "--paginate", endpoint, "--jq", `${selection} | @json`])
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
const evidence = new Set();
let unclassified = 0;

const merged = rows(`${prefix}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`,
  `.[] | select(.merged_at != null and .merged_at >= "${start.toISOString().slice(0, 10)}" and .merged_at < "${end.toISOString().slice(0, 10)}") |
    {number, head: .head.sha, merged: .merged_at}`);
for (const pr of merged.filter(pr => inWindow(pr.merged))) {
  const files = rows(`${prefix}/pulls/${pr.number}/files?per_page=100`, ".[] | .filename");
  const names = journeyForFiles(files);
  if (names.length === 0) continue;
  const runs = rows(`${prefix}/actions/workflows/stability-smoke.yml/runs?event=pull_request&head_sha=${pr.head}&per_page=100`,
    ".workflow_runs[] | {id,html_url,created_at,run_attempt,conclusion}");
  const attempts = [];
  for (const workflow of runs) {
    for (let attempt = 1; attempt <= workflow.run_attempt; attempt += 1) {
      const jobs = rows(`${prefix}/actions/runs/${workflow.id}/attempts/${attempt}/jobs?per_page=100`,
        '.jobs[] | {name, conclusion, completed_at, html_url, steps:[.steps[]? | {name, conclusion}]}');
      const smoke = jobs.find(({ name }) => name === "smoke");
      if (!smoke) continue;
      attempts.push({ ...smoke, workflow });
    }
  }

  const passes = attempts.filter(attempt => attempt.conclusion === "success" &&
    attempt.steps.some(step => step.conclusion === "success" &&
      /Verify head and install locked dependencies|Require smoke tests and applicable qualification/.test(step.name)));
  passes.sort((a, b) => date(a.completed_at) - date(b.completed_at));
  const firstRun = Math.min(...runs.map(run => date(run.created_at)));
  const firstPass = passes[0];
  const minutes = firstPass && Number.isFinite(firstRun) ? (date(firstPass.completed_at) - firstRun) / 60_000 : null;
  for (const name of names) {
    const entry = metrics.get(name);
    entry.prs += 1;
    entry.cancelled += attempts.filter(attempt => attempt.conclusion === "cancelled").length;
    entry.infrastructure += attempts.filter(attempt => ["startup_failure", "stale", "action_required"].includes(attempt.conclusion)).length;
    entry.otherNonpassing += attempts.filter(attempt => ["failure", "timed_out", "skipped"].includes(attempt.conclusion)).length;
    if (minutes === null) entry.missing += 1;
    else entry.timing.push(minutes);
  }
  if (!attempts.length) unclassified += 1;
  if (firstPass) evidence.add(`- [PR #${pr.number}](${github}/pull/${pr.number}) · [executed smoke](${firstPass.html_url}) · \`${pr.head.slice(0, 12)}\``);
}

const defectRegister = JSON.parse(readFileSync(new URL("../../doc/qa/critical-journey-defects.json", import.meta.url), "utf8"));
for (const entry of defectRegister) {
  const issue = api(`${prefix}/issues/${entry.issue}`);
  if (!inWindow(issue.created_at)) continue;
  metrics.get(entry.journey).defects.push({ ...entry, title: issue.title, url: issue.html_url });
}

let missingProfiles = 0;
let workspaceRuns = [];
const workflowFiles = rows(`${prefix}/actions/workflows?per_page=100`, ".workflows[] | .path");
if (workflowFiles.includes(".github/workflows/workspace-regression.yml")) {
  const created = encodeURIComponent(`${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`);
  workspaceRuns = rows(`${prefix}/actions/workflows/workspace-regression.yml/runs?branch=main&status=completed&created=${created}&per_page=100`,
    ".workflow_runs[] | {id,head_sha,html_url,created_at,run_attempt,conclusion}").filter(item => inWindow(item.created_at));
}
for (const workflow of workspaceRuns) {
  const temporary = mkdtempSync(path.join(tmpdir(), "proprio-qa-profiles-"));
  try {
    run(["run", "download", String(workflow.id), "--repo", repository, "--pattern", `workspace-regression-*-${workflow.run_attempt}`, "--dir", temporary], { stdio: ["ignore", "pipe", "pipe"] });
    const lanes = readdirSync(temporary, { withFileTypes: true }).filter(entry => entry.isDirectory());
    for (const lane of lanes) {
      if (lane.name.includes("cli-and-health-baseline")) continue;
      const folder = path.join(temporary, lane.name);
      try {
        const summary = JSON.parse(readFileSync(path.join(folder, "summary.json"), "utf8"));
        if (summary.source !== workflow.head_sha) throw new Error("Recorded source mismatch");
        const timings = path.join(folder, "timings");
        const profileFiles = readdirSync(timings).filter(name => name.endsWith(".ndjson"));
        if (!profileFiles.length) throw new Error("No retry profiles");
        for (const file of profileFiles) {
          const events = readFileSync(path.join(timings, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
          if (!events.some(event => event.kind === "end")) {
            missingProfiles += 1;
            continue;
          }
          for (const event of events) {
            if (event.kind !== "test" || !["passed", "failed"].includes(event.status)) continue;
            for (const name of journeyForFiles([event.file])) {
              const entry = metrics.get(name);
              entry.tests += 1;
              if (event.status === "passed" && event.retries > 0) {
                entry.retryPasses += 1;
                const test = `${event.file}: ${event.name}`;
                entry.flaky.set(test, (entry.flaky.get(test) ?? 0) + 1);
              }
            }
          }
        }
      } catch {
        missingProfiles += 1;
      }
    }
    evidence.add(`- [Workspace regression attempt](${workflow.html_url}/attempts/${workflow.run_attempt}) · \`${workflow.head_sha.slice(0, 12)}\` · ${workflow.conclusion}`);
  } catch {
    missingProfiles += 1;
    evidence.add(`- [Workspace regression without readable profiles](${workflow.html_url}/attempts/${workflow.run_attempt})`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function median(values) {
  if (!values.length) return "unknown";
  const sorted = [...values].sort((a, b) => a - b);
  return ((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2).toFixed(1);
}
const reviewDate = new Date(end.getTime() + weekMs).toISOString().slice(0, 10);
console.log(`# Critical-journey QA report

UTC window \`${start.toISOString()}\` inclusive through \`${end.toISOString()}\` exclusive.

| Journey | Merged PRs | Timed PRs | Median minutes to green | Missing pass | Cancelled attempts | Infrastructure | Other nonpassing | Retry-confirmed flakes | Recorded escapes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const [journey, entry] of metrics) {
  const retry = entry.tests ? `${entry.retryPasses}/${entry.tests} (${(entry.retryPasses / entry.tests * 100).toFixed(2)}%)` : "unknown";
  console.log(`| ${journey} | ${entry.prs} | ${entry.timing.length} | ${median(entry.timing)} | ${entry.missing} | ${entry.cancelled} | ${entry.infrastructure} | ${entry.otherNonpassing} | ${retry} | ${entry.defects.length} |`);
}
console.log("\n## Escapes and regression coverage\n");
for (const [journey, entry] of metrics) {
  for (const defect of entry.defects) console.log(`- ${journey} on \`${defect.baseline}\`. ${defect.coverage} [Issue #${defect.issue}](${defect.url}) · [Regression PR #${defect.regressionPr}](${github}/pull/${defect.regressionPr})`);
}
console.log(`\n## Repeat flakes\n\n[Repository owner](${github}/blob/main/.github/CODEOWNERS) reviews repeated exact cases by ${reviewDate}.\n`);
for (const [journey, entry] of metrics) {
  for (const [test, count] of entry.flaky) if (count > 1) console.log(`- ${journey} · \`${test.replaceAll("\`", "'")}\` · ${count} passing retries.`);
}
console.log(`\n## Coverage gaps\n\n- ${unclassified} journey PRs had no retained smoke job.\n- ${workspaceRuns.length} workspace regression runs found, ${missingProfiles} missing or incomplete profile groups. With no matching executed cases, retry rates are unknown.\n- Escape counts cover only registered issues. Untagged defects and projects outside the chosen path groups have unknown coverage.\n\n## Evidence\n\n${[...evidence].join("\n")}`);
