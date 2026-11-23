import type { MigrationCompatibility } from "./migration-compatibility.js";

export type MigrationStagingManifestEntry = {
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
      readonly kind: "expand_backfill_contract" | "staged_deployment";
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
    readonly overlap?: {
      readonly evidenceRef: string;
    };
    readonly attempts: readonly {
      readonly lock: "acquired" | "timed_out";
      readonly migrationStarted: boolean;
      readonly migrationOutcome: "applied" | "failed" | "unknown";
      readonly resultRef: string;
    }[];
  }[];
};

export type MigrationStagingEvidenceResult = {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly requiredMigrations: readonly string[];
};

const reference = (value: unknown): value is string => typeof value === "string" && value.trim().length >= 8;

/**
 * Checks a deployment owner's evidence against the exact migration manifest.
 * It validates the handoff contract and references; it does not interpret
 * deployment policy or claim that referenced operational evidence is truthful.
 */
export function checkMigrationStagingEvidence(
  manifest: MigrationStagingManifest,
  evidence: MigrationStagingEvidence | null | undefined,
  pendingMigrationTags?: readonly string[],
): MigrationStagingEvidenceResult {
  if (!manifest || typeof manifest.sourceSha !== "string" || !Array.isArray(manifest.migrationCompatibility?.migrations)) {
    return { passed: false, errors: ["Invalid migration manifest or compatibility data."], requiredMigrations: [] };
  }
  if (manifest.migrationCompatibility.migrations.some((entry) => !entry || typeof entry.tag !== "string" ||
      typeof entry.sqlSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sqlSha256) ||
      !["online_compatible", "requires_staging", "unknown"].includes(entry.compatibility))) {
    return { passed: false, errors: ["Invalid migration manifest entry."], requiredMigrations: [] };
  }
  const pendingTags = pendingMigrationTags ?? manifest.migrationCompatibility.migrations.map(({ tag }) => tag);
  if (!Array.isArray(pendingTags) || new Set(pendingTags).size !== pendingTags.length ||
      pendingTags.some((tag) => typeof tag !== "string")) {
    return { passed: false, errors: ["Invalid pending migration list."], requiredMigrations: [] };
  }
  const pending = manifest.migrationCompatibility.migrations.filter(({ tag }) => pendingTags.includes(tag));
  const knownTags = new Set(manifest.migrationCompatibility.migrations.map(({ tag }) => tag));
  const missingPending = pendingTags.filter((tag) => !knownTags.has(tag));
  if (missingPending.length > 0) {
    return { passed: false, errors: [`Pending migrations are missing from the manifest: ${missingPending.join(", ")}.`], requiredMigrations: [] };
  }
  const required = pending
    .filter((migration) => migration.compatibility === "requires_staging");
  const requiredMigrations = required.map(({ tag }) => tag);
  const errors: string[] = [];

  if (pending.some(({ compatibility }) => compatibility === "unknown")) {
    errors.push("A pending migration is unknown; classify it before rollout.");
  }
  if (required.length === 0) {
    if (evidence && (!Array.isArray(evidence.migrations) || evidence.migrations.length > 0)) errors.push("Evidence contains invalid or unnecessary entries for a manifest with no staging-required migrations.");
    return { passed: errors.length === 0, errors, requiredMigrations };
  }
  if (!evidence) {
    return { passed: false, errors: [`Missing staging evidence for: ${requiredMigrations.join(", ")}.`], requiredMigrations };
  }
  if (evidence.version !== 1 || evidence.sourceSha !== manifest.sourceSha || !reference(evidence.owner) || !Array.isArray(evidence.migrations)) {
    errors.push("Evidence must identify version 1, the exact manifest source SHA, and a deployment owner.");
    if (!Array.isArray(evidence.migrations)) return { passed: false, errors, requiredMigrations };
  }
  const evidenceEntries = evidence.migrations as readonly MigrationStagingEvidence["migrations"][number][];
  if (evidenceEntries.some((entry) => !entry || typeof entry.tag !== "string")) {
    return { passed: false, errors: [...errors, "Evidence contains an invalid migration entry."], requiredMigrations };
  }
  const entries = new Map(evidenceEntries.map((entry) => [entry.tag, entry]));
  if (entries.size !== evidence.migrations.length) errors.push("Evidence contains duplicate migration entries.");
  for (const migration of required) {
    const entry = entries.get(migration.tag);
    if (!entry) {
      errors.push(`${migration.tag}: missing rollout evidence.`);
      continue;
    }
    if (entry.sqlSha256 !== migration.sqlSha256) errors.push(`${migration.tag}: evidence SQL digest does not match the manifest.`);
    if (!entry.rollout || !["expand_backfill_contract", "staged_deployment"].includes(entry.rollout.kind) || !reference(entry.rollout.evidenceRef) || !Array.isArray(entry.rollout.stages)) {
      errors.push(`${migration.tag}: record the expand/backfill/contract sequence or staged deployment and its evidence reference.`);
    } else {
      const stages = entry.rollout.stages as readonly MigrationStagingEvidence["migrations"][number]["rollout"]["stages"][number][];
      const expectedPhases = entry.rollout.kind === "expand_backfill_contract" ? ["expand", "backfill", "contract"] : ["staging"];
      if (stages.some((stage) => !stage || typeof stage !== "object") ||
          JSON.stringify(stages.map((stage) => stage?.phase)) !== JSON.stringify(expectedPhases) ||
          stages.some((stage) => !stage || !/^[0-9a-f]{40}$/i.test(stage.releaseSha) || !reference(stage.evidenceRef))) {
        errors.push(`${migration.tag}: rollout stages must name their release SHAs and evidence in the required order.`);
      }
    }
    if (!entry.previousRelease || !["serving", "drained"].includes(entry.previousRelease.mode) || !reference(entry.previousRelease.evidenceRef)) {
      errors.push(`${migration.tag}: state whether the previous release serves or is drained, with evidence.`);
    }
    if (entry.previousRelease?.mode === "serving") {
      if (!entry.overlap || !reference(entry.overlap.evidenceRef)) {
        errors.push(`${migration.tag}: a serving previous release requires a reference to overlapping read/write evidence.`);
      }
    } else if (entry.previousRelease?.mode === "drained") {
      // A drain record replaces overlap evidence; the referenced record above
      // is the operator's proof that the old release stopped serving.
    }
    if (!Array.isArray(entry.attempts) || entry.attempts.length === 0) {
      errors.push(`${migration.tag}: record migration lock and start outcomes.`);
    } else {
      const attempts = entry.attempts as readonly MigrationStagingEvidence["migrations"][number]["attempts"][number][];
      for (const [index, attempt] of attempts.entries()) {
        if (!attempt || !reference(attempt.resultRef) || !["acquired", "timed_out"].includes(attempt.lock) || typeof attempt.migrationStarted !== "boolean" || !["applied", "failed", "unknown"].includes(attempt.migrationOutcome)) {
          errors.push(`${migration.tag}: attempt ${index + 1} must record lock outcome, whether migration started, and a result reference.`);
        }
        if (attempt?.lock === "timed_out" && attempt.migrationStarted) {
          errors.push(`${migration.tag}: a lock-acquisition timeout must be recorded before migration start.`);
        }
      }
      if (!attempts.some((attempt) => attempt?.lock === "acquired" && attempt.migrationStarted && attempt.migrationOutcome === "applied")) {
        errors.push(`${migration.tag}: evidence must include an acquired lock followed by a successfully applied migration.`);
      }
    }
  }
  for (const tag of entries.keys()) {
    if (!required.some((migration) => migration.tag === tag)) errors.push(`${tag}: evidence does not match a staging-required migration in the manifest.`);
  }
  return { passed: errors.length === 0, errors, requiredMigrations };
}
