ALTER TABLE "issues" ADD COLUMN "goal_origin" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_goal_origin_check" CHECK ("issues"."goal_origin" in ('explicit', 'inherited', 'unknown')) NOT VALID;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "goal_origin_goal_id" uuid;
--> statement-breakpoint
COMMENT ON COLUMN "issues"."goal_origin" IS 'Pre-migration bindings use unknown because existing goal IDs do not reveal whether they were explicit; the NOT VALID CHECK still constrains every new write.';
