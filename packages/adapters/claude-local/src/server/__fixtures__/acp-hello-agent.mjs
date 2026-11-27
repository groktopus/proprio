#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const sessionId = randomUUID();
const lines = createInterface({ input: process.stdin });
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);

lines.on("line", async line => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === "initialize") {
      const observedPath = process.env.PROPRIO_ACP_PROBE_FIXTURE_OBSERVED;
      if (observedPath) await writeFile(observedPath, JSON.stringify({ pid: process.pid, key: process.env.ANTHROPIC_API_KEY ?? null, model: process.env.ANTHROPIC_MODEL ?? null }));
      write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } }, agentInfo: { name: "fixture-claude-acp", version: "1" } } });
    } else if (request.method === "session/new") {
      write({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
    } else if (request.method === "session/prompt") {
      if (process.env.PROPRIO_ACP_PROBE_FIXTURE_MODE === "hang") return;
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.PROPRIO_ACP_PROBE_FIXTURE_TEXT ?? "hello" } } } });
      write({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    } else if (request.method === "session/cancel") {
      write({ jsonrpc: "2.0", id: request.id, result: {} });
    } else if (request.method === "session/close" || request.method === "session/set_mode" || request.method === "session/set_config_option") {
      write({ jsonrpc: "2.0", id: request.id, result: {} });
    } else {
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "fixture method not found" } });
    }
  } catch (error) {
    if (request?.id !== undefined) write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
});
