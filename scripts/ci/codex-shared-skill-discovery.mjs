import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const codex = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "proprio-shared-skills-"));
const skillName = "proprio-shared-skill-fixture";
const tree = ".proprio-repository";
const rootFile = join(tree, "shared.txt");
const siblingFile = join(tree, "skills", "unassigned-sibling", "data.txt");

async function createAssignment(revision) {
  const home = join(root, "pinned", revision);
  const skill = join(home, ".agents", "skills", skillName);
  const files = [
    ["SKILL.md", `---\nname: ${skillName}\ndescription: Pinned repository discovery fixture.\n---\nRead ${rootFile} and ${siblingFile}.\n`],
    [rootFile, `root from ${revision}\n`],
    [siblingFile, `unassigned sibling from ${revision}\n`],
  ];
  for (const [relativePath, content] of files) {
    const path = join(skill, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o444 });
  }
  return { home, skill, files };
}

async function verifyDiscovery(workspace, session, assignment, outsideAssignment) {
  const privateHome = join(root, session);
  await mkdir(privateHome);
  await writeFile(join(privateHome, "config.toml"), `model = ${JSON.stringify(session)}\n`);
  const selectedSkillRule = assignment ? `,${JSON.stringify(assignment.skill)}="read"` : "";
  const child = spawn(codex, [
    "-c", 'default_permissions="fixture"',
    "-c", `permissions.fixture.filesystem={":root"="none",":minimal"="read",":tmpdir"="none",${JSON.stringify(root)}="none"${selectedSkillRule}}`,
    // The Linux job already puts the whole fixture in an empty network
    // namespace. Reuse it to avoid asking nested bubblewrap to configure lo.
    "-c", `permissions.fixture.network.enabled=${process.env.PROPRIO_TEST_ISOLATED_NETWORK === "1"}`,
    "app-server",
  ], {
    cwd: workspace,
    env: { PATH: process.env.PATH, HOME: assignment?.home ?? privateHome, CODEX_HOME: privateHome, TMPDIR: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const output = createInterface({ input: child.stdout });
  const messages = output[Symbol.asyncIterator]();
  let spawnError;
  let diagnostics = "";
  child.once("error", error => { spawnError = error; });
  child.stdin.on("error", () => {});
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  const send = message => child.stdin.write(JSON.stringify(message) + "\n");

  async function resultFor(id) {
    while (true) {
      const message = await messages.next();
      if (message.done) throw new Error(`App server ended before response ${id}: ${diagnostics}`, { cause: spawnError });
      const reply = JSON.parse(message.value);
      if (reply.id !== id) continue;
      assert(!reply.error, JSON.stringify(reply.error));
      return reply.result;
    }
  }

  const command = async (id, ...argv) => {
    send({ id, method: "command/exec", params: { command: argv, cwd: workspace, timeoutMs: 3_000 } });
    return resultFor(id);
  };

  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "proprio_skill_fixture", title: "Proprio skill fixture", version: "1" } } });
    await resultFor(1);
    send({ method: "initialized" });
    send({ id: 2, method: "skills/list", params: { cwds: [workspace] } });
    const listing = await resultFor(2);
    send({ id: 3, method: "config/read", params: { includeLayers: false } });
    assert.equal((await resultFor(3)).config.model, session, "Codex must read this session's private config");
    const matches = listing.data.flatMap(entry => entry.skills).filter(skill => skill.name === skillName);
    assert.equal(matches.length, assignment ? 1 : 0, `${session} discovery count`);
    if (assignment) {
      assert.equal(await realpath(matches[0].path), await realpath(join(assignment.skill, "SKILL.md")));
      for (const [relativePath, content] of assignment.files) {
        assert.equal(await readFile(join(dirname(matches[0].path), relativePath), "utf8"), content);
      }
      const selected = join(assignment.skill, rootFile);
      const read = await command(4, "/bin/cat", selected);
      assert.equal(read.exitCode, 0, JSON.stringify(read));
      assert.equal(read.stdout, await readFile(selected, "utf8"));
      const changeMode = await command(5, "/bin/chmod", "600", selected);
      assert.notEqual(changeMode.exitCode, 0, "The Codex sandbox must refuse permission changes on a shared file");
      assert.equal((await stat(selected)).mode & 0o777, 0o444);
    }
    const outsideRead = await command(6, "/bin/cat", join(outsideAssignment.skill, rootFile));
    assert.notEqual(outsideRead.exitCode, 0, "The Codex sandbox must refuse files outside the assigned revision");
    console.log(`${session}: verified private config, ${matches.length} matching skills, and sandbox permissions`);
  } finally {
    output.close();
    child.stdin.end();
    const shutdown = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await closed;
    clearTimeout(shutdown);
    clearTimeout(deadline);
  }
}

try {
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const first = await createAssignment("first-revision");
  const alternate = await createAssignment("alternate-revision");
  await verifyDiscovery(workspace, "session-one", first, alternate);
  await verifyDiscovery(workspace, "session-two", first, alternate);
  await verifyDiscovery(workspace, "session-alternate", alternate, first);
  await verifyDiscovery(workspace, "session-without-assignment", null, first);
} finally {
  await rm(root, { recursive: true, force: true });
}
