-- proprio:migration-compat online_compatible: heartbeat_runs.id is a primary key so the company-and-ID pair cannot duplicate; CREATE UNIQUE INDEX CONCURRENTLY avoids blocking normal run writes while adding the foreign-key target.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_id_uq" ON "heartbeat_runs" USING btree ("company_id","id");
