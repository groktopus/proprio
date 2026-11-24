import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { MigrationStagingEvidence, MigrationStagingManifest } from "./migration-staging-evidence.js";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    "rollout-manifest": { type: "string" },
    "staging-evidence": { type: "string" },
  } });
  const manifestPath = values["rollout-manifest"];
  const evidencePath = values["staging-evidence"];
  if (evidencePath && !manifestPath) throw new Error("--staging-evidence requires --rollout-manifest.");
  const rollout = manifestPath ? {
    manifest: JSON.parse(await readFile(manifestPath, "utf8")) as MigrationStagingManifest,
    evidence: evidencePath ? JSON.parse(await readFile(evidencePath, "utf8")) as MigrationStagingEvidence : undefined,
  } : undefined;
  const resolved = await resolveMigrationConnection();

  console.log(`Migrating database via ${resolved.source}`);

  try {
    const before = await inspectMigrations(resolved.connectionString);
    if (before.status === "upToDate") {
      if (rollout) await applyPendingMigrations(resolved.connectionString, rollout);
      console.log("No pending migrations");
      return;
    }

    console.log(`Applying ${before.pendingMigrations.length} pending migration(s)...`);
    await applyPendingMigrations(resolved.connectionString, rollout);

    const after = await inspectMigrations(resolved.connectionString);
    if (after.status !== "upToDate") {
      throw new Error(`Migrations incomplete: ${after.pendingMigrations.join(", ")}`);
    }
    console.log("Migrations complete");
  } finally {
    await resolved.stop();
  }
}

await main();
