import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { heartbeatRuns, issues, managedAuditEvents, managedAuditExports, type Db, type DbTransaction } from "@groktopus/db";
import { and, asc, eq, exists, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";

const PAGE_SIZE = 200;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

type ExportScope = {
  companyId: string;
  userId: string;
  sourceEpoch: string;
  actor: AuthorizationActor;
};

const repeatableRead = { isolationLevel: "repeatable read" } as const;

async function visibleEvents(db: DbTransaction, { companyId, actor }: ExportScope) {
  const readable = await issueReadSqlCondition(db, actor, { enforcePrivacy: true });
  const hasIssueAccess = (issueId: typeof managedAuditEvents.taskId | typeof heartbeatRuns.issueId) =>
    exists(db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), readable)));
  const runVisible = exists(db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.id, managedAuditEvents.runId),
      or(eq(heartbeatRuns.scopeKind, "company"), hasIssueAccess(heartbeatRuns.issueId)),
    )));
  return and(
    eq(managedAuditEvents.companyId, companyId),
    eq(managedAuditEvents.source, "tool_gateway"),
    or(isNull(managedAuditEvents.taskId), hasIssueAccess(managedAuditEvents.taskId)),
    or(isNull(managedAuditEvents.runId), runVisible),
  );
}

function exportReceipt(snapshot: typeof managedAuditExports.$inferSelect) {
  return {
    exportId: snapshot.id,
    source: "tool_gateway" as const,
    coverage: "initial_gateway_decisions" as const,
    sourceEpoch: snapshot.sourceEpoch,
    from: snapshot.from.toISOString(),
    to: snapshot.to.toISOString(),
    watermark: snapshot.watermark,
    eventCount: snapshot.eventIds.length,
    expiresAt: snapshot.expiresAt.toISOString(),
  };
}

export async function createManagedAuditExport(db: Db, scope: ExportScope, window: { from: Date; to: Date }) {
  const publications: ActivityPublication[] = [];
  const snapshot = await db.transaction(async tx => {
    const now = new Date();
    await tx.delete(managedAuditExports).where(and(
      eq(managedAuditExports.companyId, scope.companyId), lte(managedAuditExports.expiresAt, now),
    ));
    const visible = await visibleEvents(tx, scope);
    const rows = await tx.select({ id: managedAuditEvents.id }).from(managedAuditEvents)
      .where(and(visible, gte(managedAuditEvents.occurredAt, window.from), lt(managedAuditEvents.occurredAt, window.to)))
      .orderBy(asc(managedAuditEvents.id));
    const eventIds = rows.map(row => row.id);
    const watermark = createHash("sha256").update(JSON.stringify(eventIds)).digest("hex");
    const [saved] = await tx.insert(managedAuditExports).values({
      companyId: scope.companyId,
      userId: scope.userId,
      sourceEpoch: scope.sourceEpoch,
      ...window,
      eventIds,
      watermark,
      expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS),
    }).returning();
    await logActivity(tx as unknown as Db, {
      companyId: scope.companyId,
      actorType: "user",
      actorId: scope.userId,
      action: "audit.managed_export_created",
      entityType: "company",
      entityId: scope.companyId,
      details: { exportId: saved.id, source: "tool_gateway" },
    }, publications);
    return saved;
  }, repeatableRead);
  for (const publication of publications) publishActivity(publication);
  return exportReceipt(snapshot);
}

function encodeCursor(snapshot: typeof managedAuditExports.$inferSelect, offset: number) {
  const signature = createHmac("sha256", snapshot.cursorSecret).update(String(offset)).digest("hex");
  return `${offset}.${signature}`;
}

function decodeCursor(snapshot: typeof managedAuditExports.$inferSelect, cursor?: string) {
  if (cursor === undefined) return 0;
  const value = /^([1-9][0-9]{0,9})\.([a-f0-9]{64})$/.exec(cursor);
  if (value) {
    const offset = Number(value[1]);
    const expected = encodeCursor(snapshot, offset);
    if (offset < snapshot.eventIds.length && timingSafeEqual(Buffer.from(cursor), Buffer.from(expected))) {
      return offset;
    }
  }
  throw conflict("Managed audit export cursor is invalid", { reasonCode: "snapshot_cursor_invalid" });
}

export async function readManagedAuditExportPage(
  db: Db,
  scope: ExportScope,
  exportId: string,
  cursor?: string,
) {
  return db.transaction(async tx => {
    const [snapshot] = await tx.select().from(managedAuditExports).where(and(
      eq(managedAuditExports.id, exportId),
      eq(managedAuditExports.companyId, scope.companyId),
      eq(managedAuditExports.userId, scope.userId),
    ));
    if (!snapshot) throw notFound("Managed audit export is unavailable", { reasonCode: "snapshot_missing" });
    if (snapshot.sourceEpoch !== scope.sourceEpoch) {
      throw conflict("Audit source epoch changed. Reconcile the archived checkpoint before creating an export.", { reasonCode: "source_epoch_changed" });
    }
    if (snapshot.expiresAt <= new Date()) {
      throw conflict("Managed audit export expired", { reasonCode: "snapshot_expired" });
    }
    const offset = decodeCursor(snapshot, cursor);
    const ids = snapshot.eventIds.slice(offset, offset + PAGE_SIZE);
    const visible = await visibleEvents(tx, scope);
    const events = ids.length
      ? await tx.select().from(managedAuditEvents).where(and(visible, inArray(managedAuditEvents.id, ids)))
        .orderBy(asc(managedAuditEvents.id))
      : [];
    if (events.length !== ids.length) {
      throw conflict("Managed audit export is incomplete. Reconcile the archived checkpoint before creating an export.", { reasonCode: "snapshot_incomplete" });
    }
    const count = offset + events.length;
    return {
      ...exportReceipt(snapshot),
      events,
      deliveredThrough: count,
      nextCursor: count < snapshot.eventIds.length ? encodeCursor(snapshot, count) : null,
      complete: count === snapshot.eventIds.length,
    };
  }, repeatableRead);
}
