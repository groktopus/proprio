import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { classifyError } from "@/api/errors";
import { useQueryView } from "@/components/QueryView";

export function useAuthorizedHistory<T>(queryKey: QueryKey, read: (signal: AbortSignal) => Promise<T>, empty: T) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey,
    refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      try {
        return await read(signal);
      } catch (error) {
        const kind = classifyError(error);
        if (!signal.aborted && (kind === "auth" || kind === "forbidden" || kind === "not_found")) {
          queryClient.setQueryData(queryKey, empty);
        }
        throw error;
      }
    },
  });
  const view = useQueryView(query);
  const waiting = query.fetchStatus !== "idle" || view.kind === "loading" || view.kind === "reconnecting";
  return {
    data: query.isSuccess && !waiting ? view.data : undefined,
    isLoading: waiting,
    error: !waiting && query.isError ? view.error : null,
    onRetry: view.retry,
  };
}
