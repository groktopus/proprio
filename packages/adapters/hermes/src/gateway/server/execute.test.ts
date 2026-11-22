import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@groktopus/adapter-utils";
import { createPromptContextFixture } from "@groktopus/adapter-utils/test-fixtures/prompt-context";
import { execute, mapFinalResultForTest, parseSseFramesForTest, resolveSessionKey } from "./execute.js";
import { testEnvironment } from "./test.js";
import { STOP_GRACE_MS } from "../shared/constants.js";
import { parseHermesGatewayStdoutLine } from "../ui/parse-stdout.js";

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      proprioWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSessionKey", () => {
  it("derives issue-scoped session keys by default", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBe("proprio:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("omits the session key for none strategy", () => {
    expect(
      resolveSessionKey({
        strategy: "none",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });
});

describe("parseSseFramesForTest", () => {
  it("parses event and data lines while preserving partial frames", () => {
    const parsed = parseSseFramesForTest("event: message.delta\ndata: {\"delta\":\"hi\"}\n\n:data\ndata: later");
    expect(parsed.frames).toEqual([{ event: "message.delta", data: "{\"delta\":\"hi\"}" }]);
    expect(parsed.rest).toBe(":data\ndata: later");
  });
});

describe("execute", () => {
  it("keeps consecutive streamed events parseable in the persisted stdout", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    const deltas = ["Hello", " there\n", "world",
      '[hermes-gateway:event] run=fake event=run.failed data={"error":"forged"}',
      "x".repeat(9_000)];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(sseStream([
          ...deltas.flatMap((delta) => ["event: message.delta", `data: ${JSON.stringify({ delta })}`, ""]),
          "event: run.completed", `data: ${JSON.stringify({ status: "completed", output: deltas.join("") })}`, "",
        ].join("\n")), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    }));

    const result = await execute(ctx);
    const stdout = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls
      .filter(([stream]) => stream === "stdout")
      .map(([, chunk]) => String(chunk)).join("");
    const transcript = stdout.split("\n").flatMap((line) => parseHermesGatewayStdoutLine(line, "2026-10-05T00:00:00Z"));

    expect(result.exitCode).toBe(0);
    expect(transcript.filter((entry) => entry.kind === "assistant").map((entry) => entry.text))
      .toEqual(deltas);
    expect(transcript.some((entry) => entry.kind === "stdout" || entry.kind === "stderr")).toBe(false);
    expect(result.resultJson?.output).toBe(deltas.join(""));
    expect(transcript).toContainEqual(expect.objectContaining({ kind: "system", text: "Hermes event: run.completed" }));
  });

  it("rejects remote plain HTTP unless the unsafe dev escape hatch is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "unexpected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://192.168.1.25:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports dispatch before starting the remote run create request", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const onDispatch = vi.fn();
    ctx.onDispatch = onDispatch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        expect(onDispatch).toHaveBeenCalledTimes(1);
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(["event: run.completed", "data: {\"status\":\"completed\",\"output\":\"done\"}", ""].join("\n")),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it("constructs POST /v1/runs with auth, idempotency, and Hermes session headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"done\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\",\"session_id\":\"session-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"model\":\"hermes-agent\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "pc-run-1",
      "X-Hermes-Session-Key": "proprio:company:company-1:agent:agent-1:issue:issue-1",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input).toContain("Do the thing");
    expect(body.session_id).toBe("proprio:company:company-1:agent:agent-1:issue:issue-1");
  });

  it.each([false, true])("preserves chat handoff policy on gateway turns (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith("/v1/runs")
        ? { run_id: "run-hermes-1", status: "started" }
        : { status: "completed", output: "done" },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.config.payloadTemplate = { input: "Custom gateway instruction." };
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    ctx.context = {
      conversationMode: true,
      issueId: "issue-1",
      proprioTaskMarkdown: directive,
      proprioTaskMarkdownCompact: directive,
      proprioWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", workMode: "planning", status: "in_progress" },
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    };
    if (resumed) ctx.runtime.sessionId = "prior-session";
    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const call = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(call?.[1]?.body)).input as string;
    expect(prompt).toContain("Custom gateway instruction.");
    expect(prompt).toContain(directive);
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("clear final disposition");
    expect(prompt).not.toContain("Create child issues");
  });

  it("sends the task brief once on fresh runs and compacts it on stable-session resumes", async () => {
    const description = "Update launch-card.svg and change the CTA to Try Team free.";
    const fullTaskMarkdown = [
      "Proprio task context:",
      '- Issue: "PAP-1"',
      "",
      "Issue description:",
      "```text",
      description,
      "```",
    ].join("\n");
    const compactTaskMarkdown = ["Proprio task context:", '- Issue: "PAP-1"'].join("\n");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const wakeContext = (reason: string) => ({
      issueId: "issue-1",
      wakeReason: reason,
      proprioTaskMarkdown: fullTaskMarkdown,
      proprioTaskMarkdownCompact: compactTaskMarkdown,
      proprioWake: {
        reason,
        issue: {
          id: "issue-1",
          identifier: "PAP-1",
          title: "Do the thing",
          description,
          descriptionTruncated: false,
          status: "in_progress",
        },
        commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
        comments: [],
        fallbackFetchNeeded: false,
      },
    });

    const freshCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    freshCtx.context = wakeContext("issue_assigned");
    await execute(freshCtx);

    const resumeCtx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    resumeCtx.context = wakeContext("issue_commented");
    resumeCtx.runtime = {
      sessionId: "session-1",
      sessionParams: null,
      sessionDisplayId: "session-1",
      taskKey: "PAP-1",
    };
    await execute(resumeCtx);

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runBodies = calls
      .filter(([input]) => String(input).endsWith("/v1/runs"))
      .map(([, init]) => JSON.parse(String(init?.body)) as { input: string });
    expect(runBodies).toHaveLength(2);
    // Fresh run: brief exactly once (task markdown only; wake-prompt copy suppressed).
    expect(runBodies[0]!.input.split(description)).toHaveLength(2);
    // Stable-session resume: compact task markdown, no re-sent brief.
    expect(runBodies[1]!.input).toContain("Proprio task context:");
    expect(runBodies[1]!.input).not.toContain(description);
  });

  it.each([false, true])("delivers the shared assignment and ordered comments at the HTTP boundary (resumed=%s)", async (resumed) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "completed", output: "done" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      payloadTemplate: { input: "Custom gateway instruction." },
    });
    const promptContext = createPromptContextFixture();
    ctx.context = { ...promptContext, conversationMode: true };
    if (resumed) ctx.runtime.sessionId = "prior-session";

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const input = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(input).toContain("Custom gateway instruction.");
    expect(input.indexOf("Append the same ledger entry.")).toBeGreaterThanOrEqual(0);
    expect(input.indexOf("Append the same ledger entry.")).toBeLessThan(input.indexOf("Change the final scope to the launch checklist."));
    expect(input.split("Append the same ledger entry.")).toHaveLength(3);
    expect(input).not.toContain("Structured wake payload JSON:");
    expect(input.split("Keep this deliberate repetition. Keep this deliberate repetition.")).toHaveLength(2);
    const continuationHeading = "## Current request and continuation context";
    const continuationStart = input.indexOf(continuationHeading);
    const fencedStart = input.indexOf("```text\n", continuationStart);
    const fencedEnd = input.indexOf("\n```", fencedStart + "```text\n".length);
    expect(continuationStart).toBeGreaterThanOrEqual(0);
    expect(fencedStart).toBeGreaterThan(continuationStart);
    expect(fencedEnd).toBeGreaterThan(fencedStart);
    const continuation = JSON.parse(input.slice(
      fencedStart + "```text\n".length,
      fencedEnd,
    )) as Record<string, unknown>;
    expect(continuation.objectiveSource).toEqual(promptContext.executionContinuation.objectiveSource);
    if (resumed) {
      expect(input).toContain("## Compact assignment");
      expect(continuation.objective).toBe("Keep this deliberate repetition. Keep this deliberate repetition.");
    } else {
      expect(continuation).not.toHaveProperty("objective");
    }
  });

  it("routes a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n"))
      .toContain("creating run at http://127.0.0.1:9119/api/v1/runs");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events",
      ]),
    );
  });

  it("renders current wake comments once when the gateway task brief owns them", async () => {
    const commentBody = "Keep this current comment exactly once.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context = {
      issueId: "issue-1",
      proprioTaskMarkdown: [
        "Proprio task context:",
        '- Issue: "PAP-1"',
      ].join("\n"),
      proprioTurnContext: {
        version: 1,
        assignment: { owner: "task_markdown" },
        events: { owner: "wake_prompt", comments: [{ id: "comment-1", revision: "rev-1" }] },
      },
      proprioWake: {
        reason: "issue_commented",
        issue: { id: "issue-1", identifier: "PAP-1", title: "Do the thing", status: "in_progress" },
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        comments: [{ id: "comment-1", body: commentBody }],
        fallbackFetchNeeded: false,
      },
    };

    await execute(ctx);
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const runCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    const prompt = JSON.parse(String(runCall?.[1]?.body)).input as string;
    expect(prompt.split(commentBody)).toHaveLength(2);
  });

  it("routes the default Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-chat", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events",
      ]),
    );
  });

  it("redacts echoed auth material from stream logs and summaries", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"Authorization: Bearer secret-key\\nX-Hermes-Session-Key: proprio:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"Authorization: Bearer secret-key\\nraw key secret-key\\nX-Hermes-Session-Key: proprio:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Bearer [redacted]");
    expect(result.summary).toContain("raw key [redacted len=10]");
    expect(result.summary).toContain("X-Hermes-Session-Key: [redacted]");
    expect(result.summary).not.toContain("secret-key");
    expect(result.summary).not.toContain("proprio:company:company-1:agent:agent-1:issue:issue-1");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(logText).toContain("Bearer [redacted]");
    expect(logText).toContain("X-Hermes-Session-Key: [redacted]");
    expect(logText).not.toContain("secret-key");
    expect(logText).not.toContain("proprio:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("redacts agent-scoped Proprio session keys from logs and public result metadata", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "agent",
      timeoutSec: 5,
    });
    const agentSessionKey = "proprio:company:company-1:agent:agent-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: {"delta":"session ${agentSessionKey}"}`,
              "",
              "event: run.completed",
              `data: {"status":"completed","output":"session ${agentSessionKey}","session_id":"${agentSessionKey}"}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("session [redacted-session-key]");
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.sessionDisplayId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
    expect(result.sessionParams).toEqual({
      hermesRunId: "run-hermes-1",
      strategy: "agent",
    });
    expect(logText).toContain("[redacted-session-key]");
    expect(logText).not.toContain(agentSessionKey);
  });

  it("falls back to polling when SSE is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response("no stream", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "polled done",
        session_id: "session-polled",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("polled done");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-hermes-1"))).toBe(true);
  });

  it("maps HTTP auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMessage).toContain("Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY");
  });

  it("includes network causes in connection failure messages", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://host.docker.internal:8642",
      apiKey: "secret-key",
      dangerouslyAllowInsecureRemoteHttp: true,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).toContain("ENOTFOUND");
    expect(result.errorMessage).toContain("host.docker.internal");
  });

  it.each([
    ["http://127.0.0.1:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://[::1]:8642", { code: "ECONNREFUSED", syscall: "connect", address: "::1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [
      { code: "ECONNREFUSED", syscall: "connect", address: "::1", port: 8642 },
      { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 },
    ] }],
    ["https://localhost", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 443 }],
    ["http://localhost", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 80 }],
  ])("explains the server-side loopback gateway at %s without claiming non-dispatch", async (apiBaseUrl, cause) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw Object.assign(new Error("fetch failed"), { cause });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl, apiKey: "gateway-private-key" });
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);

    expect(result.errorMessage).toContain("refers to the Proprio server, not an agent sandbox");
    expect(result.errorMessage).toContain("adapterConfig.apiBaseUrl");
    expect(result.errorMessage).toContain("hermes_local");
    expect(result.errorMessage).not.toContain("gateway-private-key");
    expect(result.errorMeta).toEqual({ category: "gateway_loopback_connection_refused", phase: "create_run" });
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_connect_failed", errorFamily: "transient_upstream", retryNotBefore: null });
    expect(result.executionRecovery).toBeUndefined();
    expect(result.resultJson).toEqual({ connectionFailure: {
      schemaVersion: 1, provider: "hermes_gateway", operation: "create_run", reason: "connection_refused",
    } });
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it.each([
    ["https://gateway.example.test:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", syscall: "connect", address: "192.0.2.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 9000 }],
    ["http://127.0.0.2:8642", { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ETIMEDOUT", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "EHOSTUNREACH", syscall: "connect", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { code: "ECONNREFUSED", address: "127.0.0.1", port: 8642 }],
    ["http://localhost:8642", { message: "ECONNREFUSED connect 127.0.0.1:8642" }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [] }],
    ["http://localhost:8642", { code: "ECONNREFUSED", errors: [
      { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642 },
      { code: "ETIMEDOUT", syscall: "connect", address: "::1", port: 8642 },
    ] }],
  ])("keeps ambiguous or nonmatching transport errors generic at %s", async (apiBaseUrl, cause) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("fetch failed"), { cause }); }));
    const result = await execute(makeCtx({ apiBaseUrl, apiKey: "secret-key" }));
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).not.toContain("refers to the Proprio server");
    expect(result.errorMeta).toEqual({});
    expect(result.executionRecovery).toBeUndefined();
  });

  it("does not infer loopback refusal from an HTTP provider response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 8642,
    }), { status: 503 })));
    const result = await execute(makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" }));
    expect(result.errorCode).toBe("hermes_gateway_upstream_error");
    expect(result.errorMeta?.category).toBeUndefined();
    expect(result.errorMessage).not.toContain("refers to the Proprio server");
    expect(result.executionRecovery).toBeUndefined();
  });

  it("redacts echoed auth material from HTTP error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: "Authorization rejected: Bearer secret-key raw secret-key",
            detail: "X-Hermes-Session-Key: proprio:company:company-1:agent:agent-1:issue:issue-1",
            nested: {
              note: "session proprio:company:company-1:agent:agent-1",
            },
          }),
          { status: 401 },
        )),
    );

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMeta?.body).toEqual({
      message: "Authorization rejected: Bearer [redacted] raw [redacted len=10]",
      detail: "X-Hermes-Session-Key: [redacted]",
      nested: {
        note: "session [redacted-session-key]",
      },
    });
    expect(result.errorMessage).not.toContain("secret-key");
    expect(result.errorMessage).not.toContain("proprio:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("calls stop on timeout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
  });
});

describe("Hermes Gateway operator Stop", () => {
  const makeStopContext = (timeoutSec = 0) => {
    const abort = new AbortController();
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "fixture-token", timeoutSec });
    ctx.signal = abort.signal;
    ctx.onCancellationReady = vi.fn(async () => undefined);
    ctx.onDispatch = vi.fn();
    return { abort, ctx };
  };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const hung = () => new Promise<Response>(() => {});
  const responseGate = () => {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((complete) => { resolve = complete; });
    return { promise, resolve };
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("acknowledges a proven no-launch separately and does not call the gateway", async () => {
    const { abort, ctx } = makeStopContext();
    ctx.onCancellationReady = vi.fn(async () => abort.abort());
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);

    expect(ctx.onCancellationReady).toHaveBeenCalledOnce();
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(result.errorCode).toBe("hermes_gateway_cancelled");
    expect(result.resultJson?.executionCancellation).toMatchObject({
      state: "acknowledged", proof: "hermes_gateway_create_not_started",
    });
  });

  it.each(["in-flight create", "live run"])(
    "requests Stop once for the exact remote run after cancelling the %s",
    async (phase) => {
      vi.useFakeTimers();
      const { abort, ctx } = makeStopContext(0.1);
      const creation = responseGate();
      const requests: string[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = `${init?.method} ${new URL(String(input)).pathname}`;
        requests.push(request);
        if (request === "POST /v1/runs") return creation.promise;
        if (request === "GET /v1/runs/hermes-123/events") return hung();
        if (request === "POST /v1/runs/hermes-123/stop") return json({ run_id: "hermes-123", status: "stopping" });
        if (request === "GET /v1/runs/hermes-123") return json({ run_id: "hermes-123", status: "cancelled" });
        throw new Error(`Unexpected request: ${request}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const execution = execute(ctx);
      await vi.advanceTimersByTimeAsync(0);
      if (phase === "live run") {
        creation.resolve(json({ run_id: "hermes-123", status: "running" }));
        await vi.advanceTimersByTimeAsync(0);
      }
      abort.abort();
      abort.abort();
      if (phase === "in-flight create") {
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).not.toBe(true);
        creation.resolve(json({ run_id: "hermes-123", status: "running" }));
      }
      await vi.advanceTimersByTimeAsync(100);
      const result = await execution;

      expect(requests.filter((request) => request.startsWith("POST"))).toEqual([
        "POST /v1/runs", "POST /v1/runs/hermes-123/stop",
      ]);
      expect(result).toMatchObject({ errorCode: "hermes_gateway_cancelled", timedOut: false });
      expect(result.resultJson).toMatchObject({ run_id: "hermes-123", status: "cancelled" });
      expect(result.resultJson?.executionCancellation).toBeUndefined();
    },
  );

  it.each(["create", "stop", "status", "still running"])(
    "bounds cancellation without false proof when the gateway is stuck at %s",
    async (phase) => {
      vi.useFakeTimers();
      const { abort, ctx } = makeStopContext();
      const signals = new Map<string, AbortSignal | null | undefined>();
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input)).pathname;
        signals.set(url, init?.signal);
        if (url === "/v1/runs") return phase === "create" ? hung() : json({ run_id: "hermes-123" });
        if (url.endsWith("/events")) return hung();
        if (url.endsWith("/stop")) return phase === "stop" ? hung() : json({ status: "stopping" });
        return phase === "status" ? hung() : json({ status: "running" });
      });
      vi.stubGlobal("fetch", fetchMock);
      let result: Awaited<ReturnType<typeof execute>> | undefined;
      void execute(ctx).then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
      expect(result).toMatchObject({ errorCode: "hermes_gateway_cancelled", timedOut: false });
      expect(result?.resultJson).toMatchObject({ status: "unconfirmed" });
      expect(result?.resultJson?.executionCancellation).toBeUndefined();
      const stalledUrl = phase === "create" ? "/v1/runs" : phase === "stop" ? "/v1/runs/hermes-123/stop" : "/v1/runs/hermes-123";
      expect(signals.get(stalledUrl)?.aborted).toBe(true);
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/stop"))).toHaveLength(
        phase === "create" ? 0 : 1,
      );
    },
  );

  it("rejects a redirect on the Stop POST without acknowledging the remote run", async () => {
    vi.useFakeTimers();
    const { abort, ctx } = makeStopContext(0.1);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)).pathname;
      if (url === "/v1/runs") return json({ run_id: "hermes-123" });
      if (url.endsWith("/events")) return hung();
      if (url.endsWith("/stop")) {
        // Fetch with redirect: error rejects an underlying 307 before it can
        // repeat the POST on the Location target.
        if (init?.redirect === "error") throw new TypeError("fixture redirect rejected");
        return new Response(null, { status: 307, headers: { Location: "https://redirect.invalid/stop" } });
      }
      return json({ error: "status unknown" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const execution = execute(ctx);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(100);
    const result = await execution;

    const stopCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/stop"));
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("redirect.invalid"))).toBe(false);
    expect(result).toMatchObject({ errorCode: "hermes_gateway_cancelled", timedOut: false, resultJson: { status: "unconfirmed" } });
    expect(result.resultJson?.executionCancellation).toBeUndefined();
  });

  it("preserves natural completion racing with Stop and does not acknowledge a rejected Stop", async () => {
    vi.useFakeTimers();
    const { abort, ctx } = makeStopContext(0.1);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)).pathname;
      if (url === "/v1/runs") return json({ run_id: "hermes-123" });
      if (url.endsWith("/events")) return hung();
      if (url.endsWith("/stop")) return json({ error: "run not active" }, 409);
      return json({ run_id: "hermes-123", status: "completed", output: "saved result" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const execution = execute(ctx);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(100);
    const result = await execution;

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, completionObserved: true, resultJson: { status: "completed", output: "saved result" } });
    expect(result.resultJson?.executionCancellation).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/stop"))).toHaveLength(1);
  });

  it("keeps completion received through SSE while its log write and Stop race", async () => {
    const { abort, ctx } = makeStopContext();
    let releaseLog!: () => void;
    let received!: () => void;
    const receivedEvent = new Promise<void>(resolve => { received = resolve; });
    const logGate = new Promise<void>(resolve => { releaseLog = resolve; });
    ctx.onLog = vi.fn(async (_stream, chunk) => {
      if (chunk.includes("event=run.completed")) { received(); await logGate; }
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/runs") return json({ run_id: "hermes-123" });
      if (path.endsWith("/events")) return new Response('event: run.completed\ndata: {"status":"completed","output":"SSE reply"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
      throw new Error("gateway unavailable after completion");
    }));
    try {
      const execution = execute(ctx);
      await receivedEvent;
      abort.abort();
      expect(await execution).toMatchObject({ exitCode: 0, completionObserved: true, resultJson: { output: "SSE reply" } });
    } finally { releaseLog(); }
  });

  it.each(["run created", "stop requested", "stop request failed"])("keeps Stop independent of a stalled %s log", async log => {
    const { abort, ctx } = makeStopContext();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    ctx.onLog = vi.fn(async (_stream, chunk) => { if (chunk.includes(log)) await gate; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/runs") { abort.abort(); return json({ run_id: "hermes-123" }); }
      if (path.endsWith("/stop")) {
        if (log === "stop request failed") throw new Error("Stop rejected");
        return json({ status: "stopping" });
      }
      return json({ status: "completed", output: "Observed despite log" });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await execute(ctx)).toMatchObject({ exitCode: 0, completionObserved: true,
        resultJson: { output: "Observed despite log" } });
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/stop"))).toHaveLength(1);
    } finally { release(); }
  });

  it("fills a sparse SSE completion with the observed status reply", async () => {
    const { abort, ctx } = makeStopContext();
    let release!: () => void;
    let received!: () => void;
    const event = new Promise<void>(resolve => { received = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    ctx.onLog = vi.fn(async (_stream, chunk) => { if (chunk.includes("event=run.completed")) { received(); await gate; } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/runs") return json({ run_id: "hermes-123" });
      if (path.endsWith("/events")) return new Response('event: run.completed\ndata: {"status":"completed"}\n\n');
      if (path.endsWith("/stop")) return json({ status: "stopping" });
      return json({ status: "completed", output: "Full status reply", usage: { input_tokens: 12, output_tokens: 3 } });
    }));
    try {
      const execution = execute(ctx);
      await event;
      abort.abort();
      expect(await execution).toMatchObject({ exitCode: 0, resultJson: { output: "Full status reply" } });
    } finally { release(); }
  });

  it.each(["create", "stop"] as const)("refuses real HTTP redirects during %s without replaying the POST", async phase => {
    vi.unstubAllGlobals();
    const { abort, ctx } = makeStopContext();
    let observed!: () => void;
    const events = new Promise<void>(resolve => { observed = resolve; });
    let redirected = 0, creates = 0, stops = 0;
    const server = createServer((request, response) => {
      const jsonResponse = (value: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
      const redirect = () => { response.writeHead(307, { Location: "/redirected" }); response.end(); };
      if (request.url === "/redirected") { redirected++; jsonResponse({ run_id: "unexpected" }); }
      else if (request.method === "POST" && request.url === "/v1/runs") {
        creates++; if (phase === "create") redirect(); else jsonResponse({ run_id: "hermes-123" });
      } else if (request.url?.endsWith("/events")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write(": waiting\n\n"); observed();
      } else if (request.url?.endsWith("/stop")) { stops++; redirect(); }
      else jsonResponse({ status: "cancelled" });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    ctx.config.apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const execution = execute(ctx);
      if (phase === "stop") { await events; abort.abort(); }
      expect((await execution).exitCode).toBe(1);
      expect(redirected).toBe(0);
      expect(creates).toBe(1);
      expect(stops).toBe(phase === "stop" ? 1 : 0);
    } finally {
      abort.abort(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(["stop", "status"] as const)("closes a real stalled HTTP %s connection at the Stop deadline", async phase => {
    vi.unstubAllGlobals();
    const { abort, ctx } = makeStopContext();
    let observeEvents!: () => void;
    const events = new Promise<void>(resolve => { observeEvents = resolve; });
    let closed = false, stopRequests = 0, creates = 0;
    const server = createServer((request, response) => {
      const jsonResponse = (value: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
      if (request.method === "POST" && request.url === "/v1/runs") { creates++; jsonResponse({ run_id: "hermes-123" }); }
      else if (request.url?.endsWith("/events")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write(": waiting\n\n"); observeEvents();
      } else if (request.url?.endsWith("/stop")) {
        stopRequests++;
        if (phase === "stop") request.socket.once("close", () => { closed = true; });
        else jsonResponse({ status: "stopping" });
      } else if (phase === "status") request.socket.once("close", () => { closed = true; });
      else jsonResponse({ status: "running" });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    ctx.config.apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const execution = execute(ctx);
      await events;
      abort.abort();
      expect(await execution).toMatchObject({ errorCode: "hermes_gateway_cancelled", resultJson: { status: "unconfirmed" } });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
      expect(creates).toBe(1);
      expect(stopRequests).toBe(1);
    } finally {
      abort.abort(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, STOP_GRACE_MS + 10_000);

  it("shares one remote Stop when a timeout races with an operator request", async () => {
    vi.useFakeTimers();
    const { abort, ctx } = makeStopContext(0.001);
    const stopping = responseGate();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)).pathname;
      if (url === "/v1/runs") return json({ run_id: "hermes-123" });
      if (url.endsWith("/events")) return hung();
      if (url.endsWith("/stop")) return stopping.promise;
      return json({ status: "cancelled" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const execution = execute(ctx);
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    stopping.resolve(json({ status: "stopping" }));
    await vi.advanceTimersByTimeAsync(0);
    const result = await execution;

    expect(result).toMatchObject({ errorCode: "hermes_gateway_cancelled", timedOut: false });
    expect(result.resultJson?.executionCancellation).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/stop"))).toHaveLength(1);
  });
});

describe("gateway connection failure reporting", () => {
  const config = { apiBaseUrl: "https://gateway.example.test", apiKey: "gateway-private-key" };
  const marker = (operation: string, reason: string) => ({
    schemaVersion: 1, provider: "hermes_gateway", operation, reason,
  });

  it.each([
    [{}, "api_base_url_missing", "endpoint_missing"],
    [{ apiBaseUrl: "not a URL" }, "api_base_url_invalid", "endpoint_invalid"],
    [{ apiBaseUrl: "ftp://gateway.example.test" }, "api_base_url_invalid", "endpoint_invalid"],
    [{ apiBaseUrl: "http://gateway.example.test" }, "plain_http_remote_denied", "insecure_transport"],
    [{ apiBaseUrl: config.apiBaseUrl }, "api_key_missing", "credentials_missing"],
  ])("classifies configuration failure %s without dispatch", async (settings, code, reason) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(settings);
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: `hermes_gateway_${code}`, resultJson: { connectionFailure: marker("configuration", reason) } });
    expect(result.errorMessage).toBeTruthy();
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth_failed", "authentication_failed", null],
    [403, "auth_failed", "authentication_failed", null],
    [404, "runs_unsupported", "endpoint_not_found", null],
    [429, "rate_limited", "rate_limited", "transient_upstream"],
    [500, "upstream_error", "remote_unavailable", "transient_upstream"],
    [503, "upstream_error", "remote_unavailable", "transient_upstream"],
    [599, "upstream_error", "remote_unavailable", "transient_upstream"],
  ])("classifies HTTP %i without changing retry or dispatch behavior", async (status, code, reason, errorFamily) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "remote failure" }), {
      status, headers: { "retry-after": "7" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(config);
    ctx.onDispatch = vi.fn();
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: `hermes_gateway_${code}`, errorFamily, retryNotBefore: "7",
      errorMeta: { status, body: { detail: "remote failure" } },
      resultJson: { connectionFailure: marker("create_run", reason) } });
    expect(result.errorMessage).toContain(`Hermes gateway HTTP ${status}`);
    expect(result.executionRecovery).toBeUndefined();
    expect(ctx.onDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(Object.keys(result.resultJson ?? {})).toEqual(["connectionFailure"]);
  });

  it.each([
    ["ECONNREFUSED", "connection_refused"], ["ENOTFOUND", "dns_failure"], ["EAI_AGAIN", "dns_failure"],
    ["EHOSTUNREACH", "network_unreachable"], ["ENETUNREACH", "network_unreachable"],
    ["ECONNRESET", "connection_reset"], ["EPIPE", "connection_reset"], ["UND_ERR_SOCKET", "connection_reset"],
    ["ETIMEDOUT", "connection_timeout"], ["UND_ERR_CONNECT_TIMEOUT", "connection_timeout"],
    ["UND_ERR_HEADERS_TIMEOUT", "connection_timeout"], ["UND_ERR_BODY_TIMEOUT", "connection_timeout"],
    ["CERT_HAS_EXPIRED", "tls_failure"], ["CERT_NOT_YET_VALID", "tls_failure"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_failure"], ["SELF_SIGNED_CERT_IN_CHAIN", "tls_failure"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_failure"], ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls_failure"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_failure"],
  ])("classifies structured fetch cause %s", async (code, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("external transport failed"), { code }) });
    }));
    const result = await execute(makeCtx(config));
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_connect_failed", errorFamily: "transient_upstream", retryNotBefore: null,
      resultJson: { connectionFailure: marker("create_run", reason) } });
    expect(result.errorMessage).toContain(code);
    expect(result.executionRecovery).toBeUndefined();
  });

  it("classifies a network failure reading the create response without rewriting its error", async () => {
    const response = new Response("unread");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const result = await execute(makeCtx(config));
    expect(result).toMatchObject({ exitCode: 1, signal: null, timedOut: false,
      errorCode: "hermes_gateway_protocol_error", errorFamily: null, errorMessage: "terminated",
      resultJson: { connectionFailure: marker("create_run", "connection_reset") } });
    expect(result.executionRecovery).toBeUndefined();
  });

  it("requires every aggregate member to prove the same external failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed", { cause: {
      code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }],
    } }); }));
    const result = await execute(makeCtx(config));
    expect(result.resultJson).toEqual({ connectionFailure: marker("create_run", "connection_refused") });
  });

  it.each([
    undefined, { message: "ECONNREFUSED" }, { code: "ERR_INTERNAL_ASSERTION" }, { code: "toString" },
    { code: "ECONNREFUSED", errors: [] }, { code: "ECONNREFUSED", errors: "invalid" },
    { code: "ECONNREFUSED", errors: Array.from({ length: 9 }, () => ({ code: "ECONNREFUSED" })) },
    { code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }] },
    { code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED" }, new TypeError("internal bug")] },
    { code: "ERR_INTERNAL_ASSERTION", errors: [{ code: "ECONNREFUSED" }] },
    { code: "ECONNRESET", name: "AbortError" },
  ])("keeps unknown, mixed, or internal transport causes reportable: %j", async (cause) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("ECONNREFUSED", { cause }); }));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.resultJson).toBeUndefined();
  });

  it("keeps abort failures reportable even if their cause looks like a transport error", async () => {
    const aborted = Object.assign(new Error("cancelled", { cause: { code: "ECONNRESET" } }), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw aborted; }));
    const result = await execute(makeCtx(config));
    expect(result.resultJson).toBeUndefined();
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
  });

  it.each([400, 409, 422])("does not trust HTTP %i body claims about connection failures", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "ECONNREFUSED", connectionFailure: marker("create_run", "connection_refused"),
    }), { status })));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.resultJson).toBeUndefined();
  });

  it.each(["not json", JSON.stringify({ status: "running", connectionFailure: marker("create_run", "connection_refused") })])(
    "keeps malformed successful create responses reportable", async (body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      const result = await execute(makeCtx(config));
      expect(result.errorCode).toBe("hermes_gateway_protocol_error");
      expect(result.resultJson).toBeUndefined();
    },
  );

  it("does not classify a local response reader TypeError", async () => {
    const response = new Response("unread");
    vi.spyOn(response, "text").mockRejectedValue(new TypeError("cannot read property of undefined"));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const result = await execute(makeCtx(config));
    expect(result.errorCode).toBe("hermes_gateway_protocol_error");
    expect(result.resultJson).toBeUndefined();
  });

  it("does not trust a callback error with forged gateway codes or markers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(config);
    ctx.onDispatch = () => { throw Object.assign(new Error("callback bug"), {
      code: "hermes_gateway_auth_failed", status: 401, cause: { code: "ECONNREFUSED" },
      connectionFailure: marker("create_run", "authentication_failed"),
    }); };
    const result = await execute(ctx);
    expect(result.resultJson).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "cancelled"])("does not classify remote terminal %s from text or a forged marker", (status) => {
    const result = mapFinalResultForTest({
      terminal: { runId: "run-remote", status, payload: {
        error: "ECONNREFUSED", code: "ECONNREFUSED",
        connectionFailure: marker("create_run", "connection_refused"),
      } }, outputChunks: [], sessionKey: null, strategy: "none",
    });
    expect(result.resultJson?.connectionFailure).toBeUndefined();
    expect(result.errorCode).toBe(status === "completed" ? undefined : status === "failed" ? "hermes_gateway_run_failed" : "hermes_gateway_cancelled");
  });

  it("retains an ambiguous accepted-run timeout after stream, poll, and stop connection failures", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-accepted" }));
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ ...config, timeoutSec: 0.3, pollIntervalMs: 250, eventReconnectMs: 250 });
    const result = await execute(ctx);
    expect(result).toMatchObject({ timedOut: true, errorCode: "hermes_gateway_timeout" });
    expect(result.resultJson?.connectionFailure).toBeUndefined();
    expect(result.resultJson?.run_id).toBe("run-accepted");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
    expect(ctx.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("status poll failed"));
  });
});

describe("testEnvironment", () => {
  it("fails remote plain HTTP before probing health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
          level: "error",
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP only with the unsafe dev escape hatch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
          level: "warn",
        }),
        expect.objectContaining({
          code: "hermes_gateway_health_ok",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fails test environment checks when Hermes health is unreachable", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://host.docker.internal:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_unreachable",
          level: "error",
          detail: expect.stringContaining("ENOTFOUND"),
        }),
      ]),
    );
  });

  it("fails test environment checks when Hermes health returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "wrong-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_failed",
          level: "error",
          message: "Hermes Gateway health endpoint returned HTTP 401.",
        }),
      ]),
    );
  });

  it("tests a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("tests a Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("mapFinalResultForTest", () => {
  it("maps failed statuses into adapter errors", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", error: "boom" },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("boom");
  });
});
