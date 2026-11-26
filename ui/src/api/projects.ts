import type {
  Project,
  ProjectAccessMember,
  ProjectRepositoryOptions,
  ProjectEnvironmentOptions,
  ProjectGitAuthorization,
  ProjectWorkspace,
  WorkspaceOperation,
  WorkspaceRuntimeControlTarget,
} from "@groktopus/shared";
import { api, detachInflightGet } from "./client";
import { sanitizeWorkspaceRuntimeControlTarget } from "./workspace-runtime-control";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function projectPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/projects/${encodeURIComponent(id)}${suffix}`, companyId);
}

function projectListPath(companyId: string, includeArchived = false) {
  return `/companies/${encodeURIComponent(companyId)}/projects${includeArchived ? "?includeArchived=true" : ""}`;
}

export const projectsApi = {
  environmentOptions: (companyId: string) => api.get<ProjectEnvironmentOptions>(`/companies/${companyId}/project-environments`),
  gitAuthorization: (id: string) => api.get<ProjectGitAuthorization>(projectPath(id, undefined, "/git-authorization")),
  setGitAuthorization: (id: string, grantId: string | null) => api.put<ProjectGitAuthorization>(projectPath(id, undefined, "/git-authorization"), { grantId }),
  repositoryOptions: (companyId: string) => api.get<ProjectRepositoryOptions>(`/companies/${companyId}/project-repositories`),
  setRepositories: (id: string, repositoryIds: string[]) => api.put<Project>(projectPath(id, undefined, "/repositories"), { repositoryIds }),
  list: (companyId: string, opts: { includeArchived?: boolean } = {}) =>
    api.get<Project[]>(projectListPath(companyId, opts.includeArchived)),
  detachInflightList: (companyId: string) => {
    detachInflightGet(projectListPath(companyId));
    detachInflightGet(projectListPath(companyId, true));
  },
  get: (id: string, companyId?: string) => api.get<Project>(projectPath(id, companyId), { fresh: true, cache: "no-store" }),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Project>(`/companies/${companyId}/projects`, data),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Project>(projectPath(id, companyId), data),
  listAccessMembers: (id: string, companyId?: string) =>
    api.get<ProjectAccessMember[]>(projectPath(id, companyId, "/access-members")),
  addAccessMember: (
    id: string,
    data: { subjectType: "user" | "agent"; subjectId: string },
    companyId?: string,
  ) => api.post<ProjectAccessMember>(projectPath(id, companyId, "/access-members"), data),
  removeAccessMember: (id: string, memberId: string, companyId?: string) =>
    api.delete<ProjectAccessMember>(
      projectPath(id, companyId, `/access-members/${encodeURIComponent(memberId)}`),
    ),
  listWorkspaces: (projectId: string, companyId?: string) =>
    api.get<ProjectWorkspace[]>(projectPath(projectId, companyId, "/workspaces")),
  createWorkspace: (projectId: string, data: Record<string, unknown>, companyId?: string) =>
    api.post<ProjectWorkspace>(projectPath(projectId, companyId, "/workspaces"), data),
  updateWorkspace: (projectId: string, workspaceId: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<ProjectWorkspace>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`),
      data,
    ),
  controlWorkspaceRuntimeServices: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  controlWorkspaceCommands: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart" | "run",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-commands/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),
};
