import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DbConnectionBudgetExhaustedError, DbConnectionDeadlineExceededError, heartbeatRuns, issues, managedAuditEvents, managedAuditExportPageAccess, managedAuditExports, withDedicatedDbConnection, type Db, type DbTransaction } from "@groktopus/db";
import { and, asc, count, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, lte, not, or, sql } from "drizzle-orm";
import { HttpError, ManagedAuditExportUnavailableError, conflict, forbidden, notFound, payloadTooLarge, tooManyRequests } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { authorizationService, issueEvidenceReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { heartbeatRunIssueBindingDeniedSqlCondition, heartbeatRunReadSqlCondition } from "./heartbeat-run-privacy.js";
import { isTransientLockContention, postgresErrorCode } from "./transient-lock-contention.js";

const PAGE_SIZE = 200;
// Every page revalidates the complete membership so counts and watermarks stay
// truthful. Keep that repeated query and its UUID array explicitly bounded.
const MAX_SNAPSHOT_MEMBERSHIP = 20_000;
const MAX_ACTIVE_COMPANY_SNAPSHOTS = 128;
const EXPORT_STATEMENT_TIMEOUT_MS = 5_000;
const EXPORT_CONNECTION_DEADLINE_MS = 7_000;
const EXPORT_QUEUE_TIMEOUT_MS = 25_000;
const MAX_WAITING_COMPANIES = 3;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const EXPIRED_SNAPSHOT_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

type ExportScope = {
  companyId: string;
  sourceEpoch: string;
  actor: AuthorizationActor;
  retainAfter: Date | null;
  signal?: AbortSignal;
};

const repeatableRead = { isolationLevel: "repeatable read" } as const;
const serializable = { isolationLevel: "serializable" } as const;
const snapshotColumns = {
  id: managedAuditExports.id,
  sourceEpoch: managedAuditExports.sourceEpoch,
  from: managedAuditExports.from,
  to: managedAuditExports.to,
  watermark: managedAuditExports.watermark,
  expiresAt: managedAuditExports.expiresAt,
  cursorSecret: managedAuditExports.cursorSecret,
  invalidated: managedAuditExports.invalidated,
  eventCount: sql<number>`cardinality(${managedAuditExports.eventIds})`,
};
let activeExportCompany: string | null = null;
const waitingExports: Array<{ companyId: string; admit: () => void }> = [];

function exportBusy() {
  return tooManyRequests("Managed audit export capacity is busy. Retry this request.", { reasonCode: "export_busy" });
}

async function acquireExport(companyId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (activeExportCompany === null) {
    activeExportCompany = companyId;
    return;
  }
  if (activeExportCompany === companyId || waitingExports.length >= MAX_WAITING_COMPANIES
    || waitingExports.some(entry => entry.companyId === companyId)) {
    throw exportBusy();
  }
  await new Promise<void>((resolve, reject) => {
    const entry = {
      companyId,
      admit: () => {
        stopWaiting();
        activeExportCompany = companyId;
        resolve();
      },
    };
    const onAbort = () => cancel(signal?.reason);
    const timeout = setTimeout(() => cancel(exportBusy()), EXPORT_QUEUE_TIMEOUT_MS);
    function stopWaiting() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
    function cancel(reason: unknown) {
      stopWaiting();
      const index = waitingExports.indexOf(entry);
      if (index >= 0) waitingExports.splice(index, 1);
      reject(reason);
    }
    waitingExports.push(entry);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runExportTransaction<T>(
  db: Db,
  { companyId, signal }: ExportScope,
  work: (tx: DbTransaction) => Promise<T>,
  transactionOptions: typeof repeatableRead | typeof serializable = repeatableRead,
): Promise<T> {
  await acquireExport(companyId, signal);
  try {
    signal?.throwIfAborted();
    // Keep full snapshot validation off the ordinary request pool and retain
    // admission until the dedicated connection has settled or closed.
    return await withDedicatedDbConnection(db, dedicated => dedicated.transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout',
        least(${EXPORT_STATEMENT_TIMEOUT_MS}, coalesce(nullif(setting::integer, 0), ${EXPORT_STATEMENT_TIMEOUT_MS}))::text,
        true) from pg_settings where name = 'statement_timeout'`);
      return work(tx);
    }, transactionOptions), { rejectWhenBudgetExhausted: true, deadlineMs: EXPORT_CONNECTION_DEADLINE_MS });
  } catch (error) {
    if (error instanceof DbConnectionBudgetExhaustedError || error instanceof DbConnectionDeadlineExceededError
      || ["57014", "53300"].includes(postgresErrorCode(error) ?? "") || isTransientLockContention(error)) {
      throw new ManagedAuditExportUnavailableError();
    }
    throw error;
  } finally {
    const next = waitingExports.shift();
    if (next) next.admit();
    else activeExportCompany = null;
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
  // If a surviving binding proves the event belongs to evidence the caller
  // cannot see, do not reveal whether another task/run binding is missing.
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

type SnapshotReceipt = Pick<typeof managedAuditExports.$inferSelect, "id" | "sourceEpoch" | "from" | "to" | "watermark" | "expiresAt"> & { eventCount: number };

function exportReceipt(snapshot: SnapshotReceipt) {
  return {
    exportId: snapshot.id,
    source: "tool_gateway" as const,
    coverage: "initial_gateway_decisions" as const,
    sourceEpoch: snapshot.sourceEpoch,
    from: snapshot.from.toISOString(),
    to: snapshot.to.toISOString(),
    watermark: snapshot.watermark,
    eventCount: snapshot.eventCount,
    expiresAt: snapshot.expiresAt.toISOString(),
  };
}

function assertRetainedWindow(scope: ExportScope, from: Date) {
  if (scope.retainAfter && from < scope.retainAfter) {
    throw conflict("The export window includes expired managed audit evidence", { reasonCode: "retention_window_expired" });
  }
}

async function cleanExpiredSnapshots(tx: DbTransaction, companyId: string, now: Date) {
  const markerCutoff = new Date(now.getTime() - EXPIRED_SNAPSHOT_MARKER_TTL_MS);
  const ordinals = [asc(managedAuditExports.expiresAt), asc(managedAuditExports.id)] as const;
  const pastMarkerRetention = tx.select({ id: managedAuditExports.id }).from(managedAuditExports)
    .where(and(eq(managedAuditExports.companyId, companyId), lte(managedAuditExports.expiresAt, markerCutoff)))
    .orderBy(...ordinals)
    .limit(MAX_ACTIVE_COMPANY_SNAPSHOTS);
  await tx.delete(managedAuditExports).where(inArray(managedAuditExports.id, pastMarkerRetention));

  // Keep the owner, source epoch and expiration long enough to distinguish an
  // ordinary expiry from a snapshot lost across restore. Release the membership.
  const recentExpirations = tx.select({ id: managedAuditExports.id }).from(managedAuditExports)
    .where(and(
      eq(managedAuditExports.companyId, companyId),
      gt(managedAuditExports.expiresAt, markerCutoff),
      lte(managedAuditExports.expiresAt, now),
      sql`cardinality(${managedAuditExports.eventIds}) > 0`,
    )).orderBy(...ordinals)
    .limit(MAX_ACTIVE_COMPANY_SNAPSHOTS);
  await tx.update(managedAuditExports).set({ eventIds: [] })
    .where(inArray(managedAuditExports.id, recentExpirations));
}

export async function createManagedAuditExport(
  db: Db,
  scope: ExportScope & { captureFrom: Date },
  window: { from: Date; to: Date },
) {
  const publications: ActivityPublication[] = [];
  const snapshot = await runExportTransaction(db, scope, async tx => {
    const userId = await assertCurrentAuditAuthority(tx, scope);
    assertRetainedWindow(scope, window.from);
    if (window.from < scope.captureFrom) {
      throw conflict("The requested window starts before configured capture coverage", { reasonCode: "unsupported_interval" });
    }
    const now = new Date();
    // Serializable isolation makes this quota check and the insert one
    // ordered operation even when separate API replicas create snapshots.
    const active = await tx.select({ id: managedAuditExports.id }).from(managedAuditExports)
      .where(and(eq(managedAuditExports.companyId, scope.companyId), gt(managedAuditExports.expiresAt, now)))
      .limit(MAX_ACTIVE_COMPANY_SNAPSHOTS);
    if (active.length === MAX_ACTIVE_COMPANY_SNAPSHOTS) {
      throw tooManyRequests("The company already has the maximum number of active audit snapshots. Retry after a snapshot expires.", {
        reasonCode: "active_snapshot_limit",
      });
    }
    await cleanExpiredSnapshots(tx, scope.companyId, now);
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
    }).returning(snapshotColumns);
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
  }, serializable);
  for (const publication of publications) publishActivity(publication);
  return exportReceipt(snapshot);
}

function encodeCursor(snapshot: { cursorSecret: string }, offset: number) {
  const signature = createHmac("sha256", snapshot.cursorSecret).update(String(offset)).digest("hex");
  return `${offset}.${signature}`;
}

function decodeCursor(snapshot: { cursorSecret: string; eventCount: number }, cursor?: string) {
  if (cursor === undefined) return 0;
  const value = /^([1-9][0-9]{0,9})\.([a-f0-9]{64})$/.exec(cursor);
  if (value) {
    const offset = Number(value[1]);
    const expected = encodeCursor(snapshot, offset);
    if (offset < snapshot.eventCount && timingSafeEqual(Buffer.from(cursor), Buffer.from(expected))) {
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
  recordAccess = true,
) {
  const page = await runExportTransaction(db, scope, async tx => {
    const userId = await assertCurrentAuditAuthority(tx, scope);
    const ownedSnapshot = and(
      eq(managedAuditExports.id, exportId),
      eq(managedAuditExports.companyId, scope.companyId),
      eq(managedAuditExports.userId, userId),
    );
    const [snapshot] = await tx.select(snapshotColumns).from(managedAuditExports).where(ownedSnapshot);
    if (!snapshot) throw notFound("Managed audit export is unavailable", { reasonCode: "snapshot_missing" });
    if (snapshot.sourceEpoch !== scope.sourceEpoch) {
      throw conflict("Audit source epoch changed. Reconcile the archived checkpoint before creating an export.", { reasonCode: "source_epoch_changed" });
    }
    if (snapshot.expiresAt <= new Date()) {
      throw conflict("Managed audit export expired", { reasonCode: "snapshot_expired" });
    }
    assertRetainedWindow(scope, snapshot.from);
    if (snapshot.invalidated) return null;
    // Defensive fence for rows written by older code or modified outside this
    // service. It also bounds the all-member visibility revalidation below.
    if (snapshot.eventCount > MAX_SNAPSHOT_MEMBERSHIP) {
      throw conflict("Managed audit export exceeds the supported snapshot membership. Create a narrower export.", {
        reasonCode: "snapshot_membership_limit",
      });
    }
    const offset = decodeCursor(snapshot, cursor);
    const visible = await visibleEvents(tx, scope);
    if (snapshot.eventCount > 0) {
      // Keep the full membership in PostgreSQL. Counts and watermarks
      // describe other pages, so validate all members in this transaction.
      const membership = tx.select({ ids: managedAuditExports.eventIds }).from(managedAuditExports).where(ownedSnapshot);
      const [available] = await tx.select({ eventCount: count() }).from(managedAuditEvents)
        .where(and(visible, sql`${managedAuditEvents.id} = any((${membership})::uuid[])`));
      if (available.eventCount !== snapshot.eventCount) {
        // Commit the invalidation before sending a conflict so any cursor for
        // this snapshot remains invalid after visibility or data is restored.
        await tx.update(managedAuditExports).set({ invalidated: true, eventIds: [] }).where(ownedSnapshot);
        return null;
      }
    }
    const pageIds = tx.select({
      ids: sql`${managedAuditExports.eventIds}[${offset + 1}:${offset + PAGE_SIZE}]`,
    }).from(managedAuditExports).where(ownedSnapshot);
    const events = snapshot.eventCount
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
        }).from(managedAuditEvents).where(and(visible, sql`${managedAuditEvents.id} = any((${pageIds})::uuid[])`))
        .orderBy(asc(managedAuditEvents.id))
      : [];
    const deliveredThrough = offset + events.length;
    if (recordAccess) {
      try {
        await tx.insert(managedAuditExportPageAccess).values({
          companyId: scope.companyId,
          exportId: snapshot.id,
          userId,
          pageOffset: offset,
          itemCount: events.length,
          createdAt: sql`clock_timestamp()`,
        });
      } catch (error) {
        // The driver error contains private metadata. Preserve only the
        // SQLSTATE used to decide whether the caller can retry unchanged.
        const code = postgresErrorCode(error);
        const failure = new HttpError(500, "Managed audit page access could not be recorded");
        if (code === "57014" || isTransientLockContention(error)) throw Object.assign(failure, { code });
        throw failure;
      }
    }
    return {
      ...exportReceipt(snapshot),
      events,
      deliveredThrough,
      nextCursor: deliveredThrough < snapshot.eventCount ? encodeCursor(snapshot, deliveredThrough) : null,
      complete: deliveredThrough === snapshot.eventCount,
    };
  });
  if (!page) {
    throw conflict("Managed audit export is incomplete. Reconcile the archived checkpoint before creating an export.", {
      reasonCode: "snapshot_incomplete",
    });
  }
  return page;
}
