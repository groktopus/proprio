import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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

async function createRepository(revision) {
  const repository = join(root, "repositories", revision);
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
  const skill = join(home, ".agents", "skills", skillName);
  await mkdir(skill, { recursive: true });
  for (const file of files) {
    if (file.path.startsWith(REPOSITORY_CONTENT_DIR + sep)) continue;
    const path = join(skill, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { mode: 0o444 });
  }
  await symlink(repository, join(skill, REPOSITORY_CONTENT_DIR), "dir");
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
  if (assignment) readOnlyRoots.push(assignment.repository);
  let diagnostics = "";
  const transport = new ProcessCodexAppServerTransport({
    command: codex,
    args: createIsolatedCodexAppServerArgs(environment, readOnlyRoots),
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
      assert.equal(await realpath(matches[0].path), await realpath(join(assignment.skill, "SKILL.md")));
      for (const file of assignment.files) {
        assert.equal(await readFile(join(dirname(matches[0].path), file.path), "utf8"), file.content);
      }
      const selected = await realpath(join(assignment.skill, rootFile));
      const read = await command("/bin/cat", selected);
      assert.equal(read.exitCode, 0, JSON.stringify(read));
      assert.equal(read.stdout, await readFile(selected, "utf8"));
      const changeMode = await command("/bin/chmod", "600", selected);
      assert.notEqual(changeMode.exitCode, 0, "The Codex sandbox must refuse permission changes on a shared file");
      assert.equal((await stat(selected)).mode & 0o777, 0o444);
    }
    const outsideRead = await command("/bin/cat", join(outsideAssignment.repository, "shared.txt"));
    assert.notEqual(outsideRead.exitCode, 0, "The Codex sandbox must refuse files outside the assigned revision");
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
  assert.equal(await realpath(join(first.skill, rootFile)), await realpath(join(second.skill, rootFile)));
  await verifyDiscovery(workspace, "session-one", first, alternate);
  await verifyDiscovery(workspace, "session-two", second, alternate);
  await verifyDiscovery(workspace, "session-alternate", alternate, first);
  await verifyDiscovery(workspace, "session-without-assignment", null, first);
} finally {
  await rm(root, { recursive: true, force: true });
}
