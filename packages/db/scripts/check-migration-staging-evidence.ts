import { readFileSync } from "node:fs";
import { checkMigrationStagingEvidence, type MigrationStagingEvidence, type MigrationStagingManifest } from "../src/migration-staging-evidence.js";

const [manifestPath, pendingPath, evidencePath] = process.argv.slice(2);
if (!manifestPath || !pendingPath || !evidencePath) {
  console.error("Usage: pnpm --filter @groktopus/db exec tsx scripts/check-migration-staging-evidence.ts <manifest.json> <pending-migration-tags.json> <staging-evidence.json>");
  process.exit(2);
}

try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MigrationStagingManifest;
  const pendingMigrationTags = JSON.parse(readFileSync(pendingPath, "utf8")) as string[];
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as MigrationStagingEvidence;
  const result = checkMigrationStagingEvidence(manifest, evidence, pendingMigrationTags);
  for (const error of result.errors) console.error(error);
  if (!result.passed) process.exit(1);
  console.log(result.requiredMigrations.length
    ? `Staging evidence matches ${result.requiredMigrations.length} migration(s) in ${manifest.sourceSha}.`
    : `No staging-required migrations in ${manifest.sourceSha}.`);
} catch (error) {
  console.error(`Could not check migration staging evidence: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
