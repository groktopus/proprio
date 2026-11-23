import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { runContainerCommand, type ContainerCommand } from "./container-command.js";
import { DEFAULT_SESSION_ID, type BridgeCommandResult } from "./runtime.js";

interface LeaseSettings {
  keepAlive: boolean;
  sleepAfter: string;
}

const defaults = { keepAlive: false, sleepAfter: "10m" };
const maxIdleMs = 6 * 60 * 60 * 1000;
const minKeepAliveWindowMs = 60_000;
const sessionPrefix = "session:";

function inactivityMs(settings: LeaseSettings): number {
  if (settings.keepAlive) return maxIdleMs;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/u.exec(settings.sleepAfter);
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const duration = match ? Number(match[1]) * units[match[2] as keyof typeof units] : NaN;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > maxIdleMs) {
    throw new Error("Cloudflare 1.0 sleepAfter must be between 1ms and 6h");
  }
  return duration;
}

export class ProprioSandboxV1 extends DurableObject {
  private lifecycle = Promise.resolve();
  private containerEpoch = 0;
  private leaseEpoch = 0;
  private readonly commandsBySession = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await this.configure(await this.settings());
      });
    }
  }

  private get container(): Container {
    if (!this.ctx.container) throw new Error("No Cloudflare container binding for this sandbox");
    return this.ctx.container;
  }

  private settings() {
    return this.ctx.storage.get<LeaseSettings>("lease").then(value => value ?? defaults);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async configure(settings: LeaseSettings) {
    const idleMs = inactivityMs(settings);
    if (this.container.running) {
      await this.container.setInactivityTimeout(idleMs);
    }
    if (settings.keepAlive && this.container.running) {
      await this.ctx.storage.setAlarm(Date.now() + idleMs - minKeepAliveWindowMs);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async clearSessions() {
    const sessions = await this.ctx.storage.list({ prefix: sessionPrefix });
    // Durable Object storage limits the number of keys in one delete.
    const keys = [...sessions.keys()];
    for (let index = 0; index < keys.length; index += 128) {
      await this.ctx.storage.delete(keys.slice(index, index + 128));
    }
  }

  async alarm() {
    await this.serialized(async () => {
      const settings = await this.settings();
      if (!settings.keepAlive || !this.container.running) return;
      const heartbeat = await this.container.exec(["true"], { stdout: "ignore", stderr: "ignore" });
      if (await heartbeat.exitCode !== 0) throw new Error("Cloudflare keep-alive heartbeat failed");
      await this.configure(settings);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname;
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (route === "/configure") {
      const settings = await request.json<LeaseSettings>();
      await this.serialized(async () => {
        await this.configure(settings);
        await this.ctx.storage.put("lease", settings);
      });
      return new Response(null, { status: 204 });
    }
    if (route === "/destroy") {
      await this.serialized(async () => {
        // Keep the saved policy when destruction fails so a retry can finish.
        if (this.container.running) await this.container.destroy();
        this.containerEpoch += 1;
        this.leaseEpoch += 1;
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.delete("lease");
        await this.clearSessions();
      });
      return new Response(null, { status: 204 });
    }
    if (route === "/sentinel") {
      const options = await request.json<{ path: string; timeoutMs: number }>();
      const present = await this.serialized(async () => {
        if (!this.container.running) return false;
        const deadline = options.timeoutMs > 0 ? AbortSignal.timeout(Math.min(options.timeoutMs, 2_147_483_647)) : request.signal;
        try {
          const info = await new Files(this.container).stat(options.path, { signal: AbortSignal.any([request.signal, deadline]) });
          return info.type === "file" && info.size > 0n;
        } catch (error) {
          if (SandboxFileError.is(error) && error.code === "ENOENT") return false;
          if (deadline.aborted && !request.signal.aborted) return false;
          throw error;
        }
      });
      return Response.json(present);
    }
    if (route !== "/execute") return new Response(null, { status: 404 });
    const input = await request.json<ContainerCommand>();
    // The private Worker-to-Durable-Object transport streams both output and
    // the terminal record. The public route still owns the existing SSE API.
    const encoder = new TextEncoder();
    const cancellation = new AbortController();
    const disconnect = () => cancellation.abort();
    request.signal.addEventListener("abort", disconnect, { once: true });
    if (request.signal.aborted) disconnect();
    const stream = new ReadableStream<Uint8Array>({
      type: "bytes",
      start: controller => {
        const send = (frame: unknown) => {
          if (!cancellation.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
        };
        void this.scheduleCommand(input, cancellation.signal, (channel, data) => send({ type: channel, data }))
          .then(result => send({ type: "complete", result }), error => {
            send({ type: "error", message: error instanceof Error ? error.message : String(error) });
          })
          .finally(() => {
            request.signal.removeEventListener("abort", disconnect);
            try { controller.close(); } catch { /* the consumer canceled the stream */ }
          });
      },
      cancel: disconnect,
    });
    return new Response(stream);
  }

  private scheduleCommand(
    input: ContainerCommand,
    signal: AbortSignal,
    onOutput: (channel: "stdout" | "stderr", data: string) => void,
  ): Promise<BridgeCommandResult> {
    const session = input.sessionStrategy === "named" ? sessionPrefix + (input.sessionId?.trim() || DEFAULT_SESSION_ID) : null;
    const key = session ?? "default";
    const leaseEpoch = this.leaseEpoch;
    const result = (this.commandsBySession.get(key) ?? Promise.resolve()).then(() => this.execute(
      input, session, leaseEpoch, signal, onOutput,
    ));
    const tail = result.then(() => undefined, () => undefined);
    this.commandsBySession.set(key, tail);
    void tail.then(() => {
      if (this.commandsBySession.get(key) === tail) this.commandsBySession.delete(key);
    });
    return result;
  }

  private async execute(
    input: ContainerCommand,
    session: string | null,
    leaseEpoch: number,
    signal: AbortSignal,
    onOutput: (channel: "stdout" | "stderr", data: string) => void,
  ): Promise<BridgeCommandResult> {
    let sessionEnv: Record<string, string> | undefined;
    let commandResult!: Promise<BridgeCommandResult>;
    let commandEpoch!: number;
    await this.serialized(async () => {
      signal.throwIfAborted();
      if (leaseEpoch !== this.leaseEpoch) throw new Error("Cloudflare sandbox was destroyed before command startup");
      if (!this.container.running) {
        await this.clearSessions();
        const settings = await this.settings();
        this.containerEpoch += 1;
        this.container.start({ image: this.container.images.bridge, instance: "standard-2", enableInternet: true });
        try {
          await this.configure(settings);
        } catch (error) {
          await this.container.destroy();
          throw error;
        }
      }
      if (session) {
        sessionEnv = await this.ctx.storage.get<Record<string, string>>(session);
        if (!sessionEnv) {
          sessionEnv = input.env ?? {};
          await this.ctx.storage.put(session, sessionEnv);
        }
      }
      commandEpoch = this.containerEpoch;
      let started!: () => void;
      const startup = new Promise<void>(resolve => { started = resolve; });
      commandResult = runContainerCommand(async (argv, options) => {
        try { return await this.container.exec(argv, options); } finally { started(); }
      }, { ...input, env: { ...sessionEnv, ...input.env }, signal, onOutput });
      // Hold the lifecycle lock through spawn. Release or Stop can then
      // destroy the same container without a delayed spawn recreating it.
      await Promise.race([startup, commandResult]);
    });
    const result = await commandResult;
    if (result.timedOut) {
      await this.serialized(async () => {
        if (commandEpoch !== this.containerEpoch) return;
        if (session) {
          await this.ctx.storage.delete(session);
        } else {
          if (this.container.running) await this.container.destroy();
          this.containerEpoch += 1;
          this.leaseEpoch += 1;
          await this.ctx.storage.deleteAlarm();
        }
      });
    }
    return result;
  }
}
