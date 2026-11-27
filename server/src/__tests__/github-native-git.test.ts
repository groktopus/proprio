import { generateKeyPairSync } from "node:crypto";
import { agents, connectionGrants, createDb, githubNativeGrants, heartbeatRuns, issues, projects, projectWorkspaces, runIdentityContexts, toolApplications, toolConnectionInstalls, toolConnections } from "@groktopus/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { githubNativeGitService } from "../services/github-native-git.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
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
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await cleanup?.(); });

  async function seed({ push = true, pullRequests = true } = {}) {
    const fixture = githubCredentialsFixture(() => db);
    const context = await fixture.seed();
    const { companyId, agentId, runId, issueId } = context;
    await db.update(agents).set({ adapterType: "proprio_runner", adapterConfig: { provider: "codex" }, status: "active" }).where(eq(agents.id, agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, runId));
    const [project] = await db.insert(projects).values({ companyId, name: "Fixture project" }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId, projectId: project.id,
      name: "Fixture repository", repoUrl: `https://github.com/${repository}.git` }).returning();
    await db.update(issues).set({ assigneeAgentId: agentId, projectId: project.id, projectWorkspaceId: workspace.id }).where(eq(issues.id, issueId));
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
    return { ...context, fixture, fetchImpl, workspace, input: { agentId, repository, appId: "123", privateKey: key, push, pullRequests } };
  }

  it("admits the scoped token alongside the MCP PAT and rejects a different repository, agent or revoked grant", async () => {
    const f = await seed();
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId,
      name: "GitHub MCP", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      name: "GitHub MCP", uid: "mcp-pat", transport: "mcp_remote", authKind: "api_key", credentialPolicy: "shared",
      config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key" }, status: "active", enabled: true }).returning();
    await db.insert(connectionGrants).values({ companyId: f.companyId,
      connectionId: connection.id, kind: "organization", status: "active" });
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id,
      targetType: "company", targetId: f.companyId });
    const service = githubNativeGitService(db, f.fetchImpl as typeof fetch);
    const grant = await service.configure(f.companyId, "A", f.input);
    expect(grant).toMatchObject({ agentId: f.agentId, repository, appSlug: "fixture-app" });
    expect(grant).not.toHaveProperty("secretId");
    const [row] = await db.select().from(githubNativeGrants).where(eq(githubNativeGrants.id, grant.id));
    await expect(secretService(db).resolveSecretValue(f.companyId, row.secretId, "latest"))
      .rejects.toThrow("System-owned secrets require their server-only consumer");
    await expect(service.eligibility(f.companyId, f.issueId, repository, "push")).resolves.toMatchObject({ status: "unavailable" });
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({
      status: "available", grantId: grant.id, login: "fixture-app[bot]", repository, env: { GH_TOKEN: "ghs_fixture" },
    });
    const [identity] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, f.runId));
    expect(identity.github).toMatchObject({ login: "fixture-app[bot]", repository, grantId: grant.id });
    expect(identity.github).not.toHaveProperty("token");
    expect(await resolveGitHubOperationCredentials(db, { ...f, expectedRepository: "acme/other" }))
      .toMatchObject({ status: "unavailable", env: {} });
    await service.revoke(f.companyId, grant.id, "A");
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({
      status: "unavailable", env: {}, reason: expect.stringContaining("revoked"),
    });
  });

  it("keeps a real managed conflict fail-closed even when an App grant exists", async () => {
    const f = await seed();
    const service = githubNativeGitService(db, f.fetchImpl as typeof fetch);
    await service.configure(f.companyId, "A", f.input);
    await f.fixture.grant(f, "first", true);
    await f.fixture.grant(f, "second", true);
    f.fetchImpl.mockClear();
    expect(await resolveGitHubOperationCredentials(db, f)).toMatchObject({
      status: "unavailable", env: {}, reason: expect.stringContaining("More than one"),
    });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses broader provider tokens before saving a grant", async () => {
    const f = await seed({ push: false, pullRequests: false });
    f.fetchImpl.mockImplementationOnce(async () => Response.json({ id: 123, slug: "fixture-app" }))
      .mockImplementationOnce(async () => Response.json({ id: 456, app_id: 123 }))
      .mockImplementationOnce(async () => Response.json({
        token: "ghs_fixture", expires_at: new Date(Date.now() + 60000).toISOString(),
        permissions: { contents: "write" }, repositories: [{ id: 789, full_name: repository }],
      }));
    const service = githubNativeGitService(db, f.fetchImpl as typeof fetch);
    await expect(service.configure(f.companyId, "A", f.input)).rejects.toThrow("restricted to the selected repository and permissions");
    expect(await service.list(f.companyId)).toEqual([]);
  });
});
