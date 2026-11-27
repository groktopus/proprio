import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb, prepareEmbeddedPostgresNativeRuntime } from "@groktopus/db";
import { providerTraceStore } from "../src/services/provider-trace-store.js";
import { reconcileRunEvidenceDeletions, validateRunEvidenceDeletionRecords, type RunEvidenceDeletionRecord } from "../src/services/run-evidence-restore-reconciliation.js";
import { isCloudManagedInstance } from "../src/services/cloud-instance.js";
import { cloudRuntimeConfigService } from "../src/services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../src/services/cloud-runtime-config-snapshot.js";

const args = process.argv.slice(2);
const embedded = args[0] === "--embedded";
const [manifestPath, ...extraArgs] = embedded ? args.slice(1) : args;
if (!manifestPath || extraArgs.length > 0) {
  throw new Error("Usage: tsx server/scripts/reconcile-run-evidence-deletions.ts [--embedded] <manifest.json>");
}

const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_run_evidence_deletion_manifest");
const manifest = parsed as {
  schema?: unknown;
  recoveryPoint?: unknown;
  coversThrough?: unknown;
  coverageComplete?: unknown;
  coordinatedPayloadSnapshot?: unknown;
  source?: unknown;
  records?: unknown;
};
if (manifest.schema !== "proprio.run_evidence_deletions.v1" || !Array.isArray(manifest.records)
  || typeof manifest.recoveryPoint !== "string" || typeof manifest.coversThrough !== "string"
  || manifest.coverageComplete !== true || manifest.coordinatedPayloadSnapshot !== true
  || typeof manifest.source !== "string" || !manifest.source.trim()) {
  throw new Error("invalid_run_evidence_deletion_manifest");
}
const records = manifest.records as RunEvidenceDeletionRecord[];
validateRunEvidenceDeletionRecords(records, {
  recoveryPoint: manifest.recoveryPoint,
  coversThrough: manifest.coversThrough,
});
async function reconcile(databaseUrl: string) {
  const db = createDb(databaseUrl);
  try {
    if (isCloudManagedInstance()) {
      const stored = await cloudRuntimeConfigService(db).inspectStored();
      if (!stored) throw new Error("cloud_runtime_configuration_missing");
      setCloudRuntimeConfigSnapshot(stored);
    }
    const result = await reconcileRunEvidenceDeletions(providerTraceStore(db), records);
    console.log(JSON.stringify({
      recoveryPoint: manifest.recoveryPoint,
      coversThrough: manifest.coversThrough,
      source: manifest.source,
      ...result,
    }, null, 2));
    if (result.reconciliationPending.length || result.missing.length || result.mismatched.length) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

if (embedded) {
  if (isCloudManagedInstance()) throw new Error("Embedded restore reconciliation requires a self-hosted instance");
  const { loadConfig } = await import("../src/config.js");
  const config = loadConfig();
  if (config.databaseMode !== "embedded-postgres" || config.databaseUrl) {
    throw new Error("Embedded restore reconciliation requires the restored embedded PostgreSQL configuration");
  }
  const { embeddedPostgresDataDir: databaseDir, embeddedPostgresPort: port } = config;
  await access(join(databaseDir, "PG_VERSION")).catch(error => {
    throw new Error("The restored PostgreSQL data directory must contain an existing cluster", { cause: error });
  });
  await prepareEmbeddedPostgresNativeRuntime();
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const postgres = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "proprio",
    password: "proprio",
    persistent: true,
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    onLog: message => console.error(message),
    onError: message => console.error(message),
  });
  await postgres.start();
  try {
    await reconcile(`postgres://proprio:proprio@127.0.0.1:${port}/proprio`);
  } finally {
    await postgres.stop();
  }
} else {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the isolated restored instance");
  await reconcile(process.env.DATABASE_URL);
}
