import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "../../../server/node_modules/drizzle-orm/index.js";
import { expect, test } from "@playwright/test";
import { agents, caseAccessSources, caseEvents, caseIssueLinks, cases, companyMemberships, completionContracts, closeRegisteredClients, createDb, heartbeatRuns, issues } from "../../../packages/db/src/index.ts";
import { resolveProprioInstanceConfigPath } from "../../../packages/shared/src/home-paths.ts";
import { agentService } from "../../../server/src/services/agents.ts";
import { caseHandoffService } from "../../../server/src/services/case-handoffs.ts";
import { launchTestDrive } from "../fixtures/test-drive-process";
import { json } from "../http";
import { readTestServerDatabaseUrl } from "../server-database-url";
import { createProcessTreeOwner, stopOwnedProcessTree } from "../../runner-e2e/process-tree-owner";

const outcomes: { outcome: string; reasonCode?: string }[] = [
  { outcome: "accepted" },
  { outcome: "clarification", reasonCode: "missing_prerequisite" },
  { outcome: "declined", reasonCode: "missing_capability" },
] as const;

test("recipient decisions survive a controller restart with their Case audit history", async ({ request }, info) => {
  test.setTimeout(240_000);
  const repo = resolve(import.meta.dirname, "../../..");
  const dataDir = await mkdtemp(resolve(tmpdir(), "proprio-recipient-decision-restart-"));
  const root = await mkdtemp(resolve(tmpdir(), "proprio-recipient-decision-fixture-"));
  const codexHome = resolve(root, "codex-home");
  const codex = resolve(root, "codex");
  const codexLoader = resolve(import.meta.dirname, "../fixtures/recipient-decision-codex-loader.mjs");
  const env = { ...process.env, NODE_ENV: "test", CODEX_HOME: codexHome,
    RECIPIENT_DECISION_CODEX_COMMAND: codex,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(codexLoader).href}`,
    OPENAI_API_KEY: "recipient-decision-fixture", CODEX_API_KEY: "" };
  let drive: { child: ReturnType<typeof launchTestDrive>["child"]; owner: ReturnType<typeof createProcessTreeOwner> } | undefined;
  function startDrive() {
    const launched = launchTestDrive({ cwd: repo, env,
      args: ["--data-dir", dataDir, "--harness", "codex", "--api-key-env", "OPENAI_API_KEY", "--company-name", "Recipient Decision Fixture", "--no-browser"],
      onOutput: () => undefined,
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

  let databaseUrl: string | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  try {
    await mkdir(codexHome);
    await writeFile(codex, "#!/bin/sh\nexit 78\n", { mode: 0o700 });
    await chmod(codex, 0o700);
    let base = await startDrive();
    const api = async (path: string, method = "GET", data?: unknown) => {
      return json(await request.fetch(`${base}/api${path}`, { method, data }));
    };
    const company = (await api("/companies"))[0];
    await api("/instance/settings/experimental", "PATCH", { enableCases: true, enableNativeRunner: true });

    const configPath = resolveProprioInstanceConfigPath({ homeDir: dataDir, instanceId: "default" });
    databaseUrl = await readTestServerDatabaseUrl(configPath);
    db = createDb(databaseUrl);
    // Seed dormant fixture agents and native runs for receipt persistence and
    // attribution. Creating agents through onboarding starts background probes.
    const source = { id: randomUUID() }, recipient = { id: randomUUID() };
    const dormantNativeAgent: typeof agents.$inferInsert = { companyId: company.id, name: "Fixture agent", role: "engineer", status: "active", lifecycleState: "ready",
      adapterType: "proprio_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-sol", cwd: root,
        lifecycleMode: "per_turn", codexPermissionMode: "never", timeoutSec: 60,
        env: { CODEX_HOME: codexHome, OPENAI_API_KEY: "restart-fixture-stub" } },
      runtimeConfig: { heartbeat: { enabled: false } } };
    await db.insert(agents).values([
      { ...dormantNativeAgent, id: source.id, name: "Offer source" },
      { ...dormantNativeAgent, id: recipient.id, name: "Decision recipient", reportsTo: source.id },
    ]);
    const [responsibleMembership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalType, "user")));
    expect(responsibleMembership?.principalId, "test-drive creates an active responsible user membership").toBeTruthy();
    const { token: recipientToken } = await agentService(db).createApiKey(recipient.id, "Restart fixture decision key",
      { kind: "standard" }, { responsibleUserId: responsibleMembership!.principalId });

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
        offer: { expectedDeliverable: "A verified result", prerequisites: ["Read the task brief"] } }, { enableVersionedOffers: true });
      expect(offer.state).toBe("offered");
      seeded.push({ caseId, taskId, handoffId: offer.handoffId, runId, requirementRevisionId: contract!.id, outcome: decision.outcome,
        ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}) });
    }

    const recorded = new Map<string, Record<string, unknown>>();
    for (const entry of seeded) {
      const responseBody = await json(await request.post(`${base}/api/cases/${entry.caseId}/handoffs/${entry.handoffId}/decision`, {
        headers: { authorization: `Bearer ${recipientToken}` },
        data: { outcome: entry.outcome, ...(entry.reasonCode ? { reasonCode: entry.reasonCode, message: `Recorded ${entry.reasonCode}` } : {}),
          expectedHandoffVersion: 2, requirementRevisionId: entry.requirementRevisionId },
      }));
      expect(responseBody.recipientDecision).toMatchObject({ outcome: entry.outcome, actorType: "agent", actorId: recipient.id,
        handoffVersion: 2, requirementRevisionId: entry.requirementRevisionId, decidedAt: expect.any(String),
        ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) });
      recorded.set(entry.handoffId, responseBody.recipientDecision);
    }

    const stopTime = new Date().toISOString();
    await closeRegisteredClients(databaseUrl, { scope: "database" });
    databaseUrl = undefined;
    db = undefined;
    await stopDrive();
    base = await startDrive();
    expect((await api("/companies"))[0].id).toBe(company.id);
    databaseUrl = await readTestServerDatabaseUrl(configPath);
    db = createDb(databaseUrl);
    for (const entry of seeded) {
      const history = await api(`/cases/${entry.caseId}/handoffs?limit=5`);
      const items = history.items;
      expect(Array.isArray(items)).toBe(true);
      const handoff = items.find((item: { id: string }) => item.id === entry.handoffId);
      expect(handoff).toMatchObject({ issueId: entry.taskId, version: 2,
        offerContract: { requirementRevision: { id: entry.requirementRevisionId, revision: 1 } } });
      expect(handoff.recipientDecision).toMatchObject(recorded.get(entry.handoffId)!);
      expect(handoff.recipientDecision.message).toBe(entry.reasonCode ? `Recorded ${entry.reasonCode}` : undefined);
      const events = await api(`/cases/${entry.caseId}/events?limit=100`);
      expect(Array.isArray(events)).toBe(true);
      const decisionEvents = events.filter((event: { kind: string; payload: { handoffId?: string } }) =>
        event.kind === "handoff_decision_recorded" && event.payload?.handoffId === entry.handoffId);
      expect(decisionEvents).toHaveLength(1);
      expect(decisionEvents[0]).toMatchObject({ actorType: "agent", actorAgentId: recipient.id, payload: {
        handoffId: entry.handoffId, issueId: entry.taskId, version: 2, outcome: entry.outcome,
        requirementRevisionId: entry.requirementRevisionId, ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) } });
      const persistedEvents = await db!.select().from(caseEvents).where(and(eq(caseEvents.caseId, entry.caseId), eq(caseEvents.kind, "handoff_decision_recorded")));
      expect(persistedEvents).toHaveLength(1);
      expect(persistedEvents[0]).toMatchObject({ actorType: "agent", actorAgentId: recipient.id, payload: {
        handoffId: entry.handoffId, issueId: entry.taskId, version: 2, outcome: entry.outcome,
        requirementRevisionId: entry.requirementRevisionId } });
    }
    const evidencePath = info.outputPath("recipient-decision-restart-evidence.json");
    await mkdir(resolve(evidencePath, ".."), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({
      stoppedAt: stopTime, restartedAt: new Date().toISOString(), controller: "test-drive process restarted with the same embedded database",
      source: "seeded native run and completion contract", recipient: recipient.id, decisions: seeded,
    }, null, 2));
    await info.attach("decision-restart-evidence", { path: evidencePath, contentType: "application/json" });
  } finally {
    await stopDrive();
    if (databaseUrl) await closeRegisteredClients(databaseUrl, { scope: "database" });
    await rm(dataDir, { recursive: true, force: true });
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
