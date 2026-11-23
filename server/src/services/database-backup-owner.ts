import { existsSync } from "node:fs";
import { formatDatabaseBackupResult, runDatabaseBackup, type BackupRetentionPolicy } from "@groktopus/db";
import { conflict } from "../errors.js";
import type { InstanceDatabaseBackupRunResult, InstanceDatabaseBackupTrigger } from "../routes/instance-database-backups.js";
import { beginIdleTrackedWork } from "./task-admission.js";
import { clearIdleBackupWakeRequired, idleBackupWakeMarker, markIdleBackupWakeRequired, verifyIdleDatabaseBackup } from "./idle-database-backup.js";

type BackupLogger = {
  info: (details: object, message: string) => void;
  warn: (message: string) => void;
  error: (details: object, message: string) => void;
};

export function createDatabaseBackupOwner(options: {
  connectionString: string;
  backupDir: string;
  getRetention: () => Promise<BackupRetentionPolicy>;
  logger: BackupLogger;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
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
    const timer = setTimeout(() => abort.abort(new Error(`Database backup exceeded ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    const label = trigger === "manual" ? "Manual" : trigger === "idle" ? "Pre-sleep" : "Automatic";
    try {
      if (trigger === "idle") await markIdleBackupWakeRequired(options.backupDir);
      options.logger.info({ backupDir: options.backupDir, trigger }, `${label} database backup starting`);
      const retention = await options.getRetention();
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
