import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROPRIO_FEEDBACK_SKILL_KEYS } from "@groktopus/adapter-utils/server-utils";
import {
  listCodexSkills,
  syncCodexSkills,
} from "@groktopus/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("codex local skill sync", () => {
  const proprioKey = "groktopus/proprio/proprio";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("defaults the operational Proprio skill for workspace injection on the next run", async () => {
    const codexHome = await makeTempDir("proprio-codex-skill-sync-");
    cleanupDirs.add(codexHome);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
      },
    } as const;

    const before = await listCodexSkills(ctx);
    expect(before.mode).toBe("ephemeral");
    expect(before.desiredSkills).toContain(proprioKey);
    for (const feedbackKey of PROPRIO_FEEDBACK_SKILL_KEYS) expect(before.desiredSkills).not.toContain(feedbackKey);
    expect(before.entries.find((entry) => entry.key === proprioKey)?.state).toBe("configured");
    expect(before.entries.find((entry) => entry.key === proprioKey)?.detail).toContain("CODEX_HOME/skills/");
  });

  it("does not apply the legacy operational skill default to the native runner", async () => {
    const snapshot = await listCodexSkills({
      agentId: "agent-native",
      companyId: "company-1",
      adapterType: "proprio_runner",
      config: {},
    });

    expect(snapshot.adapterType).toBe("proprio_runner");
    expect(snapshot.desiredSkills).toEqual([]);
    expect(snapshot.entries.find((entry) => entry.key === proprioKey)?.state).toBe("available");
  });

  it("does not persist Proprio skills into CODEX_HOME during sync", async () => {
    const codexHome = await makeTempDir("proprio-codex-skill-prune-");
    cleanupDirs.add(codexHome);

    const configuredCtx = {
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        proprioSkillSync: {
          desiredSkills: [proprioKey],
        },
      },
    } as const;

    const after = await syncCodexSkills(configuredCtx, [proprioKey]);
    expect(after.mode).toBe("ephemeral");
    expect(after.entries.find((entry) => entry.key === proprioKey)?.state).toBe("configured");
    await expect(fs.lstat(path.join(codexHome, "skills", "proprio"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("normalizes legacy flat Proprio skill refs before reporting configured state", async () => {
    const codexHome = await makeTempDir("proprio-codex-legacy-skill-sync-");
    cleanupDirs.add(codexHome);

    const snapshot = await listCodexSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        env: {
          CODEX_HOME: codexHome,
        },
        proprioSkillSync: {
          desiredSkills: ["proprio"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(proprioKey);
    expect(snapshot.desiredSkills).not.toContain("proprio");
    expect(snapshot.entries.find((entry) => entry.key === proprioKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "proprio")).toBeUndefined();
  });
});
