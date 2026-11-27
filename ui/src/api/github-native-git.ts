import type { GitHubNativeGrantSummary, GitHubNativeSetupInput } from "@groktopus/shared";
import { api } from "./client";

const grantPath = (companyId: string) => `/companies/${companyId}/github-native-git`;

export const githubNativeGitApi = {
  list: (companyId: string) => api.get<GitHubNativeGrantSummary[]>(grantPath(companyId)),
  eligibleAgents: (companyId: string) => api.get<string[]>(`${grantPath(companyId)}/eligible-agents`),
  configure: (companyId: string, input: GitHubNativeSetupInput) =>
    api.post<GitHubNativeGrantSummary>(grantPath(companyId), input),
  revoke: (companyId: string, grantId: string) =>
    api.delete<GitHubNativeGrantSummary>(`${grantPath(companyId)}/${grantId}`),
};
