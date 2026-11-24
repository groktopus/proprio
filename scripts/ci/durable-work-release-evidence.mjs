import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { requiresDurableWorkAcceptance } from "./durable-work-acceptance.mjs";

const repository = "groktopus/proprio";
const workflowPath = ".github/workflows/linux-source-qualification.yml";
const artifactName = "durable-work-acceptance";
const artifactFile = "durable-work-acceptance.json";
export const requiredReleaseCases = [
  "managed-update-rollback",
  "backup-restore-fresh-target",
  "migration-active-run-recovery",
  "interruption-restart-cancel-disk-pressure",
  "browser-task-readback",
];
const shaPattern = /^[a-f0-9]{40}$/;

function assertSha(sha, label) {
  if (!shaPattern.test(sha ?? "")) throw new Error(`A full lowercase ${label} SHA is required.`);
}

function trustedRun(run, sha, baseSha, workflowId) {
  const title = run.display_title ?? "";
  const bindsSource = title === `Source qualification ${sha} from ${baseSha}`;
  return run.workflow_id === workflowId && run.path === workflowPath &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.head_branch === "main" && run.event === "workflow_dispatch" &&
    run.head_sha && shaPattern.test(run.head_sha) &&
    bindsSource && Number.isSafeInteger(run.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0;
}

function githubEvidenceUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://github.com";
  } catch {
    return false;
  }
}

export function validateDurableWorkReleaseManifest(manifest, {
  sourceSha, baseSha, runId, attempt, migrationRequired = true,
}) {
  if (!manifest || manifest.schema !== "proprio.durable-work-qualification/v1") {
    throw new Error("Durable-work qualification artifact has an unsupported schema.");
  }
  if (manifest.sourceSha !== sourceSha || manifest.baseSha !== baseSha) {
    throw new Error("Durable-work qualification artifact does not match the source and previous-release SHAs.");
  }
  if (!manifest.cases || typeof manifest.cases !== "object" || Array.isArray(manifest.cases)) {
    throw new Error("Durable-work qualification artifact is missing its case map.");
  }

  validateRequiredCases(manifest, { sourceSha, baseSha, runId, attempt, migrationRequired });
  return manifest;
}

function migrationSqlChanged(paths) {
  return paths.some(path => /^packages\/db\/src\/migrations\/[^/]+\.sql$/.test(path));
}

function validateCaseEvidence(testCase, outcome, { runId, attempt }) {
  return testCase?.outcome === outcome && Array.isArray(testCase.evidenceUrls) &&
    testCase.evidenceUrls.length > 0 && testCase.evidenceUrls.every(value =>
      githubEvidenceUrl(value) && new URL(value).pathname ===
        `/groktopus/proprio/actions/runs/${runId}/attempts/${attempt}`);
}

function validateRequiredCases(manifest, { sourceSha, baseSha, runId, attempt, migrationRequired }) {
  for (const id of requiredReleaseCases.filter(id => id !== "migration-active-run-recovery")) {
    if (!validateCaseEvidence(manifest.cases[id], "passed", { runId, attempt })) {
      throw new Error(`Required durable-work case is missing passing evidence for this run attempt: ${id}.`);
    }
  }
  const migration = manifest.cases["migration-active-run-recovery"];
  const requiredOutcome = migrationRequired ? "passed" : "not_applicable";
  if (!validateCaseEvidence(migration, requiredOutcome, { runId, attempt })) {
    throw new Error(`Active-run migration case must be marked ${requiredOutcome} with evidence for this run attempt.`);
  }
  if (migrationRequired && (migration.previousReleaseSha !== baseSha || migration.schemaCandidateSha !== sourceSha ||
      !Number.isSafeInteger(migration.elapsedRecoveryMs) || migration.elapsedRecoveryMs < 0 ||
      migration.observedDataLoss !== 0)) {
    throw new Error("Active-run migration evidence does not match the source/base revisions or recovery outcome.");
  }
}

async function readDownloadedManifest(runId, downloadArtifact) {
  const directory = await mkdtemp(join(tmpdir(), "proprio-durable-work-release-"));
  try {
    await downloadArtifact(runId, artifactName, directory);
    const files = [];
    async function visit(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const fullPath = join(path, entry.name);
        if (entry.isDirectory()) await visit(fullPath);
        else files.push(fullPath);
      }
    }
    await visit(directory);
    const reports = files.filter(path => basename(path) === artifactFile);
    if (reports.length !== 1 || files.length !== 1) {
      throw new Error(`Expected exactly one ${artifactFile} in the ${artifactName} artifact.`);
    }
    return JSON.parse(await readFile(reports[0], "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readDurableWorkReleaseEvidence({ sourceSha, baseSha, api, downloadArtifact, migrationRequired = true }) {
  assertSha(sourceSha, "source");
  assertSha(baseSha, "previous-release");
  if (sourceSha === baseSha) throw new Error("Source release evidence requires a revision after the previous release.");

  const workflow = await api(`/repos/${repository}/actions/workflows/linux-source-qualification.yml`);
  if (workflow.path !== workflowPath || !Number.isSafeInteger(workflow.id) || workflow.id < 1) {
    throw new Error("Linux source qualification workflow identity does not match.");
  }
  const workflowRuns = [];
  let totalRuns;
  for (let page = 1; page <= 10; page += 1) {
    const listing = await api(`/repos/${repository}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`);
    if (!Array.isArray(listing.workflow_runs) || !Number.isSafeInteger(listing.total_count) || listing.total_count < 0 ||
        (totalRuns !== undefined && listing.total_count !== totalRuns)) {
      throw new Error("Linux source qualification run listing is malformed.");
    }
    totalRuns = listing.total_count;
    workflowRuns.push(...listing.workflow_runs);
    if (workflowRuns.length >= totalRuns) break;
    if (listing.workflow_runs.length < 100 || page === 10) {
      throw new Error("Linux source qualification run listing is incomplete.");
    }
  }
  const run = workflowRuns.filter(candidate => trustedRun(candidate, sourceSha, baseSha, workflow.id))
    .sort((a, b) => b.id - a.id)[0];
  if (!run) throw new Error(`No trusted Linux source qualification run exists for ${sourceSha}.`);
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`Linux source qualification for ${sourceSha} is not a completed pass (run ${run.id}).`);
  }

  const batch = await api(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=1`);
  if (!Array.isArray(batch.jobs) || batch.jobs.length >= 100) {
    throw new Error("Linux source qualification job listing is incomplete.");
  }
  const matches = batch.jobs.filter(job => job.name === "source-and-runner");
  const job = matches.length === 1 ? matches[0] : undefined;
  if (!job || !Number.isSafeInteger(job.id) || job.id < 1 ||
      job.status !== "completed" || job.conclusion !== "success" ||
      job.run_id !== run.id || job.run_attempt !== run.run_attempt) {
    throw new Error(`Required source-and-runner job did not pass for ${sourceSha}.`);
  }

  const artifacts = await api(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
  if (!Array.isArray(artifacts.artifacts) || !Number.isSafeInteger(artifacts.total_count) ||
      artifacts.total_count < 0 || artifacts.total_count > 100 || artifacts.artifacts.length !== artifacts.total_count) {
    throw new Error("Linux source qualification artifact listing is incomplete.");
  }
  const matchesArtifact = artifacts.artifacts.filter(item => item.name === artifactName);
  const artifact = matchesArtifact.length === 1 ? matchesArtifact[0] : undefined;
  if (!artifact || artifact.expired || !Number.isSafeInteger(artifact.id) || artifact.id < 1) {
    throw new Error(`Required ${artifactName} artifact is missing, expired, or ambiguous.`);
  }

  const manifest = validateDurableWorkReleaseManifest(
    await readDownloadedManifest(run.id, downloadArtifact), {
      sourceSha, baseSha, runId: run.id, attempt: run.run_attempt, migrationRequired,
    },
  );
  const current = await api(`/repos/${repository}/actions/runs/${run.id}`);
  if (!trustedRun(current, sourceSha, baseSha, workflow.id) || current.run_attempt !== run.run_attempt ||
      current.status !== "completed" || current.conclusion !== "success") {
    throw new Error(`Linux source qualification changed while reading evidence for ${sourceSha}.`);
  }
  return {
    sourceSha,
    baseSha,
    runId: run.id,
    attempt: run.run_attempt,
    jobId: job.id,
    artifactId: artifact.id,
    manifest,
  };
}

export function changedPathsSinceRelease(baseSha, sourceSha, runGit = execFileSync) {
  assertSha(sourceSha, "source");
  assertSha(baseSha, "previous-release");
  return runGit("git", ["diff", "--name-only", "--no-renames", `${baseSha}..${sourceSha}`], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  }).trim().split("\n").filter(Boolean);
}

function ghJson(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
}

async function downloadWithGh(runId, name, directory) {
  execFileSync("gh", ["run", "download", String(runId), "--name", name, "--dir", directory], {
    encoding: "utf8", stdio: "pipe", maxBuffer: 8 * 1024 * 1024,
  });
}

export async function verifyDurableWorkSourceRelease({
  sourceSha, baseSha, api = ghJson, downloadArtifact = downloadWithGh, changedPaths: suppliedPaths, requireLinux = false,
}) {
  const changed = suppliedPaths ?? changedPathsSinceRelease(baseSha, sourceSha);
  if (!requireLinux && !requiresDurableWorkAcceptance(changed)) {
    return { applicable: false, sourceSha, baseSha, changed };
  }
  const evidence = await readDurableWorkReleaseEvidence({ sourceSha, baseSha, api, downloadArtifact,
    migrationRequired: migrationSqlChanged(changed) });
  return { applicable: true, changed, ...evidence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [sourceSha, baseSha, ...flags] = process.argv.slice(2);
    const requireLinux = flags.length === 1 && flags[0] === "--require-linux";
    if (!sourceSha || !baseSha || (flags.length > 0 && !requireLinux)) {
      throw new Error("Usage: node scripts/ci/durable-work-release-evidence.mjs <source-sha> <previous-release-sha> [--require-linux]");
    }
    const result = await verifyDurableWorkSourceRelease({ sourceSha, baseSha, requireLinux });
    if (!result.applicable) {
      console.log(`Durable-work release qualification does not apply to ${sourceSha}.`);
    } else {
      console.log(`Durable-work qualification passed for ${sourceSha}: https://github.com/${repository}/actions/runs/${result.runId}/attempts/${result.attempt} (job ${result.jobId}); artifact https://github.com/${repository}/actions/runs/${result.runId}/artifacts/${result.artifactId}.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
