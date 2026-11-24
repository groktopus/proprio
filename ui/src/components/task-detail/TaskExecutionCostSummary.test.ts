import { describe, expect, it } from "vitest";
import type { RunForIssue } from "../../api/activity";
import { calculateTaskRunCostSummary } from "./TaskExecutionCostSummary";

const run = (overrides: Partial<RunForIssue> = {}): RunForIssue => ({
  runId: "run-1",
  status: "succeeded",
  agentId: "agent-1",
  adapterType: "codex",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:02.500Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  invocationSource: "task",
  usageJson: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 10 },
  resultJson: null,
  ...overrides,
});

describe("calculateTaskRunCostSummary", () => {
  it("aggregates token and runtime data for the task's own runs", () => {
    expect(
      calculateTaskRunCostSummary(
        [run(), run({ runId: "run-2", startedAt: null, finishedAt: null })],
      ),
    ).toMatchObject({
      input: 200,
      output: 80,
      cached: 20,
      totalTokens: 280,
      cost: 0,
      hasTokens: true,
      runtimeMs: 2500,
      runCount: 1,
    });
  });

  it("keeps an empty task free of a cost-summary signal", () => {
    expect(calculateTaskRunCostSummary(undefined)).toMatchObject({
      cost: 0,
      hasTokens: false,
      runtimeMs: 0,
      runCount: 0,
    });
  });
});
