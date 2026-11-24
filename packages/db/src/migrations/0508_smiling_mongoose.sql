ALTER TABLE "managed_audit_events" ADD COLUMN "operation_fingerprint" text;--> statement-breakpoint
ALTER TABLE "managed_audit_events" ADD COLUMN "provider_request_id" text;