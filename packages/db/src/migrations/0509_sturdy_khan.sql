CREATE TABLE "managed_audit_export_page_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"export_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"page_offset" integer NOT NULL,
	"item_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_audit_export_page_access" ADD CONSTRAINT "managed_audit_export_page_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_audit_export_page_access_company_export_idx" ON "managed_audit_export_page_access" USING btree ("company_id","export_id","created_at");