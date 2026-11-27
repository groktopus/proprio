ALTER TABLE "managed_audit_events" ADD COLUMN "run_scope_kind" text;--> statement-breakpoint
ALTER TABLE "managed_audit_events" ADD COLUMN "run_issue_id" uuid;