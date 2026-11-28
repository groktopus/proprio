#!/usr/bin/env node
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`Linux image qualification evidence rejected: ${message}`);
  process.exit(1);
}

const [runPath, jobsPath, buildPath] = process.argv.slice(2);
if (!runPath || !jobsPath || !buildPath) fail("expected run, jobs, and build metadata JSON paths");

const expectedRunId = process.env.QUALIFICATION_RUN_ID ?? "";
const expectedAttempt = process.env.QUALIFICATION_ATTEMPT ?? "";
const expectedSourceSha = process.env.SOURCE_SHA ?? "";
const expectedDigest = process.env.CANDIDATE_DIGEST ?? "";
if (!/^[1-9][0-9]*$/.test(expectedRunId) || !/^[1-9][0-9]*$/.test(expectedAttempt)) {
  fail("run ID and attempt must be positive integers");
}
if (!/^[0-9a-f]{40}$/.test(expectedSourceSha)) fail("source SHA must be a lowercase commit SHA");
if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) fail("candidate digest must be a sha256 OCI digest");

let run;
let jobs;
let build;
try {
  run = JSON.parse(readFileSync(runPath, "utf8"));
  jobs = JSON.parse(readFileSync(jobsPath, "utf8"));
  build = JSON.parse(readFileSync(buildPath, "utf8"));
} catch (error) {
  fail(`qualification evidence is unreadable JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const runId = Number(expectedRunId);
const attempt = Number(expectedAttempt);
if (run.id !== runId
  || run.path !== ".github/workflows/linux-image-release.yml"
  || run.event !== "workflow_dispatch"
  || run.status !== "completed"
  || run.conclusion !== "success"
  || run.run_attempt !== attempt
  || run.head_branch !== "main"
  || run.head_sha !== expectedSourceSha
  || run.repository?.full_name !== "groktopus/proprio"
  || run.head_repository?.full_name !== "groktopus/proprio") {
  fail("run must be a successful latest main-branch dispatch of the exact source SHA and attempt");
}
if (!Array.isArray(jobs) || !jobs.some(job => job.name === "Qualify the candidate digest in Compose"
  && job.status === "completed" && job.conclusion === "success")) {
  fail("the run has no successful Compose candidate qualification job");
}
if (build["containerimage.digest"] !== expectedDigest) {
  fail("the selected digest does not match this run attempt's build metadata");
}

console.log(`Verified qualification run ${runId} attempt ${attempt}: ${expectedSourceSha} ${expectedDigest}`);
