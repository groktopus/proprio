import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, documents, documentRevisions, heartbeatRuns, issueDocuments,
  issueRelations, issueTreeHolds, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@groktopus/db";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const point = "issue.dependency_diagnosis.after_claim_before_wake";
const worker = path.join(import.meta.dirname, "helpers/dependency-diagnosis-restart-worker.ts");
const tsxLoader = path.resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs");

async function runRecoveryProcess(input: { connectionString: string; companyId: string; issueId: string;
  additionalIssueIds?: string[]; crashReceipt?: string }) {
  const child = spawn(process.execPath, ["--import", tsxLoader, worker, input.connectionString, input.companyId,
    input.issueId, ...(input.additionalIssueIds ?? [])], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: { ...process.env, PROPRIO_CRASH_POINT: input.crashReceipt ? point : "",
      PROPRIO_CRASH_POINT_RECEIPT: input.crashReceipt ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { ...exit, stdout, stderr };
}

describe.skipIf(!support.supported)("parent dependency diagnosis survives a controller process restart", () => {
  it("reuses the committed claim and creates one normal wake through assigned-work recovery", async () => {
    const database = await startEmbeddedPostgresTestDatabase("dependency-diagnosis-restart-");
    const db = createDb(database.connectionString, { maxConnections: 4 });
    const temporary = await mkdtemp(path.join(os.tmpdir(), "dependency-diagnosis-restart-"));
    const receipt = path.join(temporary, "crash-receipt.jsonl");
    const companyId = randomUUID();
    const prefix = `D${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`;
    try {
      await db.insert(companies).values({ id: companyId, name: "Diagnosis restart fixture", issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false });
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Fixture owner", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      const [agent] = await db.insert(agents).values({ companyId, name: "Recovery worker", role: "engineer", status: "idle",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
      const parentId = randomUUID();
      const childId = randomUUID();
      const grandchildId = randomUUID();
      const siblingId = randomUUID();
      const unrelatedId = randomUUID();
      const heldParentId = randomUUID();
      const heldChildId = randomUUID();
      const old = new Date(Date.now() - 10 * 60_000);
      await db.insert(issues).values([
        { id: parentId, companyId, identifier: `${prefix}-1`, issueNumber: 1, title: "Resume independent parent work",
          status: "in_progress", assigneeAgentId: agent!.id, responsibleUserId: userId, createdAt: old, updatedAt: old },
        { id: childId, companyId, identifier: `${prefix}-2`, issueNumber: 2, title: "Unassigned dependency branch",
          status: "todo", parentId, createdAt: old, updatedAt: old },
        { id: grandchildId, companyId, identifier: `${prefix}-3`, issueNumber: 3, title: "Unassigned leaf dependency",
          status: "todo", parentId: childId, createdAt: old, updatedAt: old },
        { id: siblingId, companyId, identifier: `${prefix}-4`, issueNumber: 4, title: "Completed sibling branch",
          status: "done", parentId, createdAt: old, updatedAt: old },
        { id: unrelatedId, companyId, identifier: `${prefix}-5`, issueNumber: 5, title: "Unrelated assigned task",
          status: "in_progress", assigneeAgentId: agent!.id, responsibleUserId: userId, createdAt: old, updatedAt: old },
        { id: heldParentId, companyId, identifier: `${prefix}-6`, issueNumber: 6, title: "Paused parent remains paused",
          status: "in_progress", assigneeAgentId: agent!.id, responsibleUserId: userId, createdAt: old, updatedAt: old },
        { id: heldChildId, companyId, identifier: `${prefix}-7`, issueNumber: 7, title: "Paused required dependency",
          status: "todo", createdAt: old, updatedAt: old },
      ]);
      // Blocking relations define the required graph; parentId is only the
      // display hierarchy. The unresolved path reaches an unassigned grandchild.
      await db.insert(issueRelations).values([
        { companyId, issueId: childId, relatedIssueId: parentId, type: "blocks" },
        { companyId, issueId: grandchildId, relatedIssueId: childId, type: "blocks" },
        { companyId, issueId: siblingId, relatedIssueId: parentId, type: "blocks" },
        { companyId, issueId: heldChildId, relatedIssueId: heldParentId, type: "blocks" },
      ]);
      await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, invocationSource: "assignment",
        triggerDetail: "system", status: "running", contextSnapshot: { issueId: unrelatedId, taskId: unrelatedId } });
      await db.insert(issueTreeHolds).values({ companyId, rootIssueId: heldParentId, mode: "pause", status: "active",
        reason: "Fixture stop gate" });

      const artifactBody = `# Completed sibling\n\nFixture marker: ${randomUUID()}\n`;
      const artifactHash = createHash("sha256").update(artifactBody).digest("hex");
      const [artifact] = await db.insert(documents).values({ companyId, title: "Completed sibling result", latestBody: artifactBody,
        latestRevisionNumber: 1 }).returning();
      const [revision] = await db.insert(documentRevisions).values({ companyId, documentId: artifact!.id, revisionNumber: 1,
        title: "Completed sibling result", body: artifactBody, changeSummary: "Seeded completed branch evidence" }).returning();
      await db.update(documents).set({ latestRevisionId: revision!.id }).where(eq(documents.id, artifact!.id));
      await db.insert(issueDocuments).values({ companyId, issueId: siblingId, documentId: artifact!.id, key: "result" });

      const interrupted = await runRecoveryProcess({ connectionString: database.connectionString, companyId, issueId: parentId,
        crashReceipt: receipt });
      expect(interrupted.signal, interrupted.stderr).toBe("SIGKILL");
      const receiptText = await readFile(receipt, "utf8");
      expect(receiptText).toContain(point);

      const committedClaim = await db.select().from(activityLog).where(and(eq(activityLog.entityId, parentId),
        eq(activityLog.action, "issue.dependency_diagnosis.requested")));
      expect(committedClaim).toHaveLength(1);
      const details = committedClaim[0]!.details as Record<string, unknown>;
      expect(details).toMatchObject({ outcome: "pending", source: "automatic", assigneeAgentId: agent!.id });
      expect(String(details.dependencyPathDigest)).toMatch(/^issue_blocker_stalled:diagnosis:[a-f0-9]{64}$/);
      expect(String(details.idempotencyKey)).not.toContain(childId);
      expect(String(details.idempotencyKey)).not.toContain(grandchildId);
      const artifactAfterCrash = await db.select({ body: documents.latestBody }).from(issueDocuments)
        .innerJoin(documents, eq(documents.id, issueDocuments.documentId)).where(and(eq(issueDocuments.issueId, siblingId),
          eq(issueDocuments.key, "result")));
      expect(createHash("sha256").update(artifactAfterCrash[0]!.body).digest("hex")).toBe(artifactHash);

      // A new process uses the same assigned-work recovery entry. Its normal
      // heartbeat queue performs durable admission; no persistence is mocked.
      const restarted = await runRecoveryProcess({ connectionString: database.connectionString, companyId, issueId: parentId,
        additionalIssueIds: [unrelatedId, heldParentId] });
      expect(restarted.code, restarted.stderr).toBe(0);
      const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, String(details.idempotencyKey))));
      expect(wakes, JSON.stringify(restarted)).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ reason: "issue_blocker_stalled", requestedByActorType: "system" });
      expect(wakes[0]!.payload).toMatchObject({ issueId: parentId, dependencyDiagnosis: true,
        dependencyDiagnosisKey: details.idempotencyKey });

      const claimsAfterRestart = await db.select().from(activityLog).where(and(eq(activityLog.entityId, parentId),
        eq(activityLog.action, "issue.dependency_diagnosis.requested")));
      expect(claimsAfterRestart).toHaveLength(1);
      expect((claimsAfterRestart[0]!.details as Record<string, unknown>).outcome).toBe("queued");
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, heldParentId),
        eq(activityLog.action, "issue.dependency_diagnosis.requested")))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${heldParentId}`))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${unrelatedId}`))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, unrelatedId)))[0]).toMatchObject({ status: "in_progress",
        assigneeAgentId: agent!.id });
      const artifactAfterRestart = await db.select({ body: documents.latestBody }).from(issueDocuments)
        .innerJoin(documents, eq(documents.id, issueDocuments.documentId)).where(and(eq(issueDocuments.issueId, siblingId),
          eq(issueDocuments.key, "result")));
      expect(createHash("sha256").update(artifactAfterRestart[0]!.body).digest("hex")).toBe(artifactHash);

      // Replaying the recovery pass is safe after the wake receipt exists.
      const replay = await runRecoveryProcess({ connectionString: database.connectionString, companyId, issueId: parentId });
      expect(replay.code, replay.stderr).toBe(0);
      const wakesAfterReplay = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, String(details.idempotencyKey))));
      expect(wakesAfterReplay).toHaveLength(1);
    } finally {
      await db.$client.end({ timeout: 0 });
      await database.cleanup();
      await rm(temporary, { recursive: true, force: true });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 2);
});
