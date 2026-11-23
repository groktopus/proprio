import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { inspectDatabaseBackupHealth } from "../services/database-backup-health.js";
import { createDatabaseBackupOwner } from "../services/database-backup-owner.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("database backup stall fixture", () => {
  it("cancels a stalled dump before it allows the next scheduled backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "proprio-stall-backup-"));
    const db = await startEmbeddedPostgresTestDatabase("proprio-stall-db-");
    const first = join(directory, "proprio-20000101-000000.sql.gz");
    const ready = join(directory, "dump.started");
    const release = join(directory, "dump.release");
    const program = join(directory, "fixture-pg-dump.mjs");
    const priorBytes = gzipSync("SELECT 1;\n");
    let backup: ReturnType<ReturnType<typeof createDatabaseBackupOwner>> | undefined;

    try {
      await writeFile(first, priorBytes);
      // Old enough that any in-progress final-named output would supersede it.
      await utimes(first, new Date(1_000_000), new Date(1_000_000));
      await writeFile(program, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
process.stdout.write("SELECT 2;\\n", () => writeFileSync(${JSON.stringify(ready)}, "started"));
const interval = setInterval(() => {
  if (existsSync(${JSON.stringify(release)})) clearInterval(interval);
}, 10);
`);
      await chmod(program, 0o700);
      vi.stubEnv("PROPRIO_PG_DUMP_PATH", program);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const run = createDatabaseBackupOwner({
        connectionString: db.connectionString,
        backupDir: directory,
        getRetention: async () => ({ dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 6 }),
        logger,
        timeoutMs: 2_000,
      });
      backup = run("scheduled");
      // Observe premature setup failures as well as the expected held child.
      void backup.catch(() => undefined);
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5_000 });
      expect(await run("scheduled")).toBeNull();
      await expect(run("manual")).rejects.toMatchObject({ status: 409 });
      expect(await readFile(first)).toEqual(priorBytes);
      const health = inspectDatabaseBackupHealth({
        enabled: true, backupDir: directory, maxAgeHours: 24, getCurrentBackup: run.status,
      });
      expect(health.latestBackup?.path).toBe(first);
      expect(health.currentBackup).toMatchObject({ trigger: "scheduled", ageMs: expect.any(Number) });
      await expect(backup).rejects.toThrow("Database backup exceeded");
      expect(run.status()).toBeNull();
      expect(await readFile(first)).toEqual(priorBytes);
      expect((await readdir(directory)).filter(name => name.endsWith(".sql.gz"))).toEqual(["proprio-20000101-000000.sql.gz"]);
      await writeFile(release, "allow the next scheduled dump");
      const next = await run("scheduled");
      expect(next?.engine).toBe("pg_dump");
      expect(gunzipSync(await readFile(next!.backupFile)).toString()).toBe("SELECT 2;\n");
    } finally {
      await writeFile(release, "settle this fixture child");
      await backup?.catch(() => undefined);
      vi.unstubAllEnvs();
      try { await db.cleanup(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

});
