import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probeClaudeAcpHello } from "./acp-hello-probe.js";

const fixture = fileURLToPath(new URL("./__fixtures__/acp-hello-agent.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function probe(mode: string, text?: string, timeoutMs = 5_000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "proprio-acp-hello-test-"));
  roots.push(root);
  const observed = path.join(root, "observed.json");
  const result = await probeClaudeAcpHello({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`,
    env: {
      ANTHROPIC_API_KEY: "fixture-only-secret",
      ANTHROPIC_MODEL: "claude-test-model",
      PROPRIO_ACP_PROBE_FIXTURE_MODE: mode,
      ...(mode === "refusal" ? { PROPRIO_ACP_PROBE_FIXTURE_STOP_REASON: "refusal" } : {}),
      PROPRIO_ACP_PROBE_FIXTURE_OBSERVED: observed,
      ...(text ? { PROPRIO_ACP_PROBE_FIXTURE_TEXT: text } : {}),
    },
    target: null,
    timeoutMs,
  });
  return { result, observed };
}

async function expectProcessExit(pid: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ACP fixture process ${pid} did not exit after probe timeout`);
}

describe("Claude ACP hello probe", () => {
  it("requires a positive turn from the selected ACP process with the selected model and key", async () => {
    const { result, observed } = await probe("success");
    expect(result).toEqual({ status: "passed" });
    expect(JSON.parse(await readFile(observed, "utf8"))).toMatchObject({
      key: "fixture-only-secret",
      model: "claude-test-model",
      modelOptions: [],
    });
  });

  it("does not qualify a completed turn without a hello response", async () => {
    const { result } = await probe("success", "I cannot respond with hello.");
    expect(result).toEqual({ status: "failed" });
  });

  it("does not qualify a refusal even if it contains an affirmative greeting", async () => {
    const { result } = await probe("refusal", "hello");
    expect(result).toEqual({ status: "failed" });
  });

  it("bounds a hung ACP turn and reports timeout", async () => {
    const { result, observed } = await probe("hang", undefined, 800);
    expect(result).toEqual({ status: "timeout" });
    const { pid } = JSON.parse(await readFile(observed, "utf8")) as { pid: number };
    await expectProcessExit(pid);
  });
});
