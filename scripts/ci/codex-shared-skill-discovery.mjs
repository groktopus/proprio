import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessCodexAppServerTransport } from "../../packages/proprio-runner/src/drivers/codex/app-server-transport.ts";
import { codexExecutableReadOnlyRoots, createIsolatedCodexAppServerArgs } from "../../packages/proprio-runner/src/drivers/codex/codex-security-config.ts";
import { REPOSITORY_CONTENT_DIR, repositorySkillProjection } from "../../server/src/services/skill-repository-package.ts";

const codex = fileURLToPath(new URL("../../packages/proprio-runner/node_modules/@openai/codex/bin/codex.js", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "proprio-shared-skills-"));
const skillName = "proprio-shared-skill-fixture";
const rootFile = join(REPOSITORY_CONTENT_DIR, "shared.txt");
const useHardlinks = process.env.PROPRIO_TEST_CODEX_SHARED_INODES === "1";
const repositories = join(root, "repositories");

async function createRepository(revision) {
  const repository = join(repositories, revision);
  const entry = "skills/assigned/SKILL.md";
  const files = repositorySkillProjection([
    { path: entry, kind: "skill", content: `---\nname: ${skillName}\ndescription: Pinned repository discovery fixture.\n---\nRead ../../shared.txt and ../unassigned-sibling/data.txt.\n` },
    { path: "shared.txt", kind: "reference", content: `root from ${revision}\n` },
    { path: "skills/unassigned-sibling/data.txt", kind: "reference", content: `unassigned sibling from ${revision}\n` },
  ], entry);
  for (const file of files) {
    if (!file.path.startsWith(REPOSITORY_CONTENT_DIR + sep)) continue;
    const path = join(repository, file.path.slice(REPOSITORY_CONTENT_DIR.length + 1));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { mode: 0o444 });
  }
  return { repository, files };
}

async function createAssignment(name, { repository, files }) {
  const home = join(root, "assignments", name);
  // Codex reports the resolved wrapper path. Keep it outside the denied
  // discovery and private home paths so commands can use its sibling files.
  const skill = join(root, "wrappers", name, skillName);
  const skills = join(home, ".agents", "skills");
  await mkdir(skills, { recursive: true });
  await mkdir(skill, { recursive: true });
  for (const file of files) {
    const repositoryFile = file.path.startsWith(REPOSITORY_CONTENT_DIR + sep);
    if (repositoryFile && !useHardlinks) continue;
    const path = join(skill, file.path);
    await mkdir(dirname(path), { recursive: true });
    if (repositoryFile) await link(join(repository, file.path.slice(REPOSITORY_CONTENT_DIR.length + 1)), path);
    else await writeFile(path, file.content, { mode: 0o444 });
  }
  if (!useHardlinks) await symlink(repository, join(skill, REPOSITORY_CONTENT_DIR), "dir");
  await symlink(skill, join(skills, skillName), "dir");
  return { home, skill, files, repository };
}

async function verifyDiscovery(workspace, session, assignment, outsideAssignment) {
  const privateHome = join(root, session);
  // The policy grants read access to this private output directory. Supply
  // the mount source before Bubblewrap applies read-only parent mounts.
  await mkdir(join(privateHome, "generated_images"), { recursive: true });
  await writeFile(join(privateHome, "config.toml"), `model = ${JSON.stringify(session)}\n`);
  const environment = {
    PATH: process.env.PATH, HOME: assignment?.home ?? privateHome, CODEX_HOME: privateHome,
    // Reuse the CI job's empty network namespace so nested Bubblewrap
    // does not need to configure another loopback device.
    PROPRIO_RUNNER_NETWORK_ACCESS: process.env.PROPRIO_TEST_ISOLATED_NETWORK === "1" ? "enabled" : undefined,
  };
  const readOnlyRoots = codexExecutableReadOnlyRoots(environment, codex);
  if (assignment) {
    readOnlyRoots.push(assignment.skill);
    if (!useHardlinks) readOnlyRoots.push(assignment.repository);
  }
  let diagnostics = "";
  const transport = new ProcessCodexAppServerTransport({
    command: codex,
    args: createIsolatedCodexAppServerArgs(environment, readOnlyRoots, undefined, useHardlinks ? [repositories] : []),
    workingDirectory: workspace,
    environment,
    onDiagnostic: message => { diagnostics = (diagnostics + message).slice(-4000); },
    processGroup: true,
  });
  const command = (...argv) => transport.request("command/exec", { command: argv, cwd: workspace, timeoutMs: 3_000 });
  const deadline = setTimeout(() => void transport.close(), 15_000);
  try {
    await transport.request("initialize", { clientInfo: { name: "proprio_skill_fixture", title: "Proprio skill fixture", version: "1" } });
    transport.notify("initialized");
    const listing = await transport.request("skills/list", { cwds: [workspace] });
    const configuration = await transport.request("config/read", { includeLayers: false });
    assert.equal(configuration.config.model, session, "Codex must read this session's private config");
    const matches = listing.data.flatMap(entry => entry.skills).filter(skill => skill.name === skillName);
    assert.equal(matches.length, assignment ? 1 : 0, `${session} discovery count`);
    if (assignment) {
      assert.equal(matches[0].path, await realpath(join(assignment.skill, "SKILL.md")));
      for (const file of assignment.files) {
        const read = await command("/bin/cat", join(dirname(matches[0].path), file.path));
        assert.equal(read.exitCode, 0, JSON.stringify(read));
        assert.equal(read.stdout, file.content);
      }
      const selected = await realpath(join(assignment.skill, rootFile));
      const changeMode = await command("/bin/chmod", "600", selected);
      assert.notEqual(changeMode.exitCode, 0, "The Codex sandbox must refuse permission changes on a shared file");
      assert.equal((await stat(selected)).mode & 0o777, 0o444);
    }
    const outsideRead = await command("/bin/cat", join(outsideAssignment.skill, rootFile));
    assert.notEqual(outsideRead.exitCode, 0, "The Codex sandbox must refuse files outside the assigned revision");
    if (useHardlinks && assignment) {
      const directRead = await command("/bin/cat", join(assignment.repository, "shared.txt"));
      assert.notEqual(directRead.exitCode, 0, "The Codex sandbox must refuse access to the shared cache");
    }
    const privateRead = await command("/bin/cat", join(privateHome, "config.toml"));
    assert.notEqual(privateRead.exitCode, 0, "The Codex sandbox must refuse access to the private configuration");
    console.log(`${session}: verified private config, ${matches.length} matching skills, and sandbox permissions`);
  } catch (error) {
    throw new Error(`Codex skill qualification failed for ${session}: ${diagnostics}`, { cause: error });
  } finally {
    clearTimeout(deadline);
    await transport.close();
  }
}

try {
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const repository = await createRepository("first-revision");
  const first = await createAssignment("first", repository);
  const second = await createAssignment("second", repository);
  const alternate = await createAssignment("alternate", await createRepository("alternate-revision"));
  const firstFile = await stat(join(first.skill, rootFile));
  const secondFile = await stat(join(second.skill, rootFile));
  assert.equal(firstFile.dev, secondFile.dev);
  assert.equal(firstFile.ino, secondFile.ino);
  console.log(`Shared repository proof: ${useHardlinks ? "hardlinks" : "directory links"}`);
  await verifyDiscovery(workspace, "session-one", first, alternate);
  await rm(first.home, { recursive: true });
  await rm(first.skill, { recursive: true });
  await verifyDiscovery(workspace, "session-two", second, alternate);
  await verifyDiscovery(workspace, "session-alternate", alternate, first);
  await verifyDiscovery(workspace, "session-without-assignment", null, first);
} finally {
  await rm(root, { recursive: true, force: true });
}
