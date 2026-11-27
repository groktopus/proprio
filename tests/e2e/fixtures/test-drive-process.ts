import { spawn, type ChildProcess } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export function launchTestDrive(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  onOutput: (text: string) => void;
}) {
  const child = spawn(process.execPath, ["--import", "./cli/node_modules/tsx/dist/loader.mjs",
    "cli/src/index.ts", "test-drive", ...input.args],
  { cwd: input.cwd, env: input.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<string>((resolve, reject) => {
    let startupLogs = "";
    let settled = false;
    const finish = (url: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (url) resolve(url);
      else reject(error);
    };
    const timer = setTimeout(() => finish(null, new Error("Fixture controller did not report readiness")), 100_000);
    const record = (chunk: Buffer) => {
      const text = chunk.toString();
      input.onOutput(text);
      if (settled) return;
      startupLogs += text;
      const url = stripVTControlCharacters(startupLogs).match(/Proprio is ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) finish(url);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.once("error", error => finish(null, error));
    child.once("exit", (code, signal) => finish(null, new Error(`Fixture controller exited during startup (${code ?? signal})\n${startupLogs}`)));
  });
  return { child, ready };
}

export async function stopTestDrive(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(-child.pid!, name); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const waitForExit = (timeoutMs: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((done) => {
      const exited = () => { clearTimeout(timer); done(true); };
      const timer = setTimeout(() => { child.removeListener('exit', exited); done(false); }, timeoutMs);
      child.once('exit', exited);
    });
  };
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = waitForExit(15_000);
  signal('SIGTERM');
  if (await stopped) return;
  const killed = waitForExit(5_000);
  signal('SIGKILL');
  if (!(await killed)) throw new Error('test-drive process did not exit after SIGKILL');
}
