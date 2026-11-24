ALTER TABLE "agent_task_sessions" ADD COLUMN "goal_observation_source_id" text;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN "goal_observation_cursor" bigint;--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN "goal_authority_revision" integer DEFAULT 0 NOT NULL;