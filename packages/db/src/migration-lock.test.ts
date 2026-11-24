import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, reconcilePendingMigrationHistory } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const run = promisify(execFile);
const support = await getEmbeddedPostgresTestSupport();
const migration = new URL("./migrations/0501_sour_pepper_potts.sql", import.meta.url);
const hash = createHash("sha256").update(await readFile(migration)).digest("hex");

afterEach(() => vi.unstubAllEnvs());

(support.supported ? describe : describe.skip)("migration advisory lock", () => {
  it("times out the CLI while another session owns the lock and retries cleanly", async () => {
    const database = await startEmbeddedPostgresTestDatabase("migration-lock-cli-");
    const owner = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const migrate = fileURLToPath(new URL("./migrate.ts", import.meta.url));
    const invoke = () => run(process.execPath, ["--import", loader, migrate], {
      env: { ...process.env, DATABASE_URL: database.connectionString, PROPRIO_MIGRATION_LOCK_TIMEOUT_MS: "500" },
      timeout: 8_000,
    });
    try {
      await owner`ALTER TABLE routine_runs DROP COLUMN assignment_wake_pending`;
      await owner`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await owner`SELECT pg_advisory_lock(hashtextextended('proprio:migrations', 0))`;
      await expect(invoke()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("MIGRATION_LOCK_TIMEOUT"),
      });
      expect(await owner`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toEqual([]);
      expect(await owner`SELECT 1 FROM pg_attribute
        WHERE attrelid = 'routine_runs'::regclass AND attname = 'assignment_wake_pending' AND NOT attisdropped`).toEqual([]);
      expect(await owner`SELECT pg_advisory_unlock(hashtextextended('proprio:migrations', 0)) AS unlocked`)
        .toEqual([{ unlocked: true }]);
      expect((await invoke()).stdout).toContain("Migrations complete");
      expect(await owner`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toEqual([{ hash }]);
    } finally {
      await owner.end();
      await database.cleanup();
    }
  }, 30_000);

  it("waits for the lock before repairing migration history at startup", async () => {
    const database = await startEmbeddedPostgresTestDatabase("migration-lock-reconcile-");
    const owner = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await owner`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await owner`SELECT pg_advisory_lock(hashtextextended('proprio:migrations', 0))`;
      vi.stubEnv("PROPRIO_MIGRATION_LOCK_TIMEOUT_MS", "500");
      await expect(reconcilePendingMigrationHistory(database.connectionString))
        .rejects.toMatchObject({ code: "MIGRATION_LOCK_TIMEOUT" });
      expect(await owner`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toEqual([]);

      vi.stubEnv("PROPRIO_MIGRATION_LOCK_TIMEOUT_MS", "5000");
      const waiting = applyPendingMigrations(database.connectionString).then(() => null, error => error);
      try {
        await expect.poll(async () => {
          const [row] = await owner`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND query LIKE '%SELECT pg_try_advisory_lock%' AND query LIKE '%proprio:migrations%'`;
          return row?.count;
        }).toBe(1);
      } finally {
        await owner`SELECT pg_advisory_unlock(hashtextextended('proprio:migrations', 0))`;
        expect(await waiting).toBeNull();
      }
      expect(await owner`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toEqual([{ hash }]);
    } finally {
      await owner.end();
      await database.cleanup();
    }
  }, 30_000);
});
