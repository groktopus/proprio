import { describe, expect, it, vi } from "vitest";
import { runContainerCommand } from "./container-command.js";
import type { BridgeCommand } from "./runtime.js";

function bytes(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const command: BridgeCommand = {
  command: "/bin/printf",
  args: ["%s", "quoted ' argument"],
  cwd: "/workspace/with spaces",
  env: { TEST_PARAMETER: "a value" },
  stdin: "a\nb\n",
  sessionStrategy: "named",
  timeoutMs: 500,
};

describe("1.0 container commands", () => {
  it("preserves quoting, separate UTF-8 streams, stdin, and a natural 124 exit", async () => {
    const encoder = new TextEncoder();
    const characters = encoder.encode("bé");
    const onOutput = vi.fn();
    const start = vi.fn(async (_argv: string[], options: ContainerExecOptions) => {
      const stdin = await new Response(options.stdin as ReadableStream<Uint8Array>).text();
      expect(stdin).toBe("a\nb\n");
      return {
        stdout: bytes(characters.slice(0, 2), characters.slice(2)),
        stderr: bytes(encoder.encode("warn")),
        exitCode: Promise.resolve(124),
        kill: vi.fn(),
      } as unknown as ExecProcess;
    });
    await expect(runContainerCommand(start, { ...command, onOutput })).resolves.toEqual({
      exitCode: 124, signal: null, timedOut: false, stdout: "bé", stderr: "warn",
    });
    const [argv] = start.mock.calls[0]!;
    expect(argv.slice(0, 5)).toEqual(["timeout", "--kill-after=2s", "2.5s", "sh", "-lc"]);
    expect(argv[5]).toContain("cd '/workspace/with spaces'");
    expect(argv[5]).toContain("'quoted '\"'\"' argument'");
    expect(argv[5]).toContain("TEST_PARAMETER='a value'");
    expect(onOutput).toHaveBeenCalledWith("stdout", "é");
    expect(onOutput).toHaveBeenCalledWith("stderr", "warn");
  });

  it("terminates the group supervisor and observes exit on deadline", async () => {
    vi.useFakeTimers();
    try {
      let exit!: (status: number) => void;
      const exitCode = new Promise<number>(resolve => { exit = resolve; });
      const kill = vi.fn(() => exit(143));
      const pending = runContainerCommand(async () => ({ exitCode, kill }) as unknown as ExecProcess, command);
      await vi.advanceTimersByTimeAsync(499);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ exitCode: null, timedOut: true });
      expect(kill).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a process that starts after the request disconnects", async () => {
    const abort = new AbortController();
    let started!: (process: ExecProcess) => void;
    const starting = new Promise<ExecProcess>(resolve => { started = resolve; });
    const pending = runContainerCommand(() => starting, { ...command, signal: abort.signal });
    abort.abort();
    const kill = vi.fn();
    started({ exitCode: Promise.resolve(143), kill } as unknown as ExecProcess);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(kill).toHaveBeenCalledWith(15);
  });
});

it.skipIf(process.platform !== "linux")("prevents a timed-out child from writing later under GNU timeout", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, lstat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Readable } = await import("node:stream");
  const scratch = await mkdtemp(join(tmpdir(), "proprio-bridge-timeout-"));
  try {
    const marker = join(scratch, "late-write");
    const result = await runContainerCommand(async (argv) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
      const exitCode = new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 143));
      });
      return {
        exitCode,
        stdout: Readable.toWeb(child.stdout),
        stderr: Readable.toWeb(child.stderr),
        kill: (signal: number) => { child.kill(signal); },
      } as unknown as ExecProcess;
    }, {
      command: "sh",
      args: ["-c", '(sleep 0.6; printf late > "$1") & wait', "fixture", marker],
      sessionStrategy: "named",
      timeoutMs: 100,
    });
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    await new Promise(resolve => setTimeout(resolve, 700));
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
