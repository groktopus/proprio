CREATE TABLE "managed_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"event_type" text NOT NULL,
	"phase" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"invocation_id" uuid NOT NULL,
	"request_id" uuid,
	"connection_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"decision" text NOT NULL,
	"status" text NOT NULL,
	"reason_code" text
);
--> statement-breakpoint
ALTER TABLE "managed_audit_events" ADD CONSTRAINT "managed_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_audit_events_company_occurred_idx" ON "managed_audit_events" USING btree ("company_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_audit_events_invocation_phase_uq" ON "managed_audit_events" USING btree ("company_id","source","phase","invocation_id");