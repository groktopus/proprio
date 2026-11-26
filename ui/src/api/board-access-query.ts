import type { BoardBootstrap, BoardBootstrapSession } from "@groktopus/shared";
import type { QueryClient } from "@tanstack/react-query";
import { accessApi } from "./access";
import { ApiError } from "./client";
import { queryKeys } from "../lib/queryKeys";

export function boardAccessQueryOptions(
  userId: string | null,
  onAccountChanged: () => void,
) {
  return {
    queryKey: [...queryKeys.access.currentBoardAccess, userId] as const,
    queryFn: async ({ signal }: { signal?: AbortSignal } = {}): Promise<BoardBootstrap["boardAccess"]> => {
      const access = await accessApi.getCurrentBoardAccess({ signal });
      if (access.userId !== userId) {
        onAccountChanged();
        throw new ApiError("The signed-in account changed. Checking your session again.", 401, { code: "session_changed" });
      }
      return { userId: access.userId, isInstanceAdmin: access.isInstanceAdmin, companyIds: access.companyIds };
    },
  };
}

/** Retire access from before a membership change, including the session's seed. */
export function refreshBoardAccessAfterMembershipChange(client: QueryClient) {
  const sessionKey = queryKeys.auth.session;
  const sessionQuery = client.getQueryCache().find({ queryKey: sessionKey, exact: true });
  const session = client.getQueryData<BoardBootstrapSession>(sessionKey);
  if (sessionQuery) {
    const wasFetching = sessionQuery.state.fetchStatus === "fetching";
    void client.cancelQueries({ queryKey: sessionKey, exact: true }, { revert: false, silent: true });
    sessionQuery.setState({
      data: session?.boardBootstrap ? { ...session, boardBootstrap: undefined } : session,
      fetchStatus: "idle",
    });
    if (wasFetching) void client.refetchQueries({ queryKey: sessionKey, exact: true, type: "active" });
  }

  void client.resetQueries({ queryKey: queryKeys.access.currentBoardAccess });
  void client.resetQueries({ queryKey: queryKeys.companies.list(session?.user.id ?? null), exact: true });
}
