import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { classifyMigrationSql } from "./migration-compatibility.js";
import { checkMigrationStagingEvidence, type MigrationStagingEvidence, type MigrationStagingManifest } from "./migration-staging-evidence.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const stagingManifest: MigrationStagingManifest = {
  sourceSha,
  migrationCompatibility: { migrations: [{ tag: "0231_drop_legacy", sqlSha256: digest, compatibility: "requires_staging" }] },
};
const validEvidence: MigrationStagingEvidence = {
  version: 1,
  sourceSha,
  owner: "db-operator",
  migrations: [{
    tag: "0231_drop_legacy",
    sqlSha256: digest,
    rollout: {
      kind: "expand_backfill_contract",
      evidenceRef: "https://evidence.invalid/rollout",
      stages: ["expand", "backfill", "contract"].map((phase) => ({
        phase: phase as "expand" | "backfill" | "contract",
        releaseSha: "d".repeat(40),
        evidenceRef: `https://evidence.invalid/${phase}`,
      })),
    },
    previousRelease: { mode: "serving", evidenceRef: "https://evidence.invalid/old-release" },
    overlap: { evidenceRef: "https://evidence.invalid/overlap" },
    attempts: [
      { lock: "timed_out", migrationStarted: false, migrationOutcome: "unknown", resultRef: "https://evidence.invalid/attempt-1" },
      { lock: "acquired", migrationStarted: true, migrationOutcome: "applied", resultRef: "https://evidence.invalid/attempt-2" },
    ],
  }],
};
const withEntry = (changes: Partial<MigrationStagingEvidence["migrations"][number]>): MigrationStagingEvidence => ({
  ...validEvidence,
  migrations: [{ ...validEvidence.migrations[0]!, ...changes }],
});

describe("migration staging evidence", () => {
  it("passes online-compatible migrations without deployment evidence", () => {
    const manifest: MigrationStagingManifest = {
      sourceSha,
      migrationCompatibility: { migrations: [{ tag: "0231_add_column", sqlSha256: digest, compatibility: "online_compatible" }] },
    };
    expect(checkMigrationStagingEvidence(manifest, undefined)).toMatchObject({ passed: true, errors: [], requiredMigrations: [] });
  });

  it("blocks a staging-required migration when evidence is missing", () => {
    expect(checkMigrationStagingEvidence(stagingManifest, undefined)).toMatchObject({
      passed: false,
      errors: [expect.stringContaining("Missing staging evidence")],
      requiredMigrations: ["0231_drop_legacy"],
    });
  });

  it("accepts a valid staged rollout and preserves the pre-start timeout distinction", () => {
    expect(checkMigrationStagingEvidence(stagingManifest, validEvidence)).toMatchObject({ passed: true, errors: [] });
    const explicitStage = withEntry({
      rollout: {
        kind: "staged_deployment",
        evidenceRef: "https://evidence.invalid/staging",
        stages: [{ phase: "staging", releaseSha: "e".repeat(40), evidenceRef: "https://evidence.invalid/staging" }],
      },
    });
    expect(checkMigrationStagingEvidence(stagingManifest, explicitStage).passed).toBe(true);
  });

  it("rejects evidence for another migration revision or a timeout recorded after start", () => {
    const stale = withEntry({
      sqlSha256: "c".repeat(64),
      attempts: [
        { lock: "timed_out", migrationStarted: true, migrationOutcome: "unknown", resultRef: "https://evidence.invalid/attempt" },
        validEvidence.migrations[0]!.attempts[1]!,
      ],
    });
    const result = checkMigrationStagingEvidence(stagingManifest, stale);
    expect(result.passed).toBe(false);
    expect(result.errors.join("\n")).toMatch(/SQL digest does not match/);
    expect(result.errors.join("\n")).toMatch(/timeout must be recorded before migration start/);
  });

  it("requires overlap evidence while the previous release serves and drain evidence otherwise", () => {
    const missing = withEntry({ overlap: undefined });
    expect(checkMigrationStagingEvidence(stagingManifest, missing).errors.join("\n")).toMatch(/requires a reference to overlapping read\/write evidence/);
    const drained = withEntry({
      previousRelease: { mode: "drained", evidenceRef: "https://evidence.invalid/drain" },
      overlap: undefined,
    });
    expect(checkMigrationStagingEvidence(stagingManifest, drained).passed).toBe(true);
  });

  it("fails closed on unknown migrations", () => {
    const manifest: MigrationStagingManifest = {
      sourceSha,
      migrationCompatibility: { migrations: [{ tag: "0231_unknown", sqlSha256: digest, compatibility: "unknown" }] },
    };
    expect(checkMigrationStagingEvidence(manifest, undefined).errors.join("\n")).toMatch(/migration is unknown/);
  });

  it("only gates migrations that the target database has not applied", () => {
    const manifest: MigrationStagingManifest = {
      sourceSha,
      migrationCompatibility: { migrations: [
        { tag: "0230_historical_drop", sqlSha256: digest, compatibility: "requires_staging" },
        { tag: "0231_historical_unknown", sqlSha256: digest, compatibility: "unknown" },
        { tag: "0232_additive", sqlSha256: digest, compatibility: "online_compatible" },
      ] },
    };
    expect(checkMigrationStagingEvidence(manifest, undefined, ["0232_additive"]).passed).toBe(true);
    expect(checkMigrationStagingEvidence(manifest, undefined, ["0231_historical_unknown"]).errors.join("\n")).toMatch(/pending migration is unknown/);
    expect(checkMigrationStagingEvidence(manifest, undefined, ["not-in-manifest"]).errors.join("\n")).toMatch(/missing from the manifest/);
  });

  it("rejects an incomplete phase sequence and malformed evidence payload", () => {
    const baseRollout = validEvidence.migrations[0]!.rollout;
    const incomplete = withEntry({ rollout: { ...baseRollout, stages: baseRollout.stages.slice(0, 1) } });
    expect(checkMigrationStagingEvidence(stagingManifest, incomplete).errors.join("\n")).toMatch(/required order/);
    expect(checkMigrationStagingEvidence(stagingManifest, { ...validEvidence, migrations: undefined } as unknown as MigrationStagingEvidence).passed).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("staged migration overlap fixture", () => {
  it("preserves reads and writes from both releases during an expand migration", async () => {
    const database = await startEmbeddedPostgresTestDatabase("proprio-migration-overlap-");
    const oldRelease = postgres(database.connectionString, { max: 2, onnotice() {} });
    const newRelease = postgres(database.connectionString, { max: 2, onnotice() {} });
    try {
      await oldRelease.unsafe('CREATE TABLE "migration_overlap_fixture" ("id" serial PRIMARY KEY, "legacy_value" text NOT NULL)');
      const expandSql = 'ALTER TABLE "migration_overlap_fixture" ADD COLUMN "expanded_value" text';
      expect(classifyMigrationSql(expandSql).compatibility).toBe("online_compatible");
      await newRelease.unsafe(expandSql);

      const oldWrites = Array.from({ length: 20 }, (_, index) => oldRelease.unsafe(
        'INSERT INTO "migration_overlap_fixture" ("legacy_value") VALUES ($1)', [`old-${index}`],
      ));
      const newWrites = Array.from({ length: 20 }, (_, index) => newRelease.unsafe(
        'INSERT INTO "migration_overlap_fixture" ("legacy_value", "expanded_value") VALUES ($1, $2)', [`new-${index}`, `expanded-${index}`],
      ));
      await Promise.all([...oldWrites, ...newWrites]);

      const oldReads = await oldRelease.unsafe<{ count: string }[]>('SELECT count(*)::text AS count FROM "migration_overlap_fixture" WHERE "legacy_value" IS NOT NULL');
      const newReads = await newRelease.unsafe<{ count: string }[]>('SELECT count(*)::text AS count FROM "migration_overlap_fixture" WHERE "expanded_value" IS NOT NULL');
      expect(oldReads[0]?.count).toBe("40");
      expect(newReads[0]?.count).toBe("20");
    } finally {
      await oldRelease.end({ timeout: 1 });
      await newRelease.end({ timeout: 1 });
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
