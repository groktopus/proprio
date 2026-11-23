import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { classifyMigrationSql } from "./migration-compatibility.js";
import { checkMigrationStagingEvidence, type MigrationStagingEvidence, type MigrationStagingManifest } from "./migration-staging-evidence.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const execute = promisify(execFile);
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const migrationTag = "0501_sour_pepper_potts";
const migrationFile = `${migrationTag}.sql`;
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
      evidenceRef: "https://evidence.invalid/rollout",
      stages: ["expand", "backfill", "contract"].map((phase) => ({
        phase: phase as "expand" | "backfill" | "contract",
        releaseSha: "d".repeat(40),
        evidenceRef: `https://evidence.invalid/${phase}`,
      })),
    },
    previousRelease: { mode: "serving", evidenceRef: "https://evidence.invalid/old-release" },
    overlap: { evidenceRef: "https://evidence.invalid/overlap" },
    rehearsalAttempts: [
      { lock: "timed_out", migrationStarted: false, migrationOutcome: "unknown", resultRef: "https://evidence.invalid/attempt-1" },
      { lock: "acquired", migrationStarted: true, migrationOutcome: "applied", resultRef: "https://evidence.invalid/attempt-2" },
    ],
  }],
};
const pending = ["0231_drop_legacy"];
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
    expect(checkMigrationStagingEvidence(manifest, undefined, ["0231_add_column"])).toEqual({ errors: [], requiredMigrations: [] });
  });

  it("blocks a staging-required migration when evidence is missing", () => {
    expect(checkMigrationStagingEvidence(stagingManifest, undefined, pending)).toMatchObject({
      errors: [expect.stringContaining("Missing staging evidence")],
      requiredMigrations: ["0231_drop_legacy"],
    });
  });

  it("accepts a valid staged rollout and preserves the pre-start timeout distinction", () => {
    expect(checkMigrationStagingEvidence(stagingManifest, validEvidence, pending)).toMatchObject({ errors: [] });
    const explicitStage = withEntry({
      rollout: {
        evidenceRef: "https://evidence.invalid/staging",
        stages: [{ phase: "staging", releaseSha: "e".repeat(40), evidenceRef: "https://evidence.invalid/staging" }],
      },
    });
    expect(checkMigrationStagingEvidence(stagingManifest, explicitStage, pending).errors).toEqual([]);
  });

  it("rejects evidence for another migration revision or a timeout recorded after start", () => {
    const stale = withEntry({
      sqlSha256: "c".repeat(64),
      rehearsalAttempts: [
        { lock: "timed_out", migrationStarted: true, migrationOutcome: "unknown", resultRef: "https://evidence.invalid/attempt" },
        validEvidence.migrations[0]!.rehearsalAttempts[1]!,
      ],
    });
    const result = checkMigrationStagingEvidence(stagingManifest, stale, pending);
    expect(result.errors.join("\n")).toMatch(/SQL digest does not match/);
    expect(result.errors.join("\n")).toMatch(/timeout must be recorded before migration start/);
  });

  it("requires overlap evidence while the previous release serves and drain evidence otherwise", () => {
    const missing = withEntry({ overlap: undefined });
    expect(checkMigrationStagingEvidence(stagingManifest, missing, pending).errors.join("\n")).toMatch(/requires a reference to overlapping read\/write evidence/);
    const drained = withEntry({
      previousRelease: { mode: "drained", evidenceRef: "https://evidence.invalid/drain" },
      overlap: undefined,
    });
    expect(checkMigrationStagingEvidence(stagingManifest, drained, pending).errors).toEqual([]);
  });

  it("fails closed on unknown migrations", () => {
    const manifest: MigrationStagingManifest = {
      sourceSha,
      migrationCompatibility: { migrations: [{ tag: "0231_unknown", sqlSha256: digest, compatibility: "unknown" }] },
    };
    expect(checkMigrationStagingEvidence(manifest, undefined, ["0231_unknown"]).errors.join("\n")).toMatch(/migration is unknown/);
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
    expect(checkMigrationStagingEvidence(manifest, undefined, ["0232_additive"]).errors).toEqual([]);
    expect(checkMigrationStagingEvidence(manifest, undefined, ["0231_historical_unknown"]).errors.join("\n")).toMatch(/pending migration is unknown/);
    expect(checkMigrationStagingEvidence(manifest, undefined, ["not-in-manifest"]).errors.join("\n")).toMatch(/missing from the manifest/);
  });

  it("rejects an incomplete phase sequence and malformed evidence payload", () => {
    const baseRollout = validEvidence.migrations[0]!.rollout;
    const incomplete = withEntry({ rollout: { ...baseRollout, stages: baseRollout.stages.slice(0, 1) } });
    expect(checkMigrationStagingEvidence(stagingManifest, incomplete, pending).errors.join("\n")).toMatch(/required order/);
    expect(checkMigrationStagingEvidence(stagingManifest, { ...validEvidence, migrations: undefined } as unknown as MigrationStagingEvidence, pending).errors.length).toBeGreaterThan(0);
  });

  it("rejects contradictions even when another rehearsal succeeded", () => {
    const evidence = withEntry({ rehearsalAttempts: [
      { ...validEvidence.migrations[0]!.rehearsalAttempts[0]!, migrationOutcome: "applied" },
      validEvidence.migrations[0]!.rehearsalAttempts[1]!,
    ] });
    expect(checkMigrationStagingEvidence(stagingManifest, evidence, pending).errors.join("\n"))
      .toMatch(/applied rehearsal requires an acquired lock/);
  });

  it("allows retained evidence after its migration applies and still validates its header", () => {
    expect(checkMigrationStagingEvidence(stagingManifest, { ...validEvidence, owner: "db" }, []).errors).toEqual([]);
    expect(checkMigrationStagingEvidence(stagingManifest, { ...validEvidence, sourceSha: "unrelated" }, []).errors.join("\n"))
      .toMatch(/exact manifest source SHA/);
  });

  it("rejects an abbreviated manifest SHA, duplicate tags, and a non-string stage SHA", () => {
    const entry = stagingManifest.migrationCompatibility.migrations[0]!;
    expect(checkMigrationStagingEvidence({ ...stagingManifest, sourceSha: "deadbeef" }, validEvidence, pending).errors.join("\n"))
      .toMatch(/Invalid migration manifest/);
    expect(checkMigrationStagingEvidence({
      ...stagingManifest, migrationCompatibility: { migrations: [entry, entry] },
    }, validEvidence, pending).errors.join("\n")).toMatch(/duplicate migration tags/);
    const rollout = validEvidence.migrations[0]!.rollout;
    const malformed = withEntry({ rollout: { ...rollout, stages: [{ ...rollout.stages[0]!,
      phase: "staging", releaseSha: [sourceSha] as unknown as string }] } });
    expect(checkMigrationStagingEvidence(stagingManifest, malformed, pending).errors.join("\n")).toMatch(/release SHAs/);
  });

  it("uses migration status filenames and rejects null pending lists through the checker command", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pr-staging-status-"));
    const manifestPath = path.join(directory, "manifest.json");
    const statusPath = path.join(directory, "status.json");
    const checker = fileURLToPath(new URL("../scripts/check-migration-staging-evidence.ts", import.meta.url));
    const run = () => execute(process.execPath, ["--import", loader, checker, manifestPath, statusPath], { timeout: 10_000 });
    try {
      await writeFile(manifestPath, JSON.stringify({
        ...stagingManifest,
        migrationCompatibility: { migrations: [{ tag: migrationTag, sqlSha256: digest, compatibility: "online_compatible" }] },
      }));
      await writeFile(statusPath, JSON.stringify({ status: "needsMigrations", pendingMigrations: [migrationFile] }));
      expect((await run()).stdout).toContain("No staging-required migrations");
      await writeFile(statusPath, JSON.stringify({ status: "upToDate", pendingMigrations: [] }));
      expect((await run()).stdout).toContain("No staging-required migrations");
      await writeFile(statusPath, JSON.stringify({ status: "needsMigrations", pendingMigrations: null }));
      await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Invalid pending migration filenames") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("staged migration overlap fixture", () => {
  it("blocks a gated migration before DDL without evidence or matching packaged SQL", async () => {
    const database = await startEmbeddedPostgresTestDatabase("pr-migration-gate-");
    const sql = postgres(database.connectionString, { max: 1, onnotice() {} });
    const directory = await mkdtemp(path.join(tmpdir(), "pr-migration-gate-"));
    const manifestPath = path.join(directory, "manifest.json");
    const evidencePath = path.join(directory, "evidence.json");
    const migrate = fileURLToPath(new URL("./migrate.ts", import.meta.url));
    const sqlBytes = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url));
    const hash = createHash("sha256").update(sqlBytes).digest("hex");
    const writeManifest = (sqlSha256: string) => writeFile(manifestPath, JSON.stringify({
      sourceSha,
      migrationCompatibility: { migrations: [{ tag: migrationTag, sqlSha256, compatibility: "requires_staging" }] },
    }));
    const writeEvidence = (sqlSha256: string) => writeFile(evidencePath, JSON.stringify(withEntry({ tag: migrationTag, sqlSha256 })));
    const run = (...args: string[]) => execute(process.execPath, ["--import", loader, migrate, "--rollout-manifest", manifestPath, ...args], {
      env: { ...process.env, DATABASE_URL: database.connectionString },
      timeout: 12_000,
    });
    try {
      await sql`ALTER TABLE routine_runs DROP COLUMN assignment_wake_pending`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await writeManifest(hash);
      await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Missing staging evidence") });
      expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toEqual([]);
      expect(await sql`SELECT 1 FROM pg_attribute
        WHERE attrelid = 'routine_runs'::regclass AND attname = 'assignment_wake_pending' AND NOT attisdropped`).toEqual([]);

      await writeManifest(digest);
      await writeEvidence(digest);
      await expect(run("--staging-evidence", evidencePath))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("pending SQL does not match") });

      await writeManifest(hash);
      await writeEvidence(hash);
      expect((await run("--staging-evidence", evidencePath)).stdout).toContain("Migrations complete");
      expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toEqual([{ hash }]);
      expect((await run("--staging-evidence", evidencePath)).stdout).toContain("No pending migrations");
    } finally {
      await sql.end({ timeout: 1 });
      await database.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

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
