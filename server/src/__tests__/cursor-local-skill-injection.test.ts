import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCursorSkillsInjected } from "@groktopus/adapter-cursor-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkillDir(root: string, name: string) {
  await fs.mkdir(path.join(root, name), { recursive: true });
}

describe("cursor local adapter skill injection", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("links missing Proprio skills into Cursor skills home", async () => {
    const skillsDir = await makeTempDir("proprio-cursor-skills-src-");
    const skillsHome = await makeTempDir("proprio-cursor-skills-home-");
    cleanupDirs.add(skillsDir);
    cleanupDirs.add(skillsHome);

    await createSkillDir(skillsDir, "proprio");
    await createSkillDir(skillsDir, "proprio-create-agent");
    await fs.writeFile(path.join(skillsDir, "README.txt"), "ignore", "utf8");

    const logs: string[] = [];
    await ensureCursorSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      { skillsDir, skillsHome },
    );

    const injectedA = path.join(skillsHome, "proprio");
    const injectedB = path.join(skillsHome, "proprio-create-agent");
    expect((await fs.lstat(injectedA)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(injectedB)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(injectedA)).toBe(await fs.realpath(path.join(skillsDir, "proprio")));
    expect(await fs.realpath(injectedB)).toBe(
      await fs.realpath(path.join(skillsDir, "proprio-create-agent")),
    );
    expect(logs.some((line) => line.includes('Injected Cursor skill "proprio"'))).toBe(true);
    expect(logs.some((line) => line.includes('Injected Cursor skill "proprio-create-agent"'))).toBe(true);
  });

  it("preserves existing targets and only links missing skills", async () => {
    const skillsDir = await makeTempDir("proprio-cursor-preserve-src-");
    const skillsHome = await makeTempDir("proprio-cursor-preserve-home-");
    cleanupDirs.add(skillsDir);
    cleanupDirs.add(skillsHome);

    await createSkillDir(skillsDir, "proprio");
    await createSkillDir(skillsDir, "proprio-create-agent");

    const existingTarget = path.join(skillsHome, "proprio");
    await fs.mkdir(existingTarget, { recursive: true });
    await fs.writeFile(path.join(existingTarget, "keep.txt"), "keep", "utf8");

    await ensureCursorSkillsInjected(async () => {}, { skillsDir, skillsHome });

    expect((await fs.lstat(existingTarget)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(existingTarget, "keep.txt"), "utf8")).toBe("keep");
    expect((await fs.lstat(path.join(skillsHome, "proprio-create-agent"))).isSymbolicLink()).toBe(true);
  });

  it("removes only stale Proprio skill links after selection is revoked", async () => {
    const skillsDir = await makeTempDir("proprio-cursor-revoke-src-");
    const skillsHome = await makeTempDir("proprio-cursor-revoke-home-");
    const external = await makeTempDir("proprio-cursor-external-");
    cleanupDirs.add(skillsDir); cleanupDirs.add(skillsHome); cleanupDirs.add(external);
    await createSkillDir(skillsDir, "proprio");
    await createSkillDir(skillsDir, "complain");
    await createSkillDir(external, "suggestion-box");
    await fs.symlink(path.join(skillsDir, "complain"), path.join(skillsHome, "complain"));
    await fs.symlink(path.join(external, "suggestion-box"), path.join(skillsHome, "suggestion-box"));

    await ensureCursorSkillsInjected(async () => {}, {
      skillsEntries: ["proprio", "complain"].map(name => ({ key: name, runtimeName: name, source: path.join(skillsDir, name) })),
      desiredSkillNames: ["proprio"],
      skillsHome,
    });

    await expect(fs.lstat(path.join(skillsHome, "complain"))).rejects.toThrow();
    expect((await fs.lstat(path.join(skillsHome, "suggestion-box"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(skillsHome, "proprio"))).isSymbolicLink()).toBe(true);
  });

  it("logs per-skill link failures and continues without throwing", async () => {
    const skillsDir = await makeTempDir("proprio-cursor-fail-src-");
    const skillsHome = await makeTempDir("proprio-cursor-fail-home-");
    cleanupDirs.add(skillsDir);
    cleanupDirs.add(skillsHome);

    await createSkillDir(skillsDir, "ok-skill");
    await createSkillDir(skillsDir, "fail-skill");

    const logs: string[] = [];
    await ensureCursorSkillsInjected(
      async (_stream, chunk) => {
        logs.push(chunk);
      },
      {
        skillsDir,
        skillsHome,
        linkSkill: async (source, target) => {
          if (target.endsWith(`${path.sep}fail-skill`)) {
            throw new Error("simulated link failure");
          }
          await fs.symlink(source, target);
        },
      },
    );

    expect((await fs.lstat(path.join(skillsHome, "ok-skill"))).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(skillsHome, "fail-skill"))).rejects.toThrow();
    expect(logs.some((line) => line.includes('Failed to inject Cursor skill "fail-skill"'))).toBe(true);
  });
});
