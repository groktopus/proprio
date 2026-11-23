import { describe, expect, it, vi } from "vitest";

vi.mock("sandbox-0x", () => ({
  getSandbox: vi.fn(),
}));

import { buildLoginShellScript, executeInSandbox } from "./exec.js";

describe("bridge exec", () => {
  it("invokes target.exec with a single shell command string and no args option", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "claude 1.0.0\n",
      stderr: "",
    });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "claude",
      args: ["--version"],
      cwd: "/workspace/proprio",
      env: { PROPRIO_TEST_FLAG: "1" },
      sessionStrategy: "named",
      sessionId: "proprio",
      timeoutMs: 12_345,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    const [commandArg, optionsArg] = exec.mock.calls[0] ?? [];
    expect(typeof commandArg).toBe("string");
    expect(commandArg).toMatch(/^sh -lc /);
    expect(optionsArg).toEqual({ cwd: "/", timeout: 12_345 });
    expect(optionsArg).not.toHaveProperty("args");
    expect(optionsArg).not.toHaveProperty("stdin");
    expect(commandArg).toContain('. /etc/profile');
    // The wrapper sources no `nvm.sh`; the sandbox image supplies node on PATH.
    expect(commandArg).not.toContain("nvm.sh");
    expect(commandArg).not.toContain("NVM_DIR");
    expect(commandArg).toContain("cd ");
    expect(commandArg).toContain("/workspace/proprio");
    expect(commandArg).toContain("PROPRIO_TEST_FLAG");
    expect(commandArg).toContain("claude");
    expect(commandArg).toContain("--version");
  });

  it("requests streaming callbacks when bridge output forwarding is enabled", async () => {
    const exec = vi.fn().mockImplementation(async (_command, options) => {
      await options?.onOutput?.("stdout", "hello\n");
      return {
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      };
    });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
    } as const;
    const onOutput = vi.fn();

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "echo",
      args: ["hello"],
      sessionStrategy: "named",
      sessionId: "proprio",
      timeoutMs: 5_000,
      onOutput,
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/",
      timeout: 10_000,
      stream: true,
      onOutput: expect.any(Function),
    });
    expect(onOutput).toHaveBeenCalledWith("stdout", "hello\n");
  });

  it.each(["named", "default"] as const)("cleans up a streamed deadline using the %s strategy", async (sessionStrategy) => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn((_command, _options) => new Promise(() => {}));
      const sandbox = {
        exec,
        getSession: vi.fn().mockResolvedValue({ exec }),
        destroy: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      };
      const onOutput = vi.fn();
      const execution = executeInSandbox({
        sandbox: sandbox as never,
        command: "fixture",
        sessionStrategy,
        sessionId: "fixture-session",
        timeoutMs: 2_000,
        onOutput,
      });

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(execution).resolves.toMatchObject({ exitCode: null, timedOut: true });
      exec.mock.calls[0]?.[1].onOutput("stderr", "late output");
      expect(onOutput).not.toHaveBeenCalled();
      if (sessionStrategy === "named") {
        expect(sandbox.deleteSession).toHaveBeenCalledExactlyOnceWith("fixture-session");
        expect(sandbox.destroy).not.toHaveBeenCalled();
      } else {
        expect(sandbox.destroy).toHaveBeenCalledOnce();
        expect(sandbox.deleteSession).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a streamed command's exit 124 without cleanup", async () => {
    const exec = vi.fn(async (_command, options) => {
      await options.onOutput("stderr", "Command timed out after 2000ms\n");
      return { exitCode: 124 };
    });
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      deleteSession: vi.fn(),
    };
    await expect(executeInSandbox({
      sandbox: sandbox as never,
      command: "fixture",
      sessionStrategy: "named",
      timeoutMs: 2_000,
      onOutput: vi.fn(),
    })).resolves.toMatchObject({ exitCode: 124, timedOut: false });
    expect(sandbox.deleteSession).not.toHaveBeenCalled();
  });

  it("stages stdin through a sandbox temp file and redirects from it", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    // sessionStrategy: "default" routes through the sandbox itself (no
    // getSession wrapper), so exec must live directly on the sandbox.
    const sandbox = {
      exec,
      getSession: vi.fn(),
      writeFile,
      deleteFile,
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "cat",
      args: [],
      sessionStrategy: "default",
      timeoutMs: 5_000,
      stdin: "payload-bytes",
    });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [stdinPath, stdinPayload] = writeFile.mock.calls[0] ?? [];
    expect(typeof stdinPath).toBe("string");
    expect(stdinPath).toMatch(/^\/tmp\/\.proprio-bridge-stdin-/);
    expect(stdinPayload).toBe("payload-bytes");

    const commandArg = exec.mock.calls[0]?.[0];
    expect(commandArg).toContain(stdinPath);
    expect(commandArg).toMatch(/<\s*['"]/);

    expect(deleteFile).toHaveBeenCalledWith(stdinPath);
  });

  it("does not write a stdin file or redirect when stdin is empty", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const writeFile = vi.fn();
    const deleteFile = vi.fn();
    const sandbox = {
      getSession: vi.fn().mockResolvedValue({ exec }),
      writeFile,
      deleteFile,
    } as const;

    await executeInSandbox({
      sandbox: sandbox as never,
      command: "pwd",
      sessionStrategy: "named",
      sessionId: "proprio",
      timeoutMs: 5_000,
      stdin: null,
    });

    expect(writeFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    const commandArg = exec.mock.calls[0]?.[0];
    expect(commandArg).not.toContain("<");
  });

  it("rejects invalid environment variable keys in the login-shell wrapper", () => {
    expect(() => buildLoginShellScript({
      command: "pwd",
      args: [],
      env: { "bad-key": "1" },
    })).toThrow("Invalid sandbox environment variable key: bad-key");
  });
});
