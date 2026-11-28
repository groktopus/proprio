import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const managedAuditExports = pgTable("managed_audit_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  sourceEpoch: uuid("source_epoch").notNull(),
  from: timestamp("from_at", { withTimezone: true }).notNull(),
  to: timestamp("to_at", { withTimezone: true }).notNull(),
  eventIds: uuid("event_ids").array().notNull(),
  watermark: text("watermark").notNull(),
  cursorSecret: uuid("cursor_secret").notNull().defaultRandom(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => [
  index("managed_audit_exports_company_expiry_idx").on(table.companyId, table.expiresAt),
]);
