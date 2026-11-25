import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const indexName = "managed_audit_exports_company_uncleared_expiry_idx";
const migrationFile = "0513_large_kabuki.sql";

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

      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url));
      const hash = createHash("sha256").update(content).digest("hex");
      const readReceipts = () => sql`SELECT count(*)::int count FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      expect(await readReceipts()).toEqual([{ count: 1 }]);
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      await sql.unsafe(`DROP INDEX ${indexName}`);
      // PostgreSQL retains the invalid catalog entry when a concurrent build fails.
      await expect(sql.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON managed_audit_exports (company_id)`))
        .rejects.toMatchObject({ code: "23505" });
      expect(await sql`SELECT indisvalid FROM pg_index WHERE indexrelid=${indexName}::regclass`)
        .toEqual([{ indisvalid: false }]);

      await Promise.all([
        applyPendingMigrations(database.connectionString),
        applyPendingMigrations(database.connectionString),
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
