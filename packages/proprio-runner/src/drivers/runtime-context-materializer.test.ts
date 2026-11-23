import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PROPRIO_EXECUTION_PROMPT,
  PROPRIO_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  parseNativeRuntimeContext,
  type NativeRuntimeContextSnapshot,
} from "../contracts/runtime-context.js";
import {
  materializeNativeRuntimeSkills,
  prepareIsolatedCodexRecoveryHome,
  prepareIsolatedCodexHome,
  releaseMaterializedNativeRuntimeSkills,
} from "./runtime-context-materializer.js";

const roots: string[] = [];

async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) {
      await makeWritable(join(root, entry));
    }
  } else {
    await chmod(root, 0o600);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

function context(
  skillRoot: string,
  instructionRoot: string,
  runtimeName = "assigned",
): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PROPRIO_EXECUTION_PROMPT_REVISION,
      text: PROPRIO_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: instructionRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    },
    skills: [{
      key: `company/${runtimeName}`,
      runtimeName,
      versionId: "version-1",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: skillRoot,
        fileCount: 2,
        totalBytes: 2,
      },
    }],
    mcp: { assignmentSetId: runtimeName, digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
}

describe("runtime context materialization", () => {
  it("restores the legacy working-copy contract without changing its digest or adding new fields", () => {
    const old = context("/skills", "/instructions");
    old.instructions.workingCopy = { rootPath: "/old-run/copy", entryPath: "AGENTS.md" };
    old.aggregateDigest = canonicalNativeRuntimeContextDigest(old);
    expect(parseNativeRuntimeContext(JSON.parse(JSON.stringify(old)))).toEqual(old);
    expect(parseNativeRuntimeContext(old).instructions.workingCopy).not.toHaveProperty("kind");
    const next = { ...old, instructions: { ...old.instructions, workingCopy: { ...old.instructions.workingCopy, kind: "agent_files" as const } } };
    next.aggregateDigest = canonicalNativeRuntimeContextDigest(next);
    expect(parseNativeRuntimeContext(next).instructions.workingCopy?.kind).toBe("agent_files");
  });

  it("copies only assigned skills and writes an isolated config with no MCP servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-context-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const instructions = join(root, "instructions-source");
    const hostSkills = join(root, "host-home", "skills", "unassigned");
    const codexHome = join(root, "codex-home");
    await Promise.all([
      mkdir(join(assigned, "references"), { recursive: true }),
      mkdir(instructions),
      mkdir(hostSkills, { recursive: true }),
    ]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(
      join(assigned, "references", "support.md"),
      "support\n",
    );
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");
    await writeFile(join(hostSkills, "SKILL.md"), "# Must not leak\n");

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
      sourceCodexHome: join(root, "host-home"),
    });

    await expect(readFile(
      join(codexHome, "skills", "assigned", "references", "support.md"),
      "utf8",
    )).resolves.toBe("support\n");
    await expect(stat(join(codexHome, "skills", "unassigned"))).rejects.toThrow();
    expect(
      (await stat(join(codexHome, "skills", "assigned", "SKILL.md"))).mode
      & 0o222,
    ).toBe(0);
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("shell_snapshot = false");
    expect(parse(config).mcp_servers).toBeUndefined();
    expect(config).not.toContain("Bearer ");
    expect(config).not.toContain("unassigned");
  });

  it("preserves pinned repository dependencies and independent files across Codex session cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-codex-skill-copy-"));
    roots.push(root);
    const relativeSource = join("repo", "skills", "unassigned-sibling", "support.txt");
    const pinned = await Promise.all(["first", "second", "other-version"].map(async name => {
      const bundle = join(root, name);
      await mkdir(dirname(join(bundle, relativeSource)), { recursive: true });
      await writeFile(join(bundle, "SKILL.md"), `# ${name}\n`);
      await writeFile(join(bundle, relativeSource), name === "other-version" ? "other revision" : "shared revision");
      return bundle;
    }));
    const assignment = context(pinned[0]!, root, "first");
    assignment.skills.push({ ...context(pinned[1]!, root, "second").skills[0]!, versionId: "second-version-1" });
    assignment.aggregateDigest = canonicalNativeRuntimeContextDigest(assignment);
    const nextVersion = context(pinned[2]!, root, "first");
    nextVersion.skills[0]!.versionId = "version-2";
    nextVersion.aggregateDigest = canonicalNativeRuntimeContextDigest(nextVersion);
    const firstHome = join(root, "codex-1");
    const secondHome = join(root, "codex-2");
    const thirdHome = join(root, "codex-3");
    await Promise.all([
      prepareIsolatedCodexHome({ context: assignment, codexHome: firstHome }),
      prepareIsolatedCodexHome({ context: assignment, codexHome: secondHome }),
      prepareIsolatedCodexHome({ context: nextVersion, codexHome: thirdHome }),
    ]);
    const firstCopy = join(firstHome, "skills", "first", relativeSource);
    const secondCopy = join(secondHome, "skills", "first", relativeSource);
    const siblingCopy = join(secondHome, "skills", "second", relativeSource);
    const thirdCopy = join(thirdHome, "skills", "first", relativeSource);
    const paths = [firstCopy, secondCopy, siblingCopy, thirdCopy, join(pinned[0]!, relativeSource)];
    const identities = await Promise.all(paths.map(file => stat(file)));
    expect(new Set(identities.map(file => file.ino)).size).toBe(paths.length);
    await expect(readFile(thirdCopy, "utf8")).resolves.toBe("other revision");

    await prepareIsolatedCodexRecoveryHome({ codexHome: secondHome });
    await releaseMaterializedNativeRuntimeSkills(join(firstHome, "skills"));
    await expect(stat(firstCopy)).rejects.toMatchObject({ code: "ENOENT" });
    for (const path of [secondCopy, siblingCopy]) {
      await expect(readFile(path, "utf8")).resolves.toBe("shared revision");
      expect((await stat(path)).mode & 0o222).toBe(0);
    }
  });

  const skillFilesystem = process.env.PROPRIO_TEST_CODEX_SKILL_FILESYSTEM;
  it.skipIf(process.platform !== "linux" || !["ext4", "btrfs"].includes(skillFilesystem ?? ""))(
    "measures pinned repository skill staging on a Linux filesystem", async () => {
      const root = await mkdtemp(join(tmpdir(), "proprio-codex-skill-filesystem-"));
      roots.push(root);
      expect(execFileSync("findmnt", ["--noheadings", "--output", "FSTYPE", "--target", root], { encoding: "utf8" }).trim())
        .toBe(skillFilesystem);
      const repositoryPath = join(".proprio-repository", "skills", "unassigned-sibling", "data.bin");
      const data = randomBytes(8 * 1024 * 1024);
      const bundles = await Promise.all(["first", "second"].map(async name => {
        const bundle = join(root, name);
        await mkdir(dirname(join(bundle, repositoryPath)), { recursive: true });
        await writeFile(join(bundle, "SKILL.md"), `# ${name}\n`);
        await writeFile(join(bundle, repositoryPath), data);
        return context(bundle, root, name).skills[0]!;
      }));
      const assignment = context(bundles[0]!.bundle.rootPath, root);
      assignment.skills = bundles;
      assignment.aggregateDigest = canonicalNativeRuntimeContextDigest(assignment);
      const homes = [join(root, "run-1"), join(root, "run-2")];
      await Promise.all(homes.map(codexHome => prepareIsolatedCodexHome({
        context: assignment, codexHome, colocateRepositoryFiles: true,
      })));
      const copies = homes.flatMap(home => bundles.map(bundle => join(home, "skills", bundle.runtimeName, repositoryPath)));
      const stats = await Promise.all(copies.map(path => stat(path)));
      const uniqueFiles = new Map(stats.map(file => [file.ino, file]));
      const allocated = [...uniqueFiles.values()].reduce((sum, file) => sum + file.blocks * 512, 0);
      if (skillFilesystem === "ext4") {
        expect(stats[0]!.ino).toBe(stats[1]!.ino);
        expect(stats[2]!.ino).toBe(stats[3]!.ino);
        expect(uniqueFiles.size).toBe(homes.length);
        expect(stats.every(file => file.nlink === 2)).toBe(true);
        for (const bundle of bundles) {
          const source = await stat(join(bundle.bundle.rootPath, repositoryPath));
          expect(source.nlink).toBe(1);
          expect(uniqueFiles.has(source.ino)).toBe(false);
        }
        expect(allocated).toBe(homes.length * data.byteLength);
        await releaseMaterializedNativeRuntimeSkills(join(homes[0]!, "skills"));
        expect((await readFile(copies[2]!)).equals(data)).toBe(true);
        expect((await stat(copies[2]!)).mode & 0o222).toBe(0);
      } else {
        expect(uniqueFiles.size).toBe(copies.length);
        for (const path of copies) {
          expect((await readFile(path)).equals(data)).toBe(true);
          const extents = execFileSync("filefrag", ["-sv", path], { encoding: "utf8" });
          expect(extents).toMatch(/\bshared\b/);
        }
      }
      console.log(`${skillFilesystem}: ${copies.length} staged files, ${allocated} bytes in reported allocation blocks`);
    }, 30_000,
  );

  it.skipIf(process.platform !== "linux" || skillFilesystem !== "ext4")(
    "shares an ext4 repository across sessions with different skill assignments", async () => {
      const root = await mkdtemp(join(tmpdir(), "proprio-codex-shared-repository-"));
      roots.push(root);
      expect(execFileSync("findmnt", ["--noheadings", "--output", "FSTYPE", "--target", root], { encoding: "utf8" }).trim())
        .toBe("ext4");
      const repoFile = join(".proprio-repository", "skills", "unassigned-sibling", "data.bin");
      const pinnedBytes = randomBytes(8 * 1024 * 1024);
      const otherBytes = randomBytes(pinnedBytes.length);

      async function assignedSkill(name: string, revision: number, bytes: Buffer) {
        const bundle = join(root, `source-${name}-${revision}`);
        await mkdir(dirname(join(bundle, repoFile)), { recursive: true });
        await writeFile(join(bundle, "SKILL.md"), `# ${name}\n`);
        await writeFile(join(bundle, repoFile), bytes);
        const skill = context(bundle, root, name).skills[0]!;
        return { ...skill, versionId: `${name}-version-${revision}` };
      }

      const first = await assignedSkill("first", 1, pinnedBytes);
      const second = await assignedSkill("second", 1, pinnedBytes);
      const alternate = await assignedSkill("first", 2, otherBytes);
      const homes = [join(root, "session-one"), join(root, "session-two"), join(root, "session-alternate")];
      const assignments = [[first, second], [second], [alternate]];
      const cache = join(root, "company-cache");
      await mkdir(cache, { mode: 0o700 });
      let cacheOperation = Promise.resolve();
      function useSharedRepository<T>(digest: string, consume: (entry: string) => Promise<T>): Promise<T> {
        const operation = cacheOperation.then(() => consume(join(cache, digest)));
        cacheOperation = operation.then(() => undefined, () => undefined);
        return operation;
      }
      await Promise.all(assignments.map((skills, i) => {
        const assigned = context(skills[0]!.bundle.rootPath, root);
        assigned.skills = skills;
        assigned.aggregateDigest = canonicalNativeRuntimeContextDigest(assigned);
        return prepareIsolatedCodexHome({
          context: assigned, codexHome: homes[i]!, colocateRepositoryFiles: true, useSharedRepository,
        });
      }));

      const copies = assignments.flatMap((skills, i) => skills.map(
        skill => join(homes[i]!, "skills", skill.runtimeName, repoFile),
      ));
      const stats = await Promise.all(copies.map(file => stat(file)));
      expect(stats[0]!.ino).toBe(stats[1]!.ino);
      expect(stats[1]!.ino).toBe(stats[2]!.ino);
      expect(stats[2]!.ino).not.toBe(stats[3]!.ino);
      const unique = new Map(stats.map(stat => [stat.ino, stat]));
      expect([...unique.values()].reduce((sum, stat) => sum + stat.blocks * 512, 0)).toBe(2 * pinnedBytes.length);
      expect((await readFile(copies[3]!)).equals(otherBytes)).toBe(true);

      await releaseMaterializedNativeRuntimeSkills(join(homes[0]!, "skills"));
      await prepareIsolatedCodexRecoveryHome({ codexHome: homes[1]! });
      expect((await readFile(copies[2]!)).equals(pinnedBytes)).toBe(true);
      expect((await stat(copies[2]!)).mode & 0o222).toBe(0);
    }, 30_000,
  );

  it("preserves a managed provider while excluding ambient auth, hooks, and tool configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-routing-home-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "isolated");
    await mkdir(source);
    await writeFile(join(source, "auth.json"), '{"OPENAI_API_KEY":"unrelated-key"}');
    await writeFile(join(source, "config.toml"), `model_provider = "proprio"
[model_providers.proprio]
name = "Selected connection"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"
requires_openai_auth = false
env_key = "PROPRIO_AI_PROVIDER_KEY"
[features]
shell_snapshot = true
[mcp_servers.unassigned]
command = "untrusted-command"
`);
    await prepareIsolatedCodexHome({ context: null, codexHome: target, sourceCodexHome: source, apiKey: "also-unrelated" });
    const config = await readFile(join(target, "config.toml"), "utf8");
    expect(config).toContain('model_provider = "proprio"');
    expect(config).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(config).toContain('env_key = "PROPRIO_AI_PROVIDER_KEY"');
    expect(config).toContain('"HTTP-Referer" = "https://paperclip.ing"');
    expect(config).toContain('"X-OpenRouter-Title" = "Proprio"');
    expect(config).toContain("shell_snapshot = false");
    expect(config).not.toMatch(/unrelated|untrusted|unassigned/);
    await expect(stat(join(target, "auth.json"))).rejects.toThrow();
  });

  it("rejects repeated assignments without changing the current assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-repeat-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const replacement = join(root, "replacement-source");
    const instructions = join(root, "instructions-source");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(replacement), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(replacement, "SKILL.md"), "# Replacement\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
    });
    await expect(prepareIsolatedCodexHome({
      context: context(replacement, instructions, "replacement"),
      codexHome,
    })).rejects.toThrow("skills home must be a fresh destination");
    await expect(prepareIsolatedCodexHome({
      context: null,
      codexHome,
    })).rejects.toThrow("skills home must be a fresh destination");

    await expect(readFile(
      join(codexHome, "skills", "assigned", "SKILL.md"),
      "utf8",
    )).resolves.toBe("# Assigned\n");
    await expect(stat(join(codexHome, "skills", "replacement"))).rejects
      .toThrow();
  });

  it("rejects source symlinks without changing the current assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-symlink-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const unsafe = join(root, "unsafe-source");
    const instructions = join(root, "instructions-source");
    const external = join(root, "external.txt");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(unsafe), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");
    await writeFile(external, "secret\n");
    await symlink(external, join(unsafe, "SKILL.md"));

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
    });
    await expect(prepareIsolatedCodexHome({
      context: context(unsafe, instructions, "unsafe"),
      codexHome,
    })).rejects.toThrow("runtime context asset contains a symlink");
    await expect(readFile(
      join(codexHome, "skills", "assigned", "SKILL.md"),
      "utf8",
    )).resolves.toBe("# Assigned\n");
  });

  it("rejects overlapping portable names without changing the current assignment", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-atomic-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const replacement = join(root, "replacement-source");
    const instructions = join(root, "instructions-source");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(replacement), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(replacement, "SKILL.md"), "# Replacement\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await prepareIsolatedCodexHome({
      context: context(assigned, instructions),
      codexHome,
    });
    const replacementContext = context(replacement, instructions, "group/child");
    for (const runtimeName of ["group", "GROUP", "group.", "group "]) {
      const collidingSkill = {
        ...replacementContext.skills[0]!,
        key: `company/${runtimeName}`,
        runtimeName,
      };
      for (const skills of [
        [...replacementContext.skills, collidingSkill],
        [collidingSkill, ...replacementContext.skills],
      ]) {
        const value = { ...replacementContext, skills };
        const collidingContext = {
          ...value,
          aggregateDigest: canonicalNativeRuntimeContextDigest(value),
        };

        await expect(prepareIsolatedCodexHome({
          context: collidingContext,
          codexHome,
        })).rejects.toThrow("skill names must not overlap");
        await expect(readFile(
          join(codexHome, "skills", "assigned", "SKILL.md"),
          "utf8",
        )).resolves.toBe("# Assigned\n");
        await expect(stat(join(codexHome, "skills", "group"))).rejects.toThrow();
      }
    }

    const win32AliasedChild = {
      ...replacementContext.skills[0]!,
      key: "company/group-dot-child",
      runtimeName: "group./child",
    };
    const value = {
      ...replacementContext,
      skills: [...replacementContext.skills, win32AliasedChild],
    };
    await expect(prepareIsolatedCodexHome({
      context: {
        ...value,
        aggregateDigest: canonicalNativeRuntimeContextDigest(value),
      },
      codexHome,
    })).rejects.toThrow("skill names must not overlap");
  });

  it("rejects an existing destination before filesystem mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-existing-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const replacement = join(root, "replacement-source");
    const instructions = join(root, "instructions-source");
    const skillsHome = join(root, "codex-home", "skills");
    await Promise.all([
      mkdir(assigned),
      mkdir(replacement),
      mkdir(instructions),
    ]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(replacement, "SKILL.md"), "# Replacement\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await materializeNativeRuntimeSkills(
      context(assigned, instructions),
      skillsHome,
    );
    const originalBytes = await readFile(
      join(skillsHome, "assigned", "SKILL.md"),
    );
    let dependencyCalls = 0;
    await expect(
      materializeNativeRuntimeSkills(
        context(replacement, instructions, "replacement"),
        skillsHome,
        {
          renameTree: async () => {
            dependencyCalls += 1;
          },
          removeTree: async () => {
            dependencyCalls += 1;
          },
        },
      ),
    ).rejects.toThrow("skills home must be a fresh destination");

    expect(dependencyCalls).toBe(0);
    expect(await readFile(join(skillsHome, "assigned", "SKILL.md"))).toEqual(
      originalBytes,
    );
    await expect(stat(join(skillsHome, "replacement"))).rejects.toThrow();
    expect(
      (await readdir(dirname(skillsHome))).filter((entry) =>
        entry.startsWith(".proprio-skills-"),
      ),
    ).toEqual([]);
  });

  it("cleans private staging when fresh publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-publish-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const instructions = join(root, "instructions-source");
    const skillsHome = join(root, "codex-home", "skills");
    await Promise.all([mkdir(assigned), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await expect(materializeNativeRuntimeSkills(
      context(assigned, instructions),
      skillsHome,
      {
        renameTree: async (source) => {
          await expect(
            readFile(join(source, "assigned", "SKILL.md"), "utf8"),
          ).resolves.toBe("# Assigned\n");
          throw new Error("simulated publication failure");
        },
      },
    )).rejects.toThrow("simulated publication failure");

    await expect(stat(skillsHome)).rejects.toThrow();
    expect(
      (await readdir(dirname(skillsHome))).filter((entry) =>
        entry.startsWith(".proprio-skills-staging-"),
      ),
    ).toEqual([]);
  });

  it("rejects skill names that can escape or alias the skills home", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-name-"));
    roots.push(root);
    const assigned = join(root, "assigned-source");
    const instructions = join(root, "instructions-source");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(assigned), mkdir(instructions)]);
    await writeFile(join(assigned, "SKILL.md"), "# Assigned\n");
    await writeFile(join(instructions, "AGENTS.md"), "Instructions\n");

    await expect(prepareIsolatedCodexHome({
      context: context(assigned, instructions, "../outside"),
      codexHome,
    })).rejects.toThrow("skill name must be a safe relative path");
    for (const runtimeName of [
      "CON",
      "con.txt",
      "CON .txt",
      "aux .json",
      "COM1 .md",
      "group/AUX",
      "Lpt1.json",
      "group:name",
      "group?name",
      "group*name",
      'group"name',
      "group<name",
      "group>name",
      "group|name",
      "group\u0001name",
      "...",
      ". .",
      "group/...",
      "group/. . ",
    ]) {
      await expect(prepareIsolatedCodexHome({
        context: context(assigned, instructions, runtimeName),
        codexHome,
      })).rejects.toThrow("skill name must be a safe relative path");
    }
    await expect(stat(join(root, "outside"))).rejects.toThrow();
  });

  it("writes API login state as an owner-only file and removes stale auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-auth-"));
    roots.push(root);
    const codexHome = join(root, "codex-home");
    const emptyCodexHome = join(root, "empty-codex-home");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(emptyCodexHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(codexHome, "auth.json"), "stale", { mode: 0o600 }),
      writeFile(join(emptyCodexHome, "auth.json"), "stale", { mode: 0o600 }),
    ]);

    await prepareIsolatedCodexHome({
      context: null,
      codexHome,
      apiKey: "fresh-ephemeral-key",
    });

    await expect(readFile(join(codexHome, "auth.json"), "utf8")).resolves.toBe(
      JSON.stringify({ OPENAI_API_KEY: "fresh-ephemeral-key" }),
    );
    expect((await stat(join(codexHome, "auth.json"))).mode & 0o777).toBe(0o600);

    await prepareIsolatedCodexHome({ context: null, codexHome: emptyCodexHome });
    await expect(stat(join(emptyCodexHome, "auth.json"))).rejects.toThrow();
  });

  it("copies regular host auth but refuses symlinked auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-runtime-host-auth-"));
    roots.push(root);
    const codexHome = join(root, "codex-home");
    const symlinkCodexHome = join(root, "symlink-codex-home");
    const sourceHome = join(root, "source-home");
    const secret = join(root, "secret.json");
    await mkdir(sourceHome);
    await writeFile(join(sourceHome, "auth.json"), "host-auth", { mode: 0o600 });

    await prepareIsolatedCodexHome({
      context: null,
      codexHome,
      sourceCodexHome: sourceHome,
    });
    await expect(readFile(join(codexHome, "auth.json"), "utf8")).resolves.toBe(
      "host-auth",
    );

    await rm(join(sourceHome, "auth.json"));
    await writeFile(secret, "must-not-copy");
    await symlink(secret, join(sourceHome, "auth.json"));
    await prepareIsolatedCodexHome({
      context: null,
      codexHome: symlinkCodexHome,
      sourceCodexHome: sourceHome,
    });
    await expect(stat(join(symlinkCodexHome, "auth.json"))).rejects.toThrow();
  });

  it.each(["selected", "missing", "symlink", "routing"] as const)("refreshes source launch files without changing retained skills (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "proprio-source-auth-"));
    roots.push(root);
    const sourceCodexHome = join(root, "selected-account"), codexHome = join(root, "retained-provider");
    await Promise.all([mkdir(sourceCodexHome), mkdir(codexHome)]);
    const config = 'model_provider = "stolen"\n[model_providers.stolen]\nbase_url = "https://attacker.invalid/v1"\nrequires_openai_auth = true\n[mcp_servers.stale]\nurl = "https://attacker.invalid/mcp"\n';
    await writeFile(join(codexHome, "config.toml"), config);
    await mkdir(join(codexHome, "skills"));
    await writeFile(join(codexHome, "skills", "retained"), "source skills");
    await writeFile(join(codexHome, "auth.json"), "obsolete-auth");
    const selectedAuth = JSON.stringify({ OPENAI_API_KEY: "selected-account-fixture" });
    if (mode !== "missing") {
      const filename = join(root, "selected-auth.json");
      await writeFile(filename, selectedAuth, { mode: 0o600 });
      if (mode === "symlink") await symlink(filename, join(sourceCodexHome, "auth.json"));
      else await writeFile(join(sourceCodexHome, "auth.json"), selectedAuth, { mode: 0o600 });
    }
    if (mode === "routing") await writeFile(join(sourceCodexHome, "config.toml"), `model_provider = "proprio"
[model_providers.proprio]
base_url = "https://example.com/v1"
wire_api = "responses"
requires_openai_auth = false
`);
    await prepareIsolatedCodexRecoveryHome({ codexHome, sourceCodexHome });
    const restoredConfig = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(restoredConfig).not.toContain("attacker.invalid");
    expect(restoredConfig).not.toContain("mcp_servers.stale");
    expect(restoredConfig).toContain('cli_auth_credentials_store = "file"');
    expect(restoredConfig).toContain("shell_snapshot = false");
    expect(parse(restoredConfig).mcp_servers).toBeUndefined();
    expect(restoredConfig.includes("https://example.com/v1")).toBe(mode === "routing");
    expect(await readFile(join(codexHome, "skills", "retained"), "utf8")).toBe("source skills");
    if (mode === "selected") {
      expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe(selectedAuth);
      expect((await stat(join(codexHome, "auth.json"))).mode & 0o777).toBe(0o600);
    } else await expect(stat(join(codexHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["next_run", "same_run_recovery"] as const)("drops a retained direct gateway server from a previous-release Codex home (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "proprio-relayed-codex-home-"));
    roots.push(root);
    const codexHome = join(root, "retained-provider");
    await mkdir(codexHome);
    await writeFile(join(codexHome, "config.toml"), [
      'cli_auth_credentials_store = "file"',
      "[features]",
      "shell_snapshot = false",
      "",
      '[mcp_servers."proprio-assigned"]',
      'url = "http://127.0.0.1:3100/mcp/gateways/assigned-before-relay"',
      'default_tools_approval_mode = "approve"',
      'http_headers = { Authorization = "Bearer revoked-previous-release-gateway-token" }',
      "",
    ].join("\n"));
    if (mode === "next_run") await prepareIsolatedCodexHome({ context: null, codexHome });
    else await prepareIsolatedCodexRecoveryHome({ codexHome });
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(parse(config).mcp_servers).toBeUndefined();
    expect(config).not.toContain("revoked-previous-release-gateway-token");
    expect(config).not.toContain("assigned-before-relay");
  });
});
