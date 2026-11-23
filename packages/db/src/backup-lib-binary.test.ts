import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { runDatabaseBackup } from "./backup-lib.js";

const transport = vi.hoisted(() => ({ rows: [] as unknown[][], projection: "", end: vi.fn() }));
vi.mock("postgres", () => ({
  default: () => {
    const columns = [
      { column_name: "bytes", data_type: "bytea", udt_name: "bytea", udt_schema: "pg_catalog" },
      { column_name: "payloads", data_type: "ARRAY", udt_name: "_bytea", udt_schema: "pg_catalog" },
      { column_name: "metadata", data_type: "jsonb", udt_name: "jsonb", udt_schema: "pg_catalog" },
      { column_name: "redacted", data_type: "ARRAY", udt_name: "_bytea", udt_schema: "pg_catalog" },
    ];
    const sql = async (parts: TemplateStringsArray) => {
      const query = parts.join("?");
      if (query.includes("FROM information_schema.tables")) return [{ schema_name: "public", tablename: "binary_fixture" }];
      if (query.includes("FROM information_schema.columns")) return columns.map(column => ({ ...column, udt_schema: "pg_catalog", is_nullable: "YES", is_identity: "NO", column_default: null }));
      return [];
    };
    return Object.assign(sql, {
      begin: (_options: string, callback: (tx: typeof sql) => Promise<unknown>) => callback(sql),
      end: transport.end,
      unsafe: (query: string) => query.startsWith("SELECT count(*)") ? Promise.resolve([{ n: transport.rows.length }])
        : query.startsWith("SELECT ") && query.includes('FROM "public"."binary_fixture"')
          ? { values: () => ({ cursor: async function* () { transport.projection = query; yield transport.rows; } }) }
          : query,
    });
  },
}));

describe("JavaScript backup binary SQL", () => {
  it("writes exact binary scalars and nested arrays without changing JSON or redaction", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backup-binary-sql-"));
    const binary = Buffer.from([0, 255, ...Buffer.from("雪")]);
    const metadata = { bytes: binary, values: [null, "雪"] };
    const hex = binary.toString("hex");
    const payloads = `{"\\\\x${hex}","\\\\x",NULL}`;
    const boundedPayloads = `[0:1][3:4]={{"\\\\x${hex}",NULL},{"\\\\x","\\\\x00ff"}}`;
    transport.rows = [
      [binary, payloads, metadata, payloads],
      [new Uint8Array(), "{}", [], payloads],
      [null, null, null, payloads],
      [new Uint8Array([0, 255]), boundedPayloads, {}, boundedPayloads],
    ];
    transport.end.mockClear();
    try {
      const archive = await runDatabaseBackup({ connectionString: "postgres://unused/binary_test", backupDir: directory,
        backupEngine: "javascript", retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
        nullifyColumns: { binary_fixture: ["redacted"] } });
      const body = gunzipSync(await readFile(archive.backupFile)).toString("utf8");
      const inserts = body.split("\n").filter(line => line.startsWith("INSERT INTO"));
      const literal = (value: string) => `$proprio$${value}$proprio$`;
      const array = (value: string) => literal(value);
      const prefix = 'INSERT INTO "public"."binary_fixture" ("bytes", "payloads", "metadata", "redacted") VALUES ';
      expect(inserts).toEqual([
        `${prefix}(decode('${hex}', 'hex'), ${array(`{"\\\\x${hex}","\\\\x",NULL}`)}, ${literal(JSON.stringify(metadata))}, NULL);`,
        `${prefix}(decode('', 'hex'), ${array("{}")}, ${literal("[]")}, NULL);`,
        `${prefix}(NULL, NULL, NULL, NULL);`,
        `${prefix}(decode('00ff', 'hex'), ${array(boundedPayloads)}, ${literal("{}")}, NULL);`,
      ]);
      expect(transport.projection).toBe('SELECT "bytes", "payloads"::text AS "payloads", "metadata", "redacted"::text AS "redacted" FROM "public"."binary_fixture"');
      expect(transport.end).toHaveBeenCalledTimes(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reclaims aged orphan output while preserving a concurrent backup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backup-orphan-staging-"));
    const stem = "proprio-20260101-010203-9c7cfaa7-682c-4133-a2ef-0b916a37a793";
    const legacy = [`${stem}.sql.partial`, `${stem}.sql.gz.partial`];
    const recent = "proprio-20260101-010204-9c7cfaa7-682c-4133-a2ef-0b916a37a793.sql.partial";
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const options = { connectionString: "postgres://unused/binary_test", backupDir: directory,
      backupEngine: "javascript" as const, retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 } };
    const ready = Promise.withResolvers<string>();
    const verification = Promise.withResolvers<void>();
    let running: ReturnType<typeof runDatabaseBackup> | undefined;
    try {
      for (const name of [...legacy, recent]) await writeFile(path.join(directory, name), "incomplete backup");
      for (const name of legacy) await utimes(path.join(directory, name), old, old);

      running = runDatabaseBackup({ ...options, verifyBeforePrune: async (stagingFile) => {
        await utimes(stagingFile, old, old);
        ready.resolve(stagingFile);
        return verification.promise;
      } });
      void running.catch(ready.reject);
      const active = await ready.promise;
      const second = await runDatabaseBackup(options);

      const names = await readdir(directory);
      expect(names).toContain(path.basename(active));
      expect(names).toContain(path.basename(second.backupFile));
      expect(names).toContain(recent);
      for (const name of legacy) expect(names).not.toContain(name);
      verification.resolve();
      const first = await running;
      expect(first.backupFile).not.toBe(second.backupFile);
      expect(await readdir(directory)).toEqual(expect.arrayContaining([
        path.basename(first.backupFile), path.basename(second.backupFile),
      ]));
    } finally {
      verification.resolve();
      await running?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves aged staging owned by a different live process and reclaims it after exit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backup-live-owner-"));
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = once(owner, "exit");
    try {
      await once(owner, "spawn");
      const machine = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
      const filename = `proprio-20260101-010203-9c7cfaa7-682c-4133-a2ef-0b916a37a793.owner-${machine}-${owner.pid}.sql.gz.partial`;
      const file = path.join(directory, filename);
      await writeFile(file, "incomplete backup");
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(file, old, old);
      const options = { connectionString: "postgres://unused/binary_test", backupDir: directory,
        backupEngine: "javascript" as const, retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 } };
      await runDatabaseBackup(options);
      expect(await readdir(directory)).toContain(filename);
      owner.kill();
      await exited;
      await runDatabaseBackup(options);
      expect(await readdir(directory)).not.toContain(filename);
    } finally {
      if (!owner.killed) owner.kill();
      await exited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
