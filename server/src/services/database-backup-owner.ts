import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { formatDatabaseBackupResult, runDatabaseBackup, withDedicatedDbConnection, type BackupRetentionPolicy, type Db } from "@groktopus/db";
import { conflict } from "../errors.js";
import type { InstanceDatabaseBackupRunResult, InstanceDatabaseBackupTrigger } from "../routes/instance-database-backups.js";
import { beginIdleTrackedWork } from "./task-admission.js";
import { clearIdleBackupWakeRequired, idleBackupWakeMarker, markIdleBackupWakeRequired, verifyIdleDatabaseBackup } from "./idle-database-backup.js";

type BackupLogger = {
  info: (details: object, message: string) => void;
  warn: (message: string) => void;
  error: (details: object, message: string) => void;
};

const BACKUP_DEADLINE_MS = 60 * 60 * 1000;
const BACKUP_SETTINGS_STATEMENT_TIMEOUT_MS = 5_000;

export function readServerBackupRetention(
  db: Db,
  signal: AbortSignal,
  readRetention: (connection: Db) => Promise<BackupRetentionPolicy>,
): Promise<BackupRetentionPolicy> {
  signal.throwIfAborted();
  return withDedicatedDbConnection(db, async connection => {
    let closing: Promise<void> | undefined;
    const stop = () => { closing ??= connection.$client.end({ timeout: 0 }); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      signal.throwIfAborted();
      // The server may keep executing after a client disconnect. Bound the
      // backend statement independently on this dedicated transaction.
      const retention = await connection.transaction(async tx => {
        await tx.execute(sql`select set_config('statement_timeout', ${String(BACKUP_SETTINGS_STATEMENT_TIMEOUT_MS)}, true)`);
        return readRetention(tx as unknown as Db);
      });
      signal.throwIfAborted();
      return retention;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
      await closing;
    }
  }, { admitWithoutWaiting: true });
}

export function createDatabaseBackupOwner(options: {
  connectionString: string;
  backupDir: string;
  getRetention: (signal: AbortSignal) => Promise<BackupRetentionPolicy>;
  logger: BackupLogger;
}) {
  let current: { trigger: InstanceDatabaseBackupTrigger; startedAt: Date } | null = null;
  const status = () => current && {
    trigger: current.trigger,
    startedAt: current.startedAt.toISOString(),
    ageMs: Math.max(0, Date.now() - current.startedAt.getTime()),
  };
  const run = async (
    trigger: InstanceDatabaseBackupTrigger,
  ): Promise<InstanceDatabaseBackupRunResult | null> => {
    if (current) {
      const message = "Database backup already in progress";
      if (trigger === "scheduled") {
        options.logger.warn(`Skipping scheduled database backup because a previous backup is still running (${status()!.ageMs} ms)`);
        return null;
      }
      throw conflict(message);
    }

    const startedAt = new Date();
    const startedAtMs = startedAt.getTime();
    current = { trigger, startedAt };
    const finishIdleBackup = beginIdleTrackedWork();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`Database backup exceeded ${BACKUP_DEADLINE_MS} ms`)), BACKUP_DEADLINE_MS);
    timer.unref();
    const label = trigger === "manual" ? "Manual" : trigger === "idle" ? "Pre-sleep" : "Automatic";
    try {
      if (trigger === "idle") await markIdleBackupWakeRequired(options.backupDir);
      options.logger.info({ backupDir: options.backupDir, trigger }, `${label} database backup starting`);
      const retention = await options.getRetention(abort.signal);
      abort.signal.throwIfAborted();
      const verifyCheckpoint = trigger === "idle" || existsSync(idleBackupWakeMarker(options.backupDir));

      const result = await runDatabaseBackup({
        connectionString: options.connectionString,
        backupDir: options.backupDir,
        retention,
        filenamePrefix: "proprio",
        signal: abort.signal,
        verifyBeforePrune: verifyCheckpoint ? file => verifyIdleDatabaseBackup(file, abort.signal) : undefined,
      });
      if (verifyCheckpoint) {
        if (trigger !== "idle") await clearIdleBackupWakeRequired(options.backupDir);
      }
      const finishedAt = new Date();
      const response: InstanceDatabaseBackupRunResult = {
        ...result,
        trigger,
        backupDir: options.backupDir,
        retention,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedAtMs,
      };
      options.logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          engine: result.engine,
          fallbackReason: result.fallbackReason,
          backupDir: options.backupDir,
          retention,
          trigger,
          durationMs: response.durationMs,
        },
        `${label} database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
      return response;
    } catch (err) {
      options.logger.error({ err, backupDir: options.backupDir, trigger }, `${label} database backup failed`);
      throw err;
    } finally {
      clearTimeout(timer);
      current = null;
      finishIdleBackup();
    }
  };
  return Object.assign(run, { status });
}
