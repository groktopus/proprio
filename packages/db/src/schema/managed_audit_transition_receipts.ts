import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

/** Protected server-authored summaries of managed audit export transitions. */
export const managedAuditTransitionReceipts = pgTable("managed_audit_transition_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  transition: text("transition").notNull(),
  actorId: text("actor_id").notNull(),
  exportId: uuid("export_id"),
  recordCount: integer("record_count").notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("managed_audit_transition_receipts_transition_check", sql`${table.transition} in ('export_invalidated', 'company_exports_retired')`),
  check("managed_audit_transition_receipts_count_check", sql`(${table.transition} = 'export_invalidated' and ${table.recordCount} = 1) or (${table.transition} = 'company_exports_retired' and ${table.recordCount} > 0)`),
  check("managed_audit_transition_receipts_export_id_check", sql`(${table.transition} = 'export_invalidated' and ${table.exportId} is not null) or (${table.transition} = 'company_exports_retired' and ${table.exportId} is null)`),
  index("managed_audit_transition_receipts_company_created_idx").on(table.companyId, table.createdAt),
]).enableRLS();
