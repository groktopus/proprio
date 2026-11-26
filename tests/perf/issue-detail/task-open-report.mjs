import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const COHORTS = ["cold-direct", "uncached-in-app", "cached-return"];
const TASK_KINDS = ["live-run", "saved-history"];

const OUTCOMES = ["ready", "error", "timeout", "closed"];

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
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
  return Number.isFinite(composer) && composer >= 0 && Number.isFinite(latest) && latest >= 0 ? Math.max(composer, latest) : null;
}

function normalizeSample(sample) {
  const cohort = sample.cohort;
  const taskKind = sample.taskKind;
  if (!COHORTS.includes(cohort)) throw new Error(`Unknown task-open cohort: ${cohort}`);
  if (!TASK_KINDS.includes(taskKind)) throw new Error(`Unknown task kind: ${taskKind}`);
  if (!OUTCOMES.includes(sample.outcome)) throw new Error(`Invalid sample outcome: ${sample.outcome}`);
  const ready = readinessMs(sample);
  if (sample.outcome === "ready" && ready === null) throw new Error("Ready samples need both visible readiness marks");
  return { ...sample, readinessMs: ready };
}

function summarize(samples) {
  const outcomes = Object.fromEntries(OUTCOMES.map((key) => [key, 0]));
  for (const sample of samples) outcomes[sample.outcome] += 1;
  const ready = samples.filter((sample) => sample.outcome === "ready");
  const values = ready.map((sample) => sample.readinessMs);
  const cls = samples.map((sample) => sample.cls).filter(Number.isFinite);
  const beforeReady = ready.map((sample) => sample.requests?.beforeReady).filter(Number.isFinite);
  const pending = samples.map((sample) => sample.requests?.pending).filter(Number.isFinite);
  const serverTiming = ready.map((sample) => (sample.releasedBy ?? sample.requests?.releasedBy)?.[0]?.serverMs).filter(Number.isFinite);
  return {
    attempts: samples.length,
    outcomes,
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxCls: cls.length ? Number(Math.max(...cls).toFixed(4)) : null,
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
  if (!/^[0-9a-f]{40}$/i.test(build.commit)) throw new Error("Evidence build.commit must be a full Git SHA");
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(build.capturedAt) || !Number.isFinite(Date.parse(build.capturedAt))) {
    throw new Error("Evidence build.capturedAt must be a valid UTC timestamp");
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
  return { build: evidence.build, groups };
}

function format(value) {
  return value === null || value === undefined ? "—" : String(value);
}

export function renderReport(evidence, previous = null) {
  const summary = summarizeEvidence(evidence);
  const previousSummary = previous ? summarizeEvidence(previous) : null;
  const comparable = previousSummary
    && previousSummary.build.target === summary.build.target
    && previousSummary.build.browser === summary.build.browser;
  const rows = [];
  for (const cohort of COHORTS) {
    for (const taskKind of TASK_KINDS) {
      const key = `${cohort}:${taskKind}`;
      const group = summary.groups[key];
      const prior = previousSummary?.groups[key];
      const delta = comparable && group.attempts >= 5 && (prior?.attempts ?? 0) >= 5
        && group.p50Ms !== null && prior?.p50Ms !== null && prior?.p50Ms !== undefined
        ? round(group.p50Ms - prior.p50Ms)
        : null;
      rows.push(`| ${cohort} | ${taskKind} | ${group.attempts} | ${group.outcomes.ready} | ${group.outcomes.error} | ${group.outcomes.timeout} | ${group.outcomes.closed} | ${format(group.p50Ms)} | ${format(group.p95Ms)} | ${format(group.maxCls)} | ${group.samplesWithLatestMoves} | ${format(group.medianPendingRequests)} | ${format(group.medianRequestsBeforeReady)} | ${format(group.medianReleasedServerMs)} | ${format(delta)} |`);
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
    "| Cohort | Task kind | Attempts | Ready | Error | Timeout | Closed | p50 ready (ms) | p95 ready (ms) | Max CLS | Latest message moved | Median pending | Median API requests before ready | Median released server time (ms) | p50 delta (ms) |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    previousSummary
      ? `Comparison baseline: \`${previousSummary.build.commit}\` (${previousSummary.build.capturedAt}). Deltas require matching targets and browsers, five attempts per build and cohort, and a ready sample on both builds.`
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
