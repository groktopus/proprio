-- proprio:migration-compat online_compatible: All five optional links already target existing rows; NOT VALID begins enforcement immediately, and validation checks historical rows while ordinary reads and writes continue.
ALTER TABLE "issues" DROP CONSTRAINT "issues_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_parent_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_assignee_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_checkout_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_execution_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_company_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_company_fk" FOREIGN KEY ("company_id","parent_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_agent_company_fk" FOREIGN KEY ("company_id","assignee_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_checkout_run_company_fk" FOREIGN KEY ("company_id","checkout_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE SET NULL ("checkout_run_id") ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_execution_run_company_fk" FOREIGN KEY ("company_id","execution_run_id") REFERENCES "public"."heartbeat_runs"("company_id","id") ON DELETE SET NULL ("execution_run_id") ON UPDATE no action NOT VALID;--> statement-breakpoint
