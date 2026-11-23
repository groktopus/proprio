import { handleBridgeRequest } from "./routes.js";
import { ProprioSandboxV1 } from "./sandbox-v1.js";
import type { BridgeCommand, BridgeCommandResult, ResolveBridgeLease } from "./runtime.js";

export { ProprioSandboxV1 };

interface Env {
  ProprioSandboxV1: DurableObjectNamespace<ProprioSandboxV1>;
  BRIDGE_AUTH_TOKEN?: string;
}

type OutputFrame =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "complete"; result: BridgeCommandResult }
  | { type: "error"; message: string };

async function readCommand(response: Response, onOutput: BridgeCommand["onOutput"]): Promise<BridgeCommandResult> {
  if (!response.ok || !response.body) throw new Error("Cloudflare Durable Object command failed");
  const stream = response.body.pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Cloudflare Durable Object command ended without a result");
      buffer += chunk.value;
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        const frame = JSON.parse(buffer.slice(0, end)) as OutputFrame;
        buffer = buffer.slice(end + 1);
        if (frame.type === "error") throw new Error(frame.message);
        if (frame.type === "complete") return frame.result;
        await onOutput?.(frame.type, frame.data);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function runtime(env: Env, ctx: ExecutionContext): ResolveBridgeLease {
  return async (id, settings) => {
    const stub = env.ProprioSandboxV1.getByName(id);
    const request = (route: string, body?: unknown, signal?: AbortSignal) => stub.fetch(
      new Request(`https://sandbox.internal${route}`, { method: "POST", body: JSON.stringify(body), signal }),
    );
    return {
      setKeepAlive: async keepAlive => {
        const response = await request("/configure", { ...settings, keepAlive });
        if (!response.ok) throw new Error("Cloudflare Durable Object lease configuration failed");
      },
      destroy: async () => {
        const response = await request("/destroy");
        if (!response.ok) throw new Error("Cloudflare Durable Object destruction failed");
      },
      hasSentinel: async (path, timeoutMs) => {
        const response = await request("/sentinel", { path, timeoutMs });
        if (!response.ok) throw new Error("Cloudflare Durable Object sentinel check failed");
        return response.json<boolean>();
      },
      execute: async ({ signal, onOutput, ...command }) => {
        signal?.throwIfAborted();
        const commandId = crypto.randomUUID();
        const cancel = () => {
          ctx.waitUntil(request("/cancel", { commandId }).then(response => {
            if (!response.ok) throw new Error("Cloudflare Durable Object command cancellation failed");
          }).catch(error => console.error("Cloudflare command cancellation failed", error)));
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          return await readCommand(await request("/execute", { ...command, commandId }, signal), onOutput);
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
    };
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleBridgeRequest(request, env.BRIDGE_AUTH_TOKEN, runtime(env, ctx));
    } catch (error) {
      return Response.json({ error: "internal_error", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
};
