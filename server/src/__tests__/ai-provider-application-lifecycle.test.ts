import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityLog, companies, companyMemberships, connectionGrants, createDb, toolApplications } from "@groktopus/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aiConnectionService } from "../services/ai-connections.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("AI provider application lifecycle", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let home: string | undefined;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "proprio-ai-provider-home-")));
    vi.stubEnv("PROPRIO_HOME", home);
    vi.stubEnv("PROPRIO_INSTANCE_ID", "ai-provider-lifecycle-fixture");
    tempDb = await startEmbeddedPostgresTestDatabase("proprio-ai-provider-db-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await db?.$client.end({ timeout: 1 });
      await tempDb?.cleanup();
    } finally {
      vi.unstubAllEnvs();
      if (home) await rm(home, { recursive: true, force: true });
    }
  });

  async function fixture() {
    const companyId = randomUUID();
    const userId = "fixture-board";
    const tools = toolAccessService(db);
    const ai = aiConnectionService(db);
    await db.insert(companies).values({
      id: companyId, name: "Provider fixture", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(companyMemberships).values({
      companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member",
    });
    const saveAccount = (name: string, connectionId?: string) => ai.save(companyId, userId, {
      provider: "anthropic", method: "api_key", ownership: "personal", name, apiKey: "fixture",
      agentIds: [], allAgents: false, ...(connectionId ? { connectionId } : {}),
    }, `fixture-${name}`);
    const first = await saveAccount("first");
    const [application] = await tools.listApplications(companyId);
    const removeFirst = () => tools.archiveConnection(first.connectionId, companyId, {
      actorType: "user", actorId: userId,
    });
    return { companyId, first, application, tools, saveAccount, removeFirst };
  }

  it("shows one newly added account after the last removal without restoring its revoked grant", async () => {
    const { companyId, first, application, tools, saveAccount, removeFirst } = await fixture();
    await removeFirst();
    await expect(tools.getApplication(application.id)).resolves.toMatchObject({ status: "archived" });

    const replacement = await saveAccount("replacement");
    const applications = await tools.listApplications(companyId);
    const connections = await tools.listConnections(companyId);
    expect(applications).toMatchObject([{ id: application.id, status: "active", archivedAt: null }]);
    expect(connections.filter(connection => connection.status !== "archived")).toMatchObject([
      { id: replacement.connectionId, applicationId: application.id, status: "active" },
    ]);
    const [revoked] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, first.grantId));
    expect(revoked).toMatchObject({ status: "revoked", isDefault: false, revokedAt: expect.any(Date) });
    expect(replacement.grantId).not.toBe(first.grantId);
  });

  it("reuses the auto-archived provider on explicit account reconnect", async () => {
    const { first, application, tools, saveAccount } = await fixture();
    // Model the inconsistent state left by an old add racing last-connection removal.
    const archivedAt = new Date();
    await db.update(toolApplications).set({ status: "archived", archivedAt, updatedAt: archivedAt })
      .where(eq(toolApplications.id, application.id));
    await expect(saveAccount("first again", first.connectionId)).resolves.toMatchObject(first);
    await expect(tools.getApplication(application.id)).resolves.toMatchObject({ status: "active", archivedAt: null });
  });

  it.each(["disabled", "archived"] as const)(
    "does not revive a deliberately %s provider or create a grant after the last removal",
    async status => {
      const { companyId, first, application, tools, saveAccount, removeFirst } = await fixture();
      await tools.updateApplication(application.id, { status });
      const reconnect = saveAccount("first again", first.connectionId);
      // The active credential still exists here; rejection must be the deliberate parent state.
      const rejected = await reconnect.then(() => null, error => error as Error);
      await removeFirst();
      await expect(tools.getApplication(application.id)).resolves.toMatchObject({ status, archivedAt: null });
      await expect(saveAccount("new account")).rejects.toThrow(/disabled|archived/i);
      expect(rejected?.message).toMatch(/disabled|archived/i);
      const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId));
      expect(grants).toMatchObject([{ id: first.grantId, status: "revoked" }]);
      const connections = await tools.listConnections(companyId);
      expect(connections.filter(connection => connection.status !== "archived")).toHaveLength(0);
    },
  );

  it("preserves an explicit archive after an automatic archive", async () => {
    const { application, tools, saveAccount, removeFirst } = await fixture();
    await removeFirst();
    await tools.updateApplication(application.id, { status: "archived" });
    await expect(tools.getApplication(application.id)).resolves.toMatchObject({ status: "archived", archivedAt: null });
    await expect(saveAccount("replacement")).rejects.toThrow("archived");
  });

  it("revives an auto-archived provider matched by name after a description edit", async () => {
    const { companyId, application, tools, saveAccount, removeFirst } = await fixture();
    await db.update(toolApplications).set({ applicationKey: "legacy-provider-key" })
      .where(eq(toolApplications.id, application.id));
    await removeFirst();
    await tools.updateApplication(application.id, { description: "Updated description" });
    const replacement = await saveAccount("replacement");
    await expect(tools.getApplication(application.id)).resolves.toMatchObject({
      status: "active", description: "Updated description", archivedAt: null,
    });
    expect((await tools.listConnections(companyId)).find(connection => connection.id === replacement.connectionId))
      .toMatchObject({ applicationId: application.id, status: "active" });
  });

  it("preserves a recorded operator disable on a legacy automatic archive", async () => {
    const { companyId, application, saveAccount, removeFirst } = await fixture();
    await db.insert(activityLog).values({
      companyId, actorId: "fixture-board", actorType: "user",
      action: "tool_application.updated", entityType: "tool_application", entityId: application.id,
      details: { status: "disabled" },
    });
    await removeFirst();
    await expect(saveAccount("replacement")).rejects.toThrow("disabled or archived by an operator");
  });

  it("allows the owner to explicitly reauthorize an identity that was already revoked", async () => {
    const { first, saveAccount } = await fixture();
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() })
      .where(eq(connectionGrants.id, first.grantId));
    await expect(saveAccount("first again", first.connectionId)).resolves.toMatchObject(first);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, first.grantId));
    expect(grant).toMatchObject({ status: "active", revokedAt: null });
  });

  it("does not hide the surviving connection when add overlaps last removal", async () => {
    const { companyId, application, tools, saveAccount, removeFirst } = await fixture();
    const [replacement] = await Promise.all([saveAccount("concurrent replacement"), removeFirst()]);
    await expect(tools.getApplication(application.id)).resolves.toMatchObject({ status: "active", archivedAt: null });
    const visible = (await tools.listConnections(companyId)).filter(connection => connection.status !== "archived");
    expect(visible).toMatchObject([{ id: replacement.connectionId, applicationId: application.id, status: "active" }]);
  });
});
