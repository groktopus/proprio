-- proprio:migration-compat online_compatible: The validated foreign keys were installed NOT VALID by 0504; after the preflight audit, PostgreSQL validates under a lock that permits normal inserts, updates, and deletes.
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_project_company_fk";--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_parent_company_fk";--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_assignee_agent_company_fk";--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_checkout_run_company_fk";--> statement-breakpoint
ALTER TABLE "issues" VALIDATE CONSTRAINT "issues_execution_run_company_fk";
