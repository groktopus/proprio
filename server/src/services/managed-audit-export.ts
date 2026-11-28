import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { heartbeatRuns, issues, managedAuditEvents, managedAuditExports, type Db, type DbTransaction } from "@groktopus/db";
import { and, asc, count, eq, exists, gte, inArray, isNotNull, isNull, lt, lte, not, or, sql } from "drizzle-orm";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { authorizationService, issueEvidenceReadSqlCondition, issuePrivacySqlCondition, type AuthorizationActor } from "./authorization.js";
import { heartbeatRunIssueBindingDeniedSqlCondition, heartbeatRunReadSqlCondition } from "./heartbeat-run-privacy.js";

const PAGE_SIZE = 200;
// Keep the array-backed checkpoint and the all-membership visibility check
// bounded. Larger windows must be split and reconciled independently.
export const MAX_SNAPSHOT_EVENTS = 100_000;
const EXPORT_READ_STATEMENT_TIMEOUT_MS = 5_000;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

type ExportScope = {
  companyId: string;
  sourceEpoch: string;
  actor: AuthorizationActor;
  retainAfter?: Date;
};

const repeatableRead = { isolationLevel: "repeatable read" } as const;

function actorUserId(scope: ExportScope) {
  if (scope.actor.type !== "board" || !scope.actor.userId) {
    throw forbidden("Managed audit exports require authenticated board access");
  }
  return scope.actor.userId;
}

function assertRetentionAllows(scope: ExportScope, from: Date) {
  if (scope.retainAfter && from < scope.retainAfter) {
    throw conflict("The requested audit window starts before the configured retention boundary. Create a new export at or after the boundary.", {
      reasonCode: "retention_window_expired",
    });
  }
}

async function assertCurrentAuditAuthority(tx: DbTransaction, scope: ExportScope) {
  const userId = actorUserId(scope);
  const allowed = await authorizationService(tx).decide({
    actor: scope.actor,
    action: "audit:view_agent_actions",
    resource: { type: "company", companyId: scope.companyId },
  });
  if (!allowed.allowed) throw forbidden("Missing permission: audit:view_agent_actions");
  return userId;
}

async function visibleEvents(db: DbTransaction, { companyId, actor }: ExportScope) {
  const hasIssueAccess = (issueId: typeof managedAuditEvents.taskId | typeof heartbeatRuns.issueId) =>
    exists(db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), issuePrivacySqlCondition(actor))));
  const runVisible = await heartbeatRunReadSqlCondition(db, actor, companyId, managedAuditEvents.runId);
  return and(
    eq(managedAuditEvents.companyId, companyId),
    eq(managedAuditEvents.source, "tool_gateway"),
    or(isNull(managedAuditEvents.taskId), hasIssueAccess(managedAuditEvents.taskId)),
    or(isNull(managedAuditEvents.runId), runVisible),
  );
}

async function assertSourceBindingsAvailable(tx: DbTransaction, scope: ExportScope, window: { from: Date; to: Date }) {
  // This detects retained events whose task/run binding disappeared. It cannot
  // detect a producer that never persisted an event for an in-scope decision.
  const sourceWindow = and(
    eq(managedAuditEvents.companyId, scope.companyId),
    eq(managedAuditEvents.source, "tool_gateway"),
    gte(managedAuditEvents.occurredAt, window.from),
    lt(managedAuditEvents.occurredAt, window.to),
  );
  const missingRun = and(isNotNull(managedAuditEvents.runId), not(exists(tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, managedAuditEvents.runId))))));
  const missingTask = and(isNotNull(managedAuditEvents.taskId), not(exists(tx.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, managedAuditEvents.taskId))))));
  // If a surviving binding proves the event belongs to evidence the caller
  // cannot see, do not reveal whether another task/run binding is missing.
  const hiddenTaskBinding = and(isNotNull(managedAuditEvents.taskId), or(
    not(exists(tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, managedAuditEvents.taskId))))),
    exists(tx.select({ id: issues.id }).from(issues)
      .where(and(
        eq(issues.companyId, scope.companyId),
        eq(issues.id, managedAuditEvents.taskId),
        not(issueEvidenceReadSqlCondition(scope.actor)),
      ))),
  ))!;
  const hiddenRunBinding = heartbeatRunIssueBindingDeniedSqlCondition(tx, scope.actor, scope.companyId, managedAuditEvents.runId);
  const [missing] = await tx.select({ id: managedAuditEvents.id }).from(managedAuditEvents)
    .where(and(sourceWindow, or(missingRun, missingTask), not(hiddenTaskBinding), not(hiddenRunBinding))).limit(1);
  if (missing) throw conflict("Managed audit source has unavailable event bindings. Reconcile the archived checkpoint before creating an export.", { reasonCode: "snapshot_incomplete" });
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
  // Expiry cleanup is best-effort maintenance. Commit it in a normal
  // read-committed transaction so competing creators do not make the
  // repeatable-read snapshot transaction fail on the same expired rows.
  await db.transaction(async tx => {
    await assertCurrentAuditAuthority(tx, scope);
    assertRetentionAllows(scope, window.from);
    const now = new Date();
    await tx.delete(managedAuditExports).where(and(
      eq(managedAuditExports.companyId, scope.companyId), lte(managedAuditExports.expiresAt, now),
    ));
  });
  const snapshot = await db.transaction(async tx => {
    const userId = await assertCurrentAuditAuthority(tx, scope);
    const now = new Date();
    await assertSourceBindingsAvailable(tx, scope, window);
    const visible = await visibleEvents(tx, scope);
    const rows = await tx.select({ id: managedAuditEvents.id }).from(managedAuditEvents)
      .where(and(visible, gte(managedAuditEvents.occurredAt, window.from), lt(managedAuditEvents.occurredAt, window.to)))
      .orderBy(asc(managedAuditEvents.id))
      .limit(MAX_SNAPSHOT_EVENTS + 1);
    if (rows.length > MAX_SNAPSHOT_EVENTS) {
      throw conflict(`The requested audit window contains more than ${MAX_SNAPSHOT_EVENTS} visible events. Split the interval into smaller windows and reconcile the resulting checkpoints independently.`, {
        reasonCode: "snapshot_too_large",
        maxEvents: MAX_SNAPSHOT_EVENTS,
      });
    }
    const eventIds = rows.map(row => row.id);
    const watermark = createHash("sha256").update(JSON.stringify(eventIds)).digest("hex");
    const [saved] = await tx.insert(managedAuditExports).values({
      companyId: scope.companyId,
      userId,
      sourceEpoch: scope.sourceEpoch,
      ...window,
      eventIds,
      watermark,
      expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS),
    }).returning();
    await logActivity(tx as unknown as Db, {
      companyId: scope.companyId,
      actorType: "user",
      actorId: userId,
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
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout', ${String(EXPORT_READ_STATEMENT_TIMEOUT_MS)}, true)`);
      const userId = await assertCurrentAuditAuthority(tx, scope);
      const [snapshot] = await tx.select().from(managedAuditExports).where(and(
        eq(managedAuditExports.id, exportId),
        eq(managedAuditExports.companyId, scope.companyId),
        eq(managedAuditExports.userId, userId),
      ));
      if (!snapshot) throw notFound("Managed audit export is unavailable", { reasonCode: "snapshot_missing" });
      const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`managed-audit-export:${snapshot.id}`}, 0)) as locked`);
      if (!(lock as { locked?: boolean }).locked) {
        throw conflict("Another page read is already validating this managed audit export. Retry after it completes.", { reasonCode: "snapshot_read_busy" });
      }
      if (snapshot.sourceEpoch !== scope.sourceEpoch) {
        throw conflict("Audit source epoch changed. Reconcile the archived checkpoint before creating an export.", { reasonCode: "source_epoch_changed" });
      }
      assertRetentionAllows(scope, snapshot.from);
      if (snapshot.expiresAt <= new Date()) {
        throw conflict("Managed audit export expired", { reasonCode: "snapshot_expired" });
      }
      const offset = decodeCursor(snapshot, cursor);
      const ids = snapshot.eventIds.slice(offset, offset + PAGE_SIZE);
      const visible = await visibleEvents(tx, scope);
      if (snapshot.eventIds.length > 0) {
        // Counts and watermarks also describe rows on other pages. Check all
        // snapshot members in the same transaction before returning either.
        const [available] = await tx.select({ eventCount: count() }).from(managedAuditEvents)
          .where(and(visible, sql`${managedAuditEvents.id} = any(${sql.param(snapshot.eventIds)}::uuid[])`));
        if (available.eventCount !== snapshot.eventIds.length) {
          throw conflict("Managed audit export is incomplete. Reconcile the archived checkpoint before creating an export.", { reasonCode: "snapshot_incomplete" });
        }
      }
      const events = ids.length
        ? await tx.select({
            id: managedAuditEvents.id,
            companyId: managedAuditEvents.companyId,
            source: managedAuditEvents.source,
            schemaVersion: managedAuditEvents.schemaVersion,
            eventType: managedAuditEvents.eventType,
            phase: managedAuditEvents.phase,
            occurredAt: managedAuditEvents.occurredAt,
            runId: managedAuditEvents.runId,
            taskId: managedAuditEvents.taskId,
            invocationId: managedAuditEvents.invocationId,
            requestId: managedAuditEvents.requestId,
            connectionId: managedAuditEvents.connectionId,
            actorType: managedAuditEvents.actorType,
            actorId: managedAuditEvents.actorId,
            decision: managedAuditEvents.decision,
            status: managedAuditEvents.status,
            reasonCode: managedAuditEvents.reasonCode,
          }).from(managedAuditEvents).where(and(visible, inArray(managedAuditEvents.id, ids)))
          .orderBy(asc(managedAuditEvents.id))
        : [];
      const deliveredThrough = offset + events.length;
      return {
        ...exportReceipt(snapshot),
        events,
        deliveredThrough,
        nextCursor: deliveredThrough < snapshot.eventIds.length ? encodeCursor(snapshot, deliveredThrough) : null,
        complete: deliveredThrough === snapshot.eventIds.length,
      };
    }, repeatableRead);
  } catch (error) {
    if ((error as { code?: string }).code === "57014") {
      throw conflict("Managed audit export validation exceeded its bounded read time. Split the interval and retry.", { reasonCode: "snapshot_read_timeout" });
    }
    throw error;
  }
}
