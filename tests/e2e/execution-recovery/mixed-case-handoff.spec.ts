import { expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, rename, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { gradeMixedHandoff } from "./mixed-handoff-evidence";

test("a legacy lead hands the same Case to a native builder and legacy verifier", async ({ page, request }, info) => {
  const repo = resolve(import.meta.dirname, "../../..");
  const fixtureDir = resolve(import.meta.dirname, "../fixtures");
  const scratch = info.outputPath("mixed-handoff-fixture");
  await mkdir(scratch, { recursive: true });
  const codex = resolve(scratch, "codex");
  const codexLoader = resolve(scratch, "codex-loader.mjs");
  const codexHome = resolve(scratch, "codex-home");
  const fixtureConfig = resolve(scratch, "fixture.json");
  const sourceReceipt = resolve(scratch, "outgoing-receipt.json");
  const releaseFile = resolve(scratch, "release");
  const verificationReceipt = resolve(scratch, "verification-receipt.json");
  await mkdir(codexHome);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(fixtureDir, "mixed-handoff-codex.mjs"))} "$@"\n`, { mode: 0o700 });
  await copyFile(resolve(fixtureDir, "mixed-handoff-codex-loader.mjs"), codexLoader);
  const env = { ...process.env, NODE_ENV: "test", CODEX_HOME: codexHome,
    OPENAI_API_KEY: "mixed-handoff-fixture", CODEX_API_KEY: "", DATABASE_URL: undefined, DATABASE_MIGRATION_URL: undefined,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${codexLoader}` };
  let logs = "";
  const drive = spawn(process.execPath, ["--import", "./cli/node_modules/tsx/dist/loader.mjs", "cli/src/index.ts", "test-drive",
    "--harness", "codex", "--api-key-env", "OPENAI_API_KEY", "--company-name", "Mixed Case Handoff Fixture", "--no-browser"],
  { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  drive.stdout.on("data", chunk => { logs += chunk.toString(); });
  drive.stderr.on("data", chunk => { logs += chunk.toString(); });
  const exited = once(drive, "exit");
  const readyUrl = () => logs.match(/Proprio is ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  try {
    await Promise.race([
      expect.poll(readyUrl, { timeout: 100_000 }).toBeTruthy(),
      exited.then(([code, signal]) => { throw new Error(`Fixture controller exited during startup (${code ?? signal})\n${logs}`); }),
    ]);
    const base = readyUrl()!;
    const api = async (path: string, method = "GET", data?: unknown) => {
      const response = await request.fetch(`${base}/api${path}`, { method, data });
      const body = await response.text();
      expect(response.ok(), `${method} ${path}: ${response.status()} ${body}`).toBe(true);
      return JSON.parse(body);
    };
    const [company] = await api("/companies");
    const companyPath = `/companies/${company.id}`;
    await api("/instance/settings/experimental", "PATCH", { enableCases: true, enableNativeRunner: true });
    async function processAgent(role: "lead" | "verifier") {
      return api(`${companyPath}/agents`, "POST", { name: `Fixture ${role}`, role: "engineer", adapterType: "process",
        adapterConfig: { command: process.execPath, args: [resolve(fixtureDir, "mixed-handoff-process.mjs"), role, fixtureConfig], timeoutSec: 60 },
        runtimeConfig: { heartbeat: { enabled: false } } });
    }
    const lead = await processAgent("lead");
    const verifier = await processAgent("verifier");
    const builder = await api(`${companyPath}/agents`, "POST", { name: "Fixture builder", role: "engineer", adapterType: "proprio_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-sol", cwd: scratch, lifecycleMode: "per_turn", codexPermissionMode: "never", timeoutSec: 50,
        env: { CODEX_HOME: codexHome, OPENAI_API_KEY: "mixed-handoff-fixture", PROPRIO_MIXED_HANDOFF_CONFIG: fixtureConfig } },
      runtimeConfig: { heartbeat: { enabled: false } } });
    await expect.poll(async () => {
      const agent = await api(`/agents/${builder.id}`);
      return { status: agent.status, lifecycleHolds: agent.lifecycleHolds ?? [] };
    }, { timeout: 25_000 }).toEqual({ status: "idle", lifecycleHolds: [] });
    const title = "Verify the mixed-runner arithmetic handoff";
    const brief = { first: 17, second: 29 };
    const started = await api(`${companyPath}/case-handoffs`, "POST", { idempotencyKey: "mixed-handoff-start",
      case: { create: { caseType: "work", title, fields: {} } }, toAgentId: lead.id, phase: "triage",
      instructions: "Send the same task to the builder.", workflow_document_text: "Lead hands the task to the builder. The verifier checks the saved result and closes the task.",
      initialDocuments: [{ key: "brief", title: "Arithmetic brief", body: JSON.stringify(brief) }] });
    const { caseId, taskId } = started;
    await writeFile(`${fixtureConfig}.tmp`, JSON.stringify({ caseId, taskId, builderId: builder.id,
      verifierId: verifier.id, sourceReceipt, releaseFile, verificationReceipt }), { mode: 0o600 });
    await rename(`${fixtureConfig}.tmp`, fixtureConfig);

    const runsPath = `${companyPath}/heartbeat-runs?limit=100`;
    await expect.poll(() => readFile(sourceReceipt, "utf8").catch(() => ""), { timeout: 35_000 }).not.toBe("");
    const outgoing = JSON.parse(await readFile(sourceReceipt, "utf8"));
    expect(outgoing.staleWriteCode).toBe("case_handoff_run_yielded");
    expect((await api(runsPath)).map((run: { agentId: string }) => run.agentId)).toEqual([lead.id]);
    expect(await api(`/issues/${taskId}?view=core`)).toMatchObject({ title, assigneeAgentId: lead.id });
    await writeFile(releaseFile, "release", { flag: "wx" });

    await expect.poll(async () => (await api(`/issues/${taskId}?view=core`)).status, { timeout: 90_000 }).toBe("done");
    await expect.poll(async () => (await api(runsPath)).map((run: { status: string }) => run.status), { timeout: 25_000 })
      .toEqual(["succeeded", "succeeded", "succeeded"]);
    const task = await api(`/issues/${taskId}?view=core`);
    const caseRecord = await api(`/cases/${caseId}`);
    const ledger = await api(`/cases/${caseId}/handoffs?limit=20`);
    const artifact = await api(`/issues/${taskId}/documents/result`);
    const runRows = await api(runsPath);
    const runs = await Promise.all(runRows.map(async (entry: { id: string }) => {
      const run = await api(`/heartbeat-runs/${entry.id}`);
      return { id: run.id, agentId: run.agentId, issueId: run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId,
        runtimeMode: run.runtimeMode, status: run.status, incomingHandoffId: run.contextSnapshot?.caseHandoffId,
        handoffVersion: run.contextSnapshot?.proprioCase?.handoffVersion,
        releasedIssueId: run.resultJson?.caseHandoffExecutionReleased?.issueId ?? null };
    }));
    const observed = { task: { id: task.id, status: task.status, assigneeAgentId: task.assigneeAgentId },
      caseRecord: { workIssueId: caseRecord.workIssueId, handoffVersion: caseRecord.handoffVersion },
      agents: { lead: lead.id, builder: builder.id, verifier: verifier.id },
      handoffs: (Array.isArray(ledger) ? ledger : ledger.items ?? ledger.handoffs).map((handoff: Record<string, unknown>) => ({
        id: handoff.id, issueId: handoff.issueId, version: handoff.version, state: handoff.state,
        sourceRunId: handoff.sourceRunId, toAgentId: handoff.toAgentId,
      })), runs, artifact: { issueId: artifact.issueId, revisionId: artifact.latestRevisionId, body: artifact.body ?? artifact.latestBody },
      verification: JSON.parse(await readFile(verificationReceipt, "utf8")) };
    const verdict = gradeMixedHandoff(observed, JSON.stringify({ total: brief.first + brief.second }));
    await info.attach("mixed-handoff-evidence", { contentType: "application/json", body: JSON.stringify({
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      profiles: ["legacy/process", "native/codex-app-server fixture", "legacy/process"],
      outgoing, observed, verdict,
    }, null, 2) });
    expect(Object.entries(verdict).filter(([, passed]) => !passed).map(([check]) => check)).toEqual([]);
    await page.goto(`${base}/${company.issuePrefix}/issues/${task.identifier ?? task.id}`);
    await expect(page.getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
  } catch (error) {
    await info.attach("test-drive-logs", { body: logs, contentType: "text/plain" });
    throw error;
  } finally {
    if (drive.pid && drive.exitCode === null && drive.signalCode === null) {
      process.kill(-drive.pid, "SIGTERM");
      const timeout = new AbortController();
      try {
        await Promise.race([exited, setTimeout(10_000, undefined, { signal: timeout.signal }).then(() => {
          if (drive.exitCode === null && drive.signalCode === null) process.kill(-drive.pid!, "SIGKILL");
        })]);
      } finally {
        timeout.abort();
        await exited;
      }
    }
  }
});
