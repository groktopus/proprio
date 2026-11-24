import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  createDb,
  ensurePostgresDatabase,
  getEmbeddedPostgresTestSupport,
  runDatabaseBackup,
  runDatabaseRestore,
  startEmbeddedPostgresTestDatabase,
} from "@groktopus/db";
import { providerTraceStore } from "../services/provider-trace-store.js";

const qualificationEnabled = process.env.PROPRIO_RUN_EVIDENCE_RESTORE_QUALIFICATION === "true";
const support = qualificationEnabled ? await getEmbeddedPostgresTestSupport() : { supported: false };
const integrationTest = support.supported && qualificationEnabled ? it : it.skip;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

integrationTest("reapplies a later deletion after restoring an older database and sidecar backup", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-restore-deletion-smoke-"));
  let source: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let sourceDb: ReturnType<typeof createDb> | undefined;
  let restoredDb: ReturnType<typeof createDb> | undefined;
  let sourceStoreDb: ReturnType<typeof createDb> | undefined;
  let sourceDatabaseName: string | undefined;
  let targetDatabaseName: string | undefined;
  let adminUrl: URL | undefined;
  const originalTraceBasePath = process.env.PROVIDER_TRACE_BASE_PATH;
  const sourceStorage = path.join(root, "source-storage");
  const restoredStorage = path.join(root, "restored-storage");
  const backupDir = path.join(root, "database-backup");
  const manifestPath = path.join(root, "deletions.json");
  const psqlRunner = path.join(root, "docker-psql");
  writeFileSync(psqlRunner, '#!/bin/sh\nexec docker run --rm -i --network host postgres:17-alpine psql "$@"\n', { mode: 0o700 });
  mkdirSync(sourceStorage, { recursive: true });
  mkdirSync(restoredStorage, { recursive: true });

  const companyId = randomUUID();
  const agentId = randomUUID();
  const deletedRunId = randomUUID();
  const unrelatedRunId = randomUUID();
  const deletedTraceId = randomUUID();
  const unrelatedTraceId = randomUUID();
  const deletedTraceRef = `${randomUUID()}.ndjson`;
  const unrelatedTraceRef = `${randomUUID()}.ndjson`;
  const frameBytes = (value: string) => Buffer.from(`${JSON.stringify({ kind: "trace_status", status: value, reason: null })}\n`);
  const deletedBytes = frameBytes("deleted-trace-fixture");
  const unrelatedBytes = frameBytes("unrelated-trace-fixture");

  try {
    source = await startEmbeddedPostgresTestDatabase("proprio-trace-delete-source-");
    adminUrl = new URL(source.connectionString);
    adminUrl.pathname = "/postgres";
    sourceDatabaseName = `trace_restore_source_${randomUUID().replaceAll("-", "")}`;
    targetDatabaseName = `trace_restore_target_${randomUUID().replaceAll("-", "")}`;
    await ensurePostgresDatabase(adminUrl.toString(), sourceDatabaseName);
    await ensurePostgresDatabase(adminUrl.toString(), targetDatabaseName);
    const sourceDatabaseUrl = new URL(source.connectionString);
    sourceDatabaseUrl.pathname = `/${sourceDatabaseName}`;
    const sourceUrl = sourceDatabaseUrl.toString();
    const targetDatabaseUrl = new URL(source.connectionString);
    targetDatabaseUrl.pathname = `/${targetDatabaseName}`;
    const targetUrl = targetDatabaseUrl.toString();

    sourceDb = createDb(sourceUrl);
    await sourceDb.$client.unsafe(`
      CREATE TABLE companies (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE agents (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), name text NOT NULL);
      CREATE TABLE heartbeat_runs (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
        agent_id uuid NOT NULL REFERENCES agents(id), status text NOT NULL,
        started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL
      );
      CREATE TABLE provider_trace_records (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id),
        run_id uuid NOT NULL UNIQUE REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'capturing', provider text NOT NULL, trace_ref text NOT NULL,
        frame_count integer NOT NULL DEFAULT 0, byte_count bigint NOT NULL DEFAULT 0,
        digest text, reason text, requested_by text NOT NULL, expires_at timestamptz NOT NULL,
        deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await sourceDb.$client.unsafe("INSERT INTO companies (id, name) VALUES ($1, $2)", [companyId, "restore deletion fixture"]);
    await sourceDb.$client.unsafe("INSERT INTO agents (id, company_id, name) VALUES ($1, $2, $3)", [agentId, companyId, "fixture agent"]);
    await sourceDb.$client.unsafe(
      "INSERT INTO heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at) VALUES ($1, $3, $4, 'succeeded', now(), now()), ($2, $3, $4, 'succeeded', now(), now())",
      [deletedRunId, unrelatedRunId, companyId, agentId],
    );
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    await sourceDb.$client.unsafe(
      "INSERT INTO provider_trace_records (id, company_id, run_id, status, provider, trace_ref, requested_by, expires_at) VALUES ($1, $3, $4, 'complete', 'codex', $6, 'restore-fixture', $8), ($2, $3, $5, 'complete', 'codex', $7, 'restore-fixture', $8)",
      [deletedTraceId, unrelatedTraceId, companyId, deletedRunId, unrelatedRunId, deletedTraceRef, unrelatedTraceRef, expiresAt.toISOString()],
    );

    writeFileSync(path.join(sourceStorage, deletedTraceRef), deletedBytes, { mode: 0o600 });
    writeFileSync(path.join(sourceStorage, unrelatedTraceRef), unrelatedBytes, { mode: 0o600 });
    copyFileSync(path.join(sourceStorage, deletedTraceRef), path.join(restoredStorage, deletedTraceRef));
    copyFileSync(path.join(sourceStorage, unrelatedTraceRef), path.join(restoredStorage, unrelatedTraceRef));

    const recoveryPoint = new Date(Date.now() - 1_000).toISOString();
    const backup = await runDatabaseBackup({
      connectionString: sourceUrl,
      backupDir,
      backupEngine: "javascript",
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
    });
    expect(existsSync(backup.backupFile)).toBe(true);
    await sourceDb.$client.end();
    sourceDb = undefined;

    process.env.PROVIDER_TRACE_BASE_PATH = sourceStorage;
    sourceStoreDb = createDb(sourceUrl);
    const sourceStore = providerTraceStore(sourceStoreDb);
    const removed = await sourceStore.remove(deletedRunId, companyId);
    expect(removed).toMatchObject({ id: deletedTraceId, status: "deleted", deletedAt: expect.any(Date) });
    expect(existsSync(path.join(sourceStorage, deletedTraceRef))).toBe(false);
    expect(existsSync(path.join(sourceStorage, unrelatedTraceRef))).toBe(true);
    const deletedAt = removed!.deletedAt!.toISOString();
    await sourceStoreDb.$client.end();
    sourceStoreDb = undefined;

    const previousPsqlPath = process.env.PROPRIO_PSQL_PATH;
    process.env.PROPRIO_PSQL_PATH = psqlRunner;
    try {
      await runDatabaseRestore({ connectionString: targetUrl, backupFile: backup.backupFile });
    } finally {
      if (previousPsqlPath === undefined) delete process.env.PROPRIO_PSQL_PATH;
      else process.env.PROPRIO_PSQL_PATH = previousPsqlPath;
    }
    process.env.PROVIDER_TRACE_BASE_PATH = restoredStorage;
    restoredDb = createDb(targetUrl);
    const restoredStore = providerTraceStore(restoredDb);
    const beforeReconcile = await restoredStore.inspect(deletedRunId, companyId);
    expect(beforeReconcile.trace?.deletedAt).toBeNull();
    expect(beforeReconcile.entries).toEqual([{ kind: "trace_status", status: "deleted-trace-fixture", reason: null }]);
    await restoredDb.$client.end();
    restoredDb = undefined;

    writeFileSync(manifestPath, JSON.stringify({
      schema: "proprio.run_evidence_deletions.v1",
      recoveryPoint,
      coversThrough: deletedAt,
      coverageComplete: true,
      source: "isolated restore integration fixture",
      records: [{ traceId: deletedTraceId, runId: deletedRunId, companyId, deletedAt }],
    }, null, 2));

    const loader = path.join(repoRoot, "server/node_modules/tsx/dist/loader.mjs");
    const command = spawnSync(process.execPath, [
      "--import", loader,
      "server/scripts/reconcile-run-evidence-deletions.ts",
      manifestPath,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 150_000,
      env: {
        ...process.env,
        DATABASE_URL: targetUrl,
        DATABASE_MIGRATION_URL: targetUrl,
        PROPRIO_STORAGE_PROVIDER: "local_disk",
        PROPRIO_PSQL_PATH: psqlRunner,
        PROVIDER_TRACE_BASE_PATH: restoredStorage,
        PROPRIO_HOME: path.join(root, "proprio-home"),
      },
    });
    if (command.error) {
      throw new Error(`Reconciliation command failed: ${command.error.message}\nstdout:\n${command.stdout}\nstderr:\n${command.stderr}`);
    }
    expect(command.status, command.stderr).toBe(0);
    expect(JSON.parse(command.stdout)).toMatchObject({
      reconciled: [deletedTraceId],
      reconciliationPending: [],
      missing: [],
      mismatched: [],
    });

    restoredDb = createDb(targetUrl);
    const afterStore = providerTraceStore(restoredDb);
    const deleted = await afterStore.getByRun(deletedRunId, companyId);
    expect(deleted).toMatchObject({ id: deletedTraceId, status: "deleted", deletedAt: expect.any(Date) });
    expect(deleted!.traceRef).toBe("00000000-0000-0000-0000-000000000000.ndjson");
    expect(await afterStore.inspect(deletedRunId, companyId)).toEqual({ trace: null, entries: [] });
    await expect(afterStore.prepare({
      runId: deletedRunId, companyId, provider: "codex", requestedBy: "restore-fixture",
    })).rejects.toThrow("provider_trace_unavailable");
    expect(existsSync(path.join(restoredStorage, deletedTraceRef))).toBe(false);
    expect(existsSync(path.join(restoredStorage, unrelatedTraceRef))).toBe(true);
    await expect(afterStore.inspect(unrelatedRunId, companyId)).resolves.toMatchObject({
      trace: { id: unrelatedTraceId, deletedAt: null },
      entries: [{ status: "unrelated-trace-fixture" }],
    });
  } finally {
    try {
      await sourceStoreDb?.$client.end();
      await sourceDb?.$client.end();
      await restoredDb?.$client.end();
    } finally {
      try {
        if (adminUrl && (sourceDatabaseName || targetDatabaseName)) {
          const adminDb = createDb(adminUrl.toString());
          try {
            for (const name of [sourceDatabaseName, targetDatabaseName]) {
              if (name) await adminDb.$client.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
            }
          } finally {
            await adminDb.$client.end();
          }
        }
      } finally {
        try {
        await source?.cleanup();
        } finally {
          if (originalTraceBasePath === undefined) delete process.env.PROVIDER_TRACE_BASE_PATH;
          else process.env.PROVIDER_TRACE_BASE_PATH = originalTraceBasePath;
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  }
}, 240_000);
