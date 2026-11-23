import { Console } from "node:console";
import { afterEach, expect, it, vi } from "vitest";
import { runDatabaseBackup } from "@groktopus/db";
import { dbBackupCommand } from "../commands/db-backup.js";

vi.mock("@groktopus/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@groktopus/db")>(),
  runDatabaseBackup: vi.fn(),
}));
vi.mock("../config/store.js", () => ({
  readConfig: () => null,
  resolveConfigPath: () => "/unused/fixture-config.json",
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function captureStdout() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    chunks.push(String(chunk));
    return true;
  });
  // Vitest normally captures global console calls outside process.stdout.
  const output = new Console(process.stdout, process.stderr);
  vi.spyOn(console, "log").mockImplementation(output.log);
  return () => chunks.join("");
}

const backupFile = "/unused/proprio-fixture.sql.gz";

it.each([
  { engine: "javascript", fallbackReason: "pg_dump_failed", warning: "The pg_dump backup path failed; the JavaScript fallback may not preserve all PostgreSQL features." },
  { engine: "pg_dump", fallbackReason: null, warning: null },
] as const)("writes one JSON receipt to stdout for a $engine backup", async ({ engine, fallbackReason, warning }) => {
  vi.stubEnv("DATABASE_URL", undefined);
  vi.mocked(runDatabaseBackup).mockResolvedValue({
    backupFile, sizeBytes: 100, prunedCount: 0, engine, fallbackReason,
  });
  const stdout = captureStdout();

  await dbBackupCommand({ dir: "/unused", json: true });

  expect(JSON.parse(stdout())).toMatchObject({ backupFile, engine, fallbackReason, warning });
});

it("propagates a backup failure with empty JSON stdout", async () => {
  const failure = new Error("fixture backup failure");
  vi.mocked(runDatabaseBackup).mockRejectedValue(failure);
  const stdout = captureStdout();

  await expect(dbBackupCommand({ dir: "/unused", json: true })).rejects.toBe(failure);
  expect(stdout()).toBe("");
});

it("retains the interactive banner, progress, and completion", async () => {
  vi.mocked(runDatabaseBackup).mockResolvedValue({
    backupFile, sizeBytes: 100, prunedCount: 0, engine: "pg_dump", fallbackReason: null,
  });
  const stdout = captureStdout();

  await dbBackupCommand({ dir: "/unused" });

  expect(stdout()).toContain("proprio db:backup");
  expect(stdout()).toContain("Backup dir:");
  expect(stdout()).toContain("The app people use to manage AI agents for work");
  expect(stdout()).toContain("Backup saved:");
  expect(stdout()).toContain("Backup completed.");
});
