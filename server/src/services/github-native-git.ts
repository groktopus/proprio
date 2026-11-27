import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, executionWorkspaces, githubNativeGrants, issues, projectWorkspaces, type Db } from "@groktopus/db";
import {
  githubNativeRepositorySchema, isAgentStatusInvokable, isUuidLike,
  type GitHubNativeEligibility, type GitHubNativeGrantSummary, type GitHubNativeOperation, type GitHubNativeSetupInput,
} from "@groktopus/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";
import { instanceSettingsService } from "./instance-settings.js";
import { NativeRuntimeEligibilityError, resolveNativeRuntimeMode } from "./native-runtime/runtime-mode.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";
import { secretService } from "./secrets.js";

type Grant = typeof githubNativeGrants.$inferSelect;
type Permissions = Pick<Grant, "push" | "pullRequests">;
type Repository = { id: number; full_name: string };

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

async function mintToken(fetchImpl: typeof fetch, jwt: string, installationId: string,
  repository: string, permissions: Permissions, repositoryId?: string) {
  const scope = {
    contents: permissions.push ? "write" : "read",
    ...(permissions.pullRequests ? { pull_requests: "write" } : {}),
  };
  const result = await githubBotRequest<{
    token?: string; expires_at?: string; permissions?: Record<string, string>; repositories?: Repository[];
  }>(fetchImpl, jwt, `/app/installations/${installationId}/access_tokens`, {
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
    throw unprocessable("GitHub did not return a token restricted to the selected repository and permissions.");
  }
  return { token: result.token, repositoryId: String(selected.id) };
}

export function normalizeGitHubNativeRepositoryUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = value.replace(/^git@github\.com:/i, "https://github.com/")
      .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");
    return normalizeProjectRepositoryUrl(url).fullName.toLowerCase();
  } catch {
    return null;
  }
}

export async function taskGitHubRepository(db: Db, companyId: string, issueId: string | null | undefined, agentId: string) {
  if (!issueId || !isUuidLike(issueId)) return null;
  const [task] = await db.select({
    projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId,
    executionWorkspaceId: issues.executionWorkspaceId,
  }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId),
    eq(issues.assigneeAgentId, agentId), eq(issues.workMode, "standard")));
  if (!task) return null;
  if (task.executionWorkspaceId) {
    const [workspace] = await db.select({ repoUrl: executionWorkspaces.repoUrl }).from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, task.executionWorkspaceId)));
    return normalizeGitHubNativeRepositoryUrl(workspace?.repoUrl);
  }
  if (!task.projectId) return null;
  const rows = await db.select({ repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces).where(and(
    eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, task.projectId),
    task.projectWorkspaceId ? eq(projectWorkspaces.id, task.projectWorkspaceId) : undefined,
  )).limit(2);
  return rows.length === 1 ? normalizeGitHubNativeRepositoryUrl(rows[0]!.repoUrl) : null;
}

export function githubNativeGitService(db: Db, fetchImpl = fetch) {
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
    const grant = await db.transaction(async transaction => {
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
    });
    publications.forEach(publishActivity);
    return summarize(grant);
  }

  return {
    hasBinding,
    async list(companyId: string) {
      return (await db.select().from(githubNativeGrants).where(companyGrants(companyId))).map(summarize);
    },
    async configure(companyId: string, userId: string, input: GitHubNativeSetupInput, reauthorize?: () => Promise<void>) {
      const repository = githubNativeRepositorySchema.parse(input.repository);
      const [agent] = await db.select().from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, input.agentId)));
      if (!agent || !isAgentStatusInvokable(agent.status)) {
        throw unprocessable("Choose an active agent configured for Proprio Runner.");
      }
      try {
        const settings = await instanceSettingsService(db).getExperimental();
        const runtime = resolveNativeRuntimeMode({
          enabled: settings.enableNativeRunner, runtimeConfig: agent.runtimeConfig, adapterConfig: agent.adapterConfig,
          agent: { ...agent, status: "running" }, issue: { id: agent.id, workMode: "standard" },
          target: null, workspaceId: null,
        });
        if (runtime.kind !== "native"
          || !["codex_app_server", "opencode_server", "acpx_runtime"].includes(runtime.profile.backend)) {
          throw unprocessable("Choose a Proprio Runner agent with terminal Git support.");
        }
      } catch (error) {
        if (!(error instanceof NativeRuntimeEligibilityError)) throw error;
        throw unprocessable(error.message);
      }
      const jwt = appJwt(input.appId, input.privateKey);
      const app = await githubBotRequest<{ id?: number; slug?: string }>(fetchImpl, jwt, "/app");
      if (String(app.id) !== input.appId || !/^[a-z0-9][a-z0-9-]*$/.test(app.slug ?? "")) {
        throw unprocessable("GitHub did not verify the selected App.");
      }
      const installation = await githubBotRequest<{ id?: number; app_id?: number; suspended_at?: string | null }>(
        fetchImpl, jwt, `/repos/${repository}/installation`,
      );
      if (!Number.isSafeInteger(installation.id) || installation.id! < 1
        || installation.app_id !== app.id || installation.suspended_at) {
        throw unprocessable("Install the GitHub App on the selected repository.");
      }
      const installationId = String(installation.id);
      const verification = await mintToken(fetchImpl, jwt, installationId, repository, input);
      // This setup token never leaves the server. Its only purpose is verifying the grant.
      await githubBotRequest(fetchImpl, verification.token, "/installation/token", { method: "DELETE" });
      await reauthorize?.();
      return change(companyId, input.agentId, repository, userId, "configured", async (tx, current) => {
        const vault = secretService(tx);
        const secret = current
          ? await vault.rotate(current.secretId, { value: input.privateKey, expectedLatestVersion: current.secretVersion }, { userId })
          : await vault.createSystemSecret(companyId, {
            name: `GitHub App key ${randomUUID()}`, provider: "local_encrypted", value: input.privateKey,
          }, "github_native_git", { userId });
        const config = {
          secretId: secret.id, secretVersion: secret.latestVersion, appId: input.appId, appSlug: app.slug!,
          installationId, repositoryId: verification.repositoryId, push: input.push, pullRequests: input.pullRequests,
          revokedAt: null, verifiedAt: new Date(),
        };
        const [saved] = current
          ? await tx.update(githubNativeGrants).set(config).where(eq(githubNativeGrants.id, current.id)).returning()
          : await tx.insert(githubNativeGrants).values({ companyId, agentId: input.agentId, repository, ...config }).returning();
        return saved!;
      });
    },
    async revoke(companyId: string, id: string, userId: string) {
      const [row] = await db.select().from(githubNativeGrants).where(and(companyGrants(companyId), eq(githubNativeGrants.id, id)));
      if (!row) throw notFound("GitHub App grant not found.");
      return change(companyId, row.agentId, row.repository, userId, "revoked", async (tx, current) => {
        if (!current || current.id !== id) throw notFound("GitHub App grant not found.");
        if (current.revokedAt) return current;
        const [revoked] = await tx.update(githubNativeGrants).set({ revokedAt: new Date() })
          .where(eq(githubNativeGrants.id, id)).returning();
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
    async issueToken(companyId: string, agentId: string, repository: string | null) {
      const grant = await find(companyId, agentId, repository);
      if (!grant || grant.revokedAt) throw forbidden("No active GitHub App grant for this agent and repository.");
      const key = await secretService(db).resolveSystemSecretValue(companyId, grant.secretId, grant.secretVersion, "github_native_git", grant.id);
      const { token } = await mintToken(fetchImpl, appJwt(grant.appId, key), grant.installationId, grant.repository, grant, grant.repositoryId);
      const current = await find(companyId, agentId, grant.repository);
      if (current?.id !== grant.id || current.revokedAt || current.secretVersion !== grant.secretVersion) {
        throw conflict("The GitHub App grant changed during credential issuance.");
      }
      return { token, grant: summarize(grant) };
    },
  };
}
