import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listGeminiSkills,
  syncGeminiSkills,
} from "@groktopus/adapter-gemini-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("gemini local skill sync", () => {
  const proprioKey = "groktopus/proprio/proprio";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("defaults and installs the operational Proprio skill in the Gemini skills home", async () => {
    const home = await makeTempDir("proprio-gemini-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        env: {
          HOME: home,
        },
      },
    } as const;

    const before = await listGeminiSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(proprioKey);
    expect(before.entries.find((entry) => entry.key === proprioKey)?.state).toBe("missing");

    const after = await syncGeminiSkills(ctx, [proprioKey]);
    expect(after.entries.find((entry) => entry.key === proprioKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".gemini", "skills", "proprio"))).isSymbolicLink()).toBe(true);
  });

  it("isolates managed skills in each configured GEMINI_CLI_HOME", async () => {
    const root = await makeTempDir("proprio-gemini-cli-home-sync-");
    cleanupDirs.add(root);
    const firstHome = path.join(root, "first-provider-home");
    const secondHome = path.join(root, "second-provider-home");
    const firstSkill = path.join(root, "first-skill");
    const secondSkill = path.join(root, "second-skill");
    await fs.mkdir(firstSkill, { recursive: true });
    await fs.mkdir(secondSkill, { recursive: true });

    const firstContext = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "gemini_local",
      config: {
        env: { GEMINI_CLI_HOME: firstHome },
        proprioRuntimeSkills: [{ key: "first", runtimeName: "first", source: firstSkill }],
      },
    } as const;
    const secondContext = {
      ...firstContext,
      config: {
        env: { GEMINI_CLI_HOME: secondHome },
        proprioRuntimeSkills: [{ key: "second", runtimeName: "second", source: secondSkill }],
      },
    } as const;

    await syncGeminiSkills(firstContext, ["first"]);
    await syncGeminiSkills(secondContext, ["second"]);

    const firstSkillsHome = path.join(firstHome, ".gemini", "skills");
    const secondSkillsHome = path.join(secondHome, ".gemini", "skills");
    expect((await fs.lstat(path.join(firstSkillsHome, "first"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(secondSkillsHome, "second"))).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(firstSkillsHome, "second"))).rejects.toThrow();
    await expect(fs.lstat(path.join(secondSkillsHome, "first"))).rejects.toThrow();
    await syncGeminiSkills(secondContext, []);
    expect((await fs.lstat(path.join(firstSkillsHome, "first"))).isSymbolicLink()).toBe(true);
  });

  it("uses inherited GEMINI_CLI_HOME unless agent env overrides it", async () => {
    const root = await makeTempDir("proprio-gemini-inherited-cli-home-");
    cleanupDirs.add(root);
    const previousGeminiHome = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = path.join(root, "inherited-home");
    const inheritedContext = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "gemini_local",
      config: { env: {} },
    } as const;
    try {
      await syncGeminiSkills(inheritedContext, [proprioKey]);
      expect((await fs.lstat(path.join(root, "inherited-home", ".gemini", "skills", "proprio"))).isSymbolicLink()).toBe(true);
      const override = path.join(root, "override-home");
      const relativeOverride = path.relative(process.cwd(), override);
      await syncGeminiSkills({
        ...inheritedContext,
        config: { env: { GEMINI_CLI_HOME: relativeOverride } },
      }, [proprioKey]);
      expect((await fs.lstat(path.join(override, ".gemini", "skills", "proprio"))).isSymbolicLink()).toBe(true);
    } finally {
      if (previousGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = previousGeminiHome;
    }
  });
});
