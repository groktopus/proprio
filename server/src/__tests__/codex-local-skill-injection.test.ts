import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@groktopus/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createProprioRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"proprio"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

describe("codex local adapter skill injection", () => {
  const proprioKey = "groktopus/proprio/proprio";
  const createAgentKey = "groktopus/proprio/proprio-create-agent";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a known live Codex skill link in an isolated home", async () => {
    const currentRepo = await makeTempDir("proprio-codex-current-");
    const oldRepo = await makeTempDir("proprio-codex-old-");
    const skillsHome = await makeTempDir("proprio-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createProprioRepoSkill(currentRepo, "proprio");
    await createProprioRepoSkill(currentRepo, "proprio-create-agent");
    await createProprioRepoSkill(oldRepo, "proprio");
    await fs.symlink(path.join(oldRepo, "skills", "proprio"), path.join(skillsHome, "proprio"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        reconcileUnselected: true,
        managedSkillEntries: [{
          key: proprioKey,
          runtimeName: "proprio",
          source: path.join(oldRepo, "skills", "proprio"),
        }],
        skillsEntries: [
          {
            key: proprioKey,
            runtimeName: "proprio",
            source: path.join(currentRepo, "skills", "proprio"),
          },
          {
            key: createAgentKey,
            runtimeName: "proprio-create-agent",
            source: path.join(currentRepo, "skills", "proprio-create-agent"),
          },
        ],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "proprio"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "proprio")),
    );
    expect(await fs.realpath(path.join(skillsHome, "proprio-create-agent"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "proprio-create-agent")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "proprio"'),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Injected Codex skill "proprio-create-agent"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside Proprio repo checkouts", async () => {
    const currentRepo = await makeTempDir("proprio-codex-current-");
    const customRoot = await makeTempDir("proprio-codex-custom-");
    const skillsHome = await makeTempDir("proprio-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createProprioRepoSkill(currentRepo, "proprio");
    await createCustomSkill(customRoot, "proprio");
    await fs.symlink(path.join(customRoot, "custom", "proprio"), path.join(skillsHome, "proprio"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{
        key: proprioKey,
        runtimeName: "proprio",
        source: path.join(currentRepo, "skills", "proprio"),
      }],
    });

    expect(await fs.realpath(path.join(skillsHome, "proprio"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "proprio")),
    );
  });

  it("prunes broken symlinks for unavailable Proprio repo skills before Codex starts", async () => {
    const currentRepo = await makeTempDir("proprio-codex-current-");
    const oldRepo = await makeTempDir("proprio-codex-old-");
    const skillsHome = await makeTempDir("proprio-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createProprioRepoSkill(currentRepo, "proprio");
    await createProprioRepoSkill(oldRepo, "agent-browser");
    const staleTarget = path.join(oldRepo, "skills", "agent-browser");
    await fs.symlink(staleTarget, path.join(skillsHome, "agent-browser"));
    await fs.rm(staleTarget, { recursive: true, force: true });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{
          key: proprioKey,
          runtimeName: "proprio",
          source: path.join(currentRepo, "skills", "proprio"),
        }],
      },
    );

    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Removed stale Codex skill "agent-browser"'),
      }),
    );
  });

  it("prunes known unselected Codex links in an isolated home", async () => {
    const currentRepo = await makeTempDir("proprio-codex-current-");
    const skillsHome = await makeTempDir("proprio-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(skillsHome);

    await createProprioRepoSkill(currentRepo, "proprio");
    await createProprioRepoSkill(currentRepo, "agent-browser");
    await createProprioRepoSkill(currentRepo, "complain");
    await fs.symlink(
      path.join(currentRepo, "skills", "agent-browser"),
      path.join(skillsHome, "agent-browser"),
    );
    await fs.symlink(path.join(currentRepo, "skills", "complain"), path.join(skillsHome, "complain"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      reconcileUnselected: true,
      managedSkillEntries: ["agent-browser", "complain"].map(runtimeName => ({
        key: `groktopus/proprio/${runtimeName}`,
        runtimeName,
        source: path.join(currentRepo, "skills", runtimeName),
      })),
      skillsEntries: [{
        key: proprioKey,
        runtimeName: "proprio",
        source: path.join(currentRepo, "skills", "proprio"),
      }],
    });

    expect((await fs.lstat(path.join(skillsHome, "proprio"))).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(skillsHome, "agent-browser"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(skillsHome, "complain"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
