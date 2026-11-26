import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { listenOnFetchAllowedPort } from "../fetch-allowed-port";
import { launchTestDrive } from "../fixtures/test-drive-process";
import { makeDirectoryTreeRemovable } from "../../runner-e2e/directory-cleanup";
import { isBoundNativePrpEventRow } from "../../runner-e2e/native-event-envelope";
import { createProcessTreeOwner, stopOwnedProcessTree } from "../../runner-e2e/process-tree-owner";
import { collectRunEvents } from "../../runner-e2e/run-observations";

// The model and MCP providers are deterministic fixtures. The controller,
// authorization, recovery actions, and wake delivery are exercised through product entry points.
for (const journey of [
  "safe",
  "uncertain",
  "safe_restart",
  "ceo_lineage",
  "legacy_unknown",
] as const)
  test(`fresh execution recovery and current-request journey: ${journey}`, async ({
    page,
  }, info) => {
    if (journey === "uncertain") test.setTimeout(180_000);
    const root = resolve(import.meta.dirname, "../../..");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim() || null;
    let drive: { child: ReturnType<typeof launchTestDrive>["child"]; owner: ReturnType<typeof createProcessTreeOwner> } | undefined;
    let ownedDataDir: string | undefined;
    let logs = "";
    let diagnosticState = async () => ({});
    const uncertaintyPath = info.outputPath("uncertain-effect-evidence.json");
    const checkpoints: Array<{ phase: string; observedAt: string; details: Record<string, unknown> }> = [];
    async function recordUncertainty(phase: string, details: Record<string, unknown>, verdict?: Record<string, unknown>) {
      checkpoints.push({ phase, observedAt: new Date().toISOString(), details });
      await writeFile(uncertaintyPath, JSON.stringify({
        revision, profile: "native/codex-app-server fixture", journey, checkpoints, ...verdict,
      }, null, 2));
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

    const calls: string[] = [];
    const externalEffects: { operation: string; sequence: number }[] = [];
    let gmailReadCount = 0;
    function readFixtureGmail() {
      gmailReadCount += 1;
      if (journey === "uncertain") return "RECOVERY-INJECT-UNKNOWN-WRITE";
      if (gmailReadCount === 1 && journey !== "ceo_lineage") return "RECOVERY-INJECT-SAFE";
      return "GMAIL-73: The launch email confirms Friday approval. Source: https://example.invalid/mail/gmail-73";
    }
    const fixture = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/effects") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ effects: externalEffects }));
        return;
      }
      if (journey === "uncertain" && req.method === "POST" && req.url === "/effects") {
        externalEffects.push({ operation: "send_fixture_email", sequence: externalEffects.length + 1 });
        res.writeHead(204, { "x-proprio-fixture-inject-failure": externalEffects.length === 1 ? "1" : "0" });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const message = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const gmail = req.url === "/gmail";
      calls.push(`${gmail ? "gmail" : "notion"}:${message.method}`);
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: {
                name: gmail ? "gmail-fixture" : "heliotrope",
                version: "1",
              },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: gmail ? "gmail_read" : "archive_read",
                    description: gmail
                      ? "Read gmail-fixture launch email decisions"
                      : "Read heliotrope launch decisions",
                    annotations: { readOnlyHint: true, destructiveHint: false },
                    inputSchema: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                ],
              }
            : message.method === "tools/call"
              ? {
                  content: [
                    {
                      type: "text",
                      text: gmail
                        ? readFixtureGmail()
                        : "HELIOTROPE-42: Launch in two stages; support handoff belongs to Mira. Source: https://example.invalid/launch/heliotrope-42",
                    },
                  ],
                }
              : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    try {
      const port = await listenOnFetchAllowedPort(fixture);
      const codexHome = info.outputPath("codex-home");
      await mkdir(codexHome, { recursive: true });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PROPRIO_RECOVERY_CEO_LINEAGE: journey === "ceo_lineage" ? "1" : "0",
        IN_FEED_FIXTURE_KEY: "not-a-real-model-key",
        CODEX_HOME: codexHome,
        NODE_ENV: "test",
        PATH: `${root}/tests/e2e/fixtures/recovery-bin:${process.env.PATH}`,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${resolve(root, "tests/e2e/fixtures/recovery-codex-loader.mjs")}`,
      };
      delete env.DATABASE_URL;
      delete env.DATABASE_MIGRATION_URL;
      const instance = `execution-recovery-${process.pid}-${info.workerIndex}`;
      if (journey === "uncertain") ownedDataDir = await mkdtemp(resolve(tmpdir(), "proprio-recovery-"));
      async function startDrive(dataDir?: string) {
        const args = ["--instance", instance, "--harness", "codex", "--api-key-env", "IN_FEED_FIXTURE_KEY",
          "--company-name", "Execution recovery fixture", "--no-browser"];
        if (dataDir) args.push("--data-dir", dataDir);
        const launched = launchTestDrive({ cwd: root, env, args,
          onOutput: chunk => { logs += chunk; },
        });
        drive = { child: launched.child, owner: createProcessTreeOwner(launched.child) };
        return launched.ready;
      }
      async function restartDrive(dataDir: string) {
        await stopDrive();
        return startDrive(dataDir);
      }
      let base = await startDrive(ownedDataDir);
      const api = async (path: string, method = "GET", data?: unknown) => {
        const response = await page.request.fetch(`${base}/api${path}`, {
          method,
          data,
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        return response.json();
      };
      const fixtureEffects = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/effects`);
        expect(response.ok).toBe(true);
        return response.json();
      };
      const isSettledRun = (run: { status: string; errorCode?: string }) =>
        run.status === "succeeded" ||
        (run.status === "cancelled" &&
          run.errorCode === "issue_not_in_progress");
      const health = await api("/health");
      expect(health).toMatchObject({
        status: "ok",
        deploymentMode: "local_trusted",
        bootstrapStatus: "ready",
        serverInfo: {
          git: { available: true, fullSha: revision, branchName },
        },
      });
      const [company] = await api("/companies");
      let [agent] = await api(`/companies/${company.id}/agents`);
      expect(["codex_local", "proprio_runner"]).toContain(agent.adapterType);
      expect(await api(`/companies/${company.id}/issues`)).toEqual([]);
      expect(await api(`/companies/${company.id}/heartbeat-runs`)).toEqual([]);
      expect(
        (await api(`/companies/${company.id}/tools/connections`)).connections,
      ).toEqual([]);
      diagnosticState = async () => ({
        base,
        companyId: company.id,
        agentId: agent.id,
        agent: await api(`/agents/${agent.id}`).then((row: Record<string, unknown>) => ({
          status: row.status,
          adapterType: row.adapterType,
          lifecycleHolds: row.lifecycleHolds,
        })),
        tasks: await Promise.all((await api(`/companies/${company.id}/issues`)).map(async (task: { id: string }) => {
          const detail = await api(`/issues/${task.id}`);
          return { id: detail.id, status: detail.status, assigneeAgentId: detail.assigneeAgentId,
            recoveryCause: detail.activeRecoveryAction?.cause, recoveryEvidence: detail.activeRecoveryAction?.evidence };
        })),
        runs: await Promise.all((await api(`/companies/${company.id}/heartbeat-runs`)).map(async (run: Record<string, unknown>) => {
          const detail = await api(`/heartbeat-runs/${run.id}`);
          return {
            id: run.id,
            status: run.status,
            runtimeMode: detail.runtimeMode,
            scheduledRetryReason: detail.scheduledRetryReason,
            error: run.error ?? detail.error,
            errorCode: run.errorCode ?? detail.errorCode,
            stderrExcerpt: detail.stderrExcerpt,
            stdoutExcerpt: detail.stdoutExcerpt,
          };
        })),
        fixtureEffects: await fixtureEffects().catch((error: unknown) => ({ error: String(error) })),
      });
      const dataDir = logs
        .match(/Data directory: ([^\n\r]+)/)![1]!
        .replace(/\u001b\[[0-9;]*m/g, "")
        .trim();
      if (ownedDataDir) expect(dataDir).toBe(ownedDataDir);
      await writeFile(
        info.outputPath("running-instance.json"),
        JSON.stringify(
          { base, dataDir, companyId: company.id, agentId: agent.id },
          null,
          2,
        ),
      );
      const prefix = `/${company.issuePrefix}`;
      await page.goto(base + prefix + "/dashboard");
      await expect(page.getByText("No runs yet").first()).toBeVisible({ timeout: 30_000 });
      if (journey === "legacy_unknown") {
        agent = await api(`/companies/${company.id}/agents`, "POST", {
          name: "Legacy executor", role: "engineer", adapterType: "process",
          adapterConfig: { command: process.execPath, args: ["-e", "console.error('Deterministic provider failure; no recoverable session contract'); process.exit(1)"] },
        });
        await page.getByRole("link", { name: "Tasks", exact: true }).click();
        await page.getByRole("button", { name: "New Task", exact: true }).last().click();
        await page.getByPlaceholder("Task title").fill("Read the legacy fixture report");
        await page.getByRole("button", { name: "Assignee", exact: true }).click();
        await page.getByRole("button", { name: agent.name, exact: true }).click();
        await page.getByRole("button", { name: "Create Task", exact: true }).click();
        await page.getByRole("complementary").getByRole("link", { name: /Read the legacy fixture report/ }).click();
        await expect.poll(async () => {
          const tasks = await api(`/companies/${company.id}/issues`);
          return tasks.find((issue: { title: string }) => issue.title === "Read the legacy fixture report")?.status;
        }, { timeout: 60_000 }).toBe("blocked");
        await expect(page.getByText("Blocked", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole("button", { name: "Reconcile and continue" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
        const composer = page.locator('[contenteditable="true"]').last();
        await composer.fill("Independent draft remains usable");
        await expect(composer).toContainText("Independent draft remains usable");
        await page.screenshot({ path: info.outputPath("legacy-recovery-needed.png"), fullPage: true });
        // Observe past the shared retry delay; absence of a successor is part
        // of the fail-closed contract, not merely a momentary UI state.
        await page.waitForTimeout(35_000);
        const runs = await api(`/companies/${company.id}/heartbeat-runs`);
        expect(runs).toHaveLength(1);
        expect(await api(`/heartbeat-runs/${runs[0].id}`)).toMatchObject({ runtimeMode: "legacy", status: "failed" });
        await page.reload();
        await expect(page.getByRole("button", { name: "Reconcile and continue" })).toHaveCount(0);
        await writeFile(info.outputPath("instance-and-runs.json"), JSON.stringify({ base, dataDir, health, dependency: "deterministic legacy process fixture", companyId: company.id, agentId: agent.id, runs }, null, 2));
        return;
      }
      await page.goto(
        base + prefix + "/company/settings/instance/experimental",
      );
      const nativeRunnerToggle = page.getByRole("switch", {
        name: "Toggle Proprio Runner experimental setting",
      });
      // Fresh instances may already enable the native runner. Configure the
      // desired state instead of blindly toggling the current default off.
      if (await nativeRunnerToggle.getAttribute("aria-checked") !== "true") {
        await nativeRunnerToggle.click();
      }
      await expect(nativeRunnerToggle).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(
          async () =>
            (await api("/instance/settings/experimental")).enableNativeRunner,
        )
        .toBe(true);
      if (agent.adapterType !== "proprio_runner") {
        await page.goto(base + prefix + `/agents/${agent.id}/configuration`);
        await page.getByRole("button", { name: "Codex", exact: true }).click();
        await page.getByRole("button", { name: /Proprio Runner/ }).click();
        await page
          .getByRole("button", { name: /^Save(?: changes)?$/ })
          .first()
          .click();
        await expect
          .poll(async () => (await api(`/agents/${agent.id}`)).adapterType)
          .toBe("proprio_runner");
      }
      const nativeAgent = await api(`/agents/${agent.id}`);
      expect(nativeAgent.adapterConfig.env).toEqual(agent.adapterConfig.env);
      if (journey !== "ceo_lineage") {
        const runnerCwd = info.outputPath("runner-workspace");
        await mkdir(runnerCwd, { recursive: true });
        agent = await api(`/companies/${company.id}/agents`, "POST", {
          name: "Executor",
          role: "engineer",
          adapterType: "proprio_runner",
          adapterConfig: {
            provider: "codex",
            model: "gpt-6.1-sol",
            cwd: runnerCwd,
            lifecycleMode: "per_turn",
            codexPermissionMode: "never",
            timeoutSec: 50,
            env: {
              CODEX_HOME: codexHome,
              OPENAI_API_KEY: "not-a-real-model-key",
              ...(journey === "uncertain" ? { RECOVERY_FIXTURE_EFFECT_URL: `http://127.0.0.1:${port}/effects` } : {}),
            },
          },
        });
      }
      if (journey === "uncertain") {
        const probeAgent = await api(`/agents/${agent.id}`);
        const probeResponse = await page.request.post(
          `${base}/api/companies/${company.id}/adapters/proprio_runner/test-environment`,
          { data: { agentId: agent.id, adapterConfig: probeAgent.adapterConfig } },
        );
        const probeResult = await probeResponse.json();
        expect(probeResponse.ok(), JSON.stringify(probeResult)).toBe(true);
        expect(probeResult.status, JSON.stringify(probeResult.checks)).toBe("pass");
      }
      const connectionIds = new Set<string>();
      for (const service of ["notion", "gmail"]) {
        await page.goto(base + prefix + "/apps");
        const custom = page
          .getByRole("list", { name: "Connector list" })
          .getByRole("listitem")
          .filter({ hasText: "Connect your own tool" });
        await custom
          .getByRole("button", { name: "Connect", exact: true })
          .click();
        await custom
          .getByRole("button", { name: "Connect your own MCP server" })
          .click();
        await page
          .getByPlaceholder("https://example.com/actions")
          .fill(`http://127.0.0.1:${port}/${service}`);
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        const connectWizard = page.getByRole("main").filter({
          has: page.getByRole("heading", { name: "Connect your own MCP server" }),
        });
        await connectWizard.getByRole("button", { name: "Change", exact: true }).nth(1).click();
        await page.getByRole("radio", { name: "Just agents I pick" }).click();
        await page.getByRole("button", { name: /Select agents/ }).click();
        await page.getByRole("checkbox", { name: new RegExp(agent.name) }).check();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: /Check link/i }).click();
        await expect(
          page.getByRole("heading", { name: /is ready/i }),
        ).toBeVisible({ timeout: 30_000 });
        const connection = (
          await api(`/companies/${company.id}/tools/connections`)
        ).connections.find(
          (row: { id: string }) =>
            !connectionIds.has(row.id),
        );
        connectionIds.add(connection.id);
        const installs = (
          await api(`/tool-connections/${connection.id}/installs`)
        ).installs;
        expect(installs).toEqual([expect.objectContaining({ targetId: agent.id })]);
      }
      await page.getByRole("link", { name: "Tasks", exact: true }).click();
      await page
        .getByRole("button", { name: "New Task", exact: true })
        .last()
        .click();
      await page
        .getByRole("textbox", { name: "editable markdown" })
        .fill(
          `${journey === "ceo_lineage" ? "CEO descendant fixture: " : ""}Find the heliotrope launch notes and summarize the decisions with a source link`,
        );
      await page.getByRole("button", { name: "Select assignee", exact: true }).click();
      await page.getByRole("option").filter({ hasText: agent.name }).click();
      await page
        .getByRole("button", { name: "Create task", exact: true })
        .click();
      await page
        .getByRole("complementary")
        .getByRole("link", { name: /Find the heliotrope launch notes/ })
        .click();
      await expect(page).toHaveURL(/issues\/(?:[a-f0-9-]+|[A-Z]+-\d+)/);
      if (journey === "ceo_lineage")
        await expect(
          page
            .getByText("Provider child finished; root execution continues.", {
              exact: true,
            })
            .first(),
        ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByText(/HELIOTROPE-42: Launch in two stages/).first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(
          async () =>
            (await api(`/companies/${company.id}/heartbeat-runs`)).every(
              isSettledRun,
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      const [task] = await api(`/companies/${company.id}/issues`);
      const originalTitle = task.title;
      const followup = "Now summarize my Gmail emails about launch decisions, with the source link.";
      if (journey === "uncertain") {
        await recordUncertainty("followup", { taskId: task.id });
        await api(`/issues/${task.id}/comments`, "POST", { body: followup, reopen: true });
      } else {
        await page
          .getByRole("textbox")
          .last()
          .fill(followup);
        await page.getByRole("button", { name: "Send", exact: true }).click();
      }
      if (journey === "safe_restart") {
        await expect
          .poll(
            async () =>
              (await api(`/companies/${company.id}/heartbeat-runs`)).some(
                (run: { status: string; scheduledRetryReason?: string }) =>
                  run.status === "scheduled_retry" &&
                  run.scheduledRetryReason === "native_safe_replacement",
              ),
            { timeout: 45_000 },
          )
          .toBe(true);
        await page.screenshot({
          path: info.outputPath("retry-before-restart.png"),
          fullPage: true,
        });
        base = await restartDrive(dataDir);
        expect((await api("/health")).serverInfo.git.branchName).toBe(
          health.serverInfo.git.branchName,
        );
        expect((await api("/companies"))[0].id).toBe(company.id);
        await page.goto(base + prefix + `/issues/${task.id}`, { waitUntil: "domcontentloaded" });
      }
      const composer = page.getByRole("textbox").last();
      await composer.fill("An unsent draft stays available during recovery.");
      await expect(composer).toBeEditable();
      if (journey !== "uncertain") {
        await expect(
          page
            .getByText(/GMAIL-73: The launch email confirms Friday approval/)
            .first(),
        ).toBeVisible({ timeout: 100_000 });
        expect(gmailReadCount).toBe(journey === "ceo_lineage" ? 1 : 2);
      } else {
        await expect.poll(async () => (await api(`/issues/${task.id}`)).status, { timeout: 100_000 }).toBe("blocked");
        await expect(page.getByRole("button", { name: "Change status (current: Blocked)", exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/Deterministic failed provider session after Gmail access/)).toBeVisible();
        expect(gmailReadCount).toBe(1);
        expect(await fixtureEffects()).toEqual({ effects: [{ operation: "send_fixture_email", sequence: 1 }] });
        await expect(page.getByText(/GMAIL-73/)).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Reconcile and continue|Try again/ })).toHaveCount(0);
        await expect(page.getByRole("dialog", { name: "Reconcile execution" })).toHaveCount(0);
        await page.screenshot({ path: info.outputPath("uncertain-automatic-no-replay.png"), fullPage: true });
        const runsBeforeRestart = await api(`/companies/${company.id}/heartbeat-runs`);
        const beforeRestartRunIds = runsBeforeRestart.map((run: { id: string }) => run.id).sort();
        const uncertainRunId = runsBeforeRestart.find((run: { errorCode?: string }) => run.errorCode === "adapter_failed")?.id;
        await recordUncertainty("failed_run", { runIds: beforeRestartRunIds, failedRunId: uncertainRunId ?? null });
        expect(uncertainRunId).toBeTruthy();
        const blockedStatus = page.getByRole("button", { name: "Change status (current: Blocked)", exact: true });
        const failureExplanation = page.getByText(/Deterministic failed provider session after Gmail access/);
        const retryControls = page.getByRole("button", { name: /Reconcile and continue|Try again/ });
        const writeId = "uncertain-email-write";
        async function observeHold(phase: string) {
          const [health, issue, runs, events, effects] = await Promise.all([
            api("/health"),
            api(`/issues/${task.id}`),
            api(`/companies/${company.id}/heartbeat-runs`),
            collectRunEvents<Record<string, any>>((afterSeq, limit) =>
              api(`/heartbeat-runs/${uncertainRunId}/events?afterSeq=${afterSeq}&limit=${limit}`)),
            fixtureEffects(),
          ]);
          const binding = { runId: uncertainRunId, companyId: company.id, agentId: agent.id };
          const writeEvents = events.filter(event => isBoundNativePrpEventRow(event, binding)
            && event.payload.prpEvent.payload?.executionId === writeId);
          const starts = writeEvents.filter(event => event.eventType === "tool.execution.started")
            .map(event => ({ seq: event.seq, name: event.payload.prpEvent.payload.name,
              readOnly: event.payload.prpEvent.payload.readOnly }));
          const terminals = writeEvents.filter(event => event.eventType === "tool.execution.completed").map(event => event.seq);
          const details = { controllerBoot: health.serverInfo.processStartedAt, status: issue.status,
            cause: issue.activeRecoveryAction?.cause ?? null, runIds: runs.map((run: { id: string }) => run.id).sort(),
            effectCount: effects.effects.length, starts, terminals, boardExplanationVisible: await failureExplanation.isVisible() };
          await recordUncertainty(phase, details);
          expect(details).toMatchObject({ status: "blocked", runIds: beforeRestartRunIds, effectCount: 1,
            starts: [{ seq: expect.any(Number), name: "send_fixture_email", readOnly: false }], terminals: [] });
          expect(effects).toEqual({ effects: [{ operation: "send_fixture_email", sequence: 1 }] });
          return { details, git: health.serverInfo.git, recovery: issue.activeRecoveryAction };
        }
        const before = await observeHold("before_stop");
        expect(before.recovery).toMatchObject({
          ownerType: "board",
          cause: "native_continuation_requires_reconciliation",
          nextAction: expect.stringContaining("continues the task from its last saved work"),
          evidence: {
            runId: uncertainRunId,
            originalFailureCode: "adapter_failed",
            nativeFailureBlock: { runId: uncertainRunId },
          },
        });
        base = await restartDrive(dataDir);
        expect((await api("/companies"))[0].id).toBe(company.id);
        await page.goto(base + prefix + `/issues/${task.id}`, { waitUntil: "domcontentloaded" });
        try {
          await expect(blockedStatus).toBeVisible({ timeout: 30_000 });
          await expect(failureExplanation).toBeVisible({ timeout: 30_000 });
          await expect(retryControls).toHaveCount(0);
        } finally {
          await recordUncertainty("board_after_restart", {
            blockedVisible: await blockedStatus.isVisible(),
            explanationVisible: await failureExplanation.isVisible(),
            retryControls: await retryControls.count(),
          });
        }
        const after = await observeHold("after_restart");
        expect(after.git).toMatchObject({ available: true, fullSha: revision, branchName });
        expect(before.details.controllerBoot).toEqual(expect.any(String));
        expect(after.details.controllerBoot).toEqual(expect.any(String));
        expect(after.details.controllerBoot).not.toBe(before.details.controllerBoot);
        expect(after.recovery).toMatchObject(before.recovery);
        expect(after.details.starts).toEqual(before.details.starts);
        const observationMs = 35_000;
        await page.waitForTimeout(observationMs);
        const final = await observeHold("after_observation");
        expect(final.recovery).toMatchObject(before.recovery);
        expect(final.details.starts).toEqual(before.details.starts);
        expect(gmailReadCount).toBe(1);
        await recordUncertainty("verified", { writeId }, {
          taskId: task.id, disposition: "blocked", beforeBoot: before.details.controllerBoot,
          afterBoot: after.details.controllerBoot, runIds: beforeRestartRunIds,
          effectCount: final.details.effectCount, observationMs,
        });
      }
      await expect(composer).toHaveText(
        "An unsent draft stays available during recovery.",
      );
      await expect
        .poll(
          async () =>
            (await api(`/companies/${company.id}/heartbeat-runs`)).every(
              (run: { status: string }) =>
                !["running", "queued", "scheduled_retry"].includes(run.status),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      if (journey !== "uncertain") await expect(async () => {
        const answer = page.getByText(/GMAIL-73: The launch email confirms Friday approval/).first();
        // Refresh can replace the streamed row with its persisted transcript.
        // Re-resolve the locator if that handoff detaches it during scrolling.
        await answer.scrollIntoViewIfNeeded();
        await expect(answer).toBeInViewport();
      }).toPass({ timeout: 10_000 });
      await page.screenshot({
        path: info.outputPath(`${journey}-outcome.png`),
        fullPage: true,
      });
      const finalRuns = await Promise.all(
        (await api(`/companies/${company.id}/heartbeat-runs`)).map(
          (run: { id: string }) => api(`/heartbeat-runs/${run.id}`),
        ),
      );
      const replacements = finalRuns.filter(
        (run: { scheduledRetryReason?: string }) =>
          run.scheduledRetryReason === "native_safe_replacement",
      );
      expect(replacements).toHaveLength(
        journey === "safe" || journey === "safe_restart" ? 1 : 0,
      );
      expect(
        finalRuns.every(
          (run: { runtimeMode: string }) => run.runtimeMode === "native",
        ),
      ).toBe(true);
      expect(
        finalRuns.some((run: { status: string }) => run.status === "running"),
      ).toBe(false);
      expect((await api(`/issues/${task.id}`)).title).toBe(originalTitle);
      await composer.fill("");
      await page.reload();
      await expect(page.getByText(/Due now/, { exact: true })).toHaveCount(0);
      if (journey !== "uncertain") await expect(
        page
          .getByText(/GMAIL-73: The launch email confirms Friday approval/)
          .first(),
      ).toBeVisible();
      else {
        expect((await api(`/issues/${task.id}`)).status).toBe("blocked");
        await expect(page.getByRole("button", { name: "Reconcile and continue" })).toHaveCount(0);
      }
      if (journey !== "uncertain") await expect(async () => {
        const answer = page.getByText(/GMAIL-73: The launch email confirms Friday approval/).first();
        // Refresh can replace the streamed row with its persisted transcript.
        // Re-resolve the locator if that handoff detaches it during scrolling.
        await answer.scrollIntoViewIfNeeded();
        await expect(answer).toBeInViewport();
      }).toPass({ timeout: 10_000 });
      await page.screenshot({
        path: info.outputPath(`${journey}-after-refresh.png`),
        fullPage: true,
      });
      const evidence = JSON.stringify(
        {
          base,
          dataDir,
          health,
          journey,
          companyId: company.id,
          agentId: agent.id,
          taskId: task.id,
          connectionIds: [...connectionIds],
          runs: finalRuns.map((run: Record<string, unknown>) => ({
            id: run.id,
            runtimeMode: run.runtimeMode,
            status: run.status,
            retryOfRunId: run.retryOfRunId,
            errorCode: run.errorCode,
            execution: run.execution,
          })),
          dependency: "fixture",
          provider: "codex",
          fixtureModel: agent.adapterConfig?.model ?? "in-feed-fixture",
          calls,
        },
        null,
        2,
      );
      await writeFile(info.outputPath("instance-and-runs.json"), evidence);
      await info.attach("instance-and-runs", {
        body: evidence,
        contentType: "application/json",
      });
    } finally {
      await writeFile(
        info.outputPath("diagnostics.json"),
        JSON.stringify(await diagnosticState().catch(() => ({})), null, 2),
      );
      await writeFile(info.outputPath("test-drive.log"), logs);
      try {
        if (checkpoints.length) {
          await info.attach("uncertain-effect-evidence", { path: uncertaintyPath, contentType: "application/json" });
        }
      } finally {
        try {
          await stopDrive();
          if (ownedDataDir) {
            await makeDirectoryTreeRemovable(ownedDataDir);
            await rm(ownedDataDir, { recursive: true, force: true });
          }
        } finally {
          fixture.closeAllConnections();
          await new Promise<void>((done) => fixture.close(() => done()));
        }
      }
    }
  });
