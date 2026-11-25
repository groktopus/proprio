import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const indexName = "managed_audit_exports_company_uncleared_expiry_idx";

afterEach(() => vi.unstubAllEnvs());

(support.supported ? describe : describe.skip)("managed audit retirement migration", () => {
  it("recovers an interrupted index build during concurrent migration replay", async () => {
    const database = await startEmbeddedPostgresTestDatabase("audit-retirement-replay-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const [company] = await sql`INSERT INTO companies (name, issue_prefix)
        VALUES ('Retirement replay', 'MARE') RETURNING id`;
      const sourceEpoch = randomUUID();
      const eventId = randomUUID();
      await sql`INSERT INTO managed_audit_exports
        (company_id, user_id, source_epoch, from_at, to_at, event_ids, membership_cleared, watermark, expires_at)
        VALUES (${company!.id}, 'reviewer', ${sourceEpoch}, now(), now(), ARRAY[${eventId}::uuid], false, 'pending', now()),
               (${company!.id}, 'reviewer', ${sourceEpoch}, now(), now(), ARRAY[]::uuid[], true, 'cleared', now())`;
      const readMembership = () => sql`SELECT id, event_ids, membership_cleared FROM managed_audit_exports ORDER BY id`;
      const membership = await readMembership();

      const migrationsFolder = fileURLToPath(new URL("./migrations/", import.meta.url));
      const matches = readMigrationFiles({ migrationsFolder }).filter(migration =>
        migration.sql.some(statement =>
          /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/iu.test(statement) && statement.includes(`"${indexName}"`)),
      );
      expect(matches).toHaveLength(1);
      const { hash } = matches[0]!;
      const readReceipts = () => sql`SELECT count(*)::int count FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      expect(await readReceipts()).toEqual([{ count: 1 }]);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      await sql.unsafe(`DROP INDEX ${indexName}`);
      // PostgreSQL retains the invalid catalog entry when a concurrent build fails.
      await expect(sql.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON managed_audit_exports (company_id)`))
        .rejects.toMatchObject({ code: "23505" });
      expect(await sql`SELECT indisvalid FROM pg_index WHERE indexrelid=${indexName}::regclass`)
        .toEqual([{ indisvalid: false }]);

      vi.stubEnv("PROPRIO_MIGRATION_LOCK_TIMEOUT_MS", "5000");
      await sql`SELECT pg_advisory_lock(hashtextextended('proprio:migrations', 0))`;
      const replays = Promise.allSettled([
        applyPendingMigrations(database.connectionString),
        applyPendingMigrations(database.connectionString),
      ]);
      try {
        await expect.poll(async () => {
          const [row] = await sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND query LIKE '%SELECT pg_try_advisory_lock%'
              AND query LIKE '%proprio:migrations%'`;
          return row?.count;
        }).toBe(2);
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended('proprio:migrations', 0))`;
        await replays;
      }
      expect(await replays).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);

      const [rebuilt] = await sql`SELECT indisvalid, indisunique, pg_get_indexdef(indexrelid) definition,
        pg_get_expr(indpred, indrelid) predicate FROM pg_index WHERE indexrelid=${indexName}::regclass`;
      expect(rebuilt).toMatchObject({ indisvalid: true, indisunique: false, predicate: "(NOT membership_cleared)" });
      expect(rebuilt!.definition).toContain("company_id, expires_at, id");
      expect(await readMembership()).toEqual(membership);
      expect(await readReceipts()).toEqual([{ count: 1 }]);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 120_000);
});
