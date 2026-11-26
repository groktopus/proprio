import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rename, readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gradeMixedHandoff, type MixedHandoffObservation } from "./mixed-handoff-evidence";
import { launchTestDrive } from "../fixtures/test-drive-process";
import { makeDirectoryTreeRemovable } from "../../runner-e2e/directory-cleanup";
import { createProcessTreeOwner, stopOwnedProcessTree } from "../../runner-e2e/process-tree-owner";

for (const restart of [false, true]) test(
  `a legacy lead hands the same Case to a native builder and legacy verifier${restart ? " after controller restart" : ""}`, async ({ page, request }, info) => {
  const repo = resolve(import.meta.dirname, "../../..");
  const fixtureDir = resolve(import.meta.dirname, "../fixtures");
  const scratch = info.outputPath("mixed-handoff-fixture");
  await mkdir(scratch, { recursive: true });
  const codex = resolve(scratch, "codex");
  const codexLoader = pathToFileURL(resolve(fixtureDir, "mixed-handoff-codex-loader.mjs")).href;
  const codexHome = resolve(scratch, "codex-home");
  const fixtureConfig = resolve(scratch, "fixture.json");
  const sourceReceipt = resolve(scratch, "outgoing-receipt.json");
  const builderReceipt = resolve(scratch, "builder-input-receipt.json");
  const releaseFile = resolve(scratch, "release");
  const verificationReceipt = resolve(scratch, "verification-receipt.json");
  await mkdir(codexHome);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(codex, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(fixtureDir, "mixed-handoff-codex.mjs"))} "$@"\n`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", CODEX_HOME: codexHome, NO_COLOR: "1",
    MIXED_HANDOFF_CODEX_COMMAND: codex, OPENAI_API_KEY: "mixed-handoff-fixture", CODEX_API_KEY: "", DATABASE_URL: undefined, DATABASE_MIGRATION_URL: undefined,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${codexLoader}` };
  delete env.FORCE_COLOR;
  const dataDir = await mkdtemp(resolve(tmpdir(), "proprio-mixed-handoff-"));
  const instance = basename(dataDir);
  let logs = "";
  let drive: { child: ReturnType<typeof launchTestDrive>["child"]; owner: ReturnType<typeof createProcessTreeOwner> } | undefined;
  const checkpoints: Array<{ phase: string; observedAt: string; details: Record<string, unknown> }> = [];
  async function recordCheckpoint(phase: string, details: Record<string, unknown>) {
    checkpoints.push({ phase, observedAt: new Date().toISOString(), details });
    await writeFile(info.outputPath("mixed-handoff-restart-checkpoints.json"), JSON.stringify(checkpoints, null, 2));
  }
  async function startDrive() {
    const launched = launchTestDrive({ cwd: repo, env,
      args: ["--data-dir", dataDir, "--instance", instance, "--harness", "codex", "--api-key-env", "OPENAI_API_KEY",
        "--company-name", "Mixed Case Handoff Fixture", "--no-browser"],
      onOutput: chunk => { logs += chunk; },
    });
    drive = { child: launched.child, owner: createProcessTreeOwner(launched.child) };
    return launched.ready;
  }
  async function stopDrive() {
    const active = drive;
    if (!active) return;
    try {
      await stopOwnedProcessTree(active.child, active.owner);
      drive = undefined;
    } finally {
      active.owner.stopObserving();
    }
  }

  try {
    let base = await startDrive();
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
    if (restart) {
      await api(`/agents/${builder.id}/pause`, "POST", {});
      await expect.poll(async () => (await api(`/agents/${builder.id}`)).status).toBe("paused");
    }
    const title = "Verify the mixed-runner arithmetic handoff";
    const brief = { first: 17, second: 29 };
    const started = await api(`${companyPath}/case-handoffs`, "POST", { idempotencyKey: "mixed-handoff-start",
      case: { create: { caseType: "work", title, fields: {} } }, toAgentId: lead.id, phase: "triage",
      instructions: "Send the same task to the builder.", workflow_document_text: "Lead hands the task to the builder. The verifier checks the saved result and closes the task.",
      initialDocuments: [{ key: "brief", title: "Arithmetic brief", body: JSON.stringify(brief) }] });
    const { caseId, taskId } = started;
    const builderInstructions = "Read the brief and save the requested arithmetic result on this task.";
    await writeFile(`${fixtureConfig}.tmp`, JSON.stringify({ caseId, taskId, builderId: builder.id, builderInstructions,
      verifierId: verifier.id, sourceReceipt, builderReceipt, releaseFile, verificationReceipt }), { mode: 0o600 });
    await rename(`${fixtureConfig}.tmp`, fixtureConfig);

    const runsPath = `${companyPath}/heartbeat-runs?limit=100`;
    await expect.poll(() => readFile(sourceReceipt, "utf8").catch(() => ""), { timeout: 35_000 }).not.toBe("");
    const outgoing = JSON.parse(await readFile(sourceReceipt, "utf8"));
    expect(outgoing.staleWriteCode).toBe("case_handoff_run_yielded");
    expect((await api(runsPath)).map((run: { agentId: string }) => run.agentId)).toEqual([lead.id]);
    expect(await api(`/issues/${taskId}?view=core`)).toMatchObject({ title, assigneeAgentId: lead.id });
    await writeFile(releaseFile, "release", { flag: "wx" });

    const handoffPath = `/cases/${caseId}/handoffs?limit=20`;
    async function outgoingState() {
      const ledger = await api(handoffPath);
      return ledger.items.find((handoff: { id: string }) => handoff.id === outgoing.handoffId);
    }
    const handoffCheckpoint = (row: Awaited<ReturnType<typeof outgoingState>>) => row ? ({
      handoffId: row.id, state: row.state, wakeupRequestId: row.wakeupRequestId,
      attemptCount: row.attemptCount, updatedAt: row.updatedAt, nextAttemptAt: row.nextAttemptAt,
      leaseExpiresAt: row.leaseExpiresAt, lastErrorCode: row.lastErrorCode,
    }) : null;
    let restartEvidence: { stoppedAt: string; readyAt: string; wakeupRequestId: string; beforeController: string;
      afterController: string; attemptsBefore: number; attemptsAfterStartup: number } | undefined;
    let builderWaitMs = 30_000;
    if (restart) {
      const beforeController = (await api("/health")).serverInfo.processStartedAt;
      let pending: Awaited<ReturnType<typeof outgoingState>>;
      try {
        await expect.poll(async () => {
          pending = await outgoingState();
          return pending?.state === "pending_dispatch" && pending.leaseExpiresAt === null
            && typeof pending.lastErrorCode === "string" && Date.parse(pending.nextAttemptAt) > Date.now();
        }, { timeout: 45_000 }).toBe(true);
      } finally {
        await recordCheckpoint("before_stop", { controllerBoot: beforeController, handoff: handoffCheckpoint(pending) });
      }
      expect(pending).toMatchObject({ sourceRunId: outgoing.runId, wakeupRequestId: expect.any(String),
        attemptCount: expect.any(Number), leaseExpiresAt: null });
      expect(await api(runsPath)).toEqual([expect.objectContaining({ id: outgoing.runId, status: "succeeded" })]);
      await stopDrive();
      const stoppedAt = new Date().toISOString();
      await recordCheckpoint("controller_stopped", { stoppedAt });
      base = await startDrive();
      const readyAt = new Date().toISOString();
      const afterController = (await api("/health")).serverInfo.processStartedAt;
      const reopened = await outgoingState();
      await recordCheckpoint("controller_ready", { controllerBoot: afterController, handoff: handoffCheckpoint(reopened) });
      expect(beforeController).toEqual(expect.any(String));
      expect(afterController).toEqual(expect.any(String));
      expect(afterController).not.toBe(beforeController);
      expect((await api("/companies"))[0].id).toBe(company.id);
      expect(reopened).toMatchObject({ id: pending.id, state: "pending_dispatch",
        sourceRunId: outgoing.runId, wakeupRequestId: pending.wakeupRequestId });

      // Observe the replacement worker discover the saved work without a new
      // producer notification. The builder stays paused through this attempt.
      let rediscovered = reopened;
      try {
        await expect.poll(async () => {
          rediscovered = await outgoingState();
          return rediscovered?.attemptCount > pending.attemptCount && rediscovered.leaseExpiresAt === null
            && Date.parse(rediscovered.updatedAt) >= Date.parse(afterController);
        }, { timeout: 90_000 }).toBe(true);
      } finally {
        await recordCheckpoint("startup_delivery", { handoff: handoffCheckpoint(rediscovered) });
      }
      expect(rediscovered).toMatchObject({ state: "pending_dispatch", wakeupRequestId: pending.wakeupRequestId });
      expect(await api(runsPath)).toEqual([expect.objectContaining({ id: outgoing.runId, status: "succeeded" })]);
      const retryPath = `/cases/${caseId}/handoffs/${outgoing.handoffId}/retry`;
      const retries = await Promise.all([api(retryPath, "POST", {}), api(retryPath, "POST", {})]);
      await recordCheckpoint("concurrent_retries", { receipts: retries.map(handoffCheckpoint) });
      for (const receipt of retries) expect(receipt).toMatchObject({ id: pending.id, wakeupRequestId: pending.wakeupRequestId });
      await api(`/agents/${builder.id}/resume`, "POST", {});
      await expect.poll(async () => {
        const agent = await api(`/agents/${builder.id}`);
        return agent.lifecycleState === "ready" && agent.status !== "paused";
      }).toBe(true);
      const resumed = await outgoingState();
      await recordCheckpoint("builder_resumed", { handoff: handoffCheckpoint(resumed) });
      // Earlier paused attempts can leave a backoff deadline even after Resume.
      const dueInMs = Date.parse(resumed.nextAttemptAt) - Date.now();
      builderWaitMs += Math.max(0, Number.isFinite(dueInMs) ? dueInMs : 0);
      restartEvidence = { stoppedAt, readyAt, wakeupRequestId: pending.wakeupRequestId, beforeController, afterController,
        attemptsBefore: pending.attemptCount, attemptsAfterStartup: rediscovered.attemptCount };
    }
    await expect.poll(() => readFile(builderReceipt, "utf8").catch(() => ""), { timeout: builderWaitMs }).not.toBe("");
    const builderInput = JSON.parse(await readFile(builderReceipt, "utf8"));
    expect(builderInput).toEqual({ caseId, taskId, handoffId: outgoing.handoffId,
      handoffVersion: outgoing.handoffVersion, instructionsMatch: true });

    await expect.poll(async () => (await api(`/issues/${taskId}?view=core`)).status, { timeout: 90_000 }).toBe("done");
    await expect.poll(async () => (await api(runsPath)).map((run: { status: string }) => run.status), { timeout: 25_000 })
      .toEqual(["succeeded", "succeeded", "succeeded"]);
    const task = await api(`/issues/${taskId}?view=core`);
    const caseRecord = await api(`/cases/${caseId}`);
    const ledger = await api(handoffPath);
    if (restartEvidence) {
      const delivered = await outgoingState();
      await recordCheckpoint("delivered", { handoff: handoffCheckpoint(delivered) });
      expect(delivered).toMatchObject({ state: "delivered", wakeupRequestId: restartEvidence.wakeupRequestId });
    }
    const artifact = await api(`/issues/${taskId}/documents/result`);
    const expectedArtifact = JSON.stringify({ total: brief.first + brief.second });
    expect(artifact.body).toBe(expectedArtifact);
    const revision = await api(`/issues/${taskId}/documents/result/revisions/${artifact.latestRevisionId}`);
    expect(revision.id).toBe(artifact.latestRevisionId);
    const runRows = await api(runsPath);
    const runs = await Promise.all(runRows.map(async (entry: { id: string }) => {
      const run = await api(`/heartbeat-runs/${entry.id}`);
      const operations = await api(`/heartbeat-runs/${entry.id}/workspace-operations`);
      return { id: run.id, agentId: run.agentId, issueId: run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId,
        runtimeMode: run.runtimeMode, status: run.status, incomingHandoffId: run.contextSnapshot?.caseHandoffId,
        handoffVersion: run.contextSnapshot?.proprioCase?.handoffVersion,
        admittedAt: run.createdAt, release: run.resultJson?.caseHandoffExecutionReleased ?? null,
        workspaceFinalizations: operations.filter((operation: { heartbeatRunId: string | null; phase: string }) =>
          operation.heartbeatRunId === run.id && operation.phase === "workspace_finalize").map(
          ({ status, finishedAt }: { status: string; finishedAt: string | null }) => ({ status, finishedAt })),
      };
    }));
    const observed: MixedHandoffObservation = { task: { id: task.id, status: task.status, assigneeAgentId: task.assigneeAgentId },
      caseRecord: { workIssueId: caseRecord.workIssueId, handoffVersion: caseRecord.handoffVersion },
      agents: { lead: lead.id, builder: builder.id, verifier: verifier.id },
      handoffs: ledger.items.map((handoff: Record<string, unknown>) => ({
        id: handoff.id, issueId: handoff.issueId, version: handoff.version, state: handoff.state,
        sourceRunId: handoff.sourceRunId, toAgentId: handoff.toAgentId,
      })), runs, artifact: { issueId: revision.issueId, revisionId: revision.id, body: revision.body,
        createdByRunId: revision.createdByRunId },
      verification: JSON.parse(await readFile(verificationReceipt, "utf8")) };
    const verdict = gradeMixedHandoff(observed, expectedArtifact);
    expect(Object.entries(verdict).filter(([, passed]) => !passed).map(([check]) => check)).toEqual([]);
    const boardRoute = `/${company.issuePrefix}/issues/${task.identifier ?? task.id}`;
    const doneStatus = page.getByRole("button", { name: "Change status (current: Done)", exact: true });
    let boardHttpStatus: number | null = null;
    try {
      const boardResponse = await page.goto(`${base}${boardRoute}`, { waitUntil: "domcontentloaded" });
      boardHttpStatus = boardResponse?.status() ?? null;
      expect(boardResponse?.ok()).toBe(true);
      // Hosted source runs can still be compiling Vite modules on the first navigation.
      await expect(doneStatus).toBeVisible({ timeout: 30_000 });
    } catch (error) {
      const boardDiagnostic = { requestedPath: boardRoute, actualPath: new URL(page.url()).pathname,
        httpStatus: boardHttpStatus, doneStatusVisible: await doneStatus.isVisible() };
      const diagnosticFile = info.outputPath("mixed-handoff-board-diagnostic.json");
      await writeFile(diagnosticFile, JSON.stringify(boardDiagnostic, null, 2));
      throw error;
    }
    const evidence = info.outputPath("mixed-handoff-evidence.json");
    await writeFile(evidence, JSON.stringify({
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
      profiles: ["legacy/process", "native/codex-app-server fixture", "legacy/process"],
      outgoing, builderInput, restartEvidence, observed, verdict, boardStatus: "done",
    }, null, 2));
    await info.attach("mixed-handoff-evidence", { contentType: "application/json", path: evidence });
  } catch (error) {
    await info.attach("test-drive-logs", { body: logs, contentType: "text/plain" });
    throw error;
  } finally {
    await stopDrive();
    await makeDirectoryTreeRemovable(dataDir);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the mixed-handoff grader rejects early admission, a duplicate claim, and a stale revision", () => {
  const at = (second: number) => new Date(1_000 * second).toISOString();
  const observed: MixedHandoffObservation = {
    task: { id: "task", status: "done", assigneeAgentId: "verifier" },
    caseRecord: { workIssueId: "task", handoffVersion: 3 },
    agents: { lead: "lead", builder: "builder", verifier: "verifier" },
    handoffs: [
      { id: "h1", issueId: "task", version: 1, state: "delivered", sourceRunId: null, toAgentId: "lead" },
      { id: "h2", issueId: "task", version: 2, state: "delivered", sourceRunId: "r1", toAgentId: "builder" },
      { id: "h3", issueId: "task", version: 3, state: "delivered", sourceRunId: "r2", toAgentId: "verifier" },
    ],
    runs: [
      { id: "r1", agentId: "lead", issueId: "task", runtimeMode: "legacy", status: "succeeded",
        incomingHandoffId: "h1", handoffVersion: 1, admittedAt: at(1),
        workspaceFinalizations: [{ status: "succeeded", finishedAt: at(1.5) }],
        release: { schema: "proprio.case-handoff-release.v1", runId: "r1", issueId: "task", settledAt: at(2) } },
      { id: "r2", agentId: "builder", issueId: "task", runtimeMode: "native", status: "succeeded",
        incomingHandoffId: "h2", handoffVersion: 2, admittedAt: at(3),
        release: { schema: "proprio.case-handoff-release.v1", runId: "r2", issueId: "task", settledAt: at(5) },
        workspaceFinalizations: [{ status: "succeeded", finishedAt: at(4) }] },
      { id: "r3", agentId: "verifier", issueId: "task", runtimeMode: "legacy", status: "succeeded",
        incomingHandoffId: "h3", handoffVersion: 3, admittedAt: at(6), workspaceFinalizations: [], release: null },
    ],
    artifact: { issueId: "task", revisionId: "result", body: '{"total":46}', createdByRunId: "r2" },
    verification: { runId: "r3", artifactRevisionId: "result", artifactAuthorRunId: "r2" },
  };
  const grade = (input: MixedHandoffObservation) => gradeMixedHandoff(input, '{"total":46}');
  expect(Object.values(grade(observed))).not.toContain(false);
  const early = structuredClone(observed);
  early.runs[2].admittedAt = at(4);
  expect(grade(early).outgoingRelease).toBe(false);
  const missingCleanup = structuredClone(observed);
  missingCleanup.runs[1].workspaceFinalizations = [];
  expect(grade(missingCleanup).outgoingRelease).toBe(false);
  const duplicate = structuredClone(observed);
  duplicate.runs.push({ ...duplicate.runs[1], id: "duplicate" });
  expect(grade(duplicate).singleClaimPerRole).toBe(false);
  const stale = structuredClone(observed);
  stale.verification!.artifactRevisionId = "earlier";
  expect(grade(stale).independentlyVerifiedArtifact).toBe(false);
  const wrongAuthor = structuredClone(observed);
  wrongAuthor.artifact!.createdByRunId = "another-run";
  expect(grade(wrongAuthor).independentlyVerifiedArtifact).toBe(false);
});
