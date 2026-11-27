import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@groktopus/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@groktopus/adapter-utils/execution-target";
import { readProprioRuntimeSkillEntries } from "@groktopus/adapter-utils/server-utils";
import { createPromptContextFixture } from "@groktopus/adapter-utils/test-fixtures/prompt-context";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("OpenCode local skill injection", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it.each([false, true])("keeps chat policy with a legacy OpenCode prompt (custom=%s)", async (custom) => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({
      type: "text", sessionID: "chat-session", part: { text: "Reply" },
    }) }));
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    let prompt = "";
    const result = await execute({
      runId: "chat-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        ...(custom ? { promptTemplate: "Custom agent instruction." } : {}),
      },
      context: {
        conversationMode: true,
        proprioTaskMarkdown: directive,
        proprioWake: {
          reason: "issue_commented", issue: { id: "chat-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation", interactionStatus: "accepted",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(directive);
    expect(prompt).toContain(custom ? "Custom agent instruction." : "You are agent agent-1");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
  });

  it("delivers assignment context on an ordinary task turn and rebuilds it after resume fallback", async () => {
    const commandPath = path.join(configHome, "fake-opencode-context");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prompts: string[] = [];
    runProcessMock
      .mockReset()
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "error", error: "unknown session" }) }))
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "fresh", part: { text: "done" } }) }));
    await execute({
      runId: "run-context-fallback",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "previous", sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: createPromptContextFixture(),
      onLog: async () => {},
      onMeta: async (meta) => { prompts.push(String(meta.prompt ?? "")); },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Compact assignment");
    expect(prompts[1]).toContain("## Owned assignment");
    for (const prompt of prompts) expect(prompt).not.toContain("Execution contract:");
    expect(prompts[1]).toContain("You are agent agent-1 (OpenCode).");
    expect(prompts[1]).toContain("Connection tools:");
  });

  it("stages explicit runtime skills without writing into either shared child HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "proprio");
    const operatorSkillSource = await createSkillDir(path.join(root, "operator-skills"), "operator-native");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(configHome, "opencode"), { recursive: true });
    await fs.writeFile(path.join(configHome, "opencode", "opencode.json"), JSON.stringify({
      skills: { paths: [operatorSkillSource] },
    }), "utf8");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    let runtimeConfigHome = "";
    runProcessMock.mockReset().mockImplementationOnce(async (...args) => {
      runtimeConfigHome = args[4].env.XDG_CONFIG_HOME!;
      expect(args[4].env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe("1");
      expect(await fs.readdir(path.join(runtimeConfigHome, "opencode", "skills"))).toEqual([]);
      expect(JSON.parse(await fs.readFile(path.join(runtimeConfigHome, "opencode", "opencode.json"), "utf8")))
        .toMatchObject({ skills: { paths: [operatorSkillSource, skillSource] } });
      return probeResult({
        stdout: JSON.stringify({
          type: "text",
          sessionID: "session-configured-home",
          part: { text: "done" },
        }),
      });
    });

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          proprioRuntimeSkills: [{
            key: "groktopus/proprio/proprio",
            runtimeName: "proprio",
            source: skillSource,
          }],
          proprioSkillSync: { desiredSkills: ["groktopus/proprio/proprio"] },
          promptTemplate: "Follow the proprio heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const installedSkill = path.join(configuredHome, ".claude", "skills", "proprio");
      await expect(fs.lstat(installedSkill)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(path.join(processHome, ".claude", "skills", "proprio"))).rejects.toThrow();
      await expect(fs.stat(runtimeConfigHome)).rejects.toMatchObject({ code: "ENOENT" });

      runProcessMock.mockReset();
      await expect(execute({
        runId: "run-configured-home-attach",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode Coder", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: { HOME: configuredHome, OPENCODE_ALLOW_ALL_MODELS: "1" },
          extraArgs: ["--attach", "http://127.0.0.1:4096"],
          proprioRuntimeSkills: [{ key: "groktopus/proprio/proprio", runtimeName: "proprio", source: skillSource }],
        },
        context: {},
        onLog: async () => {},
      })).rejects.toThrow("--attach cannot honor an explicit per-run Proprio skill inventory");
      expect(runProcessMock).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates each explicit skill inventory in its run config and cleans it after success or failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-opencode-explicit-skills-"));
    const sharedHome = path.join(root, "shared-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillA = await createSkillDir(path.join(root, "sources"), "skill-a");
    const skillB = await createSkillDir(path.join(root, "sources"), "skill-b");
    await fs.writeFile(path.join(skillA, ".proprio-materialized-skill.json"), '{"version":1}\n', "utf8");
    const bundledSkills = await readProprioRuntimeSkillEntries({}, path.dirname(fileURLToPath(import.meta.url)));
    const bundledProprioSkill = bundledSkills[0];
    expect(bundledProprioSkill).toBeDefined();
    const sharedSkills = path.join(sharedHome, ".claude", "skills");
    await fs.mkdir(sharedSkills, { recursive: true });
    await fs.writeFile(path.join(sharedSkills, "operator-skill"), "keep", "utf8");
    await fs.mkdir(path.join(workspace, ".claude", "skills"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".claude", "skills", "project-skill"), "keep", "utf8");
    await fs.mkdir(path.join(configHome, "opencode"), { recursive: true });
    const nativeSkills = path.join(root, "native-skills");
    await createSkillDir(nativeSkills, "native-skill");
    await fs.symlink(skillA, path.join(nativeSkills, "revoked-proprio-skill"), "dir");
    await fs.symlink(bundledProprioSkill!.source, path.join(nativeSkills, "revoked-packaged-skill"), "dir");
    await fs.chmod(nativeSkills, 0o555);
    await fs.symlink(nativeSkills, path.join(configHome, "opencode", "skills"), "dir");
    await fs.writeFile(path.join(configHome, "opencode", "opencode.json"), JSON.stringify({ model: "native/operator-model" }));
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = sharedHome;
    const runtimeHomes: string[] = [];
    const realConfigHome = path.join(root, "real-config");
    const realSkillsHome = path.join(realConfigHome, "opencode", "skills");
    try {
      for (const [runId, skills] of [
        ["run-a", [{ key: "custom/a", runtimeName: "skill-a", source: skillA }]],
        ["run-b", [{ key: "custom/b", runtimeName: "skill-b", source: skillB }]],
        ["run-empty", []],
      ] as const) {
        runProcessMock.mockReset().mockImplementationOnce(async (...args) => {
          const runtimeEnv = args[4].env;
          expect(runtimeEnv.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe("1");
          expect(runtimeEnv.HOME).toBe(sharedHome);
          expect(runtimeEnv.PROPRIO_API_KEY).toBe("inventory-test-token");
          const runtimeHome = runtimeEnv.XDG_CONFIG_HOME!;
          runtimeHomes.push(runtimeHome);
          expect(JSON.parse(await fs.readFile(path.join(runtimeHome, "opencode", "opencode.json"), "utf8")))
            .toMatchObject({ model: "native/operator-model" });
          const staged = path.join(runtimeHome, "opencode", "skills");
          const names = await fs.readdir(staged);
          expect(names.sort()).toEqual(["native-skill"]);
          expect((await fs.lstat(staged)).isSymbolicLink()).toBe(false);
          expect((await fs.stat(staged)).mode & 0o777).toBe(0o700);
          const stagedConfig = JSON.parse(await fs.readFile(path.join(runtimeHome, "opencode", "opencode.json"), "utf8"));
          expect(stagedConfig.skills.paths).toEqual(skills.map((skill) => path.resolve(skill.source)));
          return probeResult({ stdout: JSON.stringify({ type: "text", sessionID: runId, part: { text: "done" } }) });
        });
        const result = await execute({
          runId,
          agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {
            command: commandPath,
            cwd: workspace,
            model: "openai/gpt-5",
            env: { HOME: sharedHome, XDG_CONFIG_HOME: configHome, OPENCODE_ALLOW_ALL_MODELS: "1" },
            proprioRuntimeSkills: skills,
            proprioSkillSync: { desiredSkills: skills.map((skill) => skill.key) },
          },
          context: {},
          authToken: "inventory-test-token",
          onLog: async () => {},
        });
        expect(result.exitCode).toBe(0);
      }

      await createSkillDir(realSkillsHome, "operator-native");
      await fs.symlink(skillA, path.join(realSkillsHome, "revoked-proprio-skill"), "dir");
      await fs.chmod(realSkillsHome, 0o555);
      runProcessMock.mockReset().mockImplementationOnce(async (...args) => {
        const runtimeHome = args[4].env.XDG_CONFIG_HOME!;
        runtimeHomes.push(runtimeHome);
        expect(await fs.readdir(path.join(runtimeHome, "opencode", "skills"))).toEqual(["operator-native"]);
        expect(JSON.parse(await fs.readFile(path.join(runtimeHome, "opencode", "opencode.json"), "utf8")))
          .toMatchObject({ skills: { paths: [] } });
        return probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "real-dir-empty", part: { text: "done" } }) });
      });
      const realDirResult = await execute({
        runId: "run-real-dir-empty",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: { HOME: sharedHome, XDG_CONFIG_HOME: realConfigHome, OPENCODE_ALLOW_ALL_MODELS: "1" },
          proprioRuntimeSkills: [],
          proprioSkillSync: { desiredSkills: [] },
        },
        context: {},
        onLog: async () => {},
      });
      expect(realDirResult.exitCode).toBe(0);

      runProcessMock.mockReset().mockImplementationOnce(async (...args) => {
        runtimeHomes.push(args[4].env.XDG_CONFIG_HOME!);
        throw new Error("spawn failure");
      });
      await expect(execute({
        runId: "run-failure",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: workspace, model: "openai/gpt-5", env: { HOME: sharedHome, XDG_CONFIG_HOME: configHome, OPENCODE_ALLOW_ALL_MODELS: "1" }, proprioRuntimeSkills: [], proprioSkillSync: { desiredSkills: [] } },
        context: {},
        onLog: async () => {},
      })).rejects.toThrow("spawn failure");

      expect(new Set(runtimeHomes).size).toBe(5);
      for (const runtimeHome of runtimeHomes) {
        await expect(fs.stat(runtimeHome)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await fs.readdir(nativeSkills)).sort()).toEqual(["native-skill", "revoked-packaged-skill", "revoked-proprio-skill"]);
      expect(await fs.readdir(sharedSkills)).toEqual(["operator-skill"]);
      expect(await fs.readFile(path.join(sharedSkills, "operator-skill"), "utf8")).toBe("keep");
      expect(await fs.readFile(path.join(workspace, ".claude", "skills", "project-skill"), "utf8")).toBe("keep");
      await expect(fs.lstat(path.join(sharedSkills, "skill-a"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(path.join(sharedSkills, "skill-b"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(realSkillsHome)).sort()).toEqual(["operator-native", "revoked-proprio-skill"]);
      expect((await fs.stat(realSkillsHome)).mode & 0o777).toBe(0o555);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.chmod(nativeSkills, 0o755).catch(() => {});
      await fs.chmod(realSkillsHome, 0o755).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("preserves API billing in streamed usage and final results without leaking keys (timedOut=%s)", async (timedOut) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-opencode-openrouter-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const apiKey = "openrouter-test-secret";
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    const usageLine = JSON.stringify({ type: "step_finish", sessionID: "session-openrouter",
      part: { cost: 0.0025, tokens: { input: 10, output: 2, cache: { read: 100, write: 0 } } } });
    runProcessMock.mockImplementationOnce(async (...args) => {
      await args[4].onLog("stdout", `${usageLine}\n`);
      return probeResult({ stdout: usageLine, timedOut, exitCode: timedOut ? 143 : 0, signal: timedOut ? "SIGTERM" : null });
    });
    const logs: string[] = [];
    const metadata: unknown[] = [];
    const onUsage = vi.fn();

    try {
      const result = await execute({
        runId: "run-openrouter",
        agent: {
          id: "agent-openrouter",
          companyId: "company-1",
          name: "OpenRouter Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model,
          env: {
            OPENROUTER_API_KEY: apiKey,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onUsage,
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (value) => {
          metadata.push(value);
        },
      });

      expect(result.exitCode).toBe(timedOut ? 143 : 0);
      expect(result.usageComplete).toBe(!timedOut);
      expect(result.model).toBe(model);
      expect(result.billingType).toBe("metered_api");
      expect(result.biller).toBe("openrouter");
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ billingType: "metered_api", biller: "openrouter", model, complete: false }));
      expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ billingType: "metered_api", biller: "openrouter", model, complete: !timedOut }));
      const executionCall = runProcessMock.mock.calls.at(-1)!;
      expect(executionCall[3]).toContain("--model");
      expect(executionCall[3]).toContain(model);
      expect((executionCall[4] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(apiKey);
      expect(JSON.stringify({ logs, metadata, result })).not.toContain(apiKey);
      expect(JSON.stringify(metadata)).toContain('"OPENROUTER_API_KEY":"***REDACTED***"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable — probe is non-fatal when it cannot run", () => {
  const target = { kind: "remote", transport: "ssh" } as never;
  const base = {
    runId: "run-probe",
    executionTarget: target,
    command: "opencode",
    cwd: "/tmp",
    env: {} as Record<string, string>,
    timeoutSec: 30,
    graceSec: 5,
  };

  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it("proceeds when the remote probe exits non-zero (e.g. a transient `Unexpected error`)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: "Unexpected error" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe times out", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ timedOut: true, exitCode: null }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe returns no models", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("still rejects when the probe succeeds but the configured model is absent (guard retained)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "openai/gpt-4.1\n" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");
  });
});
