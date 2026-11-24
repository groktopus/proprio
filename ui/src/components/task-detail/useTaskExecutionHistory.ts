import { useQuery } from "@tanstack/react-query";
import { activityApi, type RunForIssue } from "../../api/activity";
import { queryKeys } from "../../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../../lib/query-placeholder-data";

/** Owns the task execution-history read used by the activity surface. */
export function useTaskExecutionHistory(issueId: string) {
  return useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    placeholderData: keepPreviousDataForSameQueryTail<RunForIssue[]>(issueId),
  });
}
