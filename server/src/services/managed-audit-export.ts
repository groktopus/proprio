import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { heartbeatRuns, issues, managedAuditEvents, managedAuditExportPageAccess, managedAuditExports, withDedicatedDbConnection, type Db, type DbTransaction } from "@groktopus/db";
import { and, asc, count, eq, exists, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, not, or, sql } from "drizzle-orm";
import { HttpError, conflict, forbidden, notFound, payloadTooLarge, tooManyRequests } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { authorizationService, issueEvidenceReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { heartbeatRunIssueBindingDeniedSqlCondition, heartbeatRunReadSqlCondition } from "./heartbeat-run-privacy.js";
import { isTransientLockContention, postgresErrorCode } from "./transient-lock-contention.js";

const PAGE_SIZE = 200;
// Every page revalidates the complete membership so counts and watermarks stay
// truthful. Keep that repeated query and its UUID array explicitly bounded.
const MAX_SNAPSHOT_MEMBERSHIP = 20_000;
const EXPORT_STATEMENT_TIMEOUT_MS = 5_000;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

type ExportScope = {
  companyId: string;
  sourceEpoch: string;
  actor: AuthorizationActor;
  retainAfter: Date | null;
};

const repeatableRead = { isolationLevel: "repeatable read" } as const;
let exportInProgress = false;

async function runExportTransaction<T>(db: Db, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  if (exportInProgress) {
    throw tooManyRequests("Another managed audit export operation is running. Retry this request.", {
      reasonCode: "export_busy",
    });
  }
  exportInProgress = true;
  try {
    // Keep the full visibility scan off the ordinary request pool. Keep the
    // slot until PostgreSQL has released the connection, even on timeout.
    return await withDedicatedDbConnection(db, dedicated => dedicated.transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout',
        least(${EXPORT_STATEMENT_TIMEOUT_MS}, coalesce(nullif(setting::integer, 0), ${EXPORT_STATEMENT_TIMEOUT_MS}))::text,
        true) from pg_settings where name = 'statement_timeout'`);
      return work(tx);
    }, repeatableRead), { admitWithoutWaiting: true });
  } catch (error) {
    if (postgresErrorCode(error) === "57014" || isTransientLockContention(error)) {
      throw new HttpError(503, "Managed audit export could not finish in time. Retry this request.", {
        reasonCode: "export_retry_required",
      });
    }
    throw error;
  } finally {
    exportInProgress = false;
  }
}

function actorUserId(scope: ExportScope) {
  if (scope.actor.type !== "board" || !scope.actor.userId) {
    throw forbidden("Managed audit exports require authenticated board access");
  }
  return scope.actor.userId;
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
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), issueEvidenceReadSqlCondition(actor))));
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
  const hiddenTaskBinding = exists(tx.select({ id: issues.id }).from(issues)
    .where(and(
      eq(issues.companyId, scope.companyId),
      eq(issues.id, managedAuditEvents.taskId),
      not(issueEvidenceReadSqlCondition(scope.actor)),
    )));
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

function assertRetainedWindow(scope: ExportScope, from: Date) {
  if (scope.retainAfter && from < scope.retainAfter) {
    throw conflict("The export window includes expired managed audit evidence", { reasonCode: "retention_window_expired" });
  }
}

export async function createManagedAuditExport(
  db: Db,
  scope: ExportScope & { captureFrom: Date },
  window: { from: Date; to: Date },
) {
  const publications: ActivityPublication[] = [];
  const snapshot = await runExportTransaction(db, async tx => {
    const userId = await assertCurrentAuditAuthority(tx, scope);
    assertRetainedWindow(scope, window.from);
    if (window.from < scope.captureFrom) {
      throw conflict("The requested window starts before configured capture coverage", { reasonCode: "unsupported_interval" });
    }
    const now = new Date();
    await tx.delete(managedAuditExports).where(and(
      eq(managedAuditExports.companyId, scope.companyId), lte(managedAuditExports.expiresAt, now),
    ));
    await assertSourceBindingsAvailable(tx, scope, window);
    const visible = await visibleEvents(tx, scope);
    const rows = await tx.select({ id: managedAuditEvents.id }).from(managedAuditEvents)
      .where(and(visible, gte(managedAuditEvents.occurredAt, window.from), lt(managedAuditEvents.occurredAt, window.to)))
      .orderBy(asc(managedAuditEvents.id))
      // Fetch one sentinel row so we can reject oversized snapshots without
      // materializing an unbounded membership array in the service process.
      .limit(MAX_SNAPSHOT_MEMBERSHIP + 1);
    if (rows.length > MAX_SNAPSHOT_MEMBERSHIP) {
      throw payloadTooLarge("Managed audit export exceeds the bounded snapshot membership. Narrow the export window.", {
        reasonCode: "snapshot_membership_limit",
        maxEvents: MAX_SNAPSHOT_MEMBERSHIP,
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
  });
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
  return runExportTransaction(db, async tx => {
    const userId = await assertCurrentAuditAuthority(tx, scope);
    const [snapshot] = await tx.select({
      ...getTableColumns(managedAuditExports),
      eventIds: sql<string[] | null>`case when cardinality(${managedAuditExports.eventIds}) <= ${MAX_SNAPSHOT_MEMBERSHIP}
        then ${managedAuditExports.eventIds} end`.mapWith(managedAuditExports.eventIds),
    }).from(managedAuditExports).where(and(
      eq(managedAuditExports.id, exportId),
      eq(managedAuditExports.companyId, scope.companyId),
      eq(managedAuditExports.userId, userId),
    ));
    if (!snapshot) throw notFound("Managed audit export is unavailable", { reasonCode: "snapshot_missing" });
    if (snapshot.sourceEpoch !== scope.sourceEpoch) {
      throw conflict("Audit source epoch changed. Reconcile the archived checkpoint before creating an export.", { reasonCode: "source_epoch_changed" });
    }
    if (snapshot.expiresAt <= new Date()) {
      throw conflict("Managed audit export expired", { reasonCode: "snapshot_expired" });
    }
    assertRetainedWindow(scope, snapshot.from);
    // Defensive fence for rows written by older code or modified outside this
    // service. It also bounds the all-member visibility revalidation below.
    const eventIds = snapshot.eventIds;
    if (eventIds === null) {
      throw conflict("Managed audit export exceeds the supported snapshot membership. Create a narrower export.", {
        reasonCode: "snapshot_membership_limit",
        maxEvents: MAX_SNAPSHOT_MEMBERSHIP,
      });
    }
    const boundedSnapshot = { ...snapshot, eventIds };
    const offset = decodeCursor(boundedSnapshot, cursor);
    const ids = eventIds.slice(offset, offset + PAGE_SIZE);
    const visible = await visibleEvents(tx, scope);
    if (eventIds.length > 0) {
      // Counts and watermarks also describe rows on other pages. Check all
      // snapshot members in the same transaction before returning either.
      const [available] = await tx.select({ eventCount: count() }).from(managedAuditEvents)
        .where(and(visible, sql`${managedAuditEvents.id} = any(${sql.param(eventIds, managedAuditExports.eventIds)})`));
      if (available.eventCount !== eventIds.length) {
        throw conflict("Managed audit export is incomplete. Reconcile the archived checkpoint before creating an export.", { reasonCode: "snapshot_incomplete" });
      }
    }
    const events = ids.length
      ? await tx.select().from(managedAuditEvents).where(and(visible, inArray(managedAuditEvents.id, ids)))
        .orderBy(asc(managedAuditEvents.id))
      : [];
    const deliveredThrough = offset + events.length;
    await tx.insert(managedAuditExportPageAccess).values({
      companyId: scope.companyId,
      exportId: snapshot.id,
      userId,
      pageOffset: offset,
      itemCount: events.length,
    });
    return {
      ...exportReceipt(boundedSnapshot),
      events,
      deliveredThrough,
      nextCursor: deliveredThrough < eventIds.length ? encodeCursor(boundedSnapshot, deliveredThrough) : null,
      complete: deliveredThrough === eventIds.length,
    };
  });
}
