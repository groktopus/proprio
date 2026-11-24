import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const COHORTS = ["cold-direct", "uncached-in-app", "cached-return"];
export const TASK_KINDS = ["live-run", "saved-history"];

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function percentile(values, fraction) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function round(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function readinessMs(sample) {
  const composer = sample.marks?.composerVisible;
  const latest = sample.marks?.latestVisible;
  return finite(composer) && finite(latest) ? Math.max(composer, latest) : null;
}

function normalizeOutcome(sample) {
  if (["ready", "error", "timeout", "closed"].includes(sample.outcome)) return sample.outcome;
  return readinessMs(sample) === null ? "timeout" : "ready";
}

function normalizeSample(sample) {
  const cohort = sample.cohort;
  const taskKind = sample.taskKind;
  if (!COHORTS.includes(cohort)) throw new Error(`Unknown task-open cohort: ${cohort}`);
  if (!TASK_KINDS.includes(taskKind)) throw new Error(`Unknown task kind: ${taskKind}`);
  return {
    ...sample,
    outcome: normalizeOutcome(sample),
    readinessMs: readinessMs(sample),
  };
}

function summarize(samples) {
  const outcomes = Object.fromEntries(["ready", "error", "timeout", "closed"].map((key) => [key, 0]));
  for (const sample of samples) outcomes[sample.outcome] += 1;
  const ready = samples.filter((sample) => sample.outcome === "ready" && finite(sample.readinessMs));
  const values = ready.map((sample) => sample.readinessMs);
  const cls = samples.map((sample) => sample.cls).filter(finite);
  const beforeReady = samples.map((sample) => sample.requests?.beforeReady).filter(finite);
  const pending = samples.map((sample) => sample.requests?.pending).filter(finite);
  const serverTiming = samples.map((sample) => (sample.releasedBy ?? sample.requests?.releasedBy)?.[0]?.serverMs).filter(finite);
  return {
    attempts: samples.length,
    outcomes,
    readyCount: ready.length,
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxCls: cls.length ? round(Math.max(...cls)) : null,
    samplesWithLatestMoves: samples.filter((sample) => Array.isArray(sample.latestMoves) && sample.latestMoves.length > 0).length,
    medianRequestsBeforeReady: round(percentile(beforeReady, 0.5)),
    medianPendingRequests: round(percentile(pending, 0.5)),
    medianReleasedServerMs: round(percentile(serverTiming, 0.5)),
  };
}

export function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") throw new Error("Evidence must be an object");
  const build = evidence.build;
  for (const key of ["commit", "server", "ui", "target", "browser", "capturedAt"]) {
    if (typeof build?.[key] !== "string" || build[key].trim() === "") {
      throw new Error(`Evidence build.${key} is required`);
    }
  }
  if (!Array.isArray(evidence.samples) || evidence.samples.length === 0) {
    throw new Error("Evidence samples must be a non-empty array");
  }
  return evidence;
}

export function summarizeEvidence(evidence) {
  validateEvidence(evidence);
  const samples = evidence.samples.map(normalizeSample);
  const groups = {};
  for (const cohort of COHORTS) {
    for (const taskKind of TASK_KINDS) {
      const key = `${cohort}:${taskKind}`;
      groups[key] = summarize(samples.filter((sample) => sample.cohort === cohort && sample.taskKind === taskKind));
    }
  }
  return { build: evidence.build, sampleCount: samples.length, groups };
}

function format(value) {
  return value === null || value === undefined ? "—" : String(value);
}

export function renderReport(evidence, previous = null) {
  const summary = summarizeEvidence(evidence);
  const previousSummary = previous ? summarizeEvidence(previous) : null;
  const rows = [];
  for (const cohort of COHORTS) {
    for (const taskKind of TASK_KINDS) {
      const key = `${cohort}:${taskKind}`;
      const group = summary.groups[key];
      const prior = previousSummary?.groups[key];
      const delta = group.p50Ms !== null && prior?.p50Ms !== null && prior?.p50Ms !== undefined
        ? round(group.p50Ms - prior.p50Ms)
        : null;
      rows.push(`| ${cohort} | ${taskKind} | ${group.attempts} | ${group.outcomes.ready} | ${group.outcomes.error} | ${group.outcomes.timeout} | ${group.outcomes.closed} | ${format(group.p50Ms)} | ${format(group.p95Ms)} | ${format(group.maxCls)} | ${format(group.medianRequestsBeforeReady)} | ${format(group.medianReleasedServerMs)} | ${format(delta)} |`);
    }
  }
  return [
    "# Task-open readiness report",
    "",
    `Build commit: \`${summary.build.commit}\`  `,
    `Server build: ${summary.build.server}  `,
    `UI build: ${summary.build.ui}  `,
    `Target: ${summary.build.target}  `,
    `Browser: ${summary.build.browser}  `,
    `Captured: ${summary.build.capturedAt}`,
    "",
    "Ready means both the composer and latest message were visible. p50/p95 use ready samples only; outcome counts include failures, timeouts, and unobservable tab closes.",
    "",
    "| Cohort | Task kind | Attempts | Ready | Error | Timeout | Closed | p50 ready (ms) | p95 ready (ms) | Max CLS | Median API requests before ready | Median released server time (ms) | p50 delta (ms) |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    previousSummary
      ? `Comparison baseline: \`${previousSummary.build.commit}\` (${previousSummary.build.capturedAt}). A delta is shown only when both builds have ready samples.`
      : "No comparison baseline supplied.",
    "",
    "Scope limits: this report does not establish a release or managed-telemetry result. Record the disposable target, exact build identity, fixture/task provenance, and any staging or managed-population differences with the raw samples.",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [currentPath, previousPath, outputPath] = process.argv.slice(2);
  if (!currentPath) throw new Error("Usage: node task-open-report.mjs current.json [previous.json] [output.md]");
  const current = JSON.parse(await fs.readFile(currentPath, "utf8"));
  const previous = previousPath ? JSON.parse(await fs.readFile(previousPath, "utf8")) : null;
  const report = renderReport(current, previous);
  if (outputPath) await fs.writeFile(outputPath, `${report}\n`);
  else console.log(report);
}
