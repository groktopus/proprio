import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, assets, companies, companyMemberships, createDb, documents, heartbeatRuns, issueAttachments, issueExecutionDecisions, issueThreadInteractionIdempotencyKeys, issueThreadInteractions, issues, type Db } from "@groktopus/db";
import { issueExecutionReviewTargetBindingSchema, requiredQualityReviewSchema } from "@groktopus/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { issueService } from "../services/issues.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { documentService } from "../services/documents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { bindPendingExecutionReviewTargets, captureRequiredQualityReviewDecisionBinding, qualityReviewRequirementHash, readDeferredSignoffTargetCurrent, readRequiredQualityReview } from "../services/required-quality-review.js";
import { nativeCompletionFeedback } from "../services/native-runtime/native-completion-feedback.js";
import { ProprioRunnerToolAuthority } from "../services/native-runtime/proprio-runner-tool-authority.js";
import type { PrpStructuredRunResult } from "../vendor/proprio-runner/index.js";

// Issue writes and the `issues` row type take the policy as a plain JSON record.
function executionPolicyRecord(input: unknown): Record<string, unknown> | null {
  const policy = normalizeIssueExecutionPolicy(input);
  return policy ? { ...policy } : null;
}

const requirement = { version: 1 as const, deliverables: [{ key: "copy", label: "Blog copy" }, { key: "visual", label: "Supporting visual" }] };
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("explicit required output quality review", () => {
  let db: ReturnType<typeof createDb>, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("required-quality-review-"); db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false, enableAgentChat: true }); }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function fixture(required = true, bindTargets = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = "local-board";
    await db.insert(companies).values({ id: companyId, name: "Quality", issuePrefix: `Q${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", status: "idle", adapterType: "proprio_runner" });
    const [task] = await db.insert(issues).values({ id: issueId, companyId, title: "Review outputs", status: "in_progress", assigneeAgentId: agentId,
      createdByUserId: userId, reviewPolicy: null,
      executionPolicy: required ? executionPolicyRecord({ requiredQualityReview: requirement,
        ...(bindTargets ? { reviewTargetBinding: { source: "required_quality_review" } } : {}) }) : null }).returning();
    const saved = await documentService(db).upsertIssueDocument({ issueId, key: "copy", title: "Blog copy", body: "Draft one", format: "markdown", baseRevisionId: null, createdByUserId: userId });
    const copy = { type: "issue_document" as const, key: "copy", revisionId: saved.document.latestRevisionId! };
    const assetId = randomUUID(), attachmentId = randomUUID(), sha256 = "a".repeat(64);
    await db.insert(assets).values({ id: assetId, companyId, provider: "local_disk", objectKey: assetId, contentType: "image/png", byteSize: 100, sha256, originalFilename: "visual.png", createdByUserId: userId });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId, issueId, assetId });
    const visual = { type: "issue_attachment" as const, attachmentId, assetId, sha256 };
    const service = issueThreadInteractionService(db);
    const approve = async (key: "copy" | "visual", target = key === "copy" ? copy : visual) => {
      const card = await service.create(task, { kind: "request_confirmation", idempotencyKey: randomUUID(), payload: { version: 1, prompt: "Approve this output?", target, qualityReview: { key } } }, { userId });
      await service.acceptInteraction(task, card.id, {}, { userId }); return card;
    };
    return { task, companyId, agentId, issueId, userId, saved, copy, visual, service, approve };
  }
  async function bindSubmission(issueId: string) {
    return db.transaction(async tx => {
      const issue = await issueService(db).getByIdForUpdate(issueId, tx);
      if (!issue) throw new Error("Expected task to submit");
      const state = await bindPendingExecutionReviewTargets(tx as unknown as Db, {
        issue, nextPolicy: issue.executionPolicy, nextState: { status: "pending", currentStageId: randomUUID() },
      });
      return state.reviewTargetBinding ? issueExecutionReviewTargetBindingSchema.parse(state.reviewTargetBinding) : null;
    });
  }

  it("retains the optional policy and validates unique required output keys", () => {
    expect(normalizeIssueExecutionPolicy({ requiredQualityReview: requirement })?.requiredQualityReview).toEqual(requirement);
    const optInPolicy = { source: "required_quality_review" as const };
    expect(normalizeIssueExecutionPolicy({ requiredQualityReview: requirement, reviewTargetBinding: optInPolicy })?.reviewTargetBinding).toEqual(optInPolicy);
    expect(() => normalizeIssueExecutionPolicy({ reviewTargetBinding: optInPolicy })).toThrow("Invalid execution policy");
    expect(normalizeIssueExecutionPolicy({})).toBeNull();
    expect(requiredQualityReviewSchema.safeParse({ version: 1, deliverables: [requirement.deliverables[0], requirement.deliverables[0]] }).success).toBe(false);
    const binding = { version: 1, requirementHash: "a".repeat(64), deliverables: [{ key: "copy", label: "Copy",
      target: { type: "issue_document", key: "copy", revisionId: randomUUID() } }] };
    expect(issueExecutionReviewTargetBindingSchema.safeParse(binding).success).toBe(true);
    expect(issueExecutionReviewTargetBindingSchema.safeParse({ ...binding, deliverables: [{ ...binding.deliverables[0], target: { type: "custom", key: "copy" } }] }).success).toBe(false);
  });
  it("does not gate existing tasks without the opt-in requirement", async () => {
    const f = await fixture(false);
    expect(await readRequiredQualityReview(db, f.task)).toEqual({ required: false, satisfied: true, missing: [] });
    expect(await issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId })).toMatchObject({ status: "done" });
  });
  it("rejects completion from file presence and unrelated accepted plan/confirmation", async () => {
    const f = await fixture();
    const unrelated = await f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Accept plan?", target: f.copy } }, { userId: f.userId });
    await f.service.acceptInteraction(f.task, unrelated.id, {}, { userId: f.userId });
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: false, missing: [{ key: "copy", reason: "missing" }, { key: "visual", reason: "missing" }] });
    await expect(issueService(db).create(f.companyId, { title: "Bypass review at creation", status: "done", executionPolicy: f.task.executionPolicy })).rejects.toThrow("cannot start completed");
    await expect(issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId })).rejects.toMatchObject({ details: { code: "required_quality_review_incomplete" } });
    await expect(f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve plan?", qualityReview: { key: "copy" }, target: { ...f.copy, key: "plan" } } }, { userId: f.userId })).rejects.toThrow("not a plan");
  });
  it("accepts exact canonical human quality approvals without publishing or completing automatically", async () => {
    const f = await fixture(); await f.approve("copy"); await f.approve("visual");
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: true });
    const [before] = await db.select().from(issues).where(eq(issues.id, f.issueId)); expect(before.status).toBe("in_progress");
    expect(await issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId })).toMatchObject({ status: "done" });
  });
  it("captures opt-in signoff targets as immutable requirement and artifact references", async () => {
    const f = await fixture(true, true);
    expect(f.task.executionPolicy).toMatchObject({ reviewTargetBinding: { source: "required_quality_review" } });
    await expect(bindSubmission(f.issueId)).rejects.toMatchObject({ details: { code: "required_quality_review_incomplete" } });
    await f.approve("copy");
    await f.approve("visual");
    const binding = await bindSubmission(f.issueId);
    expect(issueExecutionReviewTargetBindingSchema.safeParse(binding).success).toBe(true);
    expect(binding).toEqual({
      version: 1,
      requirementHash: qualityReviewRequirementHash(requirement),
      deliverables: [
        { key: "copy", label: "Blog copy", target: { type: "issue_document", key: "copy", revisionId: f.copy.revisionId } },
        { key: "visual", label: "Supporting visual", target: { type: "issue_attachment", attachmentId: f.visual.attachmentId,
          assetId: f.visual.assetId, sha256: f.visual.sha256 } },
      ],
    });
    await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy", body: "Changed copy",
      format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    await expect(bindSubmission(f.issueId)).rejects.toMatchObject({ details: { code: "required_quality_review_incomplete" } });
  });
  it("does not bind an output from an expired quality confirmation", async () => {
    const f = await fixture(true, true);
    const copyCard = await f.approve("copy");
    await f.approve("visual");
    await db.update(issueThreadInteractions).set({ status: "expired" }).where(eq(issueThreadInteractions.id, copyCard.id));
    await expect(bindSubmission(f.issueId)).rejects.toMatchObject({ details: { code: "required_quality_review_incomplete" } });
  });

  it("keeps a submitted review immutable even after a newer artifact gains human approval", async () => {
    const f = await fixture(true, true);
    await f.approve("copy");
    await f.approve("visual");
    const [reviewer] = await db.insert(agents).values({ companyId: f.companyId, name: "Stage reviewer", status: "idle", adapterType: "process" }).returning();
    const stageId = randomUUID();
    const policy = executionPolicyRecord({ ...f.task.executionPolicy,
      stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: reviewer!.id }] }] });
    const service = issueService(db);
    const assigned = await service.update(f.issueId, { executionPolicy: policy, actorUserId: f.userId });
    const prepareReview = applyIssueExecutionPolicyTransition({
      issue: assigned!, policy: normalizeIssueExecutionPolicy(policy), requestedStatus: "done",
      requestedAssigneePatch: {}, actor: { agentId: f.agentId },
    });
    const submitted = await service.update(f.issueId, { ...prepareReview.patch, actorAgentId: f.agentId });
    expect(submitted).toMatchObject({ status: "in_review", executionState: {
      currentStageId: stageId, reviewTargetBinding: { requirementHash: qualityReviewRequirementHash(requirement),
        deliverables: expect.arrayContaining([expect.objectContaining({
          key: "copy", target: expect.objectContaining({ revisionId: f.copy.revisionId }),
        })]) },
    } });

    const saved = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy",
      body: "Human approved a replacement after stage submission", format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    const newCopy = { ...f.copy, revisionId: saved.document.latestRevisionId! };
    await f.approve("copy", newCopy);
    expect(await readRequiredQualityReview(db, submitted!)).toMatchObject({ satisfied: true });
    const decide = (task: typeof submitted) => db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [locked] = await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      return captureRequiredQualityReviewDecisionBinding(tx, {
        issue: locked!, previousPolicy: task!.executionPolicy, nextPolicy: locked!.executionPolicy,
        previousExecutionState: locked!.executionState, expectedExecutionState: task!.executionState,
        stage: { stageId, stageType: "review" }, actorAgentId: reviewer!.id,
      });
    });
    await expect(decide(submitted)).rejects.toMatchObject({ details: { code: "required_quality_review_stale" } });
    const returned = applyIssueExecutionPolicyTransition({
      issue: submitted!, policy: normalizeIssueExecutionPolicy(policy), requestedStatus: "in_progress",
      requestedAssigneePatch: {}, actor: { agentId: reviewer!.id }, commentBody: "Review the replacement.",
    });
    const rework = await service.update(f.issueId, { ...returned.patch, actorAgentId: reviewer!.id });
    const prepareAgain = applyIssueExecutionPolicyTransition({
      issue: rework!, policy: normalizeIssueExecutionPolicy(policy), requestedStatus: "done",
      requestedAssigneePatch: {}, actor: { agentId: f.agentId },
    });
    const resubmitted = await service.update(f.issueId, { ...prepareAgain.patch, actorAgentId: f.agentId });
    await expect(decide(submitted)).rejects.toMatchObject({ details: { code: "required_quality_review_stale" } });
    await expect(decide(resubmitted)).resolves.toMatchObject({ deliverables: expect.arrayContaining([
      expect.objectContaining({ key: "copy", target: expect.objectContaining({ revisionId: newCopy.revisionId }) }),
    ]) });
  });

  it("keeps task status and the exact submitted decision atomic through the approval PATCH", async () => {
    const f = await fixture(true, true);
    await f.approve("copy");
    await f.approve("visual");
    const stageId = randomUUID();
    const reviewerId = f.userId;
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: reviewerId,
      principalType: "user", status: "active", membershipRole: "operator" });
    const policy = executionPolicyRecord({ ...f.task.executionPolicy,
      stages: [{ id: stageId, type: "review", participants: [{ type: "user", userId: reviewerId }] }] });
    const service = issueService(db);
    const assigned = await service.update(f.issueId, { executionPolicy: policy, actorUserId: f.userId });
    const submission = applyIssueExecutionPolicyTransition({
      issue: assigned!, policy: normalizeIssueExecutionPolicy(policy), requestedStatus: "done",
      requestedAssigneePatch: {}, actor: { agentId: f.agentId },
    });
    const submitted = await service.update(f.issueId, { ...submission.patch, actorAgentId: f.agentId });
    const originalBinding = submitted?.executionState?.reviewTargetBinding;
    expect(originalBinding).toBeDefined();

    const app = express();
    app.use(express.json());
    const actor: Request["actor"] = { type: "board", userId: reviewerId, companyIds: [f.companyId], isInstanceAdmin: true, source: "local_implicit" };
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    app.use(errorHandler);
    const decision = () => request(app).patch(`/api/issues/${f.issueId}`).send({ status: "done", comment: "Approved the submitted output." });
    const readDecisions = () => db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));

    const replacement = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy",
      body: "New copy needs its own signoff", format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    await f.approve("copy", { ...f.copy, revisionId: replacement.document.latestRevisionId! });
    const rejected = await decision();
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    expect(rejected.body.details).toMatchObject({ code: "required_quality_review_stale" });
    expect(await readDecisions()).toEqual([]);
    expect(await service.getById(f.issueId)).toMatchObject({ status: "in_review", executionState: { reviewTargetBinding: originalBinding } });

    const returnForChanges = await request(app).patch(`/api/issues/${f.issueId}`)
      .send({ status: "in_progress", comment: "Return the replacement for a new review." });
    expect(returnForChanges.status, JSON.stringify(returnForChanges.body)).toBe(200);
    const rework = await service.getById(f.issueId);
    const resubmission = applyIssueExecutionPolicyTransition({
      issue: rework!, policy: normalizeIssueExecutionPolicy(policy), requestedStatus: "done",
      requestedAssigneePatch: {}, actor: { agentId: f.agentId },
    });
    const resubmitted = await service.update(f.issueId, { ...resubmission.patch, actorAgentId: f.agentId });
    const newBinding = resubmitted?.executionState?.reviewTargetBinding;
    expect(newBinding).not.toEqual(originalBinding);
    await expect(db.transaction(async transaction => {
      const locked = await service.getByIdForUpdate(f.issueId, transaction);
      if (!locked) throw new Error("Expected locked stage");
      return captureRequiredQualityReviewDecisionBinding(transaction as unknown as Db, {
        issue: locked, previousPolicy: locked.executionPolicy, nextPolicy: locked.executionPolicy,
        previousExecutionState: locked.executionState, stage: { stageId, stageType: "review" }, actorUserId: reviewerId,
        expectedExecutionState: { ...locked.executionState, lastDecisionId: submitted?.executionState?.lastDecisionId ?? null },
      });
    })).rejects.toMatchObject({ details: { code: "required_quality_review_stale" } });
    const approved = await decision();
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await service.getById(f.issueId)).toMatchObject({ status: "done" });
    expect((await readDecisions()).filter(row => row.outcome === "approved")).toMatchObject([
      { actorUserId: reviewerId, stageId, reviewTargetBinding: newBinding },
    ]);
  });

  it("rechecks an approved native decision before the final Done write", async () => {
    const f = await fixture(true, true);
    await f.approve("copy");
    await f.approve("visual");
    const binding = await bindSubmission(f.issueId);
    expect(binding).toBeTruthy();
    const decisionId = randomUUID();
    const stageId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await db.insert(issueExecutionDecisions).values({
      id: decisionId, companyId: f.companyId, issueId: f.issueId, stageId, stageType: "review",
      actorAgentId: f.agentId, outcome: "approved", body: "Reviewed the earlier output.",
      reviewTargetBinding: binding, createdByRunId: runId,
    });
    const [deferred] = await db.update(issues).set({ status: "in_review", executionRunId: runId,
      executionState: { status: "completed", lastDecisionId: decisionId, lastDecisionOutcome: "approved", completedStageIds: [stageId] },
    }).where(eq(issues.id, f.issueId)).returning();
    expect(await readDeferredSignoffTargetCurrent(db, deferred)).toBe(true);

    const replacement = await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy",
      body: "New copy after deferred approval", format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    await f.approve("copy", { ...f.copy, revisionId: replacement.document.latestRevisionId! });
    expect(await readRequiredQualityReview(db, deferred)).toMatchObject({ satisfied: true });
    expect(await readDeferredSignoffTargetCurrent(db, deferred)).toBe(false);

    const service = issueService(db);
    await expect(service.update(f.issueId, { status: "done", actorAgentId: f.agentId }))
      .rejects.toMatchObject({ details: { code: "required_quality_review_stale" } });
    expect(await service.getById(f.issueId)).toMatchObject({ status: "in_review", executionState: { lastDecisionId: decisionId } });
    expect((await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, decisionId)))[0])
      .toMatchObject({ reviewTargetBinding: binding });
  });

  it("locks reviewed artifacts while an approved decision snapshots them", async () => {
    const f = await fixture(true, true);
    await f.approve("copy"); await f.approve("visual");
    const stageId = randomUUID();
    const submitted = await bindSubmission(f.issueId);
    const captured: { value: Awaited<ReturnType<typeof captureRequiredQualityReviewDecisionBinding>> } = { value: null };
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let ready!: (pid: number) => void;
    const snapshotReady = new Promise<number>(resolve => { ready = resolve; });
    const snapshot = db.transaction(async tx => {
      captured.value = await captureRequiredQualityReviewDecisionBinding(tx as unknown as Db, {
        issue: f.task, previousPolicy: f.task.executionPolicy, nextPolicy: f.task.executionPolicy,
        previousExecutionState: { status: "pending", currentStageId: stageId, currentStageType: "review",
          currentParticipant: { type: "user", userId: f.userId }, reviewTargetBinding: submitted },
        stage: { stageId, stageType: "review" }, actorUserId: f.userId,
      });
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      ready(Number(backend.pid));
      await hold;
    });
    const snapshotPid = await Promise.race([snapshotReady, snapshot.then(() => 0)]);
    expect(snapshotPid).toBeGreaterThan(0);
    const applicationName = `review-target-edit-${randomUUID()}`;
    const competingDb = createDb(temporary.connectionString, { applicationName, maxConnections: 1 });
    const edit = documentService(competingDb).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy",
      body: "Edited while approval commits", format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    void edit.catch(() => undefined);
    try {
      await expect.poll(async () => {
        const [observed] = await db.execute(sql`select query from pg_stat_activity
          where application_name = ${applicationName} and wait_event_type = 'Lock'
          and ${snapshotPid} = any(pg_blocking_pids(pid))`);
        return observed?.query;
      }).toMatch(/"document_revisions"|"documents"/);
    } finally {
      release();
      await Promise.allSettled([snapshot, edit]);
      await competingDb.$client.end();
    }
    await snapshot;
    await edit;
    expect(captured.value?.deliverables.find(item => item.key === "copy")?.target).toEqual({
      type: "issue_document", key: "copy", revisionId: f.copy.revisionId,
    });
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: false, missing: [{ key: "copy", reason: "stale" }] });
  });
  it("leaves legacy issue policies without opt-in unbound", async () => {
    const f = await fixture();
    await f.approve("copy");
    await f.approve("visual");
    expect(await bindSubmission(f.issueId)).toBeNull();
    expect(await captureRequiredQualityReviewDecisionBinding(db, {
      issue: f.task, previousPolicy: f.task.executionPolicy, nextPolicy: f.task.executionPolicy,
    })).toBeNull();
  });
  it("protects accepted requirements from agent removal or weakening and permits audited human edits", async () => {
    const f = await fixture();
    for (const executionPolicy of [null, executionPolicyRecord({ requiredQualityReview: { version: 1, deliverables: [requirement.deliverables[0]] } })]) {
      await expect(issueService(db).update(f.issueId, { executionPolicy, actorAgentId: f.agentId })).rejects.toThrow("Only a human");
    }
    expect(await issueService(db).update(f.issueId, { executionPolicy: null, actorUserId: f.userId })).toMatchObject({ executionPolicy: null });
  });
  it("prevents an agent from disabling or silently dropping an accepted immutable policy", async () => {
    const f = await fixture(true, true);
    const service = issueService(db);
    const unboundPolicy = executionPolicyRecord({ requiredQualityReview: requirement });
    await expect(service.update(f.issueId, { executionPolicy: unboundPolicy, actorAgentId: f.agentId }))
      .rejects.toMatchObject({ details: { code: "required_quality_review_policy_protected" } });
    const stagePolicy = executionPolicyRecord({ ...f.task.executionPolicy,
      stages: [{ id: randomUUID(), type: "review", participants: [{ type: "user", userId: f.userId }] }] });
    await service.update(f.issueId, { executionPolicy: stagePolicy, actorUserId: f.userId });
    await expect(service.update(f.issueId, { executionPolicy: f.task.executionPolicy, actorAgentId: f.agentId }))
      .rejects.toMatchObject({ details: { code: "required_quality_review_policy_protected" } });
    const older = await service.create(f.companyId, { title: "Existing unbound review", executionPolicy: unboundPolicy });
    await expect(service.create(f.companyId, {
      title: older.title, allowDuplicate: false, executionPolicy: f.task.executionPolicy,
    })).rejects.toMatchObject({ details: { code: "required_quality_review_mismatch" } });
  });

  it("requires reopening before adding an unsatisfied review contract to an already-completed task", async () => {
    const f = await fixture(false), service = issueService(db);
    await service.update(f.issueId, { status: "done", actorAgentId: f.agentId });
    const executionPolicy = executionPolicyRecord({ requiredQualityReview: requirement });
    await expect(service.update(f.issueId, { executionPolicy, actorUserId: f.userId })).rejects.toMatchObject({ details: { code: "required_quality_review_incomplete" } });
    expect(await service.update(f.issueId, { status: "todo", executionPolicy, actorUserId: f.userId })).toMatchObject({ status: "todo", executionPolicy: { requiredQualityReview: requirement } });
  });
  it("does not silently drop a required review when reusing an open task by title or idempotency key", async () => {
    const f = await fixture(false), service = issueService(db);
    await expect(service.create(f.companyId, { title: f.task.title, allowDuplicate: false, executionPolicy: executionPolicyRecord({ requiredQualityReview: requirement }) })).rejects.toMatchObject({ details: { code: "required_quality_review_mismatch" } });
    const child = await service.createChild(f.issueId, { title: "Existing child", idempotencyKey: "same-child" });
    await expect(service.createChild(f.issueId, { title: "Existing child", idempotencyKey: "same-child", executionPolicy: executionPolicyRecord({ requiredQualityReview: requirement }) })).rejects.toMatchObject({ details: { code: "required_quality_review_mismatch" } });
    expect(child.issue.executionPolicy).toBeNull();
  });
  it("rejects stale revisions, removed attachments and changed requirement identities", async () => {
    const f = await fixture(); await f.approve("copy"); await f.approve("visual");
    await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy", body: "Changed copy", format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: false, missing: [{ key: "copy", reason: "stale" }] });
    await db.delete(issueAttachments).where(eq(issueAttachments.id, f.visual.attachmentId));
    expect((await readRequiredQualityReview(db, f.task)).missing.map(item => item.key)).toEqual(["copy", "visual"]);
    const changed = { ...f.task, executionPolicy: normalizeIssueExecutionPolicy({ requiredQualityReview: { ...requirement, deliverables: [{ key: "copy", label: "Revised scope" }, requirement.deliverables[1]] } }) };
    expect((await readRequiredQualityReview(db, changed)).missing.every(item => item.reason === "stale")).toBe(true);
  });
  it("evaluates each item verdict: copy rejection cannot be masked by visual approval or answered status", async () => {
    const f = await fixture();
    const card = await f.service.create(f.task, { kind: "request_item_verdicts", resolverPolicy: "anyone", payload: { version: 1, prompt: "Review copy and visual", items: [
      { id: "copy", label: "Copy", qualityReview: { key: "copy", requirementHash: "f".repeat(64) }, target: f.copy },
      { id: "visual", label: "Visual", qualityReview: { key: "visual" }, target: f.visual },
    ] } }, { userId: f.userId });
    await expect(f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Ambiguous output", items: [
      { id: "first", label: "Approved copy", qualityReview: { key: "copy" }, target: f.copy },
      { id: "second", label: "Rejected copy", qualityReview: { key: "copy" }, target: f.copy },
    ] } }, { userId: f.userId })).rejects.toThrow("Quality review keys must be unique");
    expect(card.effectiveResolverPolicy).toBe("human_only");
    await expect(f.service.submitItemVerdicts(f.task, card.id, { verdicts: [{ id: "copy", verdict: "approve" }] }, { agentId: f.agentId, runId: randomUUID() })).rejects.toThrow();
    await f.service.submitItemVerdicts(f.task, card.id, { verdicts: [{ id: "copy", verdict: "reject", reason: "Rewrite the opening" }, { id: "visual", verdict: "approve" }] }, { userId: f.userId });
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: false, missing: [{ key: "copy", reason: "not_approved" }] });
    await f.approve("copy"); expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: true });
  });
  it.each(["document", "attachment"])("refuses an ordinary item-review batch when its %s target becomes stale", async stale => {
    const f = await fixture(false);
    const card = await f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review outputs", items: [
      { id: "copy", label: "Copy", target: f.copy }, { id: "visual", label: "Visual", target: f.visual },
    ] } }, { userId: f.userId });
    if (stale === "document") {
      await documentService(db).upsertIssueDocument({ issueId: f.issueId, key: "copy", title: "Blog copy", body: "Changed copy",
        format: "markdown", baseRevisionId: f.copy.revisionId, createdByUserId: f.userId });
    } else {
      await db.delete(issueAttachments).where(eq(issueAttachments.id, f.visual.attachmentId));
    }
    await expect(f.service.submitItemVerdicts(f.task, card.id, { verdicts: [
      { id: "copy", verdict: "approve" }, { id: "visual", verdict: "approve" },
    ] }, { userId: f.userId })).rejects.toMatchObject({ status: 422 });
    const saved = await f.service.getForIssue(f.task, card.id);
    expect(saved?.status).toBe("pending");
    expect(saved?.result).toBeNull();
  });
  it("records ordinary item verdicts when both bound outputs are still current", async () => {
    const f = await fixture(false);
    const card = await f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review outputs", items: [
      { id: "copy", label: "Copy", target: f.copy }, { id: "visual", label: "Visual", target: f.visual },
    ] } }, { userId: f.userId });
    const saved = await f.service.submitItemVerdicts(f.task, card.id, { verdicts: [
      { id: "copy", verdict: "approve" }, { id: "visual", verdict: "approve" },
    ] }, { userId: f.userId });
    expect(saved.interaction.status).toBe("answered");
    expect(saved.newlyResolvedItemIds).toEqual(["copy", "visual"]);
  });
  it("stamps quality bindings before idempotent replay and rejects cross-task targets", async () => {
    const f = await fixture(), other = await fixture();
    const request = { kind: "request_confirmation" as const, idempotencyKey: "same", payload: { version: 1 as const, prompt: "Approve copy?", target: f.copy, qualityReview: { key: "copy" } } };
    const first = await f.service.create(f.task, request, { userId: f.userId });
    expect((await f.service.create(f.task, request, { userId: f.userId })).id).toBe(first.id);
    await expect(f.service.create(f.task, { ...request, idempotencyKey: "cross", payload: { ...request.payload, target: { ...other.copy, issueId: other.issueId } } }, { userId: f.userId })).rejects.toThrow("on this task");
  });
  it("reuses repeated agent quality requests with fresh idempotency keys and keeps distinct outputs actionable", async () => {
    const f = await fixture();
    const actor = { agentId: f.agentId };
    const request = { kind: "request_confirmation" as const, addresseeUserId: f.userId,
      payload: { version: 1 as const, prompt: "Approve copy?", target: f.copy, qualityReview: { key: "copy" } } };
    await expect(f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Duplicate slots", items: [
      { id: "first", label: "Copy one", qualityReview: { key: "copy" }, target: f.copy },
      { id: "second", label: "Copy two", qualityReview: { key: "copy" }, target: f.copy },
    ] } }, actor)).rejects.toThrow("Quality review keys must be unique");
    const first = await f.service.create(f.task, { ...request, idempotencyKey: randomUUID() }, actor);
    const retryKeys = Array.from({ length: 12 }, () => randomUUID());
    const repeats = await Promise.all(retryKeys.map(idempotencyKey => f.service.create(f.task, { ...request, idempotencyKey }, actor)));
    expect(new Set(repeats.map(card => card.id))).toEqual(new Set([first.id]));
    const visual = await f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Approve visual?", target: f.visual, qualityReview: { key: "visual" } } }, actor);
    await expect(f.service.create(f.task, { ...request, payload: { ...request.payload, prompt: "Another copy request" } }, actor)).rejects.toMatchObject({ details: { code: "quality_review_already_pending", interactionId: first.id } });
    await expect(f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Duplicate copy", items: [{ id: "copy", label: "Copy", qualityReview: { key: "copy" }, target: f.copy }] } }, actor)).rejects.toMatchObject({ details: { code: "quality_review_already_pending" } });
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(rows.filter(row => row.status === "pending").map(row => row.id).sort()).toEqual([first.id, visual.id].sort());
    await f.service.acceptInteraction(f.task, first.id, {}, { userId: f.userId });
    const replay = await f.service.create(f.task, { ...request, idempotencyKey: retryKeys[0] }, actor);
    expect(replay).toMatchObject({ id: first.id, status: "accepted" });
    await expect(f.service.create(f.task, { ...request, idempotencyKey: retryKeys[0], payload: { ...request.payload, prompt: "Changed request" } }, actor)).rejects.toMatchObject({ status: 409 });
    expect((await readRequiredQualityReview(db, f.task)).missing.map(item => item.key)).toEqual(["visual"]);
    const aliases = await db.select().from(issueThreadInteractionIdempotencyKeys).where(eq(issueThreadInteractionIdempotencyKeys.interactionId, first.id));
    expect(aliases.map(alias => alias.idempotencyKey).sort()).toEqual(retryKeys.sort());
    // Replaying the additive migration after a rebase must retain these durable
    // acknowledgements and their FK/index protections.
    const migrations = new URL("../../../packages/db/src/migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql"))) {
      const source = await readFile(new URL(file, migrations), "utf8");
      if (!source.includes('CREATE TABLE IF NOT EXISTS "issue_thread_interaction_idempotency_keys"')) continue;
      for (const statement of source.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await db.execute(sql.raw(statement));
    }
    expect(await f.service.create(f.task, { ...request, idempotencyKey: retryKeys[0] }, actor)).toMatchObject({ id: first.id, status: "accepted" });
    expect((await f.service.create(f.task, { ...request, idempotencyKey: randomUUID() }, actor)).id).not.toBe(first.id);
  });
  it("bounds acknowledged retry keys while preserving already-acknowledged replay", async () => {
    const f = await fixture();
    const request = { kind: "request_confirmation" as const, idempotencyKey: "original", payload: { version: 1 as const, prompt: "Approve copy?", target: f.copy, qualityReview: { key: "copy" } } };
    const actor = { agentId: f.agentId };
    const first = await f.service.create(f.task, request, actor);
    await db.insert(issueThreadInteractionIdempotencyKeys).values(Array.from({ length: 100 }, (_, index) => ({ companyId: f.companyId, issueId: f.issueId, interactionId: first.id, idempotencyKey: `retry-${index}` })));
    await expect(f.service.create(f.task, { ...request, idempotencyKey: "one-too-many" }, actor)).rejects.toMatchObject({ details: { code: "quality_review_retry_key_limit", interactionId: first.id } });
    await f.service.acceptInteraction(f.task, first.id, {}, { userId: f.userId });
    expect(await f.service.create(f.task, { ...request, idempotencyKey: "retry-99" }, actor)).toMatchObject({ id: first.id, status: "accepted" });
    expect(await f.service.create(f.task, request, actor)).toMatchObject({ id: first.id, status: "accepted" });
  });
  it("allows a fresh review for an answered item while another output in its batch remains pending", async () => {
    const f = await fixture();
    const batch = await f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review outputs", items: [
      { id: "copy", label: "Copy", qualityReview: { key: "copy" }, target: f.copy },
      { id: "visual", label: "Visual", qualityReview: { key: "visual" }, target: f.visual },
    ] } }, { agentId: f.agentId });
    await f.service.submitItemVerdicts(f.task, batch.id, { verdicts: [{ id: "copy", verdict: "reject", reason: "Revise opening" }] }, { userId: f.userId });
    const next = await f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Review copy again", qualityReview: { key: "copy" }, target: f.copy } }, { agentId: f.agentId });
    expect(next.id).not.toBe(batch.id);
    await expect(f.service.create(f.task, { kind: "request_confirmation", payload: { version: 1, prompt: "Duplicate visual", qualityReview: { key: "visual" }, target: f.visual } }, { agentId: f.agentId })).rejects.toMatchObject({ details: { code: "quality_review_already_pending", interactionId: batch.id } });
  });
  it("caps pending quality cards task-wide even when previous requirement keys or reviewers differ", async () => {
    const f = await fixture();
    await db.insert(issueThreadInteractions).values(Array.from({ length: 10 }, (_, i) => ({
      companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation" as const, status: "pending" as const, continuationPolicy: "wake_assignee" as const,
      payload: { version: 1 as const, prompt: "Prior required output", target: f.copy, qualityReview: { key: `prior-${i}`, requirementHash: "a".repeat(64) } },
    })));
    await expect(f.service.create(f.task, { kind: "request_confirmation", addresseeUserId: f.userId, payload: { version: 1, prompt: "Approve copy?", target: f.copy, qualityReview: { key: "copy" } } }, { agentId: f.agentId })).rejects.toMatchObject({ details: { code: "quality_review_pending_limit" } });
    const rows = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(rows).toHaveLength(10);
  });
  it("locks the task before a verdict output and rechecks closure after a concurrent task transition", async () => {
    const f = await fixture();
    const card = await f.service.create(f.task, { kind: "request_item_verdicts", payload: { version: 1, prompt: "Review outputs", items: [
      { id: "copy", label: "Copy", qualityReview: { key: "copy" }, target: f.copy },
      { id: "visual", label: "Visual", qualityReview: { key: "visual" }, target: f.visual },
    ] } }, { userId: f.userId });
    await f.service.submitItemVerdicts(f.task, card.id, { verdicts: [{ id: "copy", verdict: "approve" }] }, { userId: f.userId });
    let submission: ReturnType<typeof f.service.submitItemVerdicts> | undefined;
    let observed: { wait_event_type: string; query: string } | undefined;
    await db.transaction(async tx => {
      await tx.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      let resolvePid!: (value: number) => void;
      const pidReady = new Promise<number>(resolve => { resolvePid = resolve; });
      submission = f.service.submitItemVerdicts(f.task, card.id, { verdicts: [{ id: "copy", verdict: "approve" }] }, { userId: f.userId }, {
        beforeResolveInTransaction: async inner => {
          const rows = await inner.execute(sql`select pg_backend_pid() as pid`);
          resolvePid(Number(rows[0].pid));
        },
      });
      // Register rejection handling before releasing the concurrent task lock.
      void submission.catch(() => undefined);
      const pid = await pidReady;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute(sql`select wait_event_type, query from pg_stat_activity where pid = ${pid}`);
        const row = rows[0] as typeof observed;
        if (row?.wait_event_type === "Lock") { observed = row; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    await expect(submission).rejects.toMatchObject({ details: { code: "interaction_issue_closed" } });
    expect(observed?.query).toContain('from "issues"');
    expect(observed?.query).not.toContain('from "issue_thread_interactions"');
    expect(observed?.query).not.toContain('from "documents"');
  });
  it("carries the requirement through suggestion acceptance atomically", async () => {
    const f = await fixture(false);
    const suggestion = await f.service.create(f.task, { kind: "suggest_tasks", payload: { version: 1, tasks: [{ clientKey: "blog", title: "Blog", requiredQualityReview: requirement }] } }, { userId: f.userId });
    const accepted = await f.service.acceptSuggestedTasks(f.task, suggestion.id, {}, { userId: f.userId });
    const [child] = await db.select().from(issues).where(eq(issues.id, accepted.createdIssues[0]!.id));
    expect(child).toMatchObject({ reviewPolicy: null, executionPolicy: { requiredQualityReview: requirement } });
  });
  it("carries the same contract through native explicit task creation without waking a provider", async () => {
    const f = await fixture(false), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const authority = new ProprioRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId, workMode: "standard", enqueueWakeup: async () => null });
    const result = await authority.execute({ tool: "create_task", callId: "create", arguments: { idempotencyKey: "create", title: "Write approved blog", requiredQualityReview: requirement } }) as { task: { id: string } };
    const [child] = await db.select().from(issues).where(eq(issues.id, result.task.id));
    expect(child).toMatchObject({ reviewPolicy: null, executionPolicy: { requiredQualityReview: requirement } });
  });
  it.each(["confirmation", "item_verdicts"] as const)("preserves exact quality binding through the advertised native %s tool", async interactionKind => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const authority = new ProprioRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId, workMode: "standard", enqueueWakeup: async () => null });
    const definition = authority.definitions().find(tool => tool.name === "request_human_input")!;
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
    const validate = ajv.compile(definition.inputSchema as object);
    for (const [key, target] of [["copy", f.copy], ["visual", f.visual]] as const) {
      const input = { idempotencyKey: `native-${key}`, interactionKind, title: `Review ${key}`, prompt: "Approve this output?", resolverPolicy: "human_only", continuationPolicy: "wake_assignee", payload: {
        version: 1, supersedeOnUserComment: false,
        ...(interactionKind === "confirmation" ? { qualityReview: { key }, target } : { items: [{ id: key, label: key, qualityReview: { key }, target }] }),
      } };
      expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...input, supersedeOnUserComment: false })).toBe(false);
      const result = await authority.execute({ tool: "request_human_input", callId: key, arguments: input }) as { interaction: { id: string; payload: any; effectiveResolverPolicy: string } };
      expect(result.interaction.effectiveResolverPolicy).toBe("human_only");
      const item = interactionKind === "confirmation" ? result.interaction.payload : result.interaction.payload.items[0];
      expect(item).toMatchObject({ qualityReview: { key, requirementHash: expect.stringMatching(/^[a-f0-9]{64}$/) }, target });
      const replay = await authority.execute({ tool: "request_human_input", callId: `${key}-retry`, arguments: input }) as typeof result;
      expect(replay.interaction.id).toBe(result.interaction.id);
      if (interactionKind === "confirmation") await f.service.acceptInteraction(f.task, result.interaction.id, {}, { userId: f.userId });
      else await f.service.submitItemVerdicts(f.task, result.interaction.id, { verdicts: [{ id: key, verdict: "approve" }] }, { userId: f.userId });
    }
    expect(await readRequiredQualityReview(db, f.task)).toMatchObject({ satisfied: true });
  });
  it("rejects a native done claim until required output approvals exist", async () => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const done: PrpStructuredRunResult = { schema: "proprio.run_result.v1", reportedWorkDisposition: "done", summary: "Outputs ready", completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    await expect(nativeCompletionFeedback(db, runId, done)).rejects.toThrow("Required human quality review is incomplete");
    await f.approve("copy"); await f.approve("visual");
    await expect(nativeCompletionFeedback(db, runId, done)).resolves.toContain("Completion report accepted");
  });
});
