import { readFileSync } from "node:fs";
import { checkMigrationStagingEvidence, pendingMigrationTags, type MigrationStagingEvidence, type MigrationStagingManifest } from "../src/migration-staging-evidence.js";

const [manifestPath, pendingPath, evidencePath] = process.argv.slice(2);
if (!manifestPath || !pendingPath) {
  console.error("Usage: pnpm --filter @groktopus/db exec tsx scripts/check-migration-staging-evidence.ts <manifest.json> <migration-status.json> [staging-evidence.json]");
  process.exit(2);
}

try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MigrationStagingManifest;
  const status = JSON.parse(readFileSync(pendingPath, "utf8"));
  if (status?.status !== "needsMigrations" && status?.status !== "upToDate") {
    throw new Error("Invalid migration status JSON.");
  }
  const tags = pendingMigrationTags(status.pendingMigrations);
  if (status.status === "upToDate" && tags.length) throw new Error("An up-to-date target cannot have pending migrations.");
  const evidence = evidencePath ? JSON.parse(readFileSync(evidencePath, "utf8")) as MigrationStagingEvidence : undefined;
  const result = checkMigrationStagingEvidence(manifest, evidence, tags);
  for (const error of result.errors) console.error(error);
  if (result.errors.length) process.exit(1);
  console.log(result.requiredMigrations.length
    ? `Staging evidence matches ${result.requiredMigrations.length} migration(s) in ${manifest.sourceSha}.`
    : `No staging-required migrations in ${manifest.sourceSha}.`);
} catch (error) {
  console.error(`Could not check migration staging evidence: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
