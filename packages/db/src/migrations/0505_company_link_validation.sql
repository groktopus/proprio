-- proprio:migration-compat online_compatible: The five composite constraints were installed NOT VALID by 0504; PostgreSQL validates existing rows without blocking ordinary inserts, updates, or deletes.
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_project_company_fk";--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_parent_company_fk";--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_assignee_agent_company_fk";--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_checkout_run_company_fk";--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_execution_run_company_fk";
