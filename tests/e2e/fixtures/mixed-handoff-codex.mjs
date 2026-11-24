import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

if (process.argv.includes("--version") || process.argv.includes("exec")) {
  const response = process.argv.includes("--version") ? "codex-cli 0.140.0"
    : JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } });
  process.stdout.write(`${response}\n`);
  process.exit(0);
}

const configPath = process.env.PROPRIO_MIXED_HANDOFF_CONFIG;
let config;
const threadId = randomUUID();
const turnId = randomUUID();
let step = 0;
let statusVersion;
let active = false;
let setupProbe = false;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
function tool(name, args) {
  step += 1;
  send({ id: `fixture-tool-${step}`, method: "item/tool/call", params: { threadId, turnId, callId: `call-${step}`,
    tool: name, arguments: args } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const params = message.params ?? {};
  if (!message.method && String(message.id).startsWith("fixture-tool-")) {
    if (message.error || message.result?.success !== true) throw new Error(`Fixture tool ${step} failed`);
    const content = message.result.contentItems ?? message.result.content ?? [];
    const output = JSON.parse(content.find(item => typeof item.text === "string")?.text ?? "{}");
    const value = output.result ?? output;
    if (step === 1) {
      if (value.activeTask?.id !== config.taskId) throw new Error("Builder got the wrong task context");
      statusVersion = value.activeTask.statusVersion;
      tool("read_document", { key: "brief" });
    } else if (step === 2) {
      const brief = value.document;
      if (brief?.issueId !== config.taskId) throw new Error("Builder read a foreign brief");
      const { first, second } = JSON.parse(brief.body ?? brief.latestBody);
      tool("write_document", { idempotencyKey: "mixed-handoff-result", key: "result", title: "Arithmetic result", baseRevisionId: null,
        body: JSON.stringify({ total: first + second }) });
    } else if (step === 3) {
      if (!value.document?.latestRevisionId) throw new Error("Builder did not save a revision");
      tool("handoff_case", { idempotencyKey: "mixed-handoff-builder", case: { id: config.caseId }, toAgentId: config.verifierId,
        phase: "verification", instructions: "Independently verify the persisted arithmetic result and close the task.",
        expectedIssueStatusVersion: statusVersion, expectedHandoffVersion: 2 });
    } else if (!value.callerMustYield) throw new Error("Builder did not yield to the verifier");
    continue;
  }
  if (message.id === undefined) continue;
  if (message.method === "initialize") send({ id: message.id, result: { user: { sessionId: "mixed-handoff-fixture" } } });
  else if (["thread/start", "thread/resume", "thread/read"].includes(message.method)) {
    if (message.method !== "thread/read") setupProbe = !(params.dynamicTools ?? []).some(tool => tool.name === "get_task_context");
    send({ id: message.id, result: { model: "gpt-5.6-sol", thread: { id: threadId, sessionId: threadId,
      status: { type: active ? "active" : "idle" }, turns: active ? [{ id: turnId, status: "inProgress" }] : [] } } });
  } else if (message.method === "thread/turns/list") {
    send({ id: message.id, result: { data: active ? [{ id: turnId, status: "inProgress", items: [], itemsView: "notLoaded" }] : [], nextCursor: null } });
  } else if (message.method === "turn/start") {
    active = true;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
    if (setupProbe) {
      send({ method: "item/completed", params: { threadId, turnId,
        item: { id: `answer-${turnId}`, type: "agentMessage", phase: "final_answer", text: "hello" } } });
      active = false;
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    } else {
      config = JSON.parse(await readFile(configPath, "utf8"));
      tool("get_task_context", {});
    }
  } else if (message.method === "turn/interrupt") {
    active = false;
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: { id: params.turnId ?? turnId, status: "interrupted" } } });
  } else send({ id: message.id, result: {} });
}
