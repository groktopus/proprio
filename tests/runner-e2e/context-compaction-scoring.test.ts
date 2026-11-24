import { describe, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { configureContextCompactionBudgets } from "./context-compaction-case.js";
import { gradeContextCompactionPair, type CompactionObservation } from "./context-compaction-scoring.js";

const fixture = { retainedMarker: "keep-amber", activeFormat: "current-v2", supersededFormat: "obsolete-v1", releaseCode: "EMBER-72" };
const requirementRevisionIds = { control: "control-requirements-v2", treatment: "treatment-requirements-v2" };

function lane(mode: "control" | "treatment"): CompactionObservation {
  const taskId = `${mode}-task`;
  const sessionDigest = `${mode}-digest`;
  const run = (kind: string, startedAt: number, finishedAt: number) => ({ id: `${mode}-${kind}`, taskId,
    sessionDigest, runnerDigest: `${mode}-runner`, runnerGenerations: [1],
    compactionRequestId: kind === "compact" ? "manual-compact" : null, startedAt, finishedAt, status: "succeeded" });
  const initial = run("initial", 1, 5);
  const compact = run("compact", 6, 8);
  const waiting = run("waiting", 10, 15);
  const final = run("final", 20, 25);
  return { sourceRevision: "tested-revision", profileId: "runner-codex", provider: "codex", model: "fixture-model",
    fixtureDigest: "same-fixture", taskId, initial, waiting, final,
    compactRequest: mode === "treatment" ? { requestId: "manual-compact", run: compact } : null,
    compactionEvents: mode === "treatment" ? [{ runId: compact.id, reason: "provider", sameSession: true, sequence: 3 }] : [],
    prerequisite: { receiptId: `${mode}-prerequisite`, publishedAt: 18 },
    actions: [{ runId: waiting.id, kind: "request_prerequisite", at: 12 }, { runId: final.id, kind: "write_artifact", at: 22 }],
    artifact: { taskId, revisionId: `${mode}-artifact`, writtenByRunId: final.id,
      body: JSON.stringify({ marker: fixture.retainedMarker, format: fixture.activeFormat, releaseCode: fixture.releaseCode,
        requirementRevisionId: requirementRevisionIds[mode] }) },
  };
}

function pair() {
  return { control: lane("control"), treatment: lane("treatment"), fixture, requirementRevisionIds };
}

describe("paired Codex context compaction oracle", () => {
  it.each([["OPENAI_API_KEY", "block"], ["CODEX_AUTH_JSON", "allow"]] as const)(
    "keeps both priced-spend hard stops for %s and sets the unpriced usage policy to %s",
    async (credential, unpricedUsagePolicy) => {
      const post = vi.fn();
      await configureContextCompactionBudgets({ post }, "fixture-company", "fixture-agent", credential);
      const policy = { amount: 1_000, hardStopEnabled: true, isActive: true, unpricedUsagePolicy };
      expect(post.mock.calls).toEqual([
        ["/api/companies/fixture-company/budgets/policies", { ...policy, scopeType: "company", scopeId: "fixture-company" }],
        ["/api/companies/fixture-company/budgets/policies", { ...policy, scopeType: "agent", scopeId: "fixture-agent" }],
      ]);
    },
  );

  it("registers explicit local Codex pairs for API and subscription authentication", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "context-compaction");
    expect(cells.map(cell => [cell.id, cell.requiredCredentials])).toEqual([
      ["context-compaction.runner-codex.local.matched-continuations", ["OPENAI_API_KEY"]],
      ["context-compaction.runner-codex-subscription.local.matched-continuations", ["CODEX_AUTH_JSON"]],
    ]);
    for (const cell of cells) expect(cell).toMatchObject({
      suite: { manualOnly: true, definitionMetadata: { maximumAttemptsPerCell: 1, providerTurns: 6, compactionOperations: 1 } },
      task: { expectedRunCount: 7, automaticRetryPolicy: "single_attempt" } });
  });

  it("accepts a continuing treatment and matched control with independently retained constraints", () => {
    const result = gradeContextCompactionPair(pair());
    expect(result.matchedPair).toBe(true);
    expect(Object.values(result.control)).toEqual(Array(7).fill(true));
    expect(result.treatment).toEqual(result.control);
  });

  it("detects a dropped persistent requirement and the return of an obsolete instruction", () => {
    const input = pair();
    input.treatment.artifact!.body = JSON.stringify({ format: fixture.supersededFormat, requirementRevisionId: "treatment-requirements-v1" });
    const result = gradeContextCompactionPair(input);
    expect(result.treatment).toMatchObject({ retainedRequirement: false, currentRequirementsApplied: false, supersededInstructionOmitted: false });
    expect(result.control).toMatchObject({ retainedRequirement: true, currentRequirementsApplied: true, supersededInstructionOmitted: true });
  });

  it("fails premature artifact writes even when the published result is correct", () => {
    const input = pair();
    input.treatment.actions.unshift({ runId: input.treatment.waiting.id, kind: "write_artifact", at: 11 });
    expect(gradeContextCompactionPair(input).treatment).toMatchObject({ prerequisiteRespected: false, persistedArtifact: true });
  });

  it("requires the manual event on the expected continuing session and no event in control", () => {
    const input = pair();
    input.treatment.compactionEvents[0] = { runId: input.treatment.waiting.id, reason: "provider", sameSession: false, sequence: 5 };
    input.treatment.final.sessionDigest = "fresh-session";
    input.control.compactionEvents = [{ runId: input.control.waiting.id, reason: "manual", sameSession: true, sequence: 2 }];
    const result = gradeContextCompactionPair(input);
    expect(result.treatment).toMatchObject({ compaction: false, continuingSession: false });
    expect(result.control.compaction).toBe(false);
  });

  it("rejects a provider notification when the run lacks the accepted manual request", () => {
    const input = pair();
    input.treatment.compactRequest!.run.compactionRequestId = null;
    expect(gradeContextCompactionPair(input).treatment.compaction).toBe(false);
  });

  it("requires a session-bound runner identity even if the session digest matches", () => {
    const input = pair();
    input.control.waiting.runnerDigest = "";
    input.treatment.final.runnerDigest = "other-runner";
    const result = gradeContextCompactionPair(input);
    expect(result.control.continuingSession).toBe(false);
    expect(result.treatment.continuingSession).toBe(false);
  });

  it("fails missing evidence and rejects a model change between the two observations", () => {
    const input = pair();
    input.treatment.model = "different-model";
    input.treatment.compactionEvents.length = 0;
    input.treatment.prerequisite = null;
    input.treatment.artifact = null;
    const result = gradeContextCompactionPair(input);
    expect(result.matchedPair).toBe(false);
    expect(result.treatment).toMatchObject({ compaction: false, prerequisiteRespected: false, persistedArtifact: false });
  });
});
