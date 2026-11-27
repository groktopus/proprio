import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const githubNativeGrants = pgTable("github_native_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "restrict" }),
  secretVersion: integer("secret_version"),
  repository: text("repository").notNull(),
  repositoryId: text("repository_id").notNull(),
  appId: text("app_id").notNull(),
  appSlug: text("app_slug").notNull(),
  installationId: text("installation_id").notNull(),
  push: boolean("push").notNull(),
  pullRequests: boolean("pull_requests").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("github_native_grants_company_agent_repo_uq").on(table.companyId, table.agentId, table.repository),
  check("github_native_grants_active_key_ck", sql`(${table.revokedAt} is null and ${table.secretId} is not null and ${table.secretVersion} is not null)
    or (${table.revokedAt} is not null and ${table.secretId} is null and ${table.secretVersion} is null)`),
]);
