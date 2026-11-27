CREATE TABLE "github_native_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"secret_id" uuid,
	"secret_version" integer,
	"repository" text NOT NULL,
	"repository_id" text NOT NULL,
	"app_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"installation_id" text NOT NULL,
	"push" boolean NOT NULL,
	"pull_requests" boolean NOT NULL,
	"revoked_at" timestamp with time zone,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_native_grants_active_key_ck" CHECK (("github_native_grants"."revoked_at" is null and "github_native_grants"."secret_id" is not null and "github_native_grants"."secret_version" is not null)
    or ("github_native_grants"."revoked_at" is not null and "github_native_grants"."secret_id" is null and "github_native_grants"."secret_version" is null))
);
--> statement-breakpoint
ALTER TABLE "github_native_grants" ADD CONSTRAINT "github_native_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_native_grants" ADD CONSTRAINT "github_native_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_native_grants" ADD CONSTRAINT "github_native_grants_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_native_grants_company_agent_repo_uq" ON "github_native_grants" USING btree ("company_id","agent_id","repository");