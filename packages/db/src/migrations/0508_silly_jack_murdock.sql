-- proprio:migration-compat online_compatible: nullable review bindings preserve historical decision reads and writes.
ALTER TABLE "issue_execution_decisions" ADD COLUMN "review_target_binding" jsonb;
