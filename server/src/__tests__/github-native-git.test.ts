import express from "express";
import request from "supertest";
import { generateKeyPairSync } from "node:crypto";
import { agents, agentWakeupRequests, authUsers, connectionGrants, connectionIntentDeliveries, createDb, executionWorkspaces, githubNativeGrants, heartbeatRuns, issues, projectAccessMembers, projects, projectWorkspaces, runIdentityContexts, toolApplications, toolConnectionInstalls, toolConnections } from "@groktopus/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { githubNativeGitService } from "../services/github-native-git.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { connectionIntentBoardRoutes } from "../routes/connection-intents.js";
import { errorHandler } from "../middleware/error-handler.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { createGitRemoteAuthProvider } from "../services/git-credentials.js";
import { projectGitAuthorizationService } from "../services/project-git-authorization.js";
import { secretService } from "../services/secrets.js";
import { githubCredentialsFixture } from "./helpers/github-credentials-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("self-hosted GitHub App for terminal Git", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
  const repository = "acme/fixture";

  beforeAll(async () => {
    const database = await startEmbeddedPostgresTestDatabase("github-native-git-");
    cleanup = database.cleanup;
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({
      id: "A", name: "A", email: "a@example.invalid", createdAt: new Date(), updatedAt: new Date(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await cleanup?.(); });

  async function seed({ push = true, pullRequests = true } = {}) {
    const fixture = githubCredentialsFixture(() => db);
    const context = await fixture.seed();
    const { companyId, agentId, runId, issueId } = context;
    await db.update(agents).set({ adapterType: "proprio_runner", adapterConfig: { provider: "codex" }, status: "active" }).where(eq(agents.id, agentId));
    const [project] = await db.insert(projects).values({ companyId, name: "Fixture project" }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId, projectId: project.id,
      name: "Fixture repository", repoUrl: `https://github.com/${repository}.git` }).returning();
    const [execution] = await db.insert(executionWorkspaces).values({ companyId, projectId: project.id,
      projectWorkspaceId: workspace.id, mode: "isolated", strategyType: "git_worktree",
      name: "Fixture execution", repoUrl: workspace.repoUrl }).returning();
    await db.update(issues).set({ assigneeAgentId: agentId, projectId: project.id, projectWorkspaceId: workspace.id,
      executionWorkspaceId: execution.id }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ runtimeMode: "native", driverKind: "codex_app_server", nativeIssueId: issueId,
      runnerProfileJson: { nativeExecutionInput: { binding: { companyId, agentId, runId, issueId,
        executionWorkspaceId: execution.id }, workspace: { repoUrl: workspace.repoUrl } } } }).where(eq(heartbeatRuns.id, runId));
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const pathname = new URL(url).pathname;
      expect(new URL(url).origin).toBe("https://api.github.com");
      if (pathname === "/installation/token") {
        expect(init.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      }
      expect(headers.get("authorization")).toMatch(/^Bearer ey/);
      if (pathname === "/app") return Response.json({ id: 123, slug: "fixture-app" });
      if (pathname === `/repos/${repository}/installation`) return Response.json({ id: 456, app_id: 123 });
      expect(pathname).toBe("/app/installations/456/access_tokens");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        ...(body.repositories ? { repositories: ["fixture"] } : { repository_ids: [789] }),
        permissions: { contents: push ? "write" : "read", ...(pullRequests ? { pull_requests: "write" } : {}) },
      });
      return Response.json({ token: "ghs_fixture", expires_at: new Date(Date.now() + 60000).toISOString(),
        permissions: { ...body.permissions, metadata: "read" }, repositories: [{ id: 789, full_name: "Acme/Fixture" }] });
    });
    vi.stubGlobal("fetch", fetchImpl);
    return { ...context, fixture, fetchImpl, workspace, execution, input: { agentId, repository, appId: "123", privateKey: key, push, pullRequests } };
  }

  async function installOrganizationPat(companyId: string) {
    const [application] = await db.insert(toolApplications).values({ companyId: companyId,
      name: "GitHub MCP", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: companyId, applicationId: application.id,
      name: "GitHub MCP", uid: "mcp-pat", transport: "mcp_remote", authKind: "api_key", credentialPolicy: "shared",
      config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key" }, status: "active", enabled: true }).returning();
    await db.insert(connectionGrants).values({ companyId: companyId,
      connectionId: connection.id, kind: "organization", status: "active" });
    await db.insert(toolConnectionInstalls).values({ companyId: companyId, connectionId: connection.id,
      targetType: "company", targetId: companyId });
    return connection;
  }

  it("admits the scoped token alongside the MCP PAT and rejects a different repository, agent or revoked grant", async () => {
    const f = await seed();
    await installOrganizationPat(f.companyId);
    const service = githubNativeGitService(db);
    const grant = await service.configure(f.companyId, "A", f.input);
    expect(grant).toMatchObject({ agentId: f.agentId, repository, appSlug: "fixture-app" });
    expect(grant).not.toHaveProperty("secretId");
    const [row] = await db.select().from(githubNativeGrants).where(eq(githubNativeGrants.id, grant.id));
    await expect(secretService(db).resolveSecretValue(f.companyId, row.secretId!, "latest"))
      .rejects.toThrow("System-owned secrets require their server-only consumer");
    await expect(secretService(db).rotate(row.secretId!, { value: key })).rejects.toThrow("Secret not found");
    await expect(secretService(db).update(row.secretId!, { status: "disabled" })).rejects.toThrow("Secret not found");
    await expect(secretService(db).remove(row.secretId!)).rejects.toThrow("Secret not found");
    await expect(service.eligibility(f.companyId, f.issueId, repository, "push")).resolves.toMatchObject({ status: "unavailable" });
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({
      status: "available", nativeGitGrantId: grant.id, login: "fixture-app[bot]", repository, env: { GH_TOKEN: "ghs_fixture" },
    });
    const [identity] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, f.runId));
    expect(identity.github).toMatchObject({ login: "fixture-app[bot]", repository, nativeGitGrantId: grant.id });
    expect(identity.github).not.toHaveProperty("token");
    expect(await resolveGitHubOperationCredentials(db, { ...f, expectedRepository: "acme/other" }))
      .toMatchObject({ status: "unavailable", env: {} });
    await service.revoke(f.companyId, grant.id, "A");
    expect(await secretService(db).getById(row.secretId!)).toBeNull();
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({
      status: "unavailable", env: {}, reason: expect.stringContaining("revoked"),
    });
  });

  it("keeps a real managed conflict fail-closed even when an App grant exists", async () => {
    const f = await seed();
    const service = githubNativeGitService(db);
    await service.configure(f.companyId, "A", f.input);
    await f.fixture.grant(f, "first", true);
    await f.fixture.grant(f, "second", true);
    f.fetchImpl.mockClear();
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({
      status: "unavailable", env: {}, reason: expect.stringContaining("More than one"),
    });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the same repository and operation checks in native setup options and completion", async () => {
    const f = await seed();
    const mcp = await installOrganizationPat(f.companyId);
    const before = await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId));
    const intents = connectionIntentService(db);
    const claims = { sub: f.agentId, company_id: f.companyId, run_id: f.runId, responsible_user_id: "A" };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "A" };
      next();
    });
    app.use(connectionIntentBoardRoutes(db, { wakeup: vi.fn() } as never));
    app.use(errorHandler);
    const runRequest = await intents.request(claims, "github", { githubGit: { repository, operation: "push" } });
    const card = `/connection-intents/${runRequest.interactionId}`;
    await expect(intents.request(claims, "github", { githubGit: { repository: "acme/different", operation: "push" } }))
      .rejects.toMatchObject({ status: 422, details: { code: "workspace_mismatch" } });
    const options = await request(app).get(`${card}/setup-options`).expect(200);
    expect(options.body).toMatchObject({ existingConnections: [], githubGit: { status: "unavailable", code: "no_identity" } });
    await request(app).post(`${card}/phase`).send({ phase: "authorizing", setupAccess: {
      connectionId: mcp.id, access: "all_agents",
    } }).expect(422);
    expect((await intents.loadIntent(runRequest.interactionId!)).interaction.payload).not.toHaveProperty("setupAccess");
    await request(app).post(`${card}/complete`).send({ connectionId: mcp.id }).expect(409);
    expect((await intents.loadIntent(runRequest.interactionId!)).interaction.status).toBe("pending");
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId))).toEqual(before);

    const native = githubNativeGitService(db);
    f.fetchImpl.mockImplementationOnce(async () => Response.json({ id: 123, slug: "fixture-app" }))
      .mockImplementationOnce(async () => Response.json({ id: 456, app_id: 123 }))
      .mockImplementationOnce(async () => Response.json({
        token: "ghs_fixture", expires_at: new Date(Date.now() + 60000).toISOString(),
        permissions: { contents: "read" }, repositories: [{ id: 789, full_name: repository }],
      }));
    const readGrant = await native.configure(f.companyId, "A", { ...f.input, push: false, pullRequests: false });
    expect((await request(app).get(`${card}/setup-options`).expect(200)).body.githubGit)
      .toMatchObject({ status: "unavailable", code: "action_denied" });
    await request(app).post(`${card}/complete`).send({ connectionId: readGrant.id, nativeGitVerifiedAt: readGrant.verifiedAt }).expect(409);
    expect((await intents.loadIntent(runRequest.interactionId!)).interaction.status).toBe("pending");

    const grant = await native.configure(f.companyId, "A", f.input);
    expect((await request(app).get(`${card}/setup-options`).expect(200)).body.githubGit)
      .toMatchObject({ status: "available", grant: { id: grant.id } });
    await request(app).post(`${card}/complete`).send({
      connectionId: grant.id, nativeGitVerifiedAt: readGrant.verifiedAt,
    }).expect(409);
    expect((await intents.loadIntent(runRequest.interactionId!)).interaction.status).toBe("pending");
    expect((await request(app).post(`${card}/complete`).send({
      connectionId: grant.id, nativeGitVerifiedAt: grant.verifiedAt,
    }).expect(200)).body).toMatchObject({ status: "accepted", result: { nativeGitGrantId: grant.id } });
  });

  it("continues an App-only approval in a fresh turn without a GitHub MCP connection", async () => {
    const f = await seed();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, githubAuthenticationMode: "host" } })
      .where(eq(heartbeatRuns.id, f.runId));
    const grant = await githubNativeGitService(db).configure(f.companyId, "A", f.input);
    const intents = connectionIntentService(db);
    const claims = { sub: f.agentId, company_id: f.companyId, run_id: f.runId, responsible_user_id: "A" };
    const gitRequest = { githubGit: { repository, operation: "push" as const } };
    const pending = await intents.request(claims, "github", gitRequest);
    expect(pending).toMatchObject({ state: "needs_user_action", instruction: expect.stringContaining("fresh task turn") });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    const wakeup = vi.fn(async (_agentId: string, input: { idempotencyKey: string }) => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        status: "queued", idempotencyKey: input.idempotencyKey });
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "A" };
      next();
    });
    app.use(connectionIntentBoardRoutes(db, { wakeup } as never));
    app.use(errorHandler);
    await request(app).post(`/connection-intents/${pending.interactionId}/complete`).send({
      connectionId: grant.id, nativeGitVerifiedAt: grant.verifiedAt,
    }).expect(200);
    expect(wakeup).toHaveBeenCalledWith(f.agentId, expect.objectContaining({
      contextSnapshot: expect.objectContaining({ forceFreshSession: true }),
    }));
    const [delivery] = await db.select().from(connectionIntentDeliveries)
      .where(eq(connectionIntentDeliveries.interactionId, pending.interactionId!));
    expect(delivery?.deliveredAt).toBeInstanceOf(Date);
  });

  it("reports a genuinely ambiguous native identity set to both the picker and completion route", async () => {
    const f = await seed();
    const first = await f.fixture.grant(f, "first", true);
    await f.fixture.grant(f, "second", true);
    const intents = connectionIntentService(db);
    const result = await intents.request({ sub: f.agentId, company_id: f.companyId, run_id: f.runId, responsible_user_id: "A" }, "github", {
      githubGit: { repository, operation: "create_pull_request" },
    });
    expect(await intents.setupOptions(result.interactionId!)).toMatchObject({
      existingConnections: [], githubGit: { status: "unavailable", code: "ambiguous" },
    });
    await expect(intents.complete(result.interactionId!, first.connectionId, "A"))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("More than one") });
    expect((await intents.loadIntent(result.interactionId!)).interaction.status).toBe("pending");
  });

  it("denies issuance when the current workspace points to a different granted repository", async () => {
    const f = await seed();
    const service = githubNativeGitService(db);
    const grant = await service.configure(f.companyId, "A", f.input);
    const other = "acme/other";
    await db.update(githubNativeGrants).set({ repository: other }).where(eq(githubNativeGrants.id, grant.id));
    await db.update(executionWorkspaces).set({ repoUrl: `https://github.com/${other}` }).where(eq(executionWorkspaces.id, f.execution.id));
    f.fetchImpl.mockClear().mockImplementationOnce(async () => Response.json({
      token: "ghs_other", expires_at: new Date(Date.now() + 60000).toISOString(),
      permissions: { contents: "write", pull_requests: "write" }, repositories: [{ id: 789, full_name: other }],
    }));
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({ status: "unavailable", env: {} });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("requires stored admission for App tokens and preserves managed authorization on older runs", async () => {
    const f = await seed();
    const service = githubNativeGitService(db);
    await service.configure(f.companyId, "A", f.input);
    await db.update(heartbeatRuns).set({ runnerProfileJson: null }).where(eq(heartbeatRuns.id, f.runId));
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({ status: "unavailable", env: {} });
    const managed = await f.fixture.grant(f, "managed", true);
    await secretService(db).rotate(managed.secretId, { value: "ghs_previous_managed" });
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({ status: "available", grantId: managed.id });
  });

  it("offers read-only private checkout before admission and isolates anonymous board recovery", async () => {
    const f = await seed();
    await githubNativeGitService(db).configure(f.companyId, "A", f.input);
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, runnerProfileJson: null })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({ status: "unavailable", env: {} });

    const readToken = async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({ repository_ids: [789], permissions: { contents: "read" } });
      return Response.json({ token: "ghs_read", expires_at: new Date(Date.now() + 60000).toISOString(),
        permissions: { contents: "read" }, repositories: [{ id: 789, full_name: repository }] });
    };
    f.fetchImpl.mockClear().mockImplementationOnce(readToken).mockImplementationOnce(readToken);
    const provider = createGitRemoteAuthProvider(db, f.companyId, {
      agentId: f.agentId, issueId: f.issueId, heartbeatRunId: f.runId, projectCheckoutSourceId: f.workspace.id,
    });
    await expect(provider(f.workspace.repoUrl!)).resolves.toMatchObject({ env: { GH_TOKEN: "ghs_read" } });
    await expect(projectGitAuthorizationService(db).resolve({
      companyId: f.companyId, projectId: f.workspace.projectId, workspaceId: f.workspace.id,
    }, { projectId: f.workspace.projectId, agentId: f.agentId, runId: f.runId, operation: "prepare" })).resolves.toBe("ghs_read");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);

    const publicRecovery = createGitRemoteAuthProvider(db, f.companyId, { agentId: f.agentId, issueId: f.issueId },
      { env: { GH_TOKEN: "host-token" } });
    await expect(publicRecovery("https://github.com/public/other")).resolves.toMatchObject({
      env: { GH_TOKEN: "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retires a token if the responsible user loses access during minting", async () => {
    const f = await seed();
    await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, f.workspace.projectId));
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: f.workspace.projectId, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: f.workspace.projectId, subjectType: "user", subjectId: "A" },
    ]);
    await githubNativeGitService(db).configure(f.companyId, "A", f.input);
    const respond = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockClear().mockImplementationOnce(async (url, init) => {
      await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, f.workspace.projectId));
      return respond(url, init);
    });
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({ status: "unavailable", env: {} });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.fetchImpl.mock.calls[1]?.[0]).toBe("https://api.github.com/installation/token");
  });

  it("keeps a revoke that commits during a stale reconfiguration", async () => {
    const f = await seed();
    const service = githubNativeGitService(db);
    const grant = await service.configure(f.companyId, "A", f.input);
    const respond = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementationOnce(async (url, init) => {
      await service.revoke(f.companyId, grant.id.toUpperCase(), "A");
      return respond(url, init);
    });
    await expect(service.configure(f.companyId, "A", f.input)).rejects.toThrow("changed during verification");
    expect(await service.get(f.companyId, grant.id)).toMatchObject({ revokedAt: expect.any(String) });
  });

  it("refuses broader provider tokens before saving a grant", async () => {
    const f = await seed({ push: false, pullRequests: false });
    f.fetchImpl.mockImplementationOnce(async () => Response.json({ id: 123, slug: "fixture-app" }))
      .mockImplementationOnce(async () => Response.json({ id: 456, app_id: 123 }))
      .mockImplementationOnce(async () => Response.json({
        token: "ghs_fixture", expires_at: new Date(Date.now() + 60000).toISOString(),
        permissions: { contents: "write" }, repositories: [{ id: 789, full_name: repository }],
      }));
    const service = githubNativeGitService(db);
    await expect(service.configure(f.companyId, "A", f.input)).rejects.toThrow("restricted to the selected repository and permissions");
    expect(await service.list(f.companyId)).toEqual([]);
  });
});
