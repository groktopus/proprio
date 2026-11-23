import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  createBufferedTextFileWriter,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  runDatabaseRestore,
} from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("proprio-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, prefix: string): Promise<string> {
  const targetUrl = new URL(connectionString);
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const name = `${prefix.slice(0, 30)}_${randomUUID().replaceAll("-", "")}`;
  if (await ensurePostgresDatabase(adminUrl.toString(), name) !== "created") {
    throw new Error("Expected a fresh disposable restore database");
  }
  cleanups.push(async () => {
    const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 5 });
    try {
      await admin`DROP DATABASE ${admin(name)}`;
    } finally {
      await admin.end();
    }
  });
  targetUrl.pathname = `/${name}`;
  return targetUrl.toString();
}

async function restoreWithJavaScript(connectionString: string, backupFile: string, tempDir: string): Promise<void> {
  const unavailablePsql = path.join(tempDir, "unavailable-psql");
  fs.writeFileSync(unavailablePsql, "#!/bin/sh\ncat >/dev/null\nexit 1\n", { mode: 0o700 });
  const previous = process.env.PROPRIO_PSQL_PATH;
  process.env.PROPRIO_PSQL_PATH = unavailablePsql;
  try {
    await runDatabaseRestore({ connectionString, backupFile });
  } finally {
    if (previous === undefined) delete process.env.PROPRIO_PSQL_PATH;
    else process.env.PROPRIO_PSQL_PATH = previous;
  }
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("proprio-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it.each(["pg_dump", "fallback", "transforms"] as const)("reports database backup provenance for %s", async (mode) => {
    const connectionString = await createTempDatabase();
    const backupDir = createTempDir("proprio-backup-provenance-");
    const executable = path.join(backupDir, "pg-dump-fixture");
    const privateDiagnostic = "postgres://fixture:do-not-include@database.invalid/proprio";
    const fixtureDump = "SELECT 42;\n";
    fs.writeFileSync(executable, mode === "pg_dump"
      ? "#!/bin/sh\nprintf 'SELECT 42;\\n'\n"
      : `#!/bin/sh\nprintf '%s\\n' '${privateDiagnostic}' >&2\nexit 1\n`,
    { mode: 0o700 });
    const previous = process.env.PROPRIO_PG_DUMP_PATH;
    process.env.PROPRIO_PG_DUMP_PATH = executable;
    try {
      const result = await runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        ...(mode === "transforms" ? { excludeTables: ["fixture_excluded_table"] } : {}),
      });
      const dump = gunzipSync(fs.readFileSync(result.backupFile)).toString();
      const summary = formatDatabaseBackupResult(result);
      if (mode === "pg_dump") {
        expect(result).toMatchObject({ engine: "pg_dump", fallbackReason: null });
        expect(summary).toContain("pg_dump");
        expect(dump).toBe(fixtureDump);
      } else {
        expect(result).toMatchObject({
          engine: "javascript",
          fallbackReason: mode === "fallback" ? "pg_dump_failed" : null,
        });
        if (mode === "fallback") expect(summary).toContain("JavaScript fallback");
        else expect(summary).not.toContain("warning");
        expect(dump).toContain("-- Proprio database backup");
      }
      expect(result).not.toHaveProperty("warning");
      expect(JSON.stringify(result)).not.toContain(privateDiagnostic);
      expect(summary).not.toContain(privateDiagnostic);
      expect(dump).not.toContain(privateDiagnostic);
    } finally {
      if (previous === undefined) delete process.env.PROPRIO_PG_DUMP_PATH;
      else process.env.PROPRIO_PG_DUMP_PATH = previous;
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("preserves a post-pg_dump verification error without falling back or pruning", async () => {
    const connectionString = await createTempDatabase();
    const backupDir = createTempDir("checkpoint-pg-dump-");
    const executable = path.join(backupDir, "pg-dump-fixture");
    fs.writeFileSync(executable, "#!/bin/sh\nprintf 'SELECT 1;\\n'\n", { mode: 0o700 });
    const history = path.join(backupDir, "proprio-history.sql.gz");
    const historyBytes = gzipSync("SELECT 'history';");
    fs.writeFileSync(history, historyBytes);
    fs.utimesSync(history, new Date(0), new Date(0));
    const previous = process.env.PROPRIO_PG_DUMP_PATH;
    process.env.PROPRIO_PG_DUMP_PATH = executable;
    const failure = new Error("fixture archive fsync failed");
    let verified = 0;
    try {
      await expect(runDatabaseBackup({
        connectionString, backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        verifyBeforePrune: async archive => {
          verified++;
          expect(gunzipSync(fs.readFileSync(archive)).toString()).toBe("SELECT 1;\n");
          throw failure;
        },
      })).rejects.toBe(failure);
      expect(verified).toBe(1);
      expect(fs.readFileSync(history)).toEqual(historyBytes);
      expect(fs.readdirSync(backupDir).filter(name => name.endsWith(".sql.gz"))).toEqual(["proprio-history.sql.gz"]);
    } finally {
      if (previous === undefined) delete process.env.PROPRIO_PG_DUMP_PATH;
      else process.env.PROPRIO_PG_DUMP_PATH = previous;
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("preserves identity generation, sequence options and progress in JavaScript backups", async () => {
    const source = await createTempDatabase();
    const target = await createSiblingDatabase(source, "identity_restore_target");
    const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
    const targetSql = postgres(target, { max: 1, onnotice: () => {} });
    try {
      await sourceSql.unsafe(`
        CREATE SCHEMA identity_fixture;
        CREATE TABLE identity_fixture.records (
          id bigint GENERATED ALWAYS AS IDENTITY (START WITH 7 INCREMENT BY 2) PRIMARY KEY,
          default_id integer GENERATED BY DEFAULT AS IDENTITY,
          value text NOT NULL
        );
        INSERT INTO identity_fixture.records (value) VALUES ('one'), ('two');
      `);
      const backup = await runDatabaseBackup({ connectionString: source, backupDir: createTempDir("identity-backup-"), backupEngine: "javascript", retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      expect(backup).toMatchObject({ engine: "javascript", fallbackReason: null });
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
      expect(await targetSql`SELECT id::text, default_id, value FROM identity_fixture.records ORDER BY id`)
        .toEqual([{ id: "7", default_id: 1, value: "one" }, { id: "9", default_id: 2, value: "two" }]);
      expect(await targetSql`INSERT INTO identity_fixture.records (value) VALUES ('three') RETURNING id::text, default_id`)
        .toEqual([{ id: "11", default_id: 3 }]);
      await expect(targetSql`INSERT INTO identity_fixture.records (id, value) VALUES (99, 'explicit')`).rejects.toThrow("non-DEFAULT");
    } finally {
      await sourceSql.end();
      await targetSql.end();
    }
  }, 30_000);

  const nativePgDump = process.env.PROPRIO_BACKUP_TEST_NATIVE_PG_DUMP;
  const constraintBackupEngines = nativePgDump ? ["fallback", "pg_dump"] : ["fallback"];
  it.each(constraintBackupEngines)("restores ordinary-table CHECK, exclusion and NULLS NOT DISTINCT constraints with %s", async (engine) => {
    const source = await createTempDatabase();
    const target = await createSiblingDatabase(source, "constraint_restore_target");
    const sourceSql = postgres(source, { max: 1, onnotice: () => {} });
    const targetSql = postgres(target, { max: 1, onnotice: () => {} });
    const readConstraints = (sql: typeof sourceSql) => sql.begin(async (tx) => {
      await tx`SET LOCAL search_path = pg_catalog`;
      return tx<{ name: string; type: string; validated: boolean; definition: string }[]>`
        SELECT conname AS name, contype::text AS type, convalidated AS validated,
               pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'booking.reservations'::regclass AND contype IN ('c', 'u', 'x')
        ORDER BY conname
      `;
    });
    let stage = "source setup";
    try {
      await sourceSql.unsafe(`
        CREATE SCHEMA booking;
        SET search_path = booking, public;
        CREATE FUNCTION booking.normalize_state(value text) RETURNS text
          LANGUAGE sql IMMUTABLE AS $$ SELECT lower(value) $$;
        CREATE FUNCTION booking.passthrough_slot(value int4range) RETURNS int4range
          LANGUAGE sql IMMUTABLE AS $$ SELECT value $$;
        CREATE FUNCTION booking.normalize_slot(value int4range) RETURNS int4range
          LANGUAGE sql IMMUTABLE SET search_path = booking, public AS $$ SELECT passthrough_slot(value) $$;
        CREATE FUNCTION booking.explicit_context(value text) RETURNS text
          LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT value $$;
        CREATE FUNCTION booking.allowed_state(value text) RETURNS boolean
          LANGUAGE sql IMMUTABLE ${engine === "pg_dump" ? "SET search_path = booking, public" : ""}
          AS $$ SELECT normalize_state(value) IN ('active', 'held') $$;
        CREATE TABLE booking.reservations (
          id integer PRIMARY KEY,
          state text NOT NULL,
          slot int4range NOT NULL,
          external_id text,
          CONSTRAINT reservation_external_unique UNIQUE NULLS NOT DISTINCT (external_id),
          CONSTRAINT reservation_state_check CHECK (booking.allowed_state(state)),
          CONSTRAINT reservation_slot_excl EXCLUDE USING gist (booking.normalize_slot(slot) WITH &&)
        );
        INSERT INTO booking.reservations VALUES (1, 'active', int4range(1, 5));
        ALTER TABLE booking.reservations
          ADD CONSTRAINT reservation_id_check CHECK (id > 1) NOT VALID;
        CREATE FUNCTION booking.replay_path_probe() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER replay_path_probe BEFORE INSERT ON booking.reservations
          FOR EACH ROW EXECUTE FUNCTION booking.replay_path_probe();
        CREATE TABLE booking.inheritance_parent (
          id integer CONSTRAINT inheritance_parent_guard CHECK (id > 0)
        );
        CREATE TABLE booking.inheritance_child (
          CONSTRAINT inheritance_child_guard CHECK (id < 10)
        ) INHERITS (booking.inheritance_parent);
        CREATE TABLE booking.partition_parent (
          id integer CONSTRAINT partition_parent_guard CHECK (id > 0)
        ) PARTITION BY RANGE (id);
        CREATE TABLE booking.partition_child PARTITION OF booking.partition_parent
          (CONSTRAINT partition_child_guard CHECK (id < 10))
          FOR VALUES FROM (0) TO (10);
      `);
      const sourceName = new URL(source).pathname.slice(1);
      await sourceSql`ALTER DATABASE ${sourceSql(sourceName)} SET search_path = booking, public`;

      // Trusted fixture: make unqualified replay of the built-in integer >
      // operator resolve differently from the source. Keep booking in the path
      // for the unqualified trigger function emitted after the constraints.
      await targetSql.unsafe(`
        CREATE SCHEMA shadow;
        CREATE FUNCTION shadow.always_true(a integer, b integer) RETURNS boolean
          LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
        CREATE OPERATOR shadow.> (
          FUNCTION = shadow.always_true, LEFTARG = integer, RIGHTARG = integer
        );
      `);
      const targetName = new URL(target).pathname.slice(1);
      await targetSql`ALTER DATABASE ${targetSql(targetName)} SET search_path = shadow, pg_catalog, booking, public`;
      await targetSql`SET search_path = shadow, pg_catalog, booking, public`;

      stage = "source constraint inspection";
      const original = await readConstraints(sourceSql);
      expect(original.map(({ name, type, validated }) => ({ name, type, validated }))).toEqual([
        { name: "reservation_external_unique", type: "u", validated: true },
        { name: "reservation_id_check", type: "c", validated: false },
        { name: "reservation_slot_excl", type: "x", validated: true },
        { name: "reservation_state_check", type: "c", validated: true },
      ]);

      stage = "backup";
      vi.stubEnv("PROPRIO_PG_DUMP_PATH", engine === "pg_dump"
        ? nativePgDump
        : path.join(createTempDir("unavailable-native-dump-"), "pg_dump"));
      const backup = await runDatabaseBackup({
        connectionString: source,
        backupDir: createTempDir("constraint-backup-"),
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      });
      expect(backup).toMatchObject(engine === "pg_dump"
        ? { engine: "pg_dump", fallbackReason: null }
        : { engine: "javascript", fallbackReason: "pg_dump_failed" });
      stage = "restore";
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });

      stage = "restored inspection and enforcement";
      expect(await readConstraints(targetSql)).toEqual(original);
      const routineSettings = (sql: typeof sourceSql) => sql`SELECT p.proname, p.proconfig FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'booking' ORDER BY p.proname`;
      expect(await routineSettings(targetSql)).toEqual(await routineSettings(sourceSql));
      if (engine === "fallback") {
        // Partition and inheritance topology require the native dump.
        const dump = gunzipSync(fs.readFileSync(backup.backupFile)).toString("utf8");
        expect(dump).not.toMatch(/(?:inheritance|partition)_(?:parent|child)_guard/);
        expect(dump).toContain("EXECUTE FUNCTION replay_path_probe()");
      }
      expect(await targetSql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'booking.reservations'::regclass AND NOT tgisinternal`)
        .toEqual([{ tgname: "replay_path_probe" }]);
      expect(await targetSql`SELECT id, state FROM booking.reservations`).toEqual([{ id: 1, state: "active" }]);
      await expect(targetSql`INSERT INTO booking.reservations VALUES (2, 'held', int4range(15, 20))`)
        .rejects.toMatchObject({ code: "23505", constraint_name: "reservation_external_unique" });
      await expect(targetSql`INSERT INTO booking.reservations VALUES (2, 'blocked', int4range(10, 15), 'specific-2')`)
        .rejects.toMatchObject({ code: "23514", constraint_name: "reservation_state_check" });
      await expect(targetSql`INSERT INTO booking.reservations VALUES (2, 'held', int4range(3, 8), 'specific-3')`)
        .rejects.toMatchObject({ code: "23P01", constraint_name: "reservation_slot_excl" });
      await expect(targetSql`ALTER TABLE booking.reservations VALIDATE CONSTRAINT reservation_id_check`)
        .rejects.toMatchObject({ code: "23514", constraint_name: "reservation_id_check" });
      await targetSql`UPDATE booking.reservations SET id = 2 WHERE id = 1`;
      await targetSql`ALTER TABLE booking.reservations VALIDATE CONSTRAINT reservation_id_check`;
      expect((await readConstraints(targetSql)).find((c) => c.name === "reservation_id_check")?.validated).toBe(true);
      // Simulate an upgrade that refers to the preserved nullable business key.
      await targetSql.unsafe(`CREATE TABLE booking.upgrade_reference (
        reservation_external_id text REFERENCES booking.reservations (external_id)
      )`);
    } catch (error) {
      throw new Error(`Constraint round trip failed during ${stage}`, { cause: error });
    } finally {
      vi.unstubAllEnvs();
      await sourceSql.end();
      await targetSql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("preserves CHECK string literals across source and target string settings", async () => {
    const source = await createTempDatabase();
    const target = await createSiblingDatabase(source, "constraint_literals");
    const sourceSql = postgres(source, { max: 1 });
    const targetSql = postgres(target, { max: 1 });
    const previousPsql = process.env.PROPRIO_PSQL_PATH;
    process.env.PROPRIO_PSQL_PATH = "/missing/proprio-fixture-psql";
    try {
      await sourceSql.unsafe(String.raw`CREATE TABLE public.literal_guard (
        value text CHECK (value <> E'\\' AND value <> E'\r')
      ); INSERT INTO public.literal_guard VALUES ('safe');`);
      const sourceName = new URL(source).pathname.slice(1);
      await sourceSql`ALTER DATABASE ${sourceSql(sourceName)} SET standard_conforming_strings = off`;
      const backup = await runDatabaseBackup({ connectionString: source, backupDir: createTempDir("constraint-literals-"),
        backupEngine: "javascript", retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 } });
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
      await expect(targetSql`INSERT INTO public.literal_guard VALUES (${"\\"})`).rejects.toMatchObject({ code: "23514" });
      await expect(targetSql`INSERT INTO public.literal_guard VALUES (${"\r"})`).rejects.toMatchObject({ code: "23514" });
      await targetSql`INSERT INTO public.literal_guard VALUES (${"\n"})`;
    } finally {
      if (previousPsql === undefined) delete process.env.PROPRIO_PSQL_PATH;
      else process.env.PROPRIO_PSQL_PATH = previousPsql;
      await sourceSql.end(); await targetSql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["in_progress", "todo"])("handles nullification against a validated CHECK (%s)", async status => {
    const source = await createTempDatabase();
    const sourceSql = postgres(source, { max: 1 });
    const backupDir = createTempDir("constraint-transform-");
    try {
      await sourceSql.unsafe(`CREATE TABLE public.transform_guard (
        status text, execution_run_id text,
        CONSTRAINT needs_execution CHECK (status <> 'in_progress' OR execution_run_id IS NOT NULL)
      );`);
      await sourceSql`INSERT INTO public.transform_guard VALUES (${status}, 'run-1')`;
      const backup = runDatabaseBackup({ connectionString: source, backupDir, backupEngine: "javascript",
        nullifyColumns: { transform_guard: ["execution_run_id"] },
        retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 } });
      if (status === "in_progress") {
        await expect(backup).rejects.toThrow("backup_transform_constraint_conflict");
        expect(fs.readdirSync(backupDir)).toEqual([]);
      } else {
        const archive = await backup;
        const target = await createSiblingDatabase(source, "compatible_transform");
        await runDatabaseRestore({ connectionString: target, backupFile: archive.backupFile });
        const targetSql = postgres(target, { max: 1 });
        try {
          expect(await targetSql`SELECT status, execution_run_id FROM public.transform_guard`)
            .toEqual([{ status: "todo", execution_run_id: null }]);
          expect(await targetSql`SELECT convalidated FROM pg_constraint WHERE conname = 'needs_execution'`)
            .toEqual([{ convalidated: true }]);
        } finally { await targetSql.end(); }
      }
    } finally { await sourceSql.end(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("rejects nullifying distinct keys before publishing a NULLS NOT DISTINCT backup", async () => {
    const source = await createTempDatabase();
    const sourceSql = postgres(source, { max: 1 });
    const backupDir = createTempDir("unique-transform-");
    const retention = { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 };
    try {
      await sourceSql.unsafe(`CREATE TABLE public.unique_transform_guard (
        external_id text, CONSTRAINT unique_external_id UNIQUE NULLS NOT DISTINCT (external_id)
      ); INSERT INTO public.unique_transform_guard VALUES ('first'), ('second');`);
      const prior = await runDatabaseBackup({ connectionString: source, backupDir, backupEngine: "javascript", retention });
      const priorBytes = fs.readFileSync(prior.backupFile);
      await expect(runDatabaseBackup({ connectionString: source, backupDir, backupEngine: "javascript", retention,
        nullifyColumns: { unique_transform_guard: ["external_id"] } }))
        .rejects.toThrow(/backup_transform_constraint_conflict.*unique_external_id/);
      expect(fs.readdirSync(backupDir)).toEqual([path.basename(prior.backupFile)]);
      expect(fs.readFileSync(prior.backupFile)).toEqual(priorBytes);
    } finally { await sourceSql.end(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["populated", "empty", "unrelated column"])("handles nullification against exclusion expression dependencies (%s)", async variant => {
    const source = await createTempDatabase();
    const sourceSql = postgres(source, { max: 1 });
    const backupDir = createTempDir("exclusion-transform-");
    try {
      await sourceSql.unsafe(`CREATE TABLE public.exclusion_transform_guard (
        slot int4range, note text, CONSTRAINT slots_disjoint EXCLUDE USING gist ((coalesce(slot, int4range(1, 2))) WITH &&)
      );`);
      if (variant !== "empty") await sourceSql.unsafe(`INSERT INTO public.exclusion_transform_guard VALUES (int4range(1, 2), 'one'), (int4range(3, 4), 'two')`);
      const backup = runDatabaseBackup({ connectionString: source, backupDir, backupEngine: "javascript",
        nullifyColumns: { exclusion_transform_guard: [variant === "unrelated column" ? "note" : "slot"] },
        retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 } });
      if (variant === "populated") {
        await expect(backup).rejects.toThrow("backup_transform_constraint_conflict");
        expect(fs.readdirSync(backupDir)).toEqual([]);
      } else {
        const archive = await backup;
        const target = await createSiblingDatabase(source, "compatible_exclusion");
        await runDatabaseRestore({ connectionString: target, backupFile: archive.backupFile });
        const targetSql = postgres(target, { max: 1 });
        try {
          expect(await targetSql`SELECT slot, note FROM public.exclusion_transform_guard`)
            .toHaveLength(variant === "empty" ? 0 : 2);
          expect(await targetSql`SELECT conname FROM pg_constraint WHERE conname = 'slots_disjoint'`)
            .toEqual([{ conname: "slots_disjoint" }]);
        } finally { await targetSql.end(); }
      }
    } finally { await sourceSql.end(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("captures rows and constraints from one snapshot during a concurrent migration", async () => {
    const source = await createTempDatabase();
    const target = await createSiblingDatabase(source, "constraint_snapshot");
    const admin = postgres(source, { max: 1 });
    const blocker = postgres(source, { max: 1 });
    const migration = postgres(source, { max: 1 });
    const targetSql = postgres(target, { max: 1 });
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    let blocking: Promise<unknown> | undefined, dumping: Promise<Awaited<ReturnType<typeof runDatabaseBackup>>> | undefined;
    let changing: Promise<unknown> | undefined;
    try {
      await admin.unsafe(`CREATE SCHEMA backup_race;
        CREATE TABLE backup_race.a_data (value integer); INSERT INTO backup_race.a_data VALUES (0);
        CREATE TABLE backup_race.z_block (value integer); INSERT INTO backup_race.z_block VALUES (1);`);
      blocking = blocker.begin(async tx => { await tx.unsafe('LOCK TABLE backup_race.z_block IN ACCESS EXCLUSIVE MODE'); locked(); await gate; });
      await acquired;
      dumping = runDatabaseBackup({ connectionString: source, backupDir: createTempDir("constraint-snapshot-"),
        backupEngine: "javascript", retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 } });
      await vi.waitFor(async () => {
        expect(await admin`SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid()
          AND datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%z_block%'`).not.toHaveLength(0);
      }, { timeout: 10_000 });
      await migration`UPDATE backup_race.a_data SET value = 1`;
      const [{ pid }] = await migration<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      let changed = false;
      changing = migration.unsafe('ALTER TABLE backup_race.a_data ADD CONSTRAINT positive_value CHECK (value > 0)')
        .then(() => { changed = true; });
      await vi.waitFor(async () => {
        const waiting = await admin`SELECT pid FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`;
        expect(changed || waiting.length > 0).toBe(true);
      }, { timeout: 10_000 });
      release(); await blocking;
      const backup = await dumping;
      await changing;
      await runDatabaseRestore({ connectionString: target, backupFile: backup.backupFile });
      expect(await targetSql`SELECT value FROM backup_race.a_data`).toEqual([{ value: 0 }]);
      expect(await targetSql`SELECT conname FROM pg_constraint WHERE conrelid = 'backup_race.a_data'::regclass`).toEqual([]);
    } finally {
      release?.();
      await Promise.allSettled([blocking, dumping, changing].filter(Boolean));
      await admin.end(); await blocker.end(); await migration.end(); await targetSql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it(
    "keeps the newest backup for each retained calendar month",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("proprio-db-backup-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const janNewest = path.join(backupDir, "proprio-test-2026-01-28T12-00-00.sql.gz");
      const janOlder = path.join(backupDir, "proprio-test-2026-01-10T12-00-00.sql.gz");
      const decOld = path.join(backupDir, "proprio-test-2025-12-15T12-00-00.sql.gz");

      try {
        fs.writeFileSync(janNewest, "jan-newest");
        fs.writeFileSync(janOlder, "jan-older");
        fs.writeFileSync(decOld, "dec-old");

        fs.utimesSync(janNewest, new Date("2026-01-28T12:00:00Z"), new Date("2026-01-28T12:00:00Z"));
        fs.utimesSync(janOlder, new Date("2026-01-10T12:00:00Z"), new Date("2026-01-10T12:00:00Z"));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
          filenamePrefix: "proprio-test",
        });

        expect(result.prunedCount).toBe(2);
        expect(fs.existsSync(janNewest)).toBe(true);
        expect(fs.existsSync(janOlder)).toBe(false);
        expect(fs.existsSync(decOld)).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "proprio_restore_target",
      );
      const backupDir = createTempDir("proprio-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);
        await sourceSql.unsafe(`
          CREATE FUNCTION "public"."backup_test_mark_done"()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            NEW."state" := 'done';
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER "backup_test_mark_done_trigger"
          BEFORE UPDATE OF "title" ON "public"."backup_test_records"
          FOR EACH ROW
          EXECUTE FUNCTION "public"."backup_test_mark_done"();
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "proprio-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/proprio-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);

        await restoreSql.unsafe(`
          UPDATE "public"."backup_test_records"
          SET "title" = 'triggered'
          WHERE "title" = 'row-0'
        `);
        const triggeredRows = await restoreSql.unsafe<{ state: string }[]>(`
          SELECT "state"::text AS "state"
          FROM "public"."backup_test_records"
          WHERE "title" = 'triggered'
        `);
        expect(triggeredRows).toEqual([{ state: "done" }]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "proprio_full_logical_restore_target",
      );
      const backupDir = createTempDir("proprio-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('proprio-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "proprio-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'proprio-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "proprio-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "preserves composite foreign key column order without duplicate referenced columns",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "proprio_composite_fk_restore_target",
      );
      const backupDir = createTempDir("proprio-db-composite-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_composite_fk";
          CREATE TABLE "plugin_composite_fk"."content_cases" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            CONSTRAINT "content_cases_company_case_unique" UNIQUE ("company_id", "id")
          );
          CREATE TABLE "plugin_composite_fk"."content_case_signals" (
            "company_id" uuid NOT NULL,
            "case_id" uuid NOT NULL,
            "signal" text NOT NULL,
            "scopes" text[] NOT NULL,
            "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
            CONSTRAINT "content_case_signals_company_case"
              FOREIGN KEY ("company_id", "case_id")
              REFERENCES "plugin_composite_fk"."content_cases" ("company_id", "id")
              ON DELETE CASCADE
          );
          INSERT INTO "plugin_composite_fk"."content_cases" ("company_id", "id", "title")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'case'
          );
          INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes", "warnings")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'signal',
            ARRAY['upstream_import:preview', 'scope with space', 'quoted "scope"', 'NULL', 'null'],
            jsonb_build_array('json warning', jsonb_build_object('code', 'quoted "value"'))
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "proprio-composite-fk-test",
          backupEngine: "javascript",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{
          signal: string;
          title: string;
          scopes: string[];
          warnings: Array<string | { code: string }>;
        }[]>(`
          SELECT s."signal", c."title", s."scopes", s."warnings"
          FROM "plugin_composite_fk"."content_case_signals" s
          JOIN "plugin_composite_fk"."content_cases" c
            ON c."company_id" = s."company_id"
           AND c."id" = s."case_id"
        `);
        expect(rows).toEqual([
          {
            signal: "signal",
            title: "case",
            scopes: ["upstream_import:preview", "scope with space", 'quoted "scope"', "NULL", "null"],
            warnings: ["json warning", { code: 'quoted "value"' }],
          },
        ]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes")
            VALUES (
              '11111111-1111-4111-8111-111111111111',
              '33333333-3333-4333-8333-333333333333',
              'orphan',
              ARRAY[]::text[]
            )
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores fallback COPY data when child tables are dumped before parent tables",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "proprio_copy_fk_restore_target",
      );
      const backupDir = createTempDir("proprio-db-copy-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PROPRIO_PG_DUMP_PATH;
      const originalPsqlPath = process.env.PROPRIO_PSQL_PATH;
      process.env.PROPRIO_PG_DUMP_PATH = "/bin/false";
      process.env.PROPRIO_PSQL_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."zzz_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          CREATE TABLE "public"."aaa_child_records" (
            "id" uuid PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."zzz_parent_records"("id") ON DELETE CASCADE,
            "note" text NOT NULL
          );
          INSERT INTO "public"."zzz_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
          INSERT INTO "public"."aaa_child_records" ("id", "parent_id", "note")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            'child emitted before parent'
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "proprio-copy-fk-test",
          backupEngine: "auto",
        });

        const backupSql = gunzipSync(await fs.promises.readFile(result.backupFile)).toString("utf8");
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeGreaterThan(-1);
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeLessThan(
          backupSql.indexOf("-- Data for: public.zzz_parent_records"),
        );
        expect(backupSql).not.toContain(" FROM stdin;");

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ note: string; name: string }[]>(`
          SELECT child."note", parent."name"
          FROM "public"."aaa_child_records" child
          JOIN "public"."zzz_parent_records" parent ON parent."id" = child."parent_id"
        `);
        expect(rows).toEqual([{ note: "child emitted before parent", name: "parent" }]);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PROPRIO_PG_DUMP_PATH;
        } else {
          process.env.PROPRIO_PG_DUMP_PATH = originalPgDumpPath;
        }
        if (originalPsqlPath === undefined) {
          delete process.env.PROPRIO_PSQL_PATH;
        } else {
          process.env.PROPRIO_PSQL_PATH = originalPsqlPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it("preserves text line endings during JavaScript backup replay", async () => {
    const source = await createTempDatabase();
    const target = await createSiblingDatabase(source, "text_restore_target");
    const backupDir = createTempDir("proprio-restore-line-endings-");
    const sourceSql = postgres(source, { max: 1 });
    const targetSql = postgres(target, { max: 1 });

    try {
      const payload = "before\rafter\r\n雪\nend";
      const largePayload = "雪𐍈".repeat(20_000);
      await sourceSql`CREATE TABLE public.text_fixture (id int PRIMARY KEY, payload text NOT NULL)`;
      await sourceSql`INSERT INTO public.text_fixture VALUES (1, ${payload}), (2, ${largePayload})`;
      const { backupFile } = await runDatabaseBackup({
        connectionString: source,
        backupDir,
        backupEngine: "javascript",
        retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      });

      await restoreWithJavaScript(target, backupFile, backupDir);
      const rows = await targetSql<{ payload: string }[]>`SELECT payload FROM public.text_fixture ORDER BY id`;
      expect(rows[0]?.payload).toBe(payload);
      expect(rows[1]?.payload).toBe(largePayload);
    } finally {
      await sourceSql.end();
      await targetSql.end();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each([{ newline: "\n", label: "LF" }, { newline: "\r\n", label: "CRLF" }])(
    "restores legacy public-only $label backups without migration history",
    async ({ newline }) => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("proprio-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Proprio database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- proprio statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- proprio statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- proprio statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- proprio statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join(newline),
          "utf8",
        );

        await restoreWithJavaScript(restoreConnectionString, backupFile, backupDir);

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
});
