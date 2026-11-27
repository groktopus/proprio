import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runAdapterExecutionTargetProcess } from "@groktopus/adapter-utils/execution-target";
import { execute } from "./execute.js";

vi.mock("@groktopus/adapter-utils/execution-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@groktopus/adapter-utils/execution-target")>()),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

const openCodeCli = process.env.PROPRIO_TEST_OPENCODE_CLI;
const runVersion = "1.19.6";

async function writeSkill(parent: string, name: string) {
  const directory = path.join(parent, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill.\n---\nFixture.\n`);
  return directory;
}

it.skipIf(!openCodeCli)("discovers only the selected managed OpenCode skills at the CLI boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-cli-skills-"));
  const providerHome = path.join(root, "provider");
  const configHome = path.join(root, "config");
  const workspace = path.join(root, "workspace");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: providerHome,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  };
  const openCode = (args: string[], childEnv: Record<string, string>) =>
    execFileSync(openCodeCli!, args, { cwd: workspace, env: childEnv, encoding: "utf8", timeout: 10_000 });
  const discover = (childEnv: Record<string, string>) =>
    JSON.parse(openCode(["debug", "skill", "--pure"], childEnv)) as Array<{ name: string; location: string }>;
  const discoveredNames = (childEnv: Record<string, string>) => discover(childEnv).map(skill => skill.name).sort();
  try {
    await writeSkill(path.join(providerHome, ".claude", "skills"), "ambient");
    await writeSkill(path.join(workspace, ".claude", "skills"), "project-ambient");
    const nativeSkills = path.join(configHome, "opencode", "skills");
    await writeSkill(nativeSkills, "native");
    const source = await writeSkill(path.join(root, "managed"), "selected");
    const operatorSkillSource = await writeSkill(path.join(root, "operator-paths"), "path-native");
    await fs.writeFile(path.join(source, ".proprio-materialized-skill.json"), '{"version":1}\n');
    await fs.symlink(source, path.join(nativeSkills, "revoked-proprio"), "dir");
    await fs.writeFile(path.join(configHome, "opencode", "opencode.json"), JSON.stringify({
      skills: { paths: [operatorSkillSource] },
    }), "utf8");
    expect(openCode(["--version"], env).trim()).toBe(runVersion);
    expect(discoveredNames(env)).toEqual(["ambient", "customize-opencode", "native", "path-native", "project-ambient", "selected"]);
    const selected = { key: "company/selected", runtimeName: "selected", source };
    for (const inventory of [[selected], []]) {
      vi.mocked(runAdapterExecutionTargetProcess).mockImplementationOnce(async (_id, _target, _command, _args, opts) => {
        const discovered = discover({
          ...env,
          XDG_CONFIG_HOME: opts.env.XDG_CONFIG_HOME!,
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: opts.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS!,
          OPENCODE_DISABLE_PROJECT_CONFIG: opts.env.OPENCODE_DISABLE_PROJECT_CONFIG!,
        });
        expect(discovered.map(skill => skill.name).sort())
          .toEqual(inventory.length
            ? ["customize-opencode", "native", "path-native", "selected"]
            : ["customize-opencode", "native", "path-native"]);
        expect(discovered.find(skill => skill.name === "selected")?.location)
          .toBe(inventory.length ? path.join(source, "SKILL.md") : undefined);
        expect(discovered.find(skill => skill.name === "path-native")?.location)
          .toBe(path.join(operatorSkillSource, "SKILL.md"));
        return {
          exitCode: 0, signal: null, timedOut: false,
          stdout: '{"type":"text","sessionID":"test","part":{"text":"done"}}',
          stderr: "", pid: 1, startedAt: new Date().toISOString(),
        };
      });
      const result = await execute({
        runId: "opencode-cli-skills",
        agent: { id: "agent", companyId: "company", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: openCodeCli!, cwd: workspace, model: "openai/gpt-5",
          env: { ...env, OPENCODE_ALLOW_ALL_MODELS: "1" },
          proprioRuntimeSkills: inventory,
          proprioSkillSync: { desiredSkills: inventory.map(skill => skill.key) },
        },
        context: {},
        onLog: async () => {},
      });
      expect(result.exitCode).toBe(0);
    }
  } finally {
    vi.mocked(runAdapterExecutionTargetProcess).mockReset();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 35_000);
