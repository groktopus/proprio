CREATE TABLE "managed_audit_transition_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"transition" text NOT NULL,
	"actor_id" text NOT NULL,
	"export_id" uuid,
	"record_count" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_audit_transition_receipts_transition_check" CHECK ("managed_audit_transition_receipts"."transition" in ('export_invalidated', 'company_exports_retired')),
	CONSTRAINT "managed_audit_transition_receipts_count_check" CHECK (("managed_audit_transition_receipts"."transition" = 'export_invalidated' and "managed_audit_transition_receipts"."record_count" = 1) or ("managed_audit_transition_receipts"."transition" = 'company_exports_retired' and "managed_audit_transition_receipts"."record_count" > 0)),
	CONSTRAINT "managed_audit_transition_receipts_export_id_check" CHECK (("managed_audit_transition_receipts"."transition" = 'export_invalidated' and "managed_audit_transition_receipts"."export_id" is not null) or ("managed_audit_transition_receipts"."transition" = 'company_exports_retired' and "managed_audit_transition_receipts"."export_id" is null))
);
--> statement-breakpoint
ALTER TABLE "managed_audit_transition_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "managed_audit_transition_receipts" ADD CONSTRAINT "managed_audit_transition_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_audit_transition_receipts_company_created_idx" ON "managed_audit_transition_receipts" USING btree ("company_id","created_at");