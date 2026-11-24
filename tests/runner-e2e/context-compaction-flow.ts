import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { pollUntil, type RunnerApi } from "./api.js";
import { chatQuestionPresentation } from "./chat-flow.js";
import { COMPACTION_BUDGET_CENTS, COMPACTION_FIXTURE, COMPACTION_FIXTURE_DIGEST, COMPACTION_PROMPT, compactionRequirements, configureContextCompactionBudgets } from "./context-compaction-case.js";
import { gradeContextCompactionPair, type CompactionObservation } from "./context-compaction-scoring.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import { isBoundNativePrpEventRow } from "./native-event-envelope.js";
import { collectRunEvents } from "./run-observations.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;
type Lane = "control" | "treatment";
const failedStatuses = new Set(["failed", "cancelled", "timed_out"]);

export async function runContextCompactionFlow(input: {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution; nonce: string;
  sourceRevision: string; deadlineAt: number;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
  observe(issue: Row, runs: Row[]): void;
}) {
  const { page, api, fixtures, execution, nonce } = input;
  const companyPath = `/api/companies/${fixtures.company.id}`;
  const observed = new Map<Lane, CompactionObservation>();
  const requirementRevisionIds = { control: "", treatment: "" };
  const checkpoints: Array<Record<string, unknown>> = [];
  const allRuns = new Map<string, Row>();
  let issue: Row | undefined;

  async function checkpoint(stage: string, lane: Lane, data: Record<string, unknown> = {}) {
    checkpoints.push({ stage, lane, taskId: issue?.id, status: issue?.status, ...data });
    await input.evidence("context-compaction.json", { schema: "proprio.runner-e2e.context-compaction.v2",
      sourceRevision: input.sourceRevision, profileId: execution.profile.id, model: execution.profile.model,
      fixtureDigest: COMPACTION_FIXTURE_DIGEST, budgetCents: COMPACTION_BUDGET_CENTS, checkpoints, requirementRevisionIds,
      observed: Object.fromEntries(observed) });
  }

  async function runLane(lane: Lane) {
    issue = await api.post<Row>(`${companyPath}/issues`, { title: execution.task.buildTitle(nonce), description: COMPACTION_PROMPT, status: "backlog" });
    const issuePath = `/api/issues/${issue.id}`;
    const taskId = issue.id;
    const documentPath = `${issuePath}/documents/requirements`;
    const initialRequirements = await api.putSensitive<Row>(documentPath, { title: "Requirements", format: "markdown",
      body: compactionRequirements(COMPACTION_FIXTURE.supersededFormat), baseRevisionId: null });
    if (!initialRequirements.latestRevisionId) throw new Error("Initial requirements revision missing");
    await checkpoint("requirements-created", lane, { revisionId: initialRequirements.latestRevisionId });
    await api.patch(issuePath, { status: "todo", assigneeAgentId: fixtures.agent.id });

    async function load() {
      const [current, listed, interactions] = await Promise.all([
        api.get<Row>(issuePath), api.get<Row[]>(`${companyPath}/heartbeat-runs?limit=60`), api.get<Row[]>(`${issuePath}/interactions`),
      ]);
      const runs = (await Promise.all(listed.map(run => api.get<Row>(`/api/heartbeat-runs/${run.id}`))))
        .filter(run => (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) === taskId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
      for (const run of runs) allRuns.set(run.id, run);
      issue = current;
      input.observe(current, [...allRuns.values()]);
      return { issue: current, runs, interactions };
    }
    function wait(label: string, count: number, accept: (state: Awaited<ReturnType<typeof load>>) => boolean) {
      return pollUntil({ label: `${lane} ${label}`, deadlineAt: input.deadlineAt, intervalMs: 1_000, load,
        accept: state => state.runs.length === count && state.runs.every(run => run.status === "succeeded") && accept(state),
        reject: state => state.runs.length > count ? "A lane exceeded its bounded run count"
          : state.runs.some(run => failedStatuses.has(run.status)) ? "A lane run failed" : undefined });
    }
    function pending(state: Awaited<ReturnType<typeof load>>, runId: string) {
      return state.interactions.find(interaction => interaction.kind === "ask_user_questions" &&
        interaction.status === "pending" && interaction.sourceRunId === runId);
    }
    async function answer(question: Row, text: string) {
      const presentation = chatQuestionPresentation(question.payload);
      if (presentation.questions.length !== 1 || presentation.questions[0]?.answerMode !== "text") throw new Error("Expected one free-text question");
      await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue!.identifier ?? taskId}`);
      await page.getByTestId("question-text-answer-composer").last().locator('[contenteditable="true"],textarea').first().fill(text);
      await page.getByRole("button", { name: presentation.submitLabel ?? "Submit answers", exact: true }).last().click();
    }

    const seeded = await wait("initial question", 1, state => Boolean(pending(state, state.runs[0]?.id)));
    const initialRun = seeded.runs[0]!;
    const initialQuestion = pending(seeded, initialRun.id)!;
    const revised = await api.putSensitive<Row>(documentPath, { title: "Requirements", format: "markdown",
      body: compactionRequirements(COMPACTION_FIXTURE.activeFormat), baseRevisionId: initialRequirements.latestRevisionId });
    if (!revised.latestRevisionId || revised.latestRevisionId === initialRequirements.latestRevisionId) throw new Error("Current requirements revision missing");
    requirementRevisionIds[lane] = revised.latestRevisionId;
    await checkpoint("requirements-revised", lane, { initialRunId: initialRun.id, questionId: initialQuestion.id, revisionId: revised.latestRevisionId });

    let compact: { requestId: string; runId: string } | null = null;
    if (lane === "treatment") {
      compact = await api.post<{ requestId: string; runId: string }>(`${issuePath}/context/compact`, {});
      await checkpoint("compaction-requested", lane, compact);
      await wait("manual compaction settled", 2, state => state.runs[1]?.id === compact?.runId && state.issue.status === seeded.issue.status);
    }
    await answer(initialQuestion, "Begin the prerequisite check.");
    const waiting = await wait("prerequisite question", compact ? 3 : 2, state => Boolean(pending(state, state.runs.at(-1)?.id)));
    const waitingRun = waiting.runs.at(-1)!;
    const prerequisite = pending(waiting, waitingRun.id)!;
    await checkpoint("waiting-for-prerequisite", lane, { waitingRunId: waitingRun.id, prerequisiteId: prerequisite.id });
    await input.capture(`${lane}-waiting`, `${lane} waits for the release code`, `${lane}-waiting.png`);
    await answer(prerequisite, COMPACTION_FIXTURE.releaseCode);
    const final = await wait("final artifact", compact ? 4 : 3, state => state.issue.status === "done");
    const finalRun = final.runs.at(-1)!;
    const resolved = final.interactions.find(interaction => interaction.id === prerequisite.id && interaction.status === "answered");
    const documents = await api.get<Row[]>(`${issuePath}/documents`);
    const result = documents.find(document => document.key === "result");
    const revisions = result ? await api.get<Row[]>(`${issuePath}/documents/result/revisions`) : [];
    const latest = revisions.length === 1 && revisions[0]?.id === result?.latestRevisionId ? revisions[0] : null;
    const actions: CompactionObservation["actions"] = [{ runId: waitingRun.id, kind: "request_prerequisite", at: Date.parse(prerequisite.createdAt) }];
    const compactionEvents: CompactionObservation["compactionEvents"] = [];
    const sessions = new Map<string, CompactionObservation["initial"]>();
    for (const run of final.runs) {
      const events = await collectRunEvents<Row>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
      const valid = events.filter(event => run.nativeSessionId && run.runnerInstanceId && isBoundNativePrpEventRow(event, {
        runId: run.id, companyId: fixtures.company.id, agentId: fixtures.agent.id,
      }, run.runnerInstanceId) && event.payload.prpEvent.normalizedSessionId === run.nativeSessionId)
        .map(event => ({ event, envelope: event.payload.prpEvent }));
      for (const { event, envelope } of valid) {
        const payload = envelope.payload;
        if (event.eventType === "context.compacted") compactionEvents.push({ runId: run.id,
          reason: payload.reason, sameSession: payload.sameSession, sequence: event.seq });
        if (event.eventType === "item.started" && payload.item?.type === "tool_use" &&
            String(payload.item.name).split(".").at(-1) === "write_document") {
          actions.push({ runId: run.id, kind: "write_artifact", at: Date.parse(event.createdAt) });
        }
      }
      const runnerGenerations = [...new Set(valid.map(({ envelope }) => envelope.generation)
        .filter((value): value is number => Number.isSafeInteger(value) && value >= 0))].sort((left, right) => left - right);
      const requestId = run.contextSnapshot?.contextCompactionRequestId;
      sessions.set(run.id, { id: run.id, taskId,
        sessionDigest: valid.length ? createHash("sha256").update(run.nativeSessionId).digest("hex") : "",
        runnerDigest: valid.length ? createHash("sha256").update(run.runnerInstanceId).digest("hex") : "",
        runnerGenerations, compactionRequestId: typeof requestId === "string" ? requestId : null,
        startedAt: Date.parse(run.startedAt), finishedAt: Date.parse(run.finishedAt), status: run.status });
    }
    observed.set(lane, { sourceRevision: input.sourceRevision, profileId: execution.profile.id, provider: execution.profile.provider,
      model: execution.profile.model, fixtureDigest: COMPACTION_FIXTURE_DIGEST, taskId, initial: sessions.get(initialRun.id)!,
      waiting: sessions.get(waitingRun.id)!, final: sessions.get(finalRun.id)!,
      compactRequest: compact ? { requestId: compact.requestId, run: sessions.get(compact.runId)! } : null,
      compactionEvents, actions, prerequisite: resolved ? { receiptId: resolved.id, publishedAt: Date.parse(resolved.resolvedAt) } : null,
      artifact: latest ? { taskId, revisionId: latest.id, writtenByRunId: latest.createdByRunId, body: latest.body } : null });
    await checkpoint("final", lane, { finalRunId: finalRun.id, artifactRevisionId: latest?.id ?? null });
    await page.goto(`/${fixtures.company.issuePrefix}/issues/${issue!.identifier ?? taskId}`);
    await expect(page.getByRole("button", { name: "Change status (current: Done)", exact: true })).toBeVisible();
    await input.capture(`${lane}-final`, `${lane} saved the release receipt`, `${lane}-final.png`);
  }

  await api.patch("/api/instance/settings/experimental", { enableClassicTaskInterface: false });
  await configureContextCompactionBudgets(api, fixtures.company.id, fixtures.agent.id, execution.profile.credential);
  await runLane("control");
  await runLane("treatment");
  const verdict = gradeContextCompactionPair({ control: observed.get("control")!, treatment: observed.get("treatment")!,
    fixture: COMPACTION_FIXTURE, requirementRevisionIds });
  const checks = [{ id: "matchedPair", passed: verdict.matchedPair },
    ...(["control", "treatment"] as const).flatMap(lane => Object.entries(verdict[lane]).map(([id, passed]) => ({ id: `${lane}.${id}`, passed })))];
  await input.evidence("context-compaction-verdict.json", { schema: "proprio.runner-e2e.context-compaction-verdict.v1", checks });
  return { issue: issue!, runs: [...allRuns.values()], checks };
}
