import { afterEach, expect, it, vi } from "vitest";
import { runDatabaseBackup } from "@groktopus/db";
import { dbBackupCommand } from "../commands/db-backup.js";

vi.mock("@groktopus/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@groktopus/db")>(),
  runDatabaseBackup: vi.fn(),
}));
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { message: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));
vi.mock("../utils/banner.js", () => ({ printProprioCliBanner: vi.fn() }));
vi.mock("../config/store.js", () => ({
  readConfig: () => null,
  resolveConfigPath: () => "/unused/fixture-config.json",
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("includes the selected engine and fixed fallback warning in db:backup --json", async () => {
  vi.stubEnv("DATABASE_URL", undefined);
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const provenance = {
    engine: "javascript" as const,
    fallbackReason: "pg_dump_failed" as const,
  };
  vi.mocked(runDatabaseBackup).mockResolvedValue({
    backupFile: "/unused/proprio-fixture.sql.gz", sizeBytes: 100, prunedCount: 0, ...provenance,
  });

  await dbBackupCommand({ dir: "/unused", json: true });

  expect(consoleLog).toHaveBeenCalledOnce();
  expect(JSON.parse(String(consoleLog.mock.calls[0]?.[0]))).toMatchObject({
    ...provenance,
    warning: "The pg_dump backup path failed; the JavaScript fallback may not preserve all PostgreSQL features.",
  });
});
