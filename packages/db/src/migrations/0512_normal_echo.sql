-- proprio:migration-compat online_compatible: Adds a defaulted state column and a concurrent partial index for bounded cleanup.
ALTER TABLE "managed_audit_exports" ADD COLUMN IF NOT EXISTS "membership_cleared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "managed_audit_exports_company_uncleared_expiry_idx" ON "managed_audit_exports" USING btree ("company_id","expires_at","id") WHERE not "managed_audit_exports"."membership_cleared";
