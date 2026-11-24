import test from "node:test";
import assert from "node:assert/strict";
import { renderReport, summarizeEvidence, validateEvidence } from "./task-open-report.mjs";

const sample = (overrides = {}) => ({
  cohort: "cold-direct",
  taskKind: "saved-history",
  outcome: "ready",
  marks: { composerVisible: 100, latestVisible: 180 },
  cls: 0.01,
  latestMoves: [],
  requests: { beforeReady: 3, pending: 0, releasedBy: [{ serverMs: 42 }] },
  ...overrides,
});

const evidence = {
  build: { commit: "abc123", server: "server-abc123", ui: "ui-abc123", target: "disposable-local", browser: "chromium 1", capturedAt: "2026-11-24T12:00:00Z" },
  samples: [
    sample(),
    sample({ marks: { composerVisible: 140, latestVisible: 220 } }),
    sample({ taskKind: "live-run", marks: { composerVisible: 90, latestVisible: 120 } }),
    sample({ cohort: "cached-return", outcome: "timeout", marks: {} }),
    sample({ cohort: "cached-return", outcome: "error", marks: {} }),
    sample({ cohort: "cached-return", outcome: "closed", marks: {} }),
  ],
};

test("summarizes p50/p95 from ready samples and keeps all outcomes", () => {
  const summary = summarizeEvidence(evidence);
  assert.deepEqual(summary.groups["cold-direct:saved-history"].outcomes, { ready: 2, error: 0, timeout: 0, closed: 0 });
  assert.equal(summary.groups["cold-direct:saved-history"].p50Ms, 200);
  assert.equal(summary.groups["cached-return:saved-history"].outcomes.timeout, 1);
  assert.equal(summary.groups["cached-return:saved-history"].outcomes.error, 1);
  assert.equal(summary.groups["cached-return:saved-history"].outcomes.closed, 1);
  assert.equal(summary.groups["cached-return:saved-history"].p50Ms, null);
});

test("rejects evidence without exact build identity", () => {
  assert.throws(() => validateEvidence({ ...evidence, build: { ...evidence.build, ui: "" } }), /build.ui/);
  assert.throws(() => validateEvidence({ ...evidence, samples: [] }), /non-empty/);
});

test("renders a versioned comparison and explicit limits", () => {
  const previous = { ...evidence, build: { ...evidence.build, commit: "old456", capturedAt: "2026-11-23T12:00:00Z" }, samples: [sample({ marks: { composerVisible: 100, latestVisible: 100 } })] };
  const report = renderReport(evidence, previous);
  assert.match(report, /Build commit: `abc123`/);
  assert.match(report, /Comparison baseline: `old456`/);
  assert.match(report, /p50 delta \(ms\)/);
  assert.match(report, /does not establish a release or managed-telemetry result/);
});
