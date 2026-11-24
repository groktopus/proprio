import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RunForIssue } from "../../api/activity";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../../lib/query-placeholder-data";
import {
  formatDurationMs,
  formatTokens,
  visibleRunCostUsd,
  visibleRunTokenTotal,
} from "../../lib/utils";

type TaskExecutionCostSummaryProps = {
  issueId: string;
  linkedRuns: RunForIssue[] | undefined;
};

type RunCostSummary = {
  input: number;
  output: number;
  cached: number;
  cost: number;
  totalTokens: number;
  hasCost: boolean;
  hasTokens: boolean;
  runtimeMs: number;
  runCount: number;
  hasRuntime: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function calculateTaskRunCostSummary(
  linkedRuns: readonly RunForIssue[] | undefined,
  nowMs = Date.now(),
): RunCostSummary {
  let input = 0;
  let output = 0;
  let cached = 0;
  let totalTokens = 0;
  let cost = 0;
  let runtimeMs = 0;
  let runCount = 0;
  let hasCost = false;
  let hasTokens = false;

  for (const run of linkedRuns ?? []) {
    const usage = asRecord(run.usageJson);
    const result = asRecord(run.resultJson);
    const runInput = usageNumber(usage, "inputTokens", "input_tokens");
    const runOutput = usageNumber(usage, "outputTokens", "output_tokens");
    const runCached = usageNumber(
      usage,
      "cachedInputTokens",
      "cached_input_tokens",
      "cache_read_input_tokens",
    );
    const runCost = visibleRunCostUsd(usage, result);
    if (runCost > 0) hasCost = true;
    if (runInput + runOutput + runCached > 0) hasTokens = true;
    input += runInput;
    output += runOutput;
    cached += runCached;
    totalTokens += visibleRunTokenTotal(usage);
    cost += runCost;

    if (run.startedAt) {
      const startMs = new Date(run.startedAt).getTime();
      const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : nowMs;
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        runtimeMs += endMs - startMs;
        runCount += 1;
      }
    }
  }

  return {
    input,
    output,
    cached,
    cost,
    totalTokens,
    hasCost,
    hasTokens,
    runtimeMs,
    runCount,
    hasRuntime: runtimeMs > 0,
  };
}

export function TaskExecutionCostSummary({
  issueId,
  linkedRuns,
}: TaskExecutionCostSummaryProps) {
  const { data: issueTreeCostSummary } = useQuery({
    queryKey: queryKeys.issues.costSummary(issueId),
    queryFn: () => issuesApi.getCostSummary(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<
      Awaited<ReturnType<typeof issuesApi.getCostSummary>>
    >(issueId),
  });
  const issueCostSummary = useMemo(
    () => calculateTaskRunCostSummary(linkedRuns),
    [linkedRuns],
  );
  const issueTreeCostTokens =
    (issueTreeCostSummary?.inputTokens ?? 0) +
    (issueTreeCostSummary?.cachedInputTokens ?? 0) +
    (issueTreeCostSummary?.outputTokens ?? 0);
  const hasIssueTreeCost =
    !!issueTreeCostSummary &&
    (issueTreeCostSummary.costCents > 0 ||
      issueTreeCostTokens > 0 ||
      issueTreeCostSummary.cachedInputTokens > 0 ||
      issueTreeCostSummary.runtimeMs > 0 ||
      issueTreeCostSummary.issueCount > 1);
  const shouldShowCostSummary =
    (linkedRuns && linkedRuns.length > 0) || hasIssueTreeCost;

  if (!shouldShowCostSummary) return null;

  return (
    <div className="mb-3 px-3 py-2 rounded-lg border border-border">
      <div className="text-sm font-medium text-muted-foreground mb-1">
        Cost Summary
      </div>
      {!issueCostSummary.hasCost &&
      !issueCostSummary.hasTokens &&
      !hasIssueTreeCost ? (
        <div className="text-xs text-muted-foreground">No cost data yet.</div>
      ) : (
        <div className="space-y-1 text-xs text-muted-foreground tabular-nums">
          <div className="flex flex-wrap gap-3">
            <span className="font-medium text-foreground">This task</span>
            {issueCostSummary.hasCost ? (
              <span className="font-medium text-foreground">
                ${issueCostSummary.cost.toFixed(4)}
              </span>
            ) : null}
            {issueCostSummary.hasTokens ? (
              <span>
                Tokens {formatTokens(issueCostSummary.totalTokens)}
                {issueCostSummary.cached > 0
                  ? ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)}, cached ${formatTokens(issueCostSummary.cached)})`
                  : ` (in ${formatTokens(issueCostSummary.input)}, out ${formatTokens(issueCostSummary.output)})`}
              </span>
            ) : null}
            {issueCostSummary.hasRuntime ? (
              <span>
                Runtime {formatDurationMs(issueCostSummary.runtimeMs)}
                {` (${issueCostSummary.runCount} run${issueCostSummary.runCount === 1 ? "" : "s"})`}
              </span>
            ) : null}
            {!issueCostSummary.hasCost &&
            !issueCostSummary.hasTokens &&
            !issueCostSummary.hasRuntime ? (
              <span>No direct cost data.</span>
            ) : null}
          </div>
          {hasIssueTreeCost && issueTreeCostSummary ? (
            <div className="flex flex-wrap gap-3">
              <span className="font-medium text-foreground">
                Including sub-tasks{" "}
                {(issueTreeCostSummary.costCents / 100).toLocaleString(
                  undefined,
                  {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 4,
                    maximumFractionDigits: 4,
                  },
                )}
              </span>
              <span>
                Tokens {formatTokens(issueTreeCostTokens)}
                {issueTreeCostSummary.cachedInputTokens > 0
                  ? ` (in ${formatTokens(issueTreeCostSummary.inputTokens)}, out ${formatTokens(issueTreeCostSummary.outputTokens)}, cached ${formatTokens(issueTreeCostSummary.cachedInputTokens)})`
                  : ` (in ${formatTokens(issueTreeCostSummary.inputTokens)}, out ${formatTokens(issueTreeCostSummary.outputTokens)})`}
              </span>
              {issueTreeCostSummary.runCount > 0 ? (
                <span>
                  Runtime {formatDurationMs(issueTreeCostSummary.runtimeMs)}
                  {` (${issueTreeCostSummary.runCount} run${issueTreeCostSummary.runCount === 1 ? "" : "s"})`}
                </span>
              ) : null}
              <span>
                {issueTreeCostSummary.issueCount} task
                {issueTreeCostSummary.issueCount === 1 ? "" : "s"}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
