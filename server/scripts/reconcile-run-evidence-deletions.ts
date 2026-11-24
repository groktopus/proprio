import { readFile } from "node:fs/promises";
import { createDb } from "@groktopus/db";
import { providerTraceStore } from "../src/services/provider-trace-store.js";
import { reconcileRunEvidenceDeletions, validateRunEvidenceDeletionRecords, type RunEvidenceDeletionRecord } from "../src/services/run-evidence-restore-reconciliation.js";
import { isCloudManagedInstance } from "../src/services/cloud-instance.js";
import { cloudRuntimeConfigService } from "../src/services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../src/services/cloud-runtime-config-snapshot.js";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the isolated restored instance");
const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Usage: tsx server/scripts/reconcile-run-evidence-deletions.ts <manifest.json>");

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
const db = createDb(process.env.DATABASE_URL);
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
