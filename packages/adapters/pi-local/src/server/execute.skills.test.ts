import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess, ensurePiModelConfiguredAndAvailable } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
  ensurePiModelConfiguredAndAvailable: vi.fn(async () => []),
}));

vi.mock("@groktopus/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@groktopus/adapter-utils/execution-target")>();
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "pi"),
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("./models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.js")>();
  return { ...actual, ensurePiModelConfiguredAndAvailable };
});

let execute: typeof import("./execute.js")["execute"];

const result = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: JSON.stringify({
    type: "turn_end",
    message: { role: "assistant", content: "done", usage: { input: 1, output: 1, cost: { total: 0 } } },
    toolResults: [],
  }),
  stderr: "",
  pid: 123,
  startedAt: new Date().toISOString(),
};

async function makeSkill(root: string, name: string, content: string): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), content, "utf8");
  return directory;
}

describe("Pi local explicit runtime skill isolation", () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("HOME", "/tmp/proprio-pi-execute-skills-test-home");
    ({ execute } = await import("./execute.js"));
  });

  afterAll(() => vi.unstubAllEnvs());

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
    await fs.rm("/tmp/proprio-pi-execute-skills-test-home", { recursive: true, force: true });
  });

  it("mounts only each run's explicit skills, including an empty selection, and removes run roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-pi-skill-isolation-"));
    tempDirs.push(root);
    const alpha = await makeSkill(root, "alpha", "alpha private instructions");
    const beta = await makeSkill(root, "beta", "beta private instructions");
    const operatorSkill = await makeSkill(root, "operator-skill", "operator supplied instructions");
    const observed: Array<{ skillRoot: string; names: string[]; contents: string[]; args: string[] }> = [];

    runAdapterExecutionTargetProcess.mockImplementation(async (runId, _target, _command, args) => {
      const skillIndex = args.indexOf("--skill");
      const skillRoot = String(args[skillIndex + 1]);
      const names = await fs.readdir(skillRoot);
      observed.push({
        skillRoot,
        names,
        contents: await Promise.all(names.map((name) => fs.readFile(path.join(skillRoot, name, "SKILL.md"), "utf8"))),
        args,
      });
      if (runId === "run-failure") throw new Error("fake Pi failure");
      return result;
    });

    const run = async (runId: string, skills: Array<{ key: string; runtimeName: string; source: string }>, extraArgs: string[] = []) => execute({
      runId,
      agent: { id: "agent-1", companyId: "company-1", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "pi",
        cwd: root,
        model: "openai/gpt-5.4-mini",
        proprioRuntimeSkills: skills,
        proprioSkillSync: { desiredSkills: skills.map((skill) => skill.key) },
        extraArgs,
      },
      context: { proprioWorkspace: { cwd: root, source: "project_primary" } },
      onLog: async () => {},
    });

    await run("run-alpha", [{ key: "company/alpha", runtimeName: "alpha", source: alpha }], ["--skill", operatorSkill, "--verbose"]);
    await run("run-beta", [{ key: "company/beta", runtimeName: "beta", source: beta }]);
    await run("run-empty", []);
    await expect(run("run-failure", [{ key: "company/alpha", runtimeName: "alpha", source: alpha }])).rejects.toThrow("fake Pi failure");

    expect(observed.map((entry) => entry.names)).toEqual([["alpha"], ["beta"], [], ["alpha"]]);
    expect(observed[0]?.contents).toEqual(["alpha private instructions"]);
    expect(observed[1]?.contents).toEqual(["beta private instructions"]);
    expect(observed.map((entry) => entry.skillRoot).every((directory) => directory.startsWith(os.tmpdir()))).toBe(true);
    expect(new Set(observed.map((entry) => entry.skillRoot)).size).toBe(4);
    expect(observed[0]?.args).toContain("--no-skills");
    expect(observed[0]?.args).toContain("--verbose");
    expect(observed[0]?.args.filter((arg) => arg === "--skill")).toHaveLength(2);
    const operatorSkillIndex = observed[0]?.args.indexOf(operatorSkill) ?? -1;
    expect(observed[0]?.args.slice(operatorSkillIndex - 1, operatorSkillIndex + 2)).toEqual([
      "--skill", operatorSkill, "--verbose",
    ]);
    expect(observed[0]?.args.indexOf("--no-skills")).toBeLessThan(observed[0]?.args.indexOf("--verbose") ?? -1);
    for (const entry of observed) {
      await expect(fs.stat(path.dirname(entry.skillRoot))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.access("/tmp/proprio-pi-execute-skills-test-home/.pi/agent/skills"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
