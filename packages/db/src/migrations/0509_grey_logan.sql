-- proprio:migration-compat online_compatible: nullable metadata preserves existing run reads and writes.
ALTER TABLE "heartbeat_runs" ADD COLUMN "task_lineage_json" jsonb;
