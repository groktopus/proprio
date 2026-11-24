import { useQuery } from "@tanstack/react-query";
import { activityApi, type RunForIssue } from "../../api/activity";
import { queryKeys } from "../../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../../lib/query-placeholder-data";

/** Owns the task execution-history read used by the activity surface. */
export function useTaskExecutionHistory(
  issueId: string,
  options: { hasLiveRuns: boolean; issueStatus: string },
) {
  return useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    refetchInterval:
      options.hasLiveRuns || options.issueStatus === "in_progress" ? 5000 : false,
    placeholderData: keepPreviousDataForSameQueryTail<RunForIssue[]>(issueId),
  });
}
