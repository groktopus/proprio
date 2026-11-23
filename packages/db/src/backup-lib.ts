import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

export type BackupRetentionPolicy = {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
};

export type RunDatabaseBackupOptions = {
  connectionString: string;
  backupDir: string;
  retention: BackupRetentionPolicy;
  filenamePrefix?: string;
  connectTimeoutSeconds?: number;
  /**
   * @deprecated Migration-journal schemas are included with the normal backup
   * scope. This option is kept for compatibility and no longer changes backup
   * engine selection.
   */
  includeMigrationJournal?: boolean;
  excludeTables?: string[];
  nullifyColumns?: Record<string, string[]>;
  backupEngine?: "auto" | "pg_dump" | "javascript";
  signal?: AbortSignal;
  /** Check the staged archive before publication. A rejection preserves history. */
  verifyBeforePrune?: (backupFile: string) => Promise<void>;
};

export type RunDatabaseBackupResult = {
  backupFile: string;
  sizeBytes: number;
  prunedCount: number;
  /** Engine that actually produced the successful archive, never the requested "auto" mode. */
  engine: "pg_dump" | "javascript";
  /** Fixed category only, not a command's raw error or output. */
  fallbackReason: "pg_dump_failed" | null;
};

export type RunDatabaseRestoreOptions = {
  connectionString: string;
  backupFile: string;
  connectTimeoutSeconds?: number;
};

type SequenceDefinition = {
  is_identity: boolean;
  sequence_schema: string;
  sequence_name: string;
  data_type: string;
  start_value: string;
  minimum_value: string;
  maximum_value: string;
  increment: string;
  cycle_option: "YES" | "NO";
  owner_schema: string | null;
  owner_table: string | null;
  owner_column: string | null;
};

type TableDefinition = {
  schema_name: string;
  tablename: string;
};

type ExtensionDefinition = {
  extension_name: string;
  schema_name: string;
};

const DEFAULT_BACKUP_WRITE_BUFFER_BYTES = 1024 * 1024;
const BACKUP_DATA_CURSOR_ROWS = 100;
const BACKUP_CLI_STDERR_BYTES = 64 * 1024;
const BACKUP_BREAKPOINT_DETECT_BYTES = 64 * 1024;
const PG_DUMP_FALLBACK_WARNING = "The pg_dump backup path failed; the JavaScript fallback may not preserve all PostgreSQL features.";

const STATEMENT_BREAKPOINT = "-- proprio statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

function sanitizeRestoreErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const firstLine = typeof record.message === "string"
      ? record.message.split(/\r?\n/, 1)[0]?.trim()
      : "";
    const detail = typeof record.detail === "string" ? record.detail.trim() : "";
    const severity = typeof record.severity === "string" ? record.severity.trim() : "";
    const message = firstLine || detail || (error instanceof Error ? error.message : String(error));
    return severity ? `${severity}: ${message}` : message;
  }
  return error instanceof Error ? error.message : String(error);
}

function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * ISO week key for grouping backups by calendar week (ISO 8601).
 */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthlyRetentionCutoff(nowMs: number, monthlyMonths: number): number {
  const months = Math.max(1, monthlyMonths);
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1);
}

/**
 * Tiered backup pruning:
 * - Daily tier: keep ALL backups from the last `dailyDays` days
 * - Weekly tier: keep the NEWEST backup per calendar week for `weeklyWeeks` weeks
 * - Monthly tier: keep the NEWEST backup per calendar month for `monthlyMonths` months
 * - Everything else is deleted
 */
function pruneOldBackups(backupDir: string, retention: BackupRetentionPolicy, filenamePrefix: string): number {
  if (!existsSync(backupDir)) return 0;

  const now = Date.now();
  const dailyCutoff = now - Math.max(1, retention.dailyDays) * 24 * 60 * 60 * 1000;
  const weeklyCutoff = now - Math.max(1, retention.weeklyWeeks) * 7 * 24 * 60 * 60 * 1000;
  const monthlyCutoff = monthlyRetentionCutoff(now, retention.monthlyMonths);

  type BackupEntry = { name: string; fullPath: string; mtimeMs: number };
  const entries: BackupEntry[] = [];

  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`)) continue;
    if (!name.endsWith(".sql") && !name.endsWith(".sql.gz")) continue;
    const fullPath = resolve(backupDir, name);
    const stat = statSync(fullPath);
    entries.push({ name, fullPath, mtimeMs: stat.mtimeMs });
  }

  // Sort newest first so the first entry per week/month bucket is the one we keep
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const keepWeekBuckets = new Set<string>();
  const keepMonthBuckets = new Set<string>();
  const toDelete: string[] = [];

  for (const entry of entries) {
    // Daily tier — keep everything within dailyDays
    if (entry.mtimeMs >= dailyCutoff) continue;

    const date = new Date(entry.mtimeMs);
    const week = isoWeekKey(date);
    const month = monthKey(date);

    // Weekly tier — keep newest per calendar week
    if (entry.mtimeMs >= weeklyCutoff) {
      if (keepWeekBuckets.has(week)) {
        toDelete.push(entry.fullPath);
      } else {
        keepWeekBuckets.add(week);
      }
      continue;
    }

    // Monthly tier — keep newest per calendar month
    if (entry.mtimeMs >= monthlyCutoff) {
      if (keepMonthBuckets.has(month)) {
        toDelete.push(entry.fullPath);
      } else {
        keepMonthBuckets.add(month);
      }
      continue;
    }

    // Beyond all retention tiers — delete
    toDelete.push(entry.fullPath);
  }

  for (const filePath of toDelete) {
    unlinkSync(filePath);
  }

  return toDelete.length;
}

function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}K`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatSqlLiteral(value: string): string {
  const sanitized = value.replace(/\u0000/g, "");
  let tag = "$proprio$";
  while (sanitized.includes(tag)) {
    tag = `$proprio_${Math.random().toString(36).slice(2, 8)}$`;
  }
  return `${tag}${sanitized}${tag}`;
}

function normalizeTableNameSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map(normalizeTableSelector)
      .filter((value) => value.length > 0),
  );
}

function normalizeTableSelector(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.includes(".") ? trimmed : tableKey("public", trimmed);
}

function normalizeNullifyColumnMap(values: Record<string, string[]> | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!values) return out;
  for (const [tableName, columns] of Object.entries(values)) {
    const normalizedTable = normalizeTableSelector(tableName);
    if (normalizedTable.length === 0) continue;
    const normalizedColumns = new Set(
      columns
        .map((column) => column.trim())
        .filter((column) => column.length > 0),
    );
    if (normalizedColumns.size > 0) {
      out.set(normalizedTable, normalizedColumns);
    }
  }
  return out;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteQualifiedName(schemaName: string, objectName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function tableKey(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

function nonSystemSchemaPredicate(identifier: string): string {
  // PostgreSQL reserves pg_ prefixes for system schemas, including temp/toast variants.
  return `${identifier} <> 'information_schema'
    AND ${identifier} NOT LIKE 'pg\\_%' ESCAPE '\\'`;
}

function hasBackupTransforms(opts: RunDatabaseBackupOptions): boolean {
  return (opts.excludeTables?.length ?? 0) > 0 ||
    Object.keys(opts.nullifyColumns ?? {}).length > 0;
}

function formatPostgresArrayElement(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) return formatPostgresArrayLiteral(value);
  const raw = value instanceof Date
    ? value.toISOString()
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  if (raw.length === 0 || /^null$/i.test(raw) || /[{}\s,"\\]/.test(raw)) {
    return `"${raw.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return raw;
}

function formatPostgresArrayLiteral(value: unknown[]): string {
  return `{${value.map(formatPostgresArrayElement).join(",")}}`;
}

function formatSqlValue(
  rawValue: unknown,
  columnName: string | undefined,
  nullifiedColumns: Set<string>,
  dataType?: string,
): string {
  const val = columnName && nullifiedColumns.has(columnName) ? null : rawValue;
  if (val === null || val === undefined) return "NULL";
  if (dataType === "json" || dataType === "jsonb") {
    return formatSqlLiteral(JSON.stringify(val));
  }
  if (dataType === "bytea" && val instanceof Uint8Array) {
    return `decode('${Buffer.from(val).toString("hex")}', 'hex')`;
  }
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (val instanceof Date) return formatSqlLiteral(val.toISOString());
  if (Array.isArray(val)) return formatSqlLiteral(formatPostgresArrayLiteral(val));
  if (typeof val === "object") return formatSqlLiteral(JSON.stringify(val));
  return formatSqlLiteral(String(val));
}

function appendCapturedStderr(previous: string, chunk: Buffer | string): string {
  const next = previous + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  if (Buffer.byteLength(next, "utf8") <= BACKUP_CLI_STDERR_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-BACKUP_CLI_STDERR_BYTES).toString("utf8");
}

async function waitForChildExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapturedStderr(stderr, chunk);
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  if (result.signal) {
    throw new Error(`${label} exited via ${result.signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
}

async function terminateBackupChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>(done => {
      const taskkill = resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      execFile(taskkill, ["/pid", String(child.pid), "/t", "/f"], { timeout: 2_000, windowsHide: true }, error => {
        if (error) child.kill("SIGKILL");
        done();
      });
    });
    return;
  }
  // Include children of an operator-supplied wrapper that share its pipes.
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
  }
}

async function runPgDumpBackup(opts: {
  connectionString: string;
  backupFile: string;
  connectTimeout: number;
  signal?: AbortSignal;
}): Promise<void> {
  opts.signal?.throwIfAborted();
  const pgDumpBin = process.env.PROPRIO_PG_DUMP_PATH || "pg_dump";
  const child = spawn(
    pgDumpBin,
    [
      `--dbname=${opts.connectionString}`,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(opts.connectTimeout),
      },
    },
  );

  if (!child.stdout) {
    throw new Error("pg_dump did not expose stdout");
  }

  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let termination: Promise<void> | undefined;
  const stopChild = () => {
    termination ??= terminateBackupChild(child);
  };
  const streamCancellation = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, streamCancellation.signal])
    : streamCancellation.signal;
  opts.signal?.addEventListener("abort", stopChild, { once: true });
  const stages = [
    waitForChildExit(child, pgDumpBin),
    pipeline(child.stdout, createGzip(), createWriteStream(opts.backupFile), { signal }),
  ];
  try {
    await Promise.all(stages);
  } catch (error) {
    stopChild();
    streamCancellation.abort();
    await Promise.allSettled(stages);
    opts.signal?.throwIfAborted();
    throw error;
  } finally {
    await termination;
    await closed;
    opts.signal?.removeEventListener("abort", stopChild);
  }
}

function openRestoreInput(backupFile: string) {
  const raw = createReadStream(backupFile);
  return backupFile.endsWith(".gz") ? raw.compose(createGunzip()) : raw;
}

class RestoreInputError extends Error {}

async function restoreWithPsql(opts: RunDatabaseRestoreOptions, connectTimeout: number): Promise<void> {
  const psqlBin = process.env.PROPRIO_PSQL_PATH || "psql";
  const child = spawn(
    psqlBin,
    [
      `--dbname=${opts.connectionString}`,
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--no-psqlrc",
    ],
    {
      stdio: ["pipe", "ignore", "pipe"],
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(connectTimeout),
      },
    },
  );

  if (!child.stdin) {
    throw new Error("psql did not expose stdin");
  }

  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const processExit = waitForChildExit(child, psqlBin);
  const input = pipeline(openRestoreInput(opts.backupFile), child.stdin).catch(async (error: NodeJS.ErrnoException) => {
    // psql can close stdin on a SQL error. Keep its stderr and exit status.
    if (error.code === "EPIPE" || error.code === "ERR_STREAM_PREMATURE_CLOSE" || error.code === "ERR_STREAM_DESTROYED") {
      throw error;
    }
    await terminateBackupChild(child);
    throw new RestoreInputError("Failed to read the restore input", { cause: error });
  });
  const [processResult, streamResult] = await Promise.allSettled([processExit, input, closed]);

  if (streamResult.status === "rejected" && streamResult.reason instanceof RestoreInputError) throw streamResult.reason;
  if (processResult.status === "rejected") throw processResult.reason;
  if (streamResult.status === "rejected") throw streamResult.reason;
}

async function hasStatementBreakpoints(backupFile: string): Promise<boolean> {
  const stream = openRestoreInput(backupFile);
  let text = "";

  try {
    for await (const chunk of stream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(STATEMENT_BREAKPOINT)) return true;
      if (Buffer.byteLength(text, "utf8") >= BACKUP_BREAKPOINT_DETECT_BYTES) return false;
    }
    return text.includes(STATEMENT_BREAKPOINT);
  } finally {
    stream.destroy();
  }
}

async function* readRestoreStatements(backupFile: string): AsyncGenerator<string> {
  const stream = openRestoreInput(backupFile);
  stream.setEncoding("utf8");
  const isBreakpoint = (line: string) => line === STATEMENT_BREAKPOINT || line === `${STATEMENT_BREAKPOINT}\r`;
  let lineFragments: string[] = [];
  let statementParts: string[] = [];

  const flushStatement = () => {
    const statement = statementParts.join("").trim();
    statementParts = [];
    return statement;
  };

  try {
    // LF frames the backup; a legacy CRLF breakpoint is also accepted.
    // Preserve all other line endings, which may be part of a SQL literal.
    for await (const chunk of stream) {
      let offset = 0;
      for (let newline = chunk.indexOf("\n"); newline !== -1; newline = chunk.indexOf("\n", offset)) {
        const part = chunk.slice(offset, newline);
        offset = newline + 1;
        const line = lineFragments.length > 0 ? [...lineFragments, part].join("") : part;
        lineFragments = [];
        if (isBreakpoint(line)) {
          const statement = flushStatement();
          if (statement.length > 0) yield statement;
        } else {
          statementParts.push(line, "\n");
        }
      }
      if (offset < chunk.length) lineFragments.push(chunk.slice(offset));
    }

    const lastLine = lineFragments.join("");
    if (!isBreakpoint(lastLine)) statementParts.push(lastLine);
    const trailingStatement = flushStatement();
    if (trailingStatement.length > 0) yield trailingStatement;
  } finally {
    stream.destroy();
  }
}

export function createBufferedTextFileWriter(filePath: string, maxBufferedBytes = DEFAULT_BACKUP_WRITE_BUFFER_BYTES) {
  const filePromise = openFile(filePath, "w");
  const flushThreshold = Math.max(1, Math.trunc(maxBufferedBytes));
  let bufferedLines: string[] = [];
  let bufferedBytes = 0;
  let firstChunk = true;
  let closed = false;
  let pendingWrite = Promise.resolve();

  const writeChunk = async (chunk: string | Buffer): Promise<void> => {
    const file = await filePromise;
    if (typeof chunk === "string") {
      await file.write(chunk, null, "utf8");
    } else {
      await file.write(chunk);
    }
  };

  const flushBufferedLines = () => {
    if (bufferedLines.length === 0) return;
    const linesToWrite = bufferedLines;
    bufferedLines = [];
    bufferedBytes = 0;
    const chunkBody = linesToWrite.join("\n");
    const chunk = firstChunk ? chunkBody : `\n${chunkBody}`;
    firstChunk = false;
    pendingWrite = pendingWrite.then(() => writeChunk(chunk));
  };

  return {
    emit(line: string) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      bufferedLines.push(line);
      bufferedBytes += Buffer.byteLength(line, "utf8") + 1;
      if (bufferedBytes >= flushThreshold) {
        flushBufferedLines();
      }
    },
    async drain() {
      if (closed) {
        throw new Error(`Cannot drain closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      await pendingWrite;
    },
    async writeRaw(chunk: string | Buffer) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      firstChunk = false;
      pendingWrite = pendingWrite.then(() => writeChunk(chunk));
      await pendingWrite;
    },
    async close() {
      if (closed) return;
      closed = true;
      flushBufferedLines();
      await pendingWrite;
      const file = await filePromise;
      await file.close();
    },
    async abort() {
      if (closed) return;
      closed = true;
      bufferedLines = [];
      bufferedBytes = 0;
      await pendingWrite.catch(() => {});
      await filePromise.then((file) => file.close()).catch(() => {});
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // Preserve the original backup failure if temporary file cleanup also fails.
        }
      }
    },
  };
}

export async function runDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RunDatabaseBackupResult> {
  const { signal } = opts;
  signal?.throwIfAborted();
  const filenamePrefix = opts.filenamePrefix ?? "proprio";
  const retention = opts.retention;
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  const backupEngine = opts.backupEngine ?? "auto";
  let effectiveBackupEngine = backupEngine;
  const canUsePgDump = !hasBackupTransforms(opts);
  const excludedTableNames = normalizeTableNameSet(opts.excludeTables);
  const nullifiedColumnsByTable = normalizeNullifyColumnMap(opts.nullifyColumns);
  let sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
  let sqlClosing: Promise<void> | undefined;
  const closeSql = () => sqlClosing ??= Promise.resolve(sql.end({ timeout: signal?.aborted ? 0 : 1 }));
  const abortSql = () => { void closeSql().catch(() => {}); };

  mkdirSync(opts.backupDir, { recursive: true });
  // Keep partial output out of health checks and retention. Concurrent
  // one-off and server-owned jobs also get a separate final archive name.
  const fileStem = resolve(opts.backupDir, `${filenamePrefix}-${timestamp()}-${randomUUID()}`);
  const sqlFile = `${fileStem}.sql.partial`;
  const stagedArchive = `${fileStem}.sql.gz.partial`;
  const backupFile = `${fileStem}.sql.gz`;
  const writer = createBufferedTextFileWriter(sqlFile);

  async function publish(engine: RunDatabaseBackupResult["engine"], fallbackReason: RunDatabaseBackupResult["fallbackReason"]) {
    const sizeBytes = statSync(stagedArchive).size;
    await opts.verifyBeforePrune?.(stagedArchive);
    signal?.throwIfAborted();
    renameSync(stagedArchive, backupFile);
    try {
      if (opts.verifyBeforePrune) {
        // The verification fsync covered the staged bytes. Persist their final name.
        const directory = await openFile(opts.backupDir, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      signal?.throwIfAborted();
    } catch (error) {
      try { unlinkSync(backupFile); } catch { /* keep the publication error */ }
      throw error;
    }
    const prunedCount = pruneOldBackups(opts.backupDir, retention, filenamePrefix);
    return { backupFile, sizeBytes, prunedCount, engine, fallbackReason };
  }

  signal?.addEventListener("abort", abortSql, { once: true });

  try {
    if (backupEngine === "pg_dump" || (backupEngine === "auto" && canUsePgDump)) {
      await sql`SELECT 1`;
      let dumped = false;
      try {
        await closeSql();
        await runPgDumpBackup({
          connectionString: opts.connectionString,
          backupFile: stagedArchive,
          connectTimeout,
          signal,
        });
        dumped = true;
      } catch (error) {
        signal?.throwIfAborted();
        if (existsSync(stagedArchive)) unlinkSync(stagedArchive);
        if (backupEngine === "pg_dump") {
          throw error;
        }
        effectiveBackupEngine = "javascript";
        sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        sqlClosing = undefined;
      }
      if (dumped) {
        // Only an engine failure can select the JavaScript fallback. Once
        // pg_dump succeeds, archive verification or persistence failures
        // must retain their original error and must not reuse a closed writer.
        await writer.abort();
        return await publish("pg_dump", null);
      }
    }

    await sql.begin("isolation level repeatable read read only", async (sql) => {
    await sql`SET LOCAL standard_conforming_strings = on`;
    const [sourceSettings] = await sql<{ search_path: string; schemas: string[] }[]>`
      SELECT current_setting('search_path') AS search_path, current_schemas(true) AS schemas
    `;
    const sourceSchemas = sourceSettings?.schemas ?? ["pg_catalog", "public"];
    const sourceSearchPath = sourceSchemas.map(quoteIdentifier).join(", ");

    const emit = (line: string) => writer.emit(line);
    const emitStatement = (statement: string) => {
      emit(statement);
      emit(STATEMENT_BREAKPOINT);
    };
    const emitStatementBoundary = () => {
      emit(STATEMENT_BREAKPOINT);
    };

    emit("-- Proprio database backup");
    emit(`-- Created: ${new Date().toISOString()}`);
    emit("");
    emitStatement("BEGIN;");
    emitStatement("SET LOCAL session_replication_role = replica;");
    emitStatement("SET LOCAL client_min_messages = warning;");
    emitStatement("SET LOCAL check_function_bodies = false;");
    emitStatement("SET LOCAL standard_conforming_strings = on;");
    emit("");

    const allTables = await sql<TableDefinition[]>`
      SELECT table_schema AS schema_name, table_name AS tablename
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND ${sql.unsafe(nonSystemSchemaPredicate("table_schema"))}
      ORDER BY table_schema, table_name
    `;
    // Keep catalog definitions stable while rows are streamed. Row updates
    // remain allowed and the repeatable-read snapshot supplies their old state.
    if (allTables.length > 0) await sql.unsafe(`LOCK TABLE ${allTables.map(table =>
      quoteQualifiedName(table.schema_name, table.tablename)).join(", ")} IN ACCESS SHARE MODE`);
    const tables = allTables;
    const includedTableNames = new Set(tables.map(({ schema_name, tablename }) => tableKey(schema_name, tablename)));
    const includedSchemas = new Set(tables.map(({ schema_name }) => schema_name));

    // Get all enums
    const enums = await sql<{ schema_name: string; typname: string; labels: string[] }[]>`
      SELECT n.nspname AS schema_name, t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      GROUP BY n.nspname, t.typname
      ORDER BY n.nspname, t.typname
    `;
    for (const e of enums) includedSchemas.add(e.schema_name);

    const allSequences = await sql<SequenceDefinition[]>`
      SELECT
        false AS is_identity,
        s.sequence_schema,
        s.sequence_name,
        s.data_type,
        s.start_value,
        s.minimum_value,
        s.maximum_value,
        s.increment,
        s.cycle_option,
        tblns.nspname AS owner_schema,
        tbl.relname AS owner_table,
        attr.attname AS owner_column
      FROM information_schema.sequences s
      JOIN pg_class seq ON seq.relname = s.sequence_name
      JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = s.sequence_schema
      LEFT JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a'
      LEFT JOIN pg_class tbl ON tbl.oid = dep.refobjid
      LEFT JOIN pg_namespace tblns ON tblns.oid = tbl.relnamespace
      LEFT JOIN pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = dep.refobjsubid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("s.sequence_schema"))}
      ORDER BY s.sequence_schema, s.sequence_name
    `;
    const identitySequences = await sql<SequenceDefinition[]>`
      SELECT true AS is_identity, n.nspname AS sequence_schema, seq.relname AS sequence_name,
             format_type(options.seqtypid, NULL) AS data_type,
             options.seqstart::text AS start_value, options.seqmin::text AS minimum_value,
             options.seqmax::text AS maximum_value, options.seqincrement::text AS increment,
             CASE WHEN options.seqcycle THEN 'YES' ELSE 'NO' END AS cycle_option,
             owner_namespace.nspname AS owner_schema, owner.relname AS owner_table,
             attribute.attname AS owner_column
      FROM pg_sequence options
      JOIN pg_class seq ON seq.oid = options.seqrelid
      JOIN pg_namespace n ON n.oid = seq.relnamespace
      JOIN pg_depend dependency ON dependency.objid = seq.oid AND dependency.deptype = 'i'
        AND dependency.classid = 'pg_class'::regclass AND dependency.refclassid = 'pg_class'::regclass
      JOIN pg_class owner ON owner.oid = dependency.refobjid
      JOIN pg_namespace owner_namespace ON owner_namespace.oid = owner.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid = owner.oid AND attribute.attnum = dependency.refobjsubid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, seq.relname
    `;
    const sequences = [...allSequences, ...identitySequences].filter(
      (seq) => !seq.owner_table || includedTableNames.has(tableKey(seq.owner_schema ?? "public", seq.owner_table)),
    );

    const schemas = new Set<string>(includedSchemas);
    for (const seq of sequences) schemas.add(seq.sequence_schema);
    const extraSchemas = [...schemas].filter((schemaName) => schemaName !== "public");
    if (extraSchemas.length > 0) {
      emit("-- Schemas");
      for (const schemaName of extraSchemas) {
        emitStatement(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)};`);
      }
      emit("");
    }

    for (const e of enums) {
      const labels = e.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ");
      emitStatement(`CREATE TYPE ${quoteQualifiedName(e.schema_name, e.typname)} AS ENUM (${labels});`);
    }
    if (enums.length > 0) emit("");

    const extensions = await sql<ExtensionDefinition[]>`
      SELECT
        e.extname AS extension_name,
        n.nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname <> 'plpgsql'
      ORDER BY e.extname
    `;
    if (extensions.length > 0) {
      emit("-- Extensions");
      for (const extension of extensions) {
        emitStatement(
          `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.extension_name)} WITH SCHEMA ${quoteIdentifier(extension.schema_name)};`,
        );
      }
      emit("");
    }

    if (sequences.length > 0) {
      emit("-- Sequences");
      for (const seq of sequences.filter(seq => !seq.is_identity)) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        emitStatement(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName} CASCADE;`);
        emitStatement(
          `CREATE SEQUENCE ${qualifiedSequenceName} AS ${seq.data_type} INCREMENT BY ${seq.increment} MINVALUE ${seq.minimum_value} MAXVALUE ${seq.maximum_value} START WITH ${seq.start_value}${seq.cycle_option === "YES" ? " CYCLE" : " NO CYCLE"};`,
        );
      }
      emit("");
    }

    // Get full CREATE TABLE DDL via column info
    for (const { schema_name, tablename } of tables) {
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const columns = await sql<{
        column_name: string;
        data_type: string;
        udt_schema: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        is_identity: string;
        identity_generation: "ALWAYS" | "BY DEFAULT" | null;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }[]>`
        SELECT column_name, data_type, udt_schema, udt_name, is_nullable, column_default, is_identity, identity_generation,
               character_maximum_length, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = ${schema_name} AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;

      emit(`-- Table: ${schema_name}.${tablename}`);
      emitStatement(`DROP TABLE IF EXISTS ${qualifiedTableName} CASCADE;`);

      const colDefs: string[] = [];
      for (const col of columns) {
        let typeStr: string;
        if (col.data_type === "USER-DEFINED") {
          typeStr = quoteQualifiedName(col.udt_schema, col.udt_name);
        } else if (col.data_type === "ARRAY") {
          const elementType = col.udt_name.replace(/^_/, "");
          typeStr = col.udt_schema === "pg_catalog"
            ? `${elementType}[]`
            : `${quoteQualifiedName(col.udt_schema, elementType)}[]`;
        } else if (col.data_type === "character varying") {
          typeStr = col.character_maximum_length
            ? `varchar(${col.character_maximum_length})`
            : "varchar";
        } else if (col.data_type === "numeric" && col.numeric_precision != null) {
          typeStr =
            col.numeric_scale != null
              ? `numeric(${col.numeric_precision}, ${col.numeric_scale})`
              : `numeric(${col.numeric_precision})`;
        } else {
          typeStr = col.data_type;
        }

        let def = `  "${col.column_name}" ${typeStr}`;
        if (col.is_identity === "YES") {
          const sequence = sequences.find(seq => seq.is_identity && seq.owner_schema === schema_name
            && seq.owner_table === tablename && seq.owner_column === col.column_name);
          if (!sequence || !col.identity_generation) throw new Error(`Missing identity sequence for ${schema_name}.${tablename}.${col.column_name}`);
          def += ` GENERATED ${col.identity_generation} AS IDENTITY (SEQUENCE NAME ${quoteQualifiedName(sequence.sequence_schema, sequence.sequence_name)} START WITH ${sequence.start_value} INCREMENT BY ${sequence.increment} MINVALUE ${sequence.minimum_value} MAXVALUE ${sequence.maximum_value} ${sequence.cycle_option === "YES" ? "CYCLE" : "NO CYCLE"})`;
        } else if (col.column_default != null) def += ` DEFAULT ${col.column_default}`;
        if (col.is_nullable === "NO") def += " NOT NULL";
        colDefs.push(def);
      }

      // Primary key
      const pk = await sql<{ constraint_name: string; column_names: string[] }[]>`
        SELECT c.conname AS constraint_name,
               array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS column_names
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE n.nspname = ${schema_name} AND t.relname = ${tablename} AND c.contype = 'p'
        GROUP BY c.conname
      `;
      for (const p of pk) {
        const cols = p.column_names.map((c) => `"${c}"`).join(", ");
        colDefs.push(`  CONSTRAINT "${p.constraint_name}" PRIMARY KEY (${cols})`);
      }

      emit(`CREATE TABLE ${qualifiedTableName} (`);
      emit(colDefs.join(",\n"));
      emit(");");
      emitStatementBoundary();
      emit("");
    }

    const ownedSequences = sequences.filter((seq) => !seq.is_identity && seq.owner_table && seq.owner_column);
    if (ownedSequences.length > 0) {
      emit("-- Sequence ownership");
      for (const seq of ownedSequences) {
        emitStatement(
          `ALTER SEQUENCE ${quoteQualifiedName(seq.sequence_schema, seq.sequence_name)} OWNED BY ${quoteQualifiedName(seq.owner_schema ?? "public", seq.owner_table!)}.${quoteIdentifier(seq.owner_column!)};`,
        );
      }
      emit("");
    }

    // Unique constraints must exist before foreign keys that reference them.
    const allUniqueConstraints = await sql<{
      constraint_name: string;
      schema_name: string;
      tablename: string;
      definition: string;
      columns: string[];
    }[]>`
      SELECT c.conname AS constraint_name,
             n.nspname AS schema_name,
             t.relname AS tablename,
             pg_get_constraintdef(c.oid) AS definition,
             ARRAY(SELECT a.attname FROM unnest(c.conkey) AS k(attnum)
               JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS columns
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'u'
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, t.relname, c.conname
    `;
    const uniques = allUniqueConstraints.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));

    if (uniques.length > 0) {
      emit("-- Unique constraints");
      for (const u of uniques) {
        emitStatement(`ALTER TABLE ${quoteQualifiedName(u.schema_name, u.tablename)} ADD CONSTRAINT ${quoteIdentifier(u.constraint_name)} ${u.definition};`);
      }
      emit("");
    }

    // Collect foreign keys now. Emit them after routines and standalone indexes
    // because PostgreSQL permits a non-constraint unique index to be the target
    // of a foreign key.
    const allForeignKeys = await sql<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      source_columns: string[];
      target_schema: string;
      target_table: string;
      target_columns: string[];
      update_rule: string;
      delete_rule: string;
    }[]>`
      SELECT
        c.conname AS constraint_name,
        srcn.nspname AS source_schema,
        src.relname AS source_table,
        array_agg(sa.attname ORDER BY key_columns.ordinal_position) AS source_columns,
        tgtn.nspname AS target_schema,
        tgt.relname AS target_table,
        array_agg(ta.attname ORDER BY key_columns.ordinal_position) AS target_columns,
        CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS update_rule,
        CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = c.confrelid
      JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
      JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS key_columns(source_attnum, target_attnum, ordinal_position) ON true
      JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = key_columns.source_attnum
      JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = key_columns.target_attnum
      WHERE c.contype = 'f'
        AND ${sql.unsafe(nonSystemSchemaPredicate("srcn.nspname"))}
      GROUP BY c.conname, srcn.nspname, src.relname, tgtn.nspname, tgt.relname, c.confupdtype, c.confdeltype
      ORDER BY srcn.nspname, src.relname, c.conname
    `;
    const fks = allForeignKeys.filter(
      (fk) => includedTableNames.has(tableKey(fk.source_schema, fk.source_table))
        && includedTableNames.has(tableKey(fk.target_schema, fk.target_table)),
    );

    // JavaScript backups are used when a worktree seed filters or transforms
    // table data. Preserve user-defined routines before indexes because an
    // expression index may depend on a user-defined function.
    await sql`SET LOCAL search_path = pg_catalog`;
    const routines = await sql<{ definition: string; identity: string; kind: string; has_search_path: boolean }[]>`
      SELECT pg_get_functiondef(p.oid) AS definition,
        quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS identity,
        CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind,
        EXISTS (SELECT 1 FROM unnest(p.proconfig) AS setting WHERE setting LIKE 'search_path=%') AS has_search_path
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (
          SELECT 1
          FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
        )
      ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
    `;
    await sql`SELECT set_config('search_path', ${sourceSettings?.search_path ?? '"$user", public'}, true)`;
    if (routines.length > 0) {
      emit("-- Functions and procedures");
      for (const routine of routines) {
        const definition = routine.definition.trimEnd();
        emitStatement(definition.endsWith(";") ? definition : `${definition};`);
        if (!routine.has_search_path) emitStatement(
          `ALTER ${routine.kind} ${routine.identity} SET search_path TO ${sourceSearchPath};`,
        );
      }
      emit("");
    }

    // Indexes (non-primary, non-unique-constraint)
    const allIndexes = await sql<{ schema_name: string; tablename: string; indexdef: string }[]>`
      SELECT schemaname AS schema_name, tablename, indexdef
      FROM pg_indexes
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("schemaname"))}
        AND indexname NOT IN (
          SELECT conname FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = pg_indexes.schemaname
        )
      ORDER BY schemaname, tablename, indexname
    `;
    const indexes = allIndexes.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));

    if (indexes.length > 0) {
      emit("-- Indexes");
      for (const idx of indexes) {
        emitStatement(`${idx.indexdef};`);
      }
      emit("");
    }

    if (fks.length > 0) {
      emit("-- Foreign keys");
      for (const fk of fks) {
        const srcCols = fk.source_columns.map((c) => `"${c}"`).join(", ");
        const tgtCols = fk.target_columns.map((c) => `"${c}"`).join(", ");
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(fk.source_schema, fk.source_table)} ADD CONSTRAINT "${fk.constraint_name}" FOREIGN KEY (${srcCols}) REFERENCES ${quoteQualifiedName(fk.target_schema, fk.target_table)} (${tgtCols}) ON UPDATE ${fk.update_rule} ON DELETE ${fk.delete_rule};`,
        );
      }
      emit("");
    }

    const tableRowCounts = new Map<string, number>();
    // Dump data for each table
    for (const { schema_name, tablename } of tables) {
      const currentTableKey = tableKey(schema_name, tablename);
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const overrideIdentity = identitySequences.some(seq => seq.owner_schema === schema_name && seq.owner_table === tablename);
      const count = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${qualifiedTableName}`);
      tableRowCounts.set(currentTableKey, count[0]?.n ?? 0);
      if (excludedTableNames.has(currentTableKey) || (count[0]?.n ?? 0) === 0) continue;

      // Get column info for this table
      const cols = await sql<{ column_name: string; data_type: string; udt_schema: string; udt_name: string }[]>`
        SELECT column_name, data_type, udt_schema, udt_name
        FROM information_schema.columns
        WHERE table_schema = ${schema_name} AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;
      const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");

      emit(`-- Data for: ${schema_name}.${tablename} (${count[0]!.n} rows)`);

      const nullifiedColumns = nullifiedColumnsByTable.get(currentTableKey) ?? new Set<string>();
      if (effectiveBackupEngine !== "javascript" && nullifiedColumns.size === 0) {
        emit(`COPY ${qualifiedTableName} (${colNames}) FROM stdin;`);
        await writer.writeRaw("\n");
        const copyStream = await sql.unsafe(`COPY ${qualifiedTableName} (${colNames}) TO STDOUT`).readable();
        for await (const chunk of copyStream) {
          await writer.writeRaw(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        await writer.writeRaw("\\.\n");
        emitStatementBoundary();
        emit("");
        continue;
      }

      const binaryArray = (column: (typeof cols)[number]) => column.data_type === "ARRAY"
        && column.udt_schema === "pg_catalog" && column.udt_name === "_bytea";
      const projection = cols.some(binaryArray) ? cols.map(column => binaryArray(column)
        ? `${quoteIdentifier(column.column_name)}::text AS ${quoteIdentifier(column.column_name)}`
        : quoteIdentifier(column.column_name)).join(", ") : "*";
      const rowCursor = sql
        .unsafe(`SELECT ${projection} FROM ${qualifiedTableName}`)
        .values()
        .cursor(BACKUP_DATA_CURSOR_ROWS) as AsyncIterable<unknown[][]>;
      for await (const rows of rowCursor) {
        for (const row of rows) {
          const values = row.map((rawValue, index) =>
            formatSqlValue(rawValue, cols[index]?.column_name, nullifiedColumns, cols[index]?.data_type),
          );
          emitStatement(`INSERT INTO ${qualifiedTableName} (${colNames})${overrideIdentity ? " OVERRIDING SYSTEM VALUE" : ""} VALUES (${values.join(", ")});`);
        }
        await writer.drain();
      }
      emit("");
    }

    // Restore CHECK and exclusion constraints after loading data. In particular,
    // a NOT VALID check can have pre-existing rows that it would reject on insert.
    // Use the same catalog-only schema path for deparsing and replay, rather than the
    // restoring session's search_path.
    for (const constraint of uniques) {
      const key = tableKey(constraint.schema_name, constraint.tablename);
      const nullified = nullifiedColumnsByTable.get(key);
      if (!nullified?.size || excludedTableNames.has(key) || (tableRowCounts.get(key) ?? 0) < 2) continue;
      if (constraint.definition.startsWith("UNIQUE NULLS NOT DISTINCT ") &&
          constraint.columns.some(column => nullified.has(column))) {
        throw new Error(`backup_transform_constraint_conflict: cannot certify unique constraint ${key}.${constraint.constraint_name} after nullification`);
      }
    }

    const transformedChecks = nullifiedColumnsByTable.size > 0 ? await sql<{
      schema_name: string; tablename: string; constraint_name: string; expression: string;
    }[]>`SELECT n.nspname AS schema_name, t.relname AS tablename, c.conname AS constraint_name,
        pg_get_expr(c.conbin, c.conrelid) AS expression
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c' AND c.convalidated AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}` : [];
    await sql`SET LOCAL search_path = pg_catalog`;
    const checkAndExclusionConstraints = await sql<{
        constraint_name: string;
        schema_name: string;
        tablename: string;
        definition: string;
        type: string;
        columns: string[];
      }[]>`
        SELECT c.conname AS constraint_name, n.nspname AS schema_name, t.relname AS tablename,
               pg_get_constraintdef(c.oid) AS definition, c.contype::text AS type,
               ARRAY(SELECT a.attname FROM pg_attribute a WHERE a.attrelid = t.oid AND (
                 a.attnum = ANY(c.conkey) OR EXISTS (
                   SELECT 1 FROM pg_depend d WHERE d.refobjid = t.oid AND d.refobjsubid = a.attnum
                     AND ((d.classid = 'pg_constraint'::regclass AND d.objid = c.oid)
                       OR (d.classid = 'pg_class'::regclass AND d.objid = c.conindid))
                 ))) AS columns
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype IN ('c', 'x')
          AND c.conislocal
          AND c.conparentid = 0
          AND t.relkind = 'r'
          AND NOT t.relispartition
          AND NOT EXISTS (
            SELECT 1 FROM pg_inherits i WHERE i.inhrelid = t.oid OR i.inhparent = t.oid
          )
          AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        ORDER BY n.nspname, t.relname, c.conname
      `;
    await sql`SELECT set_config('search_path', ${sourceSettings?.search_path ?? '"$user", public'}, true)`;
    // The JavaScript serializer does not rebuild inheritance or partition
    // topology. Do not change those tables' current behavior in this slice.
    const ordinaryTableConstraints = checkAndExclusionConstraints.filter(
      (constraint) => includedTableNames.has(tableKey(constraint.schema_name, constraint.tablename)),
    );
    for (const constraint of ordinaryTableConstraints) {
      const key = tableKey(constraint.schema_name, constraint.tablename);
      const nullified = nullifiedColumnsByTable.get(key);
      if (!nullified?.size || excludedTableNames.has(key) || !tableRowCounts.get(key)) continue;
      if (constraint.type === "x" && constraint.columns.some(column => nullified.has(column))) {
        throw new Error(`backup_transform_constraint_conflict: cannot certify exclusion ${key}.${constraint.constraint_name} after nullification`);
      }
      const check = transformedChecks.find(entry => entry.schema_name === constraint.schema_name &&
        entry.tablename === constraint.tablename && entry.constraint_name === constraint.constraint_name);
      if (!check) continue; // NOT VALID checks deliberately permit existing invalid rows.
      const columns = await sql<{ name: string; type: string }[]>`SELECT attname AS name,
        format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = ${quoteQualifiedName(constraint.schema_name, constraint.tablename)}::regclass
          AND attnum > 0 AND NOT attisdropped ORDER BY attnum`;
      const projection = columns.map(column => nullified.has(column.name)
        ? `NULL::${column.type} AS ${quoteIdentifier(column.name)}` : quoteIdentifier(column.name)).join(", ");
      let invalid;
      try {
        invalid = await sql.unsafe(`SELECT 1 FROM (SELECT ${projection} FROM ${quoteQualifiedName(constraint.schema_name, constraint.tablename)}) AS ${quoteIdentifier(constraint.tablename)} WHERE NOT (${check.expression}) LIMIT 1`);
      } catch (error) {
        throw new Error(`backup_transform_constraint_conflict: cannot evaluate ${key}.${constraint.constraint_name} after nullification`, { cause: error });
      }
      if (invalid.length > 0) throw new Error(`backup_transform_constraint_conflict: ${key}.${constraint.constraint_name}`);
    }
    if (ordinaryTableConstraints.length > 0) {
      emit("-- Check and exclusion constraints");
      // Replay in the same catalog-only path used for deparsing, so unqualified
      // built-ins cannot bind differently. Save and restore the exact preceding
      // setting with a transaction-local, restore-private configuration key.
      emitStatement("SELECT pg_catalog.set_config('proprio.restore_constraint_saved_search_path', pg_catalog.current_setting('search_path'), true);");
      emitStatement("SET LOCAL search_path = pg_catalog;");
      for (const constraint of ordinaryTableConstraints) {
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(constraint.schema_name, constraint.tablename)} ADD CONSTRAINT ${quoteIdentifier(constraint.constraint_name)} ${constraint.definition};`,
        );
      }
      emitStatement("SELECT pg_catalog.set_config('search_path', pg_catalog.current_setting('proprio.restore_constraint_saved_search_path'), true);");
      emit("");
    }

    for (const routine of routines) {
      if (!routine.has_search_path) emitStatement(`ALTER ${routine.kind} ${routine.identity} RESET search_path;`);
    }

    const allTriggers = await sql<{
      schema_name: string;
      tablename: string;
      definition: string;
    }[]>`
      SELECT
        n.nspname AS schema_name,
        c.relname AS tablename,
        pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, c.relname, t.tgname
    `;
    const triggers = allTriggers.filter((entry) => (
      includedTableNames.has(tableKey(entry.schema_name, entry.tablename))
    ));
    if (triggers.length > 0) {
      emit("-- Triggers");
      for (const trigger of triggers) {
        emitStatement(`${trigger.definition};`);
      }
      emit("");
    }

    // Sequence values
    if (sequences.length > 0) {
      emit("-- Sequence values");
      for (const seq of sequences) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        const val = await sql.unsafe<{ last_value: string; is_called: boolean }[]>(
          `SELECT last_value::text, is_called FROM ${qualifiedSequenceName}`,
        );
        const skipSequenceValue =
          seq.owner_table !== null
            && excludedTableNames.has(seq.owner_table);
        if (val[0] && !skipSequenceValue) {
          emitStatement(`SELECT setval('${qualifiedSequenceName.replaceAll("'", "''")}', ${val[0].last_value}, ${val[0].is_called ? "true" : "false"});`);
        }
      }
      emit("");
    }

    emitStatement("COMMIT;");
    emit("");
    });

    await writer.close();

    // Compress the SQL file with gzip
    const sqlReadStream = createReadStream(sqlFile);
    const gzWriteStream = createWriteStream(stagedArchive);
    await pipeline(sqlReadStream, createGzip(), gzWriteStream, { signal });
    unlinkSync(sqlFile);
    await closeSql();

    // Intentional JavaScript selection is not a fallback.
    return await publish("javascript",
      backupEngine === "auto" && effectiveBackupEngine === "javascript" ? "pg_dump_failed" : null);
  } catch (error) {
    await writer.abort();
    for (const partial of [stagedArchive, sqlFile]) {
      try { unlinkSync(partial); } catch { /* keep the original error */ }
    }
    signal?.throwIfAborted();
    throw error;
  } finally {
    await closeSql();
    signal?.removeEventListener("abort", abortSql);
  }
}

export async function runDatabaseRestore(opts: RunDatabaseRestoreOptions): Promise<void> {
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  let psqlRestoreError: unknown = null;
  try {
    await restoreWithPsql(opts, connectTimeout);
    return;
  } catch (error) {
    if (error instanceof RestoreInputError) throw error.cause;
    psqlRestoreError = error;
    if (!(await hasStatementBreakpoints(opts.backupFile))) {
      throw new Error(
        `Failed to restore ${basename(opts.backupFile)} with psql: ${sanitizeRestoreErrorMessage(error)}`,
      );
    }
  }

  const sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });

  try {
    await sql`SELECT 1`;
    for await (const statement of readRestoreStatements(opts.backupFile)) {
      await sql.unsafe(statement).execute();
    }
  } catch (error) {
    const statementPreview = typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).query === "string"
      ? String((error as Record<string, unknown>).query)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("--"))
      : null;
    const psqlMessage = psqlRestoreError === null ? "" : `; psql error: ${sanitizeRestoreErrorMessage(psqlRestoreError)}`;
    throw new Error(
      `Failed to restore ${basename(opts.backupFile)}: ${sanitizeRestoreErrorMessage(error)}${statementPreview ? ` [statement: ${statementPreview.slice(0, 120)}]` : ""}${psqlMessage}`,
    );
  } finally {
    await sql.end();
  }
}

/** Operator-facing text is derived from a fixed reason, never subprocess diagnostics. */
export function databaseBackupWarning(reason: RunDatabaseBackupResult["fallbackReason"]): string | null {
  return reason === "pg_dump_failed" ? PG_DUMP_FALLBACK_WARNING : null;
}

export function formatDatabaseBackupResult(result: RunDatabaseBackupResult): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0 ? `; pruned ${result.prunedCount} old backup(s)` : "";
  const warning = databaseBackupWarning(result.fallbackReason);
  return `${result.backupFile} (${size}; engine: ${result.engine}${pruned}${warning ? `; warning: ${warning}` : ""})`;
}
