import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { and, eq } from "../../../server/node_modules/drizzle-orm/index.js";
import { expect, test } from "@playwright/test";
import { agentApiKeys, agents, caseAccessSources, caseEvents, caseIssueLinks, cases, companyMemberships, completionContracts, closeRegisteredClients, createDb, heartbeatRuns, issues } from "../../../packages/db/src/index.ts";
import { caseHandoffService } from "../../../server/src/services/case-handoffs.ts";

const outcomes = [
  { outcome: "accepted" },
  { outcome: "clarification", reasonCode: "missing_prerequisite" },
  { outcome: "declined", reasonCode: "missing_capability" },
] as const;

test("recipient decisions survive a controller restart with their Case audit history", async ({ request }) => {
  test.setTimeout(240_000);
  const repo = resolve(import.meta.dirname, "../../..");
  const dataDir = await mkdtemp(resolve(tmpdir(), "proprio-recipient-decision-restart-"));
  const root = await mkdtemp(resolve(tmpdir(), "proprio-recipient-decision-fixture-"));
  const codexHome = resolve(root, "codex-home");
  const codex = resolve(root, "codex");
  const codexLoader = resolve(root, "codex-loader.mjs");
  const log = { text: "" };
  const env = { ...process.env, NODE_ENV: "test", PROPRIO_HOME: dataDir, PROPRIO_INSTANCE_ID: "default", CODEX_HOME: codexHome,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${codexLoader}`,
    OPENAI_API_KEY: "recipient-decision-fixture", DATABASE_URL: undefined, DATABASE_MIGRATION_URL: undefined };
  let drive: ReturnType<typeof spawn> | undefined;
  let exited: ReturnType<typeof once> | undefined;
  function startDrive() {
    drive = spawn(process.execPath, ["--import", "./cli/node_modules/tsx/dist/loader.mjs", "cli/src/index.ts", "test-drive",
      "--data-dir", dataDir, "--harness", "codex", "--api-key-env", "OPENAI_API_KEY", "--company-name", "Recipient Decision Fixture", "--no-browser"],
    { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    drive.stdout!.on("data", chunk => { log.text += chunk.toString(); });
    drive.stderr!.on("data", chunk => { log.text += chunk.toString(); });
    exited = once(drive, "exit");
  }
  async function stopDrive() {
    if (!drive?.pid || drive.exitCode !== null || drive.signalCode !== null) return;
    process.kill(-drive.pid, "SIGTERM");
    const timeout = new AbortController();
    try {
      await Promise.race([exited, setTimeout(10_000, undefined, { signal: timeout.signal }).then(() => {
        if (drive?.exitCode === null && drive.signalCode === null) process.kill(-drive.pid!, "SIGKILL");
      })]);
    } finally { timeout.abort(); await exited; }
  }
  async function readyUrl(offset = 0) {
    const url = () => log.text.slice(offset).match(/Proprio is ready at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    await Promise.race([
      expect.poll(url, { timeout: 100_000 }).toBeTruthy(),
      exited!.then(([code, signal]) => { throw new Error(`Test-drive exited during startup (${code ?? signal})\n${log.text}`); }),
    ]);
    return url()!;
  }

  let databaseUrl: string | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  try {
    await mkdir(codexHome);
    await writeFile(codex, "#!/bin/sh\nexit 78\n", { mode: 0o700 });
    await chmod(codex, 0o700);
    const loaderContents = [
      'import { registerHooks } from "node:module";',
      'registerHooks({ load(url, context, nextLoad) {',
      '  if (/\\/packages\\/proprio-runner\\/(src|dist)\\/drivers\\/codex\\/codex-command\\.(js|ts)$/.test(url)) {',
      `    const source = ${JSON.stringify(`export const resolveCodexCommand = () => ${JSON.stringify(codex)};\nexport const resolvePinnedCodexCommand = resolveCodexCommand;`)};`,
      '    return { format: "module", shortCircuit: true, source };',
      '  }',
      '  return nextLoad(url, context);',
      '} });',
    ].join("\n");
    await writeFile(codexLoader, loaderContents);
    startDrive();
    let base = await readyUrl();
    const api = async (path: string, method = "GET", data?: unknown) => {
      const response = await request.fetch(`${base}/api${path}`, { method, data });
      const body = await response.text();
      expect(response.ok(), `${method} ${path}: ${response.status()} ${body}`).toBe(true);
      return body ? JSON.parse(body) : null;
    };
    const company = (await api("/companies"))[0];
    await api("/instance/settings/experimental", "PATCH", { enableCases: true, enableNativeRunner: true });
    const source = await api(`/companies/${company.id}/agents`, "POST", { name: "Offer source", role: "engineer", adapterType: "proprio_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-sol", cwd: root, lifecycleMode: "per_turn", codexPermissionMode: "never", timeoutSec: 60, env: { CODEX_HOME: codexHome, OPENAI_API_KEY: "restart-fixture-stub" } },
      runtimeConfig: { heartbeat: { enabled: false } } });
    const recipient = await api(`/companies/${company.id}/agents`, "POST", { name: "Decision recipient", role: "engineer", reportsTo: source.id,
      adapterType: "proprio_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol", cwd: root, lifecycleMode: "per_turn", codexPermissionMode: "never", timeoutSec: 60, env: { CODEX_HOME: codexHome, OPENAI_API_KEY: "restart-fixture-stub" } },
      runtimeConfig: { heartbeat: { enabled: false } } });

    const configPath = resolve(dataDir, "instances/default/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const databaseDir = config.database.embeddedPostgresDataDir;
    const serverPort = (await readFile(resolve(databaseDir, "postmaster.pid"), "utf8")).split("\n")[3];
    databaseUrl = `postgres://proprio:proprio@127.0.0.1:${serverPort}/proprio`;
    db = createDb(databaseUrl);
    // This fixture seeds an authorized source identity and native run to create
    // versioned offers. It qualifies receipt persistence and attribution, not
    // runner readiness or native source tool execution.
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, source.id));
    const [responsibleMembership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalType, "user")));
    expect(responsibleMembership?.principalId, "test-drive creates an active responsible user membership").toBeTruthy();
    const recipientToken = `recipient-restart-${randomUUID()}`;
    await db.insert(agentApiKeys).values({ companyId: company.id, agentId: recipient.id, name: "Restart fixture decision key",
      keyHash: createHash("sha256").update(recipientToken).digest("hex"), responsibleUserId: responsibleMembership!.principalId });

    const seeded: { caseId: string; taskId: string; handoffId: string; runId: string; requirementRevisionId: string; outcome: string; reasonCode?: string }[] = [];
    for (const [index, decision] of outcomes.entries()) {
      const caseId = randomUUID(), taskId = randomUUID(), runId = randomUUID();
      const requirementId = randomUUID();
      const caseNumber = index + 1;
      await db.insert(cases).values({ id: caseId, companyId: company.id, caseNumber,
        identifier: `${company.issuePrefix}-C${caseNumber}`, caseType: "work", title: `Decision ${decision.outcome}`,
        status: "in_progress", phase: "triage", handoffVersion: 1 });
      await db.insert(issues).values({ id: taskId, companyId: company.id, title: `Decision ${decision.outcome}`,
        description: "Retain this accepted requirement revision across restart.", status: "todo", statusVersion: 0,
        assigneeAgentId: source.id, visibility: "open" });
      await db.update(cases).set({ workIssueId: taskId }).where(eq(cases.id, caseId));
      await db.insert(caseIssueLinks).values({ companyId: company.id, caseId, issueId: taskId, role: "work" });
      await db.insert(caseAccessSources).values({ companyId: company.id, caseId, sourceKind: "issue", sourceId: taskId });
      const [contract] = await db.insert(completionContracts).values({ companyId: company.id, issueId: taskId, revision: 1,
        schemaVersion: "proprio.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { objective: "Complete the delegated work", criteria: [{ id: "verified", requirement: "Verify the result" }] },
        canonicalSha256: "a".repeat(64), createdByActorType: "agent", createdByActorId: source.id }).returning();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: company.id, issueId: taskId, agentId: source.id, status: "running",
        runtimeMode: "native", invocationSource: "assignment", triggerDetail: "system", completionContractId: contract!.id, contextSnapshot: { issueId: taskId } });
      await db.update(issues).set({ status: "in_progress", statusVersion: 1, executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, taskId));
      const offer = await caseHandoffService(db).handoff(company.id, { type: "agent", companyId: company.id, agentId: source.id,
        runId, source: "agent_jwt" }, { case: { id: caseId }, idempotencyKey: randomUUID(), expectedHandoffVersion: 1,
        expectedIssueStatusVersion: 1, toAgentId: recipient.id, phase: "implementation", instructions: "Review the stated requirements.",
        offer: { expectedDeliverable: "A verified result", prerequisites: ["Read the task brief"] } });
      expect(offer.state).toBe("offered");
      seeded.push({ caseId, taskId, handoffId: offer.handoffId, runId, requirementRevisionId: contract!.id, outcome: decision.outcome,
        ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}) });
    }

    const recorded = new Map<string, unknown>();
    for (const entry of seeded) {
      const response = await request.post(`${base}/api/cases/${entry.caseId}/handoffs/${entry.handoffId}/decision`, {
        headers: { authorization: `Bearer ${recipientToken}` },
        data: { outcome: entry.outcome, ...(entry.reasonCode ? { reasonCode: entry.reasonCode, message: `Recorded ${entry.reasonCode}` } : {}),
          expectedHandoffVersion: 2, requirementRevisionId: entry.requirementRevisionId },
      });
      const responseBody = await response.json();
      expect(response.ok(), `${entry.outcome}: ${response.status()} ${JSON.stringify(responseBody)}`).toBe(true);
      expect(responseBody.recipientDecision).toMatchObject({ outcome: entry.outcome, actorType: "agent", actorId: recipient.id,
        handoffVersion: 2, requirementRevisionId: entry.requirementRevisionId, decidedAt: expect.any(String),
        ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) });
      recorded.set(entry.handoffId, responseBody.recipientDecision);
    }

    const stopTime = new Date().toISOString();
    await stopDrive();
    startDrive();
    base = await readyUrl(log.text.length);
    expect((await api("/companies"))[0].id).toBe(company.id);
    for (const entry of seeded) {
      const history = await api(`/cases/${entry.caseId}/handoffs?limit=5`);
      const items = Array.isArray(history) ? history : history.items ?? history.handoffs;
      const handoff = items.find((item: { id: string }) => item.id === entry.handoffId);
      expect(handoff).toMatchObject({ issueId: entry.taskId, version: 2 });
      expect(handoff.recipientDecision).toEqual(recorded.get(entry.handoffId));
      const events = await db.select().from(caseEvents).where(and(eq(caseEvents.caseId, entry.caseId), eq(caseEvents.kind, "handoff_decision_recorded")));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: "agent", actorAgentId: recipient.id, payload: { handoffId: entry.handoffId,
        issueId: entry.taskId, outcome: entry.outcome, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) } });
    }
    await test.info().attach("decision-restart-evidence", { contentType: "application/json", body: JSON.stringify({
      stoppedAt: stopTime, restartedAt: new Date().toISOString(), controller: "test-drive process restarted with the same embedded database",
      source: "seeded native run and completion contract", recipient: recipient.id, decisions: seeded,
    }, null, 2) });
  } catch (error) {
    await test.info().attach("test-drive-logs", { body: log.text, contentType: "text/plain" });
    throw error;
  } finally {
    await stopDrive();
    if (databaseUrl) await closeRegisteredClients(databaseUrl, { scope: "database" });
    await rm(dataDir, { recursive: true, force: true });
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
