import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

/**
 * Shared cache ownership for both Company Skills presentations.
 *
 * The board variants intentionally keep their own presentation and route
 * state, but mutations must invalidate the same skill and folder projections.
 * Keeping these keys here prevents a mutation fix from landing in only one
 * variant.
 */
export function createCompanySkillsCache(queryClient: QueryClient, companyId: string) {
  return {
    invalidateList: () => queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) }),
    refetchList: () => queryClient.refetchQueries({ queryKey: queryKeys.companySkills.list(companyId), type: "active" }),
    invalidateFolders: () => queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(companyId, "skill") }),
  };
}
