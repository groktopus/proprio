import { buildLoginShellScript } from "./exec.js";
import { DEFAULT_TIMEOUT_MS, type BridgeCommand, type BridgeCommandResult } from "./runtime.js";

export type ContainerCommand = Omit<BridgeCommand, "signal" | "onOutput">;

const terminationGraceMs = 2_000;
const imageEnvironment = { HOME: "/root", USER: "root" };

function stdinStream(value: string | null | undefined): ReadableStream<Uint8Array> | undefined {
  if (!value) return undefined;
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({ type: "bytes", start(controller) {
    controller.enqueue(bytes);
    controller.close();
  } });
}

async function collectOutput(
  stream: ReadableStream | null | undefined,
  onChunk: ((data: string) => void | Promise<void>) | undefined,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  async function emit(chunk: string) {
    if (!chunk) return;
    chunks.push(chunk);
    await onChunk?.(chunk);
  }
  try {
    for (;;) {
      const output = await reader.read();
      if (output.done) break;
      await emit(decoder.decode(output.value, { stream: true }));
    }
    await emit(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

/** The timeout process owns a process group. TERM reaches its children and
 * GNU timeout escalates to KILL after the grace period. */
export async function runContainerCommand(
  start: (
    argv: string[],
    options: ContainerExecOptions,
  ) => Promise<ExecProcess>,
  input: BridgeCommand,
): Promise<BridgeCommandResult> {
  input.signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  const script = buildLoginShellScript({
    command: input.command, args: input.args ?? [], cwd: input.cwd, env: input.env,
  });
  const argv = ["timeout", "--kill-after=2s", `${(timeoutMs + terminationGraceMs) / 1000}s`, "sh", "-lc", script];
  let process: ExecProcess | undefined;
  let timedOut = false;
  let finished = false;
  let stopping = false;
  const stop = () => {
    if (!process || finished || stopping) return;
    stopping = true;
    process.kill(15);
  };
  input.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.min(timeoutMs, 2_147_483_647));
  try {
    process = await start(argv, { cwd: "/", env: imageEnvironment, stdin: stdinStream(input.stdin) });
    if (timedOut || input.signal?.aborted) stop();
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exitCode.then(code => { finished = true; clearTimeout(timer); return code; }),
      collectOutput(process.stdout, input.onOutput && (data => input.onOutput!("stdout", data))),
      collectOutput(process.stderr, input.onOutput && (data => input.onOutput!("stderr", data))),
    ]);
    input.signal?.throwIfAborted();
    return { exitCode: timedOut ? null : exitCode, signal: null, timedOut, stdout, stderr };
  } finally {
    stop();
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", stop);
  }
}
