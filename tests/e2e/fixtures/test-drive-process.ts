import type { ChildProcess } from "node:child_process";

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
