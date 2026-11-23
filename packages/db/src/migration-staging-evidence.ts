import { MIGRATION_COMPATIBILITY_VALUES, type MigrationCompatibility } from "./migration-compatibility.js";

type MigrationStagingManifestEntry = {
  readonly tag: string;
  readonly sqlSha256: string;
  readonly compatibility: MigrationCompatibility;
};

export type MigrationStagingManifest = {
  readonly sourceSha: string;
  readonly migrationCompatibility: { readonly migrations: readonly MigrationStagingManifestEntry[] };
};

export type MigrationStagingEvidence = {
  readonly version: 1;
  readonly sourceSha: string;
  readonly owner: string;
  readonly migrations: readonly {
    readonly tag: string;
    readonly sqlSha256: string;
    readonly rollout: {
      readonly evidenceRef: string;
      readonly stages: readonly {
        readonly phase: "expand" | "backfill" | "contract" | "staging";
        readonly releaseSha: string;
        readonly evidenceRef: string;
      }[];
    };
    readonly previousRelease: {
      readonly mode: "serving" | "drained";
      readonly evidenceRef: string;
    };
    readonly overlap?: { readonly evidenceRef: string };
    readonly rehearsalAttempts: readonly {
      readonly lock: "acquired" | "timed_out";
      readonly migrationStarted: boolean;
      readonly migrationOutcome: "applied" | "failed" | "unknown";
      readonly resultRef: string;
    }[];
  }[];
};

const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const reference = (value: unknown): value is string => typeof value === "string" && value.trim().length >= 8;
const commitSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

export function pendingMigrationTags(filenames: unknown): string[] {
  if (!Array.isArray(filenames) || filenames.some(file => typeof file !== "string" || !/^[^/\\\\]+\.sql$/.test(file))) {
    throw new Error("Invalid pending migration filenames. Use pendingMigrations from migration status JSON.");
  }
  return filenames.map((file: string) => file.slice(0, -4));
}

/** Validate the handoff from the owner who reviewed the external rollout evidence. */
export function checkMigrationStagingEvidence(
  manifest: MigrationStagingManifest,
  evidence: MigrationStagingEvidence | undefined,
  pendingTags: readonly string[],
): { errors: string[]; requiredMigrations: string[] } {
  const errors: string[] = [];
  const requiredMigrations: string[] = [];
  const result = { errors, requiredMigrations };
  const migrations = manifest?.migrationCompatibility?.migrations;
  if (!commitSha(manifest?.sourceSha) || !Array.isArray(migrations)) {
    errors.push("Invalid migration manifest or compatibility data.");
    return result;
  }
  if (migrations.some(entry => !entry || !nonblank(entry.tag) ||
      typeof entry.sqlSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sqlSha256) ||
      !MIGRATION_COMPATIBILITY_VALUES.includes(entry.compatibility))) {
    errors.push("Invalid migration manifest entry.");
    return result;
  }
  const byTag = new Map(migrations.map(migration => [migration.tag, migration]));
  if (byTag.size !== migrations.length) errors.push("Manifest contains duplicate migration tags.");
  if (!Array.isArray(pendingTags) || new Set(pendingTags).size !== pendingTags.length || pendingTags.some(tag => !nonblank(tag))) {
    errors.push("Invalid pending migration list.");
    return result;
  }

  for (const tag of pendingTags) {
    const migration = byTag.get(tag);
    if (!migration) errors.push(`${tag}: pending migration is missing from the manifest.`);
    else if (migration.compatibility === "unknown") errors.push(`${tag}: pending migration is unknown. Classify it before rollout.`);
    else if (migration.compatibility === "requires_staging") requiredMigrations.push(tag);
  }

  if (evidence === undefined) {
    if (requiredMigrations.length > 0) errors.push(`Missing staging evidence for: ${requiredMigrations.join(", ")}.`);
    return result;
  }
  if (evidence?.version !== 1 || evidence.sourceSha !== manifest.sourceSha || !nonblank(evidence.owner) || !Array.isArray(evidence.migrations)) {
    errors.push("Evidence must identify version 1, the exact manifest source SHA, and a deployment owner.");
    return result;
  }

  const suppliedTags = new Set<string>();
  for (const entry of evidence.migrations) {
    if (!entry || !nonblank(entry.tag)) {
      errors.push("Evidence contains an invalid migration entry.");
      continue;
    }
    const { tag } = entry;
    if (suppliedTags.has(tag)) errors.push(`${tag}: duplicate migration evidence.`);
    suppliedTags.add(tag);
    const migration = byTag.get(tag);
    if (migration?.compatibility !== "requires_staging") {
      errors.push(`${tag}: evidence does not match a staging-required migration in the manifest.`);
      continue;
    }
    if (entry.sqlSha256 !== migration.sqlSha256) errors.push(`${tag}: evidence SQL digest does not match the manifest.`);
    const stages = entry.rollout?.stages;
    const expectedPhases = stages?.length === 1 ? ["staging"] : ["expand", "backfill", "contract"];
    if (!reference(entry.rollout?.evidenceRef) || !Array.isArray(stages) ||
        stages.length !== expectedPhases.length ||
        stages.some((stage, index) => stage?.phase !== expectedPhases[index] ||
          !commitSha(stage.releaseSha) || !reference(stage.evidenceRef))) {
      errors.push(`${tag}: rollout stages must name their release SHAs and evidence in the required order.`);
    }
    if (!entry.previousRelease || !["serving", "drained"].includes(entry.previousRelease.mode) || !reference(entry.previousRelease.evidenceRef)) {
      errors.push(`${tag}: state whether the previous release serves or is drained, with evidence.`);
    }
    if (entry.previousRelease?.mode === "serving" && !reference(entry.overlap?.evidenceRef)) {
      errors.push(`${tag}: a serving previous release requires a reference to overlapping read/write evidence.`);
    }
    const attempts = entry.rehearsalAttempts;
    if (!Array.isArray(attempts) || attempts.length === 0) {
      errors.push(`${tag}: record rehearsal lock and start outcomes.`);
      continue;
    }
    for (const [index, attempt] of attempts.entries()) {
      if (!attempt || !reference(attempt.resultRef) || !["acquired", "timed_out"].includes(attempt.lock) ||
          typeof attempt.migrationStarted !== "boolean" || !["applied", "failed", "unknown"].includes(attempt.migrationOutcome)) {
        errors.push(`${tag}: rehearsal attempt ${index + 1} must record lock outcome, start, and a result reference.`);
        continue;
      }
      if (attempt.lock === "timed_out" && attempt.migrationStarted) {
        errors.push(`${tag}: a lock-acquisition timeout must be recorded before migration start.`);
      }
      if (attempt.migrationOutcome === "applied" && (attempt.lock !== "acquired" || !attempt.migrationStarted)) {
        errors.push(`${tag}: an applied rehearsal requires an acquired lock and a recorded start.`);
      }
    }
    if (!attempts.some(attempt => attempt?.lock === "acquired" && attempt.migrationStarted === true && attempt.migrationOutcome === "applied")) {
      errors.push(`${tag}: evidence must include a successful exact-SQL rehearsal.`);
    }
  }
  for (const tag of requiredMigrations) {
    if (!suppliedTags.has(tag)) errors.push(`${tag}: missing rollout evidence.`);
  }
  return result;
}
