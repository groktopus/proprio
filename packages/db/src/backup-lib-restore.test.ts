import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { runDatabaseRestore } from "./backup-lib.js";

const fixtures = vi.hoisted(() => ({
  fail: new Map<string, number>(),
  reads: new Map<string, number>(),
  beforeFailure: new Map<string, () => Promise<void>>(),
  statements: vi.fn(),
  end: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    createReadStream(file: Parameters<typeof fs.createReadStream>[0], options?: Parameters<typeof fs.createReadStream>[1]) {
      if (typeof file === "string" && fixtures.fail.has(file)) {
        const after = fixtures.fail.get(file);
        const count = (fixtures.reads.get(file) ?? 0) + 1;
        fixtures.reads.set(file, count);
        if (count === after) {
          return Readable.from((async function* () {
            yield gzipSync("SELECT 1;\n");
            await fixtures.beforeFailure.get(file)?.();
            throw Object.assign(new Error("fixture source read failed"), { code: "EIO" });
          })());
        }
      }
      return fs.createReadStream(file, options);
    },
  };
});

vi.mock("postgres", () => ({
  default: () => Object.assign(async () => [], {
    unsafe: (statement: string) => ({ execute: () => fixtures.statements(statement) }),
    end: fixtures.end,
  }),
}));

const dirs: string[] = [];
const connectionString = "postgresql://fixture@127.0.0.1:1/fixture";
const source = new URL("./backup-lib.ts", import.meta.url).href;

function fixture(script: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "proprio-restore-stream-"));
  dirs.push(directory);
  const executable = path.join(directory, "psql");
  writeFileSync(executable, "#!/bin/sh\n" + script, { mode: 0o700 });
  vi.stubEnv("PROPRIO_PSQL_PATH", executable);
  return directory;
}

afterEach(() => {
  fixtures.fail.clear();
  fixtures.reads.clear();
  fixtures.beforeFailure.clear();
  fixtures.statements.mockClear();
  fixtures.end.mockClear();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")("rejects missing gzip input in a subprocess and reaps psql", () => {
  const directory = fixture('printf "%s" "$$" > "$RESTORE_FIXTURE_PID"\nexec cat >/dev/null\n');
  const pidPath = path.join(directory, "pid");
  const backupFile = path.join(directory, "missing.sql.gz");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
    import { runDatabaseRestore } from ${JSON.stringify(source)};
    try {
      await runDatabaseRestore(${JSON.stringify({ backupFile, connectionString })});
      process.exitCode = 2;
    } catch (error) {
      console.log(JSON.stringify({ message: error.message, code: error.code }));
    }
  `], { env: { ...process.env, RESTORE_FIXTURE_PID: pidPath }, encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ code: "ENOENT" });
  expect(result.stderr).not.toContain("Unhandled");
  if (existsSync(pidPath)) {
    const childPid = Number(readFileSync(pidPath, "utf8"));
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }
});

it.skipIf(process.platform === "win32").each(["sql", "sql.gz"])("streams valid %s inputs to psql", async extension => {
  const directory = fixture('cat > "$RESTORE_FIXTURE_OUTPUT"\n');
  const output = path.join(directory, "capture");
  vi.stubEnv("RESTORE_FIXTURE_OUTPUT", output);
  const backupFile = path.join(directory, `backup.${extension}`);
  const sql = "SELECT 'fixture';\n";
  writeFileSync(backupFile, extension.endsWith(".gz") ? gzipSync(sql) : sql);
  await runDatabaseRestore({ backupFile, connectionString });
  expect(readFileSync(output, "utf8")).toBe(sql);
});

it.skipIf(process.platform === "win32")("keeps the psql SQL error when psql closes stdin", async () => {
  const directory = fixture("printf 'ERROR: fixture SQL error\\n' >&2\nexit 4\n");
  const backupFile = path.join(directory, "backup.sql");
  writeFileSync(backupFile, "SELECT 1;\n".repeat(100_000));
  await expect(runDatabaseRestore({ backupFile, connectionString })).rejects.toThrow(/exit code 4.*fixture SQL error/);
  expect(fixtures.end).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32").each([1, 2, 3])("propagates gzip source failure on read %i", async read => {
  const directory = fixture("cat >/dev/null\nexit 4\n");
  const backupFile = path.join(directory, "backup.sql.gz");
  writeFileSync(backupFile, gzipSync("SELECT 1;\n-- proprio statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900\n"));
  fixtures.fail.set(backupFile, read);
  await expect(runDatabaseRestore({ backupFile, connectionString })).rejects.toThrow("fixture source read failed");
  expect(fixtures.reads.get(backupFile)).toBe(read);
  expect(fixtures.end).toHaveBeenCalledTimes(read === 3 ? 1 : 0);
});

it.skipIf(process.platform === "win32")("stops a running psql wrapper after a gzip read error", async () => {
  const directory = fixture('printf "%s" "$$" > "$RESTORE_FIXTURE_PID"\nexec sleep 30\n');
  const pidPath = path.join(directory, "pid");
  const backupFile = path.join(directory, "backup.sql.gz");
  vi.stubEnv("RESTORE_FIXTURE_PID", pidPath);
  fixtures.fail.set(backupFile, 1);
  fixtures.beforeFailure.set(backupFile, async () => {
    const deadline = Date.now() + 2_000;
    while (!existsSync(pidPath) && Date.now() < deadline) await delay(10);
  });

  try {
    await expect(runDatabaseRestore({ backupFile, connectionString })).rejects.toMatchObject({ code: "EIO" });
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  }
});
