import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, executionWorkspaces, githubNativeGrants, heartbeatRuns, issues, projects, projectWorkspaces, type Db, type DbTransaction } from "@groktopus/db";
import { withAccountHomeSecretMutationLock } from "@groktopus/adapter-codex-local/server";
import {
  githubNativeRepositorySchema, isAgentStatusInvokable, isUuidLike,
  type GitHubNativeEligibility, type GitHubNativeGrantSummary, type GitHubNativeOperation, type GitHubNativeSetupInput,
} from "@groktopus/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { githubAppJwt, requestGitHubApp } from "./github-app-client.js";
import { instanceSettingsService } from "./instance-settings.js";
import { NativeRuntimeEligibilityError, resolveNativeRuntimeMode } from "./native-runtime/runtime-mode.js";
import { parseGitHubRepository } from "./github-repository.js";
import { secretService } from "./secrets.js";
import { assertTaskWorkspaceExecutionAccess, assertTaskWorkspaceSourceProjectAccess } from "./task-workspace-access.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

type Grant = typeof githubNativeGrants.$inferSelect;
type Permissions = Pick<Grant, "push" | "pullRequests">;
type TokenMode = "terminal" | "checkout" | "verify_pull_request";
type Repository = { id: number; full_name: string };

export function supportsNativeGitBackend(backend: string | null) {
  return backend === "codex_app_server" || backend === "opencode_server" || backend === "acpx_runtime";
}

export async function removeAgentNativeGitBindings(db: Db | DbTransaction, companyId: string, agentId: string) {
  const removed = await db.delete(githubNativeGrants).where(and(
    eq(githubNativeGrants.companyId, companyId), eq(githubNativeGrants.agentId, agentId),
  )).returning({ secretId: githubNativeGrants.secretId });
  const vault = secretService(db);
  for (const row of removed) {
    if (row.secretId) await vault.remove(row.secretId, { systemPurpose: "github_native_git" });
  }
}

function summarize(grant: Grant): GitHubNativeGrantSummary {
  return {
    id: grant.id, agentId: grant.agentId, repository: grant.repository, appSlug: grant.appSlug,
    push: grant.push, pullRequests: grant.pullRequests, verifiedAt: grant.verifiedAt.toISOString(),
    revokedAt: grant.revokedAt?.toISOString() ?? null,
  };
}

function appJwt(appId: string, privateKey: string) {
  try {
    return githubAppJwt(appId, privateKey);
  } catch {
    throw unprocessable("Enter a valid GitHub App private key.");
  }
}

async function retireToken(token: string) {
  await requestGitHubApp(fetch, token, "/installation/token", { method: "DELETE" });
}

async function mintToken(jwt: string, installationId: string,
  repository: string, permissions: Permissions, repositoryId?: string, mode: TokenMode = "terminal") {
  const scope = {
    contents: mode === "terminal" && permissions.push ? "write" : "read",
    ...(mode === "verify_pull_request" ? { pull_requests: "read" }
      : mode === "terminal" && permissions.pullRequests ? { pull_requests: "write" } : {}),
  };
  const result = await requestGitHubApp<{
    token?: string; expires_at?: string; permissions?: Record<string, string>; repositories?: Repository[];
  }>(fetch, jwt, `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    body: {
      ...(repositoryId ? { repository_ids: [Number(repositoryId)] } : { repositories: [repository.split("/")[1]] }),
      permissions: scope,
    },
  });
  const granted = result.permissions ?? {};
  const [selected] = result.repositories ?? [];
  if (!result.token || result.token.length > 4096 || /[\s\0]/.test(result.token)
    || !(Date.parse(result.expires_at ?? "") > Date.now())
    || result.repositories?.length !== 1 || selected?.full_name?.toLowerCase() !== repository
    || !Number.isSafeInteger(selected.id) || selected.id < 1
    || (repositoryId && String(selected.id) !== repositoryId)
    || Object.entries(scope).some(([key, value]) => granted[key] !== value)
    || Object.entries(granted).some(([key, value]) =>
      !(key in scope) && !(key === "metadata" && value === "read"))) {
    if (result.token && result.token.length <= 4096 && !/[\s\0]/.test(result.token)) {
      await retireToken(result.token).catch(() => undefined);
    }
    throw unprocessable("GitHub did not return a token restricted to the selected repository and permissions.");
  }
  return { token: result.token, repositoryId: String(selected.id) };
}

export function normalizeGitHubNativeRepositoryUrl(value: string | null | undefined) {
  if (!value || /^http:/i.test(value.trim())) return null;
  const repository = parseGitHubRepository(value);
  if (!repository) return null;
  return githubNativeRepositorySchema.safeParse(`${repository.owner}/${repository.repo}`).data ?? null;
}

type NativeGitRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" |
  "activeIdentityContextId" | "nativeIssueId" | "issueId" | "runtimeMode" | "contextSnapshot" | "responsibleUserId">;

export async function authorizedRunGitHubRepository(db: Db, run: NativeGitRun,
  { projectCheckoutSourceId, allowFinishedRun, lockWorkspace }: {
    projectCheckoutSourceId?: string; allowFinishedRun?: boolean; lockWorkspace?: boolean;
  } = {}) {
  const { companyId, agentId } = run;
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
  if (typeof issueId !== "string" || !isUuidLike(issueId)) return null;
  const [current] = await db.select({
    status: heartbeatRuns.status, identityContextId: heartbeatRuns.activeIdentityContextId,
    driverKind: heartbeatRuns.driverKind,
    binding: sql<Record<string, unknown> | null>`${heartbeatRuns.runnerProfileJson} #> '{nativeExecutionInput,binding}'`,
    repoUrl: sql<string | null>`${heartbeatRuns.runnerProfileJson} #>> '{nativeExecutionInput,workspace,repoUrl}'`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.agentId, agentId)));
  if (!current || current.identityContextId !== run.activeIdentityContextId
    || (!allowFinishedRun && current.status !== "running")) return null;
  const [task] = await db.select({
    projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId,
    executionWorkspaceId: issues.executionWorkspaceId, workspaceSelection: issues.workspaceSelection,
  }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId),
    eq(issues.assigneeAgentId, agentId), eq(issues.workMode, "standard")));
  if (!task) return null;
  const actor = {
    type: "agent" as const, source: "agent_jwt" as const, companyId, agentId, runId: run.id,
    onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId,
  };
  const binding = current.binding;
  if (!projectCheckoutSourceId || binding) {
    if (run.runtimeMode !== "native" || !supportsNativeGitBackend(current.driverKind)
      || !binding || binding.companyId !== companyId || binding.agentId !== agentId
      || binding.runId !== run.id || binding.issueId !== issueId || binding.executionWorkspaceId !== task.executionWorkspaceId
      || !task.executionWorkspaceId) return null;
    const repository = normalizeGitHubNativeRepositoryUrl(current.repoUrl);
    if (!repository) return null;
    const { workspace } = await assertTaskWorkspaceExecutionAccess(db, actor, companyId, {
      issueId, workspaceId: task.executionWorkspaceId, lockWorkspace,
    });
    if (projectCheckoutSourceId && workspace?.projectWorkspaceId !== projectCheckoutSourceId) return null;
    return normalizeGitHubNativeRepositoryUrl(workspace?.repoUrl) === repository ? repository : null;
  }
  const selection = task.workspaceSelection?.selection;
  if (selection?.kind === "task_directory") return null;
  const { workspace } = await assertTaskWorkspaceExecutionAccess(db, actor, companyId, {
    issueId, workspaceId: task.executionWorkspaceId,
    ...(selection?.kind === "configured_source" ? { projectWorkspaceId: selection.projectWorkspaceId } : {}),
  });
  const selectedId = selection?.kind === "configured_source" ? selection.projectWorkspaceId
    : workspace?.projectWorkspaceId ?? task.projectWorkspaceId;
  if ((selection?.kind === "existing" && !workspace) || (selectedId && selectedId !== projectCheckoutSourceId)) return null;
  const [source] = await db.select({
    repoUrl: projectWorkspaces.repoUrl, projectId: projectWorkspaces.projectId,
    projectCompanyId: projects.companyId, executionWorkspacePolicy: projects.executionWorkspacePolicy,
  }).from(projectWorkspaces).innerJoin(projects, and(eq(projects.id, projectWorkspaces.projectId), eq(projects.companyId, companyId)))
    .where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.id, projectCheckoutSourceId)));
  if (!source || (!selectedId && source.projectId !== task.projectId)
    || resolveCoreTrustPreset({ companyId, workspaceSourceProject: {
      companyId: source.projectCompanyId, executionWorkspacePolicy: source.executionWorkspacePolicy,
    } }).kind !== "standard") return null;
  await assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, source.projectId);
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  if (!supportsNativeGit(agent, (await instanceSettingsService(db).getExperimental()).enableNativeRunner)) return null;
  return normalizeGitHubNativeRepositoryUrl(source.repoUrl);
}

function supportsNativeGit(agent: typeof agents.$inferSelect | undefined, enabled: boolean) {
  if (!agent || !isAgentStatusInvokable(agent.status)) return false;
  try {
    const runtime = resolveNativeRuntimeMode({
      enabled, runtimeConfig: agent.runtimeConfig, adapterConfig: agent.adapterConfig,
      agent: { ...agent, status: "running" }, issue: { id: agent.id, workMode: "standard" },
      target: null, workspaceId: null,
    });
    return runtime.kind === "native" && supportsNativeGitBackend(runtime.profile.backend);
  } catch (error) {
    if (!(error instanceof NativeRuntimeEligibilityError)) throw error;
    return false;
  }
}

export function githubNativeGitService(db: Db) {
  const companyGrants = (companyId: string) => eq(githubNativeGrants.companyId, companyId);
  const agentGrants = (companyId: string, agentId: string) => and(companyGrants(companyId), eq(githubNativeGrants.agentId, agentId));
  const byRepository = (companyId: string, agentId: string, repository: string) =>
    and(agentGrants(companyId, agentId), eq(githubNativeGrants.repository, repository));

  async function hasBinding(companyId: string, agentId: string) {
    const [row] = await db.select({ id: githubNativeGrants.id }).from(githubNativeGrants)
      .where(agentGrants(companyId, agentId)).limit(1);
    return Boolean(row);
  }

  async function find(companyId: string, agentId: string, repository: string | null, lock = false) {
    if (!repository) return undefined;
    const query = db.select().from(githubNativeGrants).where(byRepository(companyId, agentId, repository));
    const [grant] = await (lock ? query.for("share") : query);
    return grant;
  }

  async function change(companyId: string, agentId: string, repository: string, userId: string,
    action: "configured" | "revoked", write: (tx: Db, current: Grant | undefined) => Promise<Grant>) {
    const publications: ActivityPublication[] = [];
    const grant = await withAccountHomeSecretMutationLock(undefined, companyId, () => db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      // Serialize even first creation and a retry before writing a vault value.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`github-native:${companyId}:${agentId}:${repository}`}, 0))`);
      const [current] = await tx.select().from(githubNativeGrants).where(byRepository(companyId, agentId, repository)).for("update");
      const updated = await write(tx, current);
      if (updated === current) return updated;
      await logActivity(tx, {
        companyId, agentId, actorType: "user", actorId: userId, action: `github_native_git.${action}`,
        entityType: "github_native_grant", entityId: updated.id,
        details: { repository, appSlug: updated.appSlug, push: updated.push, pullRequests: updated.pullRequests },
      }, publications);
      return updated;
    }));
    publications.forEach(publishActivity);
    return summarize(grant);
  }

  return {
    hasBinding,
    async get(companyId: string, id: string) {
      const [grant] = await db.select().from(githubNativeGrants).where(and(companyGrants(companyId), eq(githubNativeGrants.id, id)));
      return grant ? summarize(grant) : null;
    },
    async list(companyId: string) {
      return (await db.select().from(githubNativeGrants).where(companyGrants(companyId))).map(summarize);
    },
    async eligibleAgentIds(companyId: string) {
      const { enableNativeRunner } = await instanceSettingsService(db).getExperimental();
      const candidates = await db.select().from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, "proprio_runner")));
      return candidates.filter(agent => supportsNativeGit(agent, enableNativeRunner)).map(agent => agent.id);
    },
    async removeAgentBindings(companyId: string, agentId: string) {
      await removeAgentNativeGitBindings(db, companyId, agentId);
    },
    async configure(companyId: string, userId: string, input: GitHubNativeSetupInput, reauthorize?: () => Promise<void>) {
      const repository = githubNativeRepositorySchema.parse(input.repository);
      const [agent] = await db.select().from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, input.agentId)));
      if (!supportsNativeGit(agent, (await instanceSettingsService(db).getExperimental()).enableNativeRunner)) {
        throw unprocessable("Choose an active Proprio Runner agent with terminal Git support.");
      }
      const before = await find(companyId, input.agentId, repository);
      const jwt = appJwt(input.appId, input.privateKey);
      const app = await requestGitHubApp<{ id?: number; slug?: string }>(fetch, jwt, "/app");
      if (String(app.id) !== input.appId || !/^[a-z0-9][a-z0-9-]*$/.test(app.slug ?? "")) {
        throw unprocessable("GitHub did not verify the selected App.");
      }
      const installation = await requestGitHubApp<{ id?: number; app_id?: number; suspended_at?: string | null }>(
        fetch, jwt, `/repos/${repository}/installation`,
      );
      if (!Number.isSafeInteger(installation.id) || installation.id! < 1
        || installation.app_id !== app.id || installation.suspended_at) {
        throw unprocessable("Install the GitHub App on the selected repository.");
      }
      const installationId = String(installation.id);
      const verification = await mintToken(jwt, installationId, repository, input);
      // This setup token never leaves the server. Its only purpose is verifying the grant.
      await retireToken(verification.token);
      return change(companyId, input.agentId, repository, userId, "configured", async (tx, current) => {
        await reauthorize?.();
        const [lockedAgent] = await tx.select().from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, input.agentId))).for("update");
        if (!supportsNativeGit(lockedAgent, (await instanceSettingsService(tx).getExperimental()).enableNativeRunner)) {
          throw unprocessable("Choose an active Proprio Runner agent with terminal Git support.");
        }
        if (current?.id !== before?.id || current?.secretId !== before?.secretId
          || current?.revokedAt?.getTime() !== before?.revokedAt?.getTime()) {
          throw conflict("The GitHub App grant changed during verification. Review its current state before retrying.");
        }
        const vault = secretService(tx);
        const secret = await vault.createSystemSecret(companyId, {
          name: `GitHub App key ${randomUUID()}`, provider: "local_encrypted", value: input.privateKey,
        }, "github_native_git", { userId });
        const config = {
          secretId: secret.id, secretVersion: secret.latestVersion, appId: input.appId, appSlug: app.slug!,
          installationId, repositoryId: verification.repositoryId, push: input.push, pullRequests: input.pullRequests,
          revokedAt: null, verifiedAt: new Date(Math.max(Date.now(), (current?.verifiedAt.getTime() ?? 0) + 1)),
        };
        const [saved] = current
          ? await tx.update(githubNativeGrants).set(config).where(eq(githubNativeGrants.id, current.id)).returning()
          : await tx.insert(githubNativeGrants).values({ companyId, agentId: input.agentId, repository, ...config }).returning();
        if (current?.secretId) await vault.remove(current.secretId, { systemPurpose: "github_native_git" });
        return saved!;
      });
    },
    async revoke(companyId: string, id: string, userId: string, reauthorize?: () => Promise<void>) {
      const [row] = await db.select().from(githubNativeGrants).where(and(companyGrants(companyId), eq(githubNativeGrants.id, id)));
      if (!row) throw notFound("GitHub App grant not found.");
      return change(companyId, row.agentId, row.repository, userId, "revoked", async (tx, current) => {
        await reauthorize?.();
        if (!current || current.id !== row.id) throw notFound("GitHub App grant not found.");
        if (current.revokedAt) return current;
        const [revoked] = await tx.update(githubNativeGrants).set({ revokedAt: new Date(), secretId: null, secretVersion: null })
          .where(eq(githubNativeGrants.id, id)).returning();
        if (current.secretId) await secretService(tx).remove(current.secretId, { systemPurpose: "github_native_git" });
        return revoked!;
      });
    },
    async eligibility(companyId: string, agentId: string, repository: string | null, operation: GitHubNativeOperation,
      lock = false): Promise<GitHubNativeEligibility> {
      const grant = await find(companyId, agentId, repository, lock);
      if (!grant) {
        const bound = await hasBinding(companyId, agentId);
        return bound
          ? { status: "unavailable", code: "repository_denied", reason: "No GitHub App grant covers this repository for this agent." }
          : { status: "unavailable", code: "no_identity", reason: "No eligible GitHub App identity is configured for this agent." };
      }
      if (grant.revokedAt) return { status: "unavailable", code: "revoked", reason: "The GitHub App grant for this repository was revoked." };
      if ((operation === "push" && !grant.push) || (operation === "create_pull_request" && !grant.pullRequests)) {
        return { status: "unavailable", code: "action_denied", reason: "The GitHub App grant does not allow this action." };
      }
      return { status: "available", grant: summarize(grant) };
    },
    async issueToken(companyId: string, agentId: string, repository: string | null,
      options: { mode: TokenMode; reauthorize: () => Promise<void> }) {
      const grant = await find(companyId, agentId, repository);
      if (!grant || grant.revokedAt || !grant.secretId || grant.secretVersion === null) {
        throw forbidden("No active GitHub App grant for this agent and repository.");
      }
      const key = await secretService(db).resolveSystemSecretValue(companyId, grant.secretId, grant.secretVersion, "github_native_git", grant.id);
      const { token } = await mintToken(appJwt(grant.appId, key), grant.installationId, grant.repository, grant, grant.repositoryId, options.mode);
      try {
        await options.reauthorize();
        const current = await find(companyId, agentId, grant.repository);
        if (current?.id !== grant.id || current.revokedAt || current.secretId !== grant.secretId || current.secretVersion !== grant.secretVersion) {
          throw conflict("The GitHub App grant changed during credential issuance.");
        }
        return { token, grant: summarize(grant) };
      } catch (error) {
        await retireToken(token).catch(() => undefined);
        throw error;
      }
    },
  };
}
