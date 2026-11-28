import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CreateBucketCommand, DeleteBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  providerTraceRecords,
  ensurePostgresDatabase,
  getEmbeddedPostgresTestSupport,
  runDatabaseBackup,
  runDatabaseRestore,
  startEmbeddedPostgresTestDatabase,
} from "@groktopus/db";
import { createProviderTraceObjectStore } from "../services/provider-trace-object-store.js";
import { providerTraceStore } from "../services/provider-trace-store.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageProvider } from "../storage/types.js";

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
    targetDatabaseName = `trace_restore_target_${randomUUID().replaceAll("-", "")}`;
    await ensurePostgresDatabase(adminUrl.toString(), targetDatabaseName);
    const sourceUrl = source.connectionString;
    const targetDatabaseUrl = new URL(source.connectionString);
    targetDatabaseUrl.pathname = `/${targetDatabaseName}`;
    const targetUrl = targetDatabaseUrl.toString();

    sourceDb = createDb(sourceUrl);
    await sourceDb.insert(companies).values({ id: companyId, name: "Restore deletion fixture", issuePrefix: "TRACE" });
    await sourceDb.insert(agents).values({ id: agentId, companyId, name: "Fixture agent" });
    await sourceDb.insert(heartbeatRuns).values([deletedRunId, unrelatedRunId].map(id => ({
      id, companyId, agentId, status: "succeeded", startedAt: new Date(), finishedAt: new Date(),
    })));
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    await sourceDb.insert(providerTraceRecords).values([
      { id: deletedTraceId, runId: deletedRunId, traceRef: deletedTraceRef },
      { id: unrelatedTraceId, runId: unrelatedRunId, traceRef: unrelatedTraceRef },
    ].map(trace => ({ ...trace, companyId, status: "complete", provider: "codex", requestedBy: "restore-fixture", expiresAt })));

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
      coordinatedPayloadSnapshot: true,
      source: "isolated restore integration fixture",
      records: [{ traceId: deletedTraceId, runId: deletedRunId, companyId, deletedAt }],
    }, null, 2));

    const loader = path.join(repoRoot, "server/node_modules/tsx/dist/loader.mjs");
    const reconcile = (storageEnv: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [
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
        ...storageEnv,
      },
    });
    const restoredPayload = path.join(restoredStorage, deletedTraceRef);
    const heldPayload = path.join(root, "held-payload");
    renameSync(restoredPayload, heldPayload);
    mkdirSync(restoredPayload);
    const pending = reconcile();
    expect(pending.status, pending.stderr).toBe(1);
    expect(JSON.parse(pending.stdout)).toMatchObject({
      reconciled: [],
      reconciliationPending: [{ traceId: deletedTraceId, error: "reconciliation_failed" }],
    });
    restoredDb = createDb(targetUrl);
    const pendingStore = providerTraceStore(restoredDb);
    await expect(pendingStore.getByRun(deletedRunId, companyId)).resolves.toMatchObject({
      status: "deleted", traceRef: deletedTraceRef, deletedAt: expect.any(Date),
    });
    await expect(pendingStore.inspect(deletedRunId, companyId)).resolves.toEqual({ trace: null, entries: [] });
    await expect(pendingStore.prepare({
      runId: deletedRunId, companyId, provider: "codex", requestedBy: "restore-fixture",
    })).rejects.toThrow("provider_trace_unavailable");
    await restoredDb.$client.end();
    restoredDb = undefined;
    rmSync(restoredPayload, { recursive: true });
    renameSync(heldPayload, restoredPayload);

    const command = reconcile();
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

    // A second restore ordering leaves the local filename in PostgreSQL
    // while the restored object store contains its later imported copy.
    const migratedRef = `s3-segments-v1:${companyId}/${unrelatedRunId}/${unrelatedTraceRef}`;
    const migratedPath = path.join(restoredStorage, unrelatedTraceRef);
    const endpoint = process.env.PROPRIO_LOG_TEST_S3_ENDPOINT;
    if (endpoint && !["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname)) {
      throw new Error("Restore evidence qualification requires a disposable loopback S3 service");
    }
    const bucket = `proprio-trace-restore-${randomUUID()}`;
    const s3 = endpoint ? new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true }) : null;
    let bucketCreated = false;
    const objects = new Map<string, { bytes: Buffer; etag: string }>();
    const previousMasterKey = process.env.PROPRIO_SECRETS_MASTER_KEY;
    process.env.PROPRIO_SECRETS_MASTER_KEY = "e".repeat(64);
    try {
      const memoryProvider: StorageProvider = {
        id: "s3",
        async getObject({ objectKey }) {
          const object = objects.get(objectKey);
          if (!object) throw Object.assign(new Error("Missing object"), { name: "NoSuchKey" });
          return { stream: Readable.from([object.bytes]), etag: object.etag, contentLength: object.bytes.length };
        },
        async putObject() { throw new Error("Unexpected unconditional write"); },
        async putObjectConditional({ objectKey, body, ifMatch, ifNoneMatch }) {
          const previous = objects.get(objectKey);
          if (ifNoneMatch ? previous : previous?.etag !== ifMatch) {
            throw Object.assign(new Error("Object changed"), { name: "PreconditionFailed" });
          }
          const chunks: Buffer[] = [];
          if (Buffer.isBuffer(body)) chunks.push(body);
          else for await (const chunk of body) chunks.push(Buffer.from(chunk));
          const etag = randomUUID();
          objects.set(objectKey, { bytes: Buffer.concat(chunks), etag });
          return { etag };
        },
        async headObject({ objectKey }) { return { exists: objects.has(objectKey) }; },
        async deleteObject({ objectKey }) { objects.delete(objectKey); },
        async listObjects({ prefix }) { return { keys: [...objects.keys()].filter(key => key.startsWith(prefix)) }; },
      };
      const provider = endpoint
        ? createS3StorageProvider({ endpoint, bucket, region: "us-east-1", forcePathStyle: true })
        : memoryProvider;
      if (s3) {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        bucketCreated = true;
      }
      const journal = createProviderTraceObjectStore(provider);
      await journal.open(migratedRef, migratedPath, async () => undefined);
      writeFileSync(migratedPath, unrelatedBytes);
      await journal.finish(migratedRef);
      await expect(journal.read(migratedRef)).resolves.toEqual(unrelatedBytes);
      const migratedDeletionTime = new Date();
      if (endpoint) {
        const migratedDeletedAt = migratedDeletionTime.toISOString();
        writeFileSync(manifestPath, JSON.stringify({
          schema: "proprio.run_evidence_deletions.v1",
          recoveryPoint,
          coversThrough: migratedDeletedAt,
          coverageComplete: true,
          coordinatedPayloadSnapshot: true,
          source: "isolated restore integration fixture",
          records: [{ traceId: unrelatedTraceId, runId: unrelatedRunId, companyId, deletedAt: migratedDeletedAt }],
        }));
        const command = reconcile({
          PROPRIO_STORAGE_PROVIDER: "s3",
          PROPRIO_STORAGE_S3_BUCKET: bucket,
          PROPRIO_STORAGE_S3_ENDPOINT: endpoint,
          PROPRIO_STORAGE_S3_REGION: "us-east-1",
          PROPRIO_STORAGE_S3_PREFIX: "",
          PROPRIO_STORAGE_S3_FORCE_PATH_STYLE: "true",
        });
        expect(command.status, command.stderr).toBe(0);
        expect(JSON.parse(command.stdout)).toMatchObject({ reconciled: [unrelatedTraceId], reconciliationPending: [] });
      } else {
        const migratedStore = providerTraceStore(restoredDb, { objectStore: journal });
        await expect(migratedStore.reconcileDeletion({
          traceId: unrelatedTraceId, runId: unrelatedRunId, companyId, deletedAt: migratedDeletionTime,
        })).resolves.toEqual({ status: "cleaned" });
      }
      await expect(journal.read(migratedRef)).rejects.toThrow("provider_trace_payload_unavailable");
      await expect(journal.open(migratedRef, migratedPath, async () => undefined)).rejects.toThrow();
      const remaining = await provider.listObjects!({ prefix: "provider-traces/" });
      expect(remaining.keys).toHaveLength(2);
      expect(remaining.keys.every(key => key.endsWith("/head.json"))).toBe(true);
      await expect(afterStore.getByRun(unrelatedRunId, companyId)).resolves.toMatchObject({ status: "deleted" });
      expect(existsSync(migratedPath)).toBe(false);
    } finally {
      try {
        if (s3 && endpoint && bucketCreated) {
          const provider = createS3StorageProvider({ endpoint, bucket, region: "us-east-1", forcePathStyle: true });
          const fixture = await provider.listObjects!({ prefix: "provider-traces/" });
          await Promise.all(fixture.keys.map(objectKey => provider.deleteObject({ objectKey })));
          await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
        }
      } finally {
        s3?.destroy();
        if (previousMasterKey === undefined) delete process.env.PROPRIO_SECRETS_MASTER_KEY;
        else process.env.PROPRIO_SECRETS_MASTER_KEY = previousMasterKey;
      }
    }
  } finally {
    try {
      await sourceStoreDb?.$client.end();
      await sourceDb?.$client.end();
      await restoredDb?.$client.end();
    } finally {
      try {
        if (adminUrl && targetDatabaseName) {
          const adminDb = createDb(adminUrl.toString());
          try {
            await adminDb.$client.unsafe(`DROP DATABASE IF EXISTS "${targetDatabaseName}"`);
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
