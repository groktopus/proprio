import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { requiresDurableWorkAcceptance } from "./durable-work-acceptance.mjs";

const smokeWorkflow = ".github/workflows/stability-smoke.yml";
const linuxWorkflow = ".github/workflows/linux-source-qualification.yml";
const protectedInputs = new Set([
  smokeWorkflow, linuxWorkflow, ".github/workflows/durable-work-policy.yml", ".github/scripts/ci-diff.mjs",
  "scripts/ci/durable-work-acceptance.mjs", "scripts/ci/assert-required-vitest-tests.mjs",
  "scripts/ci/durable-work-policy.mjs", "scripts/ci/linux-source-qualification.mjs",
  "scripts/ci/managed-update-command.mjs",
  "scripts/e2e-update-migrations.sh",
]);
const shaPattern = /^[0-9a-f]{40}$/;

export function evidenceSubject(run) {
  if (run.path === smokeWorkflow && run.event === "pull_request" && shaPattern.test(run.head_sha)) {
    return { head: run.head_sha, manual: false };
  }
  if (run.path === linuxWorkflow && run.event === "workflow_dispatch" && run.head_branch === "main"
      && run.head_repository?.full_name === "groktopus/proprio") {
    const match = /^PR ([1-9][0-9]*) source qualification ([0-9a-f]{40})$/.exec(run.display_title);
    if (match) return { number: Number(match[1]), head: match[2], manual: true };
  }
  return null;
}

export function qualificationDecision(changed, subject, jobs) {
  if (!requiresDurableWorkAcceptance(changed)) {
    return { state: "success", description: "Durable-work qualification does not apply" };
  }

  // An ordinary PR that edits the proof recipe may still run it for review.
  // Only a maintainer-dispatched default-branch workflow can attest that head.
  if (!subject.manual && changed.some(path => protectedInputs.has(path))) return null;

  const name = subject.manual ? "source-and-runner" : "durable-work / source-and-runner";
  const evidence = jobs.filter(job => job.name === name);
  if (evidence.length === 1 && evidence[0].conclusion === "success") {
    return { state: "success", description: "Exact-head Linux durable-work qualification passed" };
  }
  return { state: "failure", description: "Required exact-head Linux qualification did not pass" };
}

function readApi(endpoint, paginate = false) {
  const args = ["api", endpoint, ...(paginate ? ["--paginate", "--slurp"] : [])];
  const data = JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  return paginate ? data.flat() : data;
}

export function changedPaths(files) {
  return [...new Set(files.flatMap(file => [file.filename, file.previous_filename]).filter(Boolean))];
}

function evaluate(repository, run) {
  const subject = evidenceSubject(run);
  if (!subject) return;
  const prNumbers = subject.manual ? [subject.number] : run.pull_requests.map(pr => pr.number);
  if (prNumbers.length === 0) {
    const matches = readApi(`repos/${repository}/commits/${subject.head}/pulls?per_page=100`, true);
    prNumbers.push(...matches.map(pr => pr.number));
  }

  for (const number of new Set(prNumbers)) {
    const pr = readApi(`repos/${repository}/pulls/${number}`);
    if (pr.state !== "open" || pr.base.ref !== "main" || pr.head.sha !== subject.head) continue;
    const files = readApi(`repos/${repository}/pulls/${number}/files?per_page=100`, true);
    if (files.length !== pr.changed_files) throw new Error("GitHub did not return the full pull request diff");
    const jobs = readApi(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    const decision = qualificationDecision(changedPaths(files), subject, jobs.jobs);
    if (!decision) {
      console.log(`PR ${number} needs default-branch qualification for its changed workflow inputs`);
      continue;
    }
    execFileSync("gh", [
      "api", `repos/${repository}/statuses/${subject.head}`, "--method", "POST",
      "-f", "context=trusted durable-work acceptance", "-f", `state=${decision.state}`,
      "-f", `description=${decision.description}`, "-f", `target_url=${run.html_url}`,
    ], { stdio: "ignore" });
    console.log(`PR ${number} at ${subject.head}: ${decision.description}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_REPOSITORY !== "groktopus/proprio") throw new Error("Unexpected policy repository");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  evaluate(process.env.GITHUB_REPOSITORY, event.workflow_run);
}
