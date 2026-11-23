import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
} from "@groktopus/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@groktopus/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("documentService system issue documents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("proprio-documents-service-");
    db = createDb(tempDb.connectionString);
    svc = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function createIssueWithDocuments() {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Proprio",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1600",
      title: "System document filtering",
      description: "Validate document filtering",
      status: "in_progress",
      priority: "medium",
    });

    await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan",
      createdByUserId: "board-user",
    });
    await svc.upsertIssueDocument({
      issueId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Handoff",
    });

    return { issueId, companyId };
  }

  it("filters continuation summaries from default document lists and issue payload summaries", async () => {
    const { issueId } = await createIssueWithDocuments();

    const defaultDocuments = await svc.listIssueDocuments(issueId);
    expect(defaultDocuments.map((doc) => doc.key)).toEqual(["plan"]);

    const payload = await svc.getIssueDocumentPayload({ id: issueId, description: null });
    expect(payload.planDocument?.key).toBe("plan");
    expect(payload.documentSummaries.map((doc) => doc.key)).toEqual(["plan"]);
  });

  it("reads one pinned revision and never substitutes a newer or unrelated document", async () => {
    const { issueId } = await createIssueWithDocuments();
    const original = await svc.getIssueDocumentByKey(issueId, "plan");
    await svc.upsertIssueDocument({ issueId, key: "plan", format: "markdown", body: "# Newer plan", baseRevisionId: original!.latestRevisionId });
    const pinned = await svc.getIssueDocumentRevision(issueId, "plan", original!.latestRevisionId!);
    expect(pinned?.body).toBe("# Plan");
    expect(pinned?.id).toBe(original!.latestRevisionId);
    const current = await svc.getIssueDocumentByKey(issueId, "plan");
    expect(pinned).toMatchObject({ isLatest: false, latestRevisionId: current!.latestRevisionId, latestRevisionNumber: 2 });
    expect(await svc.getIssueDocumentRevision(issueId, "plan", current!.latestRevisionId!)).toMatchObject({ isLatest: true, revisionNumber: 2, body: "# Newer plan" });
    expect(await svc.getIssueDocumentRevision(issueId, "other-document", original!.latestRevisionId!)).toBeNull();
    expect(await svc.getIssueDocumentRevision(randomUUID(), "plan", original!.latestRevisionId!)).toBeNull();
    expect(await svc.getIssueDocumentRevision(issueId, "plan", randomUUID())).toBeNull();
  });

  it("keeps system documents available for includeSystem and direct fetch callers", async () => {
    const { issueId } = await createIssueWithDocuments();

    const debugDocuments = await svc.listIssueDocuments(issueId, { includeSystem: true });
    expect(debugDocuments.map((doc) => doc.key)).toEqual([
      ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      "plan",
    ]);

    const directHandoff = await svc.getIssueDocumentByKey(issueId, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY);
    expect(directHandoff).toEqual(expect.objectContaining({
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      body: "# Handoff",
    }));
  });

  it("returns each actual writer run in revision history without attributing human revisions to a run", async () => {
    const { issueId, companyId } = await createIssueWithDocuments();
    const agentId = randomUUID(), firstRunId = randomUUID(), secondRunId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Receipt writer", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values([firstRunId, secondRunId].map(id => ({ id, companyId, agentId,
      status: "succeeded", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } })));
    const first = await svc.upsertIssueDocument({ issueId, key: "receipt", title: "Receipt", format: "markdown",
      body: '{"total":6}', createdByAgentId: agentId, createdByRunId: firstRunId });
    const second = await svc.upsertIssueDocument({ issueId, key: "receipt", title: "Receipt", format: "markdown",
      body: '{"total":6,"currency":"USD"}', createdByAgentId: agentId, createdByRunId: secondRunId,
      baseRevisionId: first.document.latestRevisionId });
    expect(await svc.listIssueDocumentRevisions(issueId, "receipt")).toMatchObject([
      { id: second.document.latestRevisionId, revisionNumber: 2, createdByAgentId: agentId, createdByRunId: secondRunId,
        body: '{"total":6,"currency":"USD"}' },
      { id: first.document.latestRevisionId, revisionNumber: 1, createdByAgentId: agentId, createdByRunId: firstRunId,
        body: '{"total":6}' },
    ]);
    expect(await svc.listIssueDocumentRevisions(issueId, "plan")).toMatchObject([{ createdByUserId: "board-user", createdByRunId: null }]);
    expect(await svc.listIssueDocumentRevisions(randomUUID(), "receipt")).toEqual([]);
  });

  it("explains the revision guard and rejects missing or stale update revisions without changing the document", async () => {
    const { issueId } = await createIssueWithDocuments();
    const current = (await svc.getIssueDocumentByKey(issueId, "plan"))!;
    const update = {
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown" as const,
      body: "# Revised plan",
    };

    await expect(svc.upsertIssueDocument(update)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("set baseRevisionId to that latestRevisionId"),
      details: { currentRevisionId: current.latestRevisionId },
    });
    expect(await svc.getIssueDocumentByKey(issueId, "plan")).toMatchObject({
      body: current.body,
      latestRevisionId: current.latestRevisionId,
    });

    const saved = await svc.upsertIssueDocument({ ...update, baseRevisionId: current.latestRevisionId });
    expect(saved.document.body).toBe(update.body);
    expect(saved.document.latestRevisionNumber).toBe(current.latestRevisionNumber + 1);
    await expect(svc.upsertIssueDocument({
      ...update,
      body: "# Stale replacement",
      baseRevisionId: current.latestRevisionId,
    })).rejects.toMatchObject({ status: 409, message: "Document was updated by someone else" });
    expect(await svc.getIssueDocumentByKey(issueId, "plan")).toMatchObject({
      body: saved.document.body,
      latestRevisionId: saved.document.latestRevisionId,
    });
  });

  async function overlapRevisionInserts<T>(start: () => Promise<T>[]) {
    await db.execute(sql`
      create function test_gate_document_revision() returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(72072);
        return new;
      end;
      $$
    `);
    try {
      await db.execute(sql`
        create trigger test_gate_document_revision before insert on document_revisions
        for each row execute function test_gate_document_revision()
      `);
      try {
        let release!: () => void;
        let ready!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        const acquired = new Promise<void>(resolve => { ready = resolve; });
        const gate = db.transaction(async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock(72072)`);
          ready();
          await released;
        });
        await Promise.race([acquired, gate]);
        const results = Promise.allSettled(start());
        try {
          await expect.poll(async () => {
            const [row] = await db.execute<{ waiting: number }>(sql`
              select count(*)::int as waiting from pg_locks
              where locktype = 'advisory' and objid = 72072 and not granted
            `);
            return row.waiting;
          }, { timeout: 5_000 }).toBe(2);
        } finally {
          release();
          await gate;
          await results;
        }
        return results;
      } finally {
        await db.execute(sql`drop trigger test_gate_document_revision on document_revisions`);
      }
    } finally {
      await db.execute(sql`drop function test_gate_document_revision()`);
    }
  }

  it("reports the winning revision when two saves share the same base", async () => {
    const { issueId } = await createIssueWithDocuments();
    const initial = await svc.getIssueDocumentByKey(issueId, "plan");
    expect(initial?.latestRevisionId).toBeTruthy();
    const save = (body: string, baseRevisionId = initial!.latestRevisionId) =>
      svc.upsertIssueDocument({ issueId, key: "plan", format: "markdown", body, baseRevisionId });

    const results = await overlapRevisionInserts(() => [save("First edit"), save("Second edit")]);
    const winner = results.find(result => result.status === "fulfilled");
    const loser = results.find(result => result.status === "rejected");
    expect(winner?.value.document.latestRevisionNumber).toBe(2);
    const winningId = winner!.value.document.latestRevisionId;
    expect(loser?.reason).toMatchObject({ status: 409, details: { currentRevisionId: winningId } });
    const history = await svc.listIssueDocumentRevisions(issueId, "plan");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ id: winningId, body: winner!.value.document.body });

    const updated = await save("Reconciled edit", winningId);
    expect(updated.document.latestRevisionNumber).toBe(3);
  });

  it("preserves the duplicate-key conflict for overlapping document creation", async () => {
    const { issueId } = await createIssueWithDocuments();
    const create = (body: string) => svc.upsertIssueDocument({
      issueId, key: "receipt", format: "markdown", body,
    });

    const results = await overlapRevisionInserts(() => [create("First create"), create("Second create")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")?.reason).toMatchObject({
      status: 409,
      message: "Document key already exists on this issue",
      details: { key: "receipt" },
    });
    expect(await svc.listIssueDocumentRevisions(issueId, "receipt")).toHaveLength(1);
  });

  it("locks and unlocks issue documents", async () => {
    const { issueId } = await createIssueWithDocuments();

    const locked = await svc.lockIssueDocument({
      issueId,
      key: "plan",
      lockedByUserId: "board-user",
    });

    expect(locked.changed).toBe(true);
    expect(locked.document.lockedAt).toBeInstanceOf(Date);
    expect(locked.document.lockedByUserId).toBe("board-user");

    await expect(svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: locked.document.latestRevisionId,
      createdByUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      message: "Document is locked",
    });

    const unlocked = await svc.unlockIssueDocument(issueId, "plan");
    expect(unlocked.changed).toBe(true);
    expect(unlocked.document.lockedAt).toBeNull();

    const updated = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: unlocked.document.latestRevisionId,
      createdByUserId: "board-user",
    });

    expect(updated.created).toBe(false);
    expect(updated.document.body).toBe("# Updated plan");
  });

  it("creates a new document instead of updating a locked document when requested", async () => {
    const { issueId } = await createIssueWithDocuments();
    const locked = await svc.lockIssueDocument({
      issueId,
      key: "plan",
      lockedByUserId: "board-user",
    });

    const fallback = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Agent replacement plan",
      baseRevisionId: locked.document.latestRevisionId,
      lockedDocumentStrategy: "create_new_document",
    });

    expect(fallback.created).toBe(true);
    expect(fallback.document.key).toBe("plan-2");
    expect(fallback.document.body).toBe("# Agent replacement plan");
    expect("redirectedFromLockedDocument" in fallback ? fallback.redirectedFromLockedDocument : null)
      .toEqual({ id: locked.document.id, key: "plan" });

    const originalPlan = await svc.getIssueDocumentByKey(issueId, "plan");
    expect(originalPlan).toEqual(expect.objectContaining({
      body: "# Plan",
      lockedAt: expect.any(Date),
    }));

    const newPlan = await svc.getIssueDocumentByKey(issueId, "plan-2");
    expect(newPlan).toEqual(expect.objectContaining({
      body: "# Agent replacement plan",
      lockedAt: null,
    }));
  });
});
