import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/** Minimized, immutable delivery events captured with their owning gateway write. */
export const managedAuditEvents = pgTable("managed_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  eventType: text("event_type").notNull(),
  phase: text("phase").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  runId: uuid("run_id"),
  taskId: uuid("task_id"),
  invocationId: uuid("invocation_id").notNull(),
  requestId: uuid("request_id"),
  /** Hash of company/actor/destination/canonical arguments; used only to fence unresolved writes. */
  operationFingerprint: text("operation_fingerprint"),
  /** JSON-RPC id sent with tools/call, distinct from the approval request id above. */
  providerRequestId: text("provider_request_id"),
  connectionId: uuid("connection_id"),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  decision: text("decision").notNull(),
  status: text("status").notNull(),
  reasonCode: text("reason_code"),
}, (table) => ({
  companyOccurredIdx: index("managed_audit_events_company_occurred_idx")
    .on(table.companyId, table.occurredAt, table.id),
  invocationPhaseUnique: uniqueIndex("managed_audit_events_invocation_phase_uq")
    .on(table.companyId, table.source, table.phase, table.invocationId),
  pendingOperationIdx: index("managed_audit_events_pending_operation_idx")
    .on(table.companyId, table.operationFingerprint)
    .where(sql`${table.source} = 'tool_gateway' and ${table.phase} = 'dispatch_intent' and ${table.operationFingerprint} is not null`),
}));
