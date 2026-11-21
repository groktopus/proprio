import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { companies } from "@groktopus/db";
import type { Db, agents, agentTaskSessions, heartbeatRuns } from "@groktopus/db";
import { AUTOMATION_CONVERSATION_ORIGIN_KIND, FAST_RESPONSE_AGENT_GUIDANCE, ONBOARDING_FIRST_TASK_ORIGIN_KIND, RESPONSIBILITY_BAR_ORIGIN_KIND, RESPONSIBILITY_DASHBOARD_ORIGIN_KIND, RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND, fastResponseHistoryBody, isValidIanaTimeZone } from "@groktopus/shared";
import type { ProprioTurnContext } from "@groktopus/adapter-utils/server-utils";
import { parseObject } from "../../adapters/utils.js";
import { isConversation } from "../agent-conversations.js";
import { chatCompletionInstruction } from "../chat-completion-delivery.js";
import { getConversationConfirmationContext } from "../conversation-confirmation-context.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { getIssueContinuationSummaryDocument } from "../issue-continuation-summary.js";
import type { issueService } from "../issues.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import { redactQuarantinedBodyForHigherTrust, sanitizeQuarantinedCommentForHigherTrust } from "../source-trust.js";
import { getTaskPlanContext } from "../task-plan-context.js";
import { loadResponsibilityBarGuidance } from "../responsibility-bar-guidance.js";
import { loadAutomationConversationGuidance } from "../automation-conversation-guidance.js";
import { loadDashboardConversationGuidance } from "../responsibility-dashboard-guidance.js";
import { loadStatusRefreshReminder, loadStatusUpdateGuidance } from "../responsibility-status-guidance.js";
import { loadStandingCheckGuidance } from "../routine-standing-checks.js";
import { caseExecutionMarkdown, getCaseExecutionContext } from "../case-context.js";
import type { TrustPresetResolution } from "../trust-preset-resolver.js";
import { liveVoiceExecutionGuidance } from "../voice/voice-execution-guidance.js";
import { buildProprioWakePayload, ConfigurationIncompleteFailure, readHeartbeatWakeComments, PROPRIO_WAKE_PAYLOAD_KEY, type createHeartbeatRunPreparation } from "./run-preparation.js";
import { buildProprioTaskMarkdown } from "./task-markdown.js";
import { deriveCommentId, extractWakeCommentIds } from "../../modules/run-dispatch/index.js";
import { workspacePreferenceService } from "../workspace-preferences.js";

type RunPreparation = ReturnType<typeof createHeartbeatRunPreparation>;
type IssueContext = NonNullable<Awaited<ReturnType<RunPreparation["getIssueExecutionContext"]>>>;

export interface HeartbeatTaskContextInput {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id">;
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType">;
  task: {
    issueRef: Pick<IssueContext,
      "id" | "identifier" | "title" | "status" | "priority" | "workMode" |
      "conversationAgentId" | "description" | "projectId"> | null;
    issueContext: IssueContext | null;
    context: Record<string, unknown>;
    taskSession: Pick<typeof agentTaskSessions.$inferSelect, "lastRunId"> | null;
  };
  policy: {
    recovering?: boolean;
    trustPreset: Pick<TrustPresetResolution, "kind">;
    experimentalInstanceSettings: { enableSimplifiedEnglishInteractions?: boolean; enableCases?: boolean; enableConferenceRoomChat?: boolean; enableStatusCards?: boolean; enableResponsibilities?: boolean };
  };
  services: {
    issuesSvc: Pick<ReturnType<typeof issueService>, "getAncestors">;
    getPinnedSkillTestContext: RunPreparation["getPinnedSkillTestContext"];
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Rebuilds task prompt fields on the run's context; acquires no execution resources. */
export async function prepareHeartbeatTaskContext(db: Db, input: HeartbeatTaskContextInput) {
  const { run, agent } = input;
  const { issueRef, issueContext, context, taskSession } = input.task;
  const { trustPreset, experimentalInstanceSettings } = input.policy;
  const { issuesSvc, getPinnedSkillTestContext } = input.services;
  const admittedScope = parseObject(context.proprioAgentJwtScope);
  if (!input.policy.recovering || (admittedScope.kind !== "standard" && admittedScope.kind !== "skill_test")) {
    const savedIssue = parseObject(context.proprioIssue);
    const skillTest = input.policy.recovering
      ? savedIssue.workMode === "skill_test" || Boolean(context.proprioSkillTest)
      : issueRef?.workMode === "skill_test";
    context.proprioAgentJwtScope = skillTest && issueRef
      ? { kind: "skill_test", issueId: issueRef.id }
      : { kind: "standard" };
  }
  const isSkillTest = parseObject(context.proprioAgentJwtScope).kind === "skill_test";
  const wakeCommentId = deriveCommentId(context, null);
  const commentIds = [...new Set([...extractWakeCommentIds(context), ...(wakeCommentId ? [wakeCommentId] : [])])];
  const [summary, ancestors, pinnedSkillTestRead, wakeComments] = await Promise.allSettled([
    issueRef && !isConversation(issueContext) ? getIssueContinuationSummaryDocument(db, issueRef.id) : Promise.resolve(null),
    issueRef ? issuesSvc.getAncestors(issueRef.id) : Promise.resolve([]),
    isSkillTest && issueRef ? getPinnedSkillTestContext(agent.companyId, issueRef.id) : Promise.resolve(null),
    readHeartbeatWakeComments(db, agent.companyId, readNonEmptyString(context.issueId), commentIds),
  ]);
  if (summary.status === "rejected") throw summary.reason;
  if (ancestors.status === "rejected") throw ancestors.reason;
  if (pinnedSkillTestRead.status === "rejected") throw pinnedSkillTestRead.reason;
  if (wakeComments.status === "rejected") throw wakeComments.reason;
  const wakeCommentRows = wakeComments.value;
  const selectedWakeComment = issueRef && wakeCommentId ? wakeCommentRows.find(comment => comment.id === wakeCommentId && comment.issueId === issueRef.id) ?? null : null;
  const wakeCommentContext = selectedWakeComment ? {
    id: selectedWakeComment.id,
    body: selectedWakeComment.deletedAt ? "" : selectedWakeComment.body,
    authorType: selectedWakeComment.authorType,
    authorAgentId: selectedWakeComment.authorAgentId,
    authorUserId: selectedWakeComment.authorUserId,
    presentation: selectedWakeComment.deletedAt ? null : selectedWakeComment.presentation,
    metadata: selectedWakeComment.deletedAt ? null : selectedWakeComment.metadata,
    deletedAt: selectedWakeComment.deletedAt,
    deletedByType: selectedWakeComment.deletedByType,
    deletedByAgentId: selectedWakeComment.deletedByAgentId,
    deletedByUserId: selectedWakeComment.deletedByUserId,
    deletedByRunId: selectedWakeComment.deletedByRunId,
    sourceTrust: selectedWakeComment.sourceTrust,
  } : null;
  const continuationSummary = summary.value;
  const issueAncestors = ancestors.value;
  const pinnedSkillTestContext = pinnedSkillTestRead.value;
  const exposeLowTrustRaw = trustPreset.kind === "low_trust_review";
  const safeContinuationSummary =
    continuationSummary && !exposeLowTrustRaw
      ? redactQuarantinedBodyForHigherTrust(continuationSummary)
      : continuationSummary;
  const safeWakeCommentContext =
    wakeCommentContext && !exposeLowTrustRaw
      ? sanitizeQuarantinedCommentForHigherTrust(wakeCommentContext)
      : wakeCommentContext;
  if (continuationSummary) {
    context.proprioContinuationSummary = {
      key: safeContinuationSummary!.key,
      title: safeContinuationSummary!.title,
      body: safeContinuationSummary!.body,
      sourceTrust: safeContinuationSummary!.sourceTrust ?? null,
      updatedAt: safeContinuationSummary!.updatedAt.toISOString(),
    };
  } else {
    delete context.proprioContinuationSummary;
  }
  if (isSkillTest && !pinnedSkillTestContext) {
    throw new ConfigurationIncompleteFailure("The skill test's saved version is unavailable.", {
      configurationIncomplete: { reason: "skill_unavailable", actionUrl: "/skills" },
    });
  }
  if (pinnedSkillTestContext) {
    context.proprioSkillTest = {
      ...pinnedSkillTestContext,
      directive:
        "Use this pinned file inventory as the exact skill revision under test, regardless of synced runtime skills.",
    };
  } else {
    delete context.proprioSkillTest;
  }
  const executionContinuation =
    issueRef && !isConversation(issueContext) && issueContext?.assigneeAgentId === agent.id
      ? await buildExecutionContinuation({
          db,
          companyId: agent.companyId,
          issueId: issueRef.id,
          agentId: agent.id,
          runId: run.id,
          context,
          previousContextRunId: taskSession?.lastRunId,
          summary: safeContinuationSummary?.body ?? null,
          exposeLowTrustRaw,
        })
      : null;
  context.executionContinuation = executionContinuation;
  const proprioWakePayload = await buildProprioWakePayload({
    db,
    companyId: agent.companyId,
    agentId: agent.id,
    runId: run.id,
    contextSnapshot: context,
    wakeCommentRows,
    continuationSummary,
    issueSummary: issueRef
      ? {
          id: issueRef.id,
          identifier: issueRef.identifier,
          title: issueRef.title,
          description: issueContext?.description ?? null,
          status: issueRef.status,
          priority: issueRef.priority,
          workMode: issueRef.workMode,
          projectId: issueRef.projectId,
          executionPolicy: issueContext?.executionPolicy ?? null,
          originKind: issueContext?.originKind ?? null,
        }
      : null,
    exposeLowTrustRaw,
    simplifiedEnglishInteractions:
      experimentalInstanceSettings.enableSimplifiedEnglishInteractions ===
      true,
  });
  if (proprioWakePayload) {
    context[PROPRIO_WAKE_PAYLOAD_KEY] = proprioWakePayload;
  } else {
    delete context[PROPRIO_WAKE_PAYLOAD_KEY];
  }
  const safeWakeComments = (proprioWakePayload?.comments ?? []).flatMap(
    (comment) =>
      typeof comment.id === "string" && typeof comment.body === "string"
        ? [
            {
              id: comment.id,
              body: fastResponseHistoryBody({ body: comment.body, origin: typeof comment.origin === "string" ? comment.origin : null }),
              attachments: Array.isArray(comment.attachments)
                ? comment.attachments.flatMap((attachment) => {
                    const descriptor = parseObject(attachment);
                    const id = readNonEmptyString(descriptor.id);
                    const filename = readNonEmptyString(
                      descriptor.filename,
                    );
                    const contentType = readNonEmptyString(
                      descriptor.contentType,
                    );
                    const contentPath = readNonEmptyString(
                      descriptor.contentPath,
                    );
                    const byteSize = descriptor.byteSize;
                    return id &&
                      filename &&
                      contentType &&
                      contentPath &&
                      typeof byteSize === "number"
                      ? [
                          {
                            id,
                            filename,
                            contentType,
                            byteSize,
                            contentPath,
                          },
                        ]
                      : [];
                  })
                : [],
            },
          ]
        : [],
  );
  // Always replace caller-supplied context with the immutable, company-scoped
  // conversation snapshot. It belongs only to the endpoint's assigned agent.
  const liveVoiceGuidance = issueContext?.chatAssignedAgentId === agent.id && issueContext.chatProvider === "speko"
    ? await liveVoiceExecutionGuidance(db, { companyId: agent.companyId, issueId: issueContext.id, agentId: agent.id })
    : null;
  context.proprioTaskCommunicationGuidance =
    issueContext?.chatAssignedAgentId === agent.id
      ? issueContext.chatCommunicationGuidance
      : null;
  // Use the standing chat owner's saved preferences, never worker text.
  // Recovery retains the admitted choices instead of silently changing its prompt.
  const conversationOwnerPreference = isConversation(issueContext) && issueContext?.conversationUserId
    && !input.policy.recovering
    ? await workspacePreferenceService(db).get(issueContext.conversationUserId)
    : null;
  const coordinatorWorkspace = agent.adapterType === "proprio_runner" && isConversation(issueContext)
    && issueContext?.conversationUserId
    ? input.policy.recovering
      ? context.proprioCoordinatorWorkspaceEnabled === true
      : conversationOwnerPreference?.coordinatorWorkspaceEnabled === true
    : false;
  context.proprioCoordinatorWorkspaceEnabled = Boolean(coordinatorWorkspace);
  const savedPersonTimeZone = input.policy.recovering
    ? readNonEmptyString(context.proprioConversationTimeZone)
    : conversationOwnerPreference?.timeZone ?? null;
  const personTimeZone = isConversation(issueContext) && issueContext?.conversationUserId
    && savedPersonTimeZone && isValidIanaTimeZone(savedPersonTimeZone)
    ? savedPersonTimeZone
    : null;
  if (personTimeZone) context.proprioConversationTimeZone = personTimeZone;
  else delete context.proprioConversationTimeZone;
  const [chatCompany] = issueRef?.conversationAgentId && !issueRef.identifier
    ? await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, agent.companyId))
    : [];
  const taskMarkdownInput = {
    companyPrefix: chatCompany?.issuePrefix,
    coordinatorWorkspace: Boolean(coordinatorWorkspace),
    personTimeZone,
    conferenceRoomEnabled: experimentalInstanceSettings.enableConferenceRoomChat === true,
    statusCardsEnabled: experimentalInstanceSettings.enableStatusCards === true,
    casesEnabled: experimentalInstanceSettings.enableCases === true,
    responsibilitiesEnabled: experimentalInstanceSettings.enableResponsibilities === true,
    // Work a routine created, the onboarding task, bar and automation conversations and status update requests are never offered as routines.
    routineSuggestionsEnabled: experimentalInstanceSettings.enableResponsibilities === true
      && issueContext?.originKind !== "routine_execution"
      && issueContext?.originKind !== ONBOARDING_FIRST_TASK_ORIGIN_KIND
      && issueContext?.originKind !== RESPONSIBILITY_BAR_ORIGIN_KIND
      && issueContext?.originKind !== AUTOMATION_CONVERSATION_ORIGIN_KIND
      && issueContext?.originKind !== RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND
      && issueContext?.originKind !== RESPONSIBILITY_DASHBOARD_ORIGIN_KIND,
    // The bar conversation's instructions, rebuilt from the responsibility each wake.
    responsibilityBarGuidance: experimentalInstanceSettings.enableResponsibilities === true && issueRef && issueContext
      && issueContext.originKind === RESPONSIBILITY_BAR_ORIGIN_KIND
      ? await loadResponsibilityBarGuidance(db, {
        issue: {
          id: issueRef.id,
          companyId: agent.companyId,
          originKind: issueContext.originKind,
          originId: issueContext.originId ?? null,
          assigneeAgentId: issueContext.assigneeAgentId ?? null,
        },
        agentId: agent.id,
      })
      : null,
    // The automation conversation's instructions, rebuilt from the task being automated each wake.
    automationConversationGuidance: experimentalInstanceSettings.enableResponsibilities === true && issueRef && issueContext
      && issueContext.originKind === AUTOMATION_CONVERSATION_ORIGIN_KIND
      ? await loadAutomationConversationGuidance(db, {
        issue: {
          id: issueRef.id,
          companyId: agent.companyId,
          originKind: issueContext.originKind,
          originId: issueContext.originId ?? null,
          assigneeAgentId: issueContext.assigneeAgentId ?? null,
        },
        agentId: agent.id,
      })
      : null,
    // A status update request's instructions, rebuilt from the responsibility each wake.
    responsibilityStatusUpdateGuidance: experimentalInstanceSettings.enableResponsibilities === true && issueRef && issueContext
      && issueContext.originKind === RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND
      ? await loadStatusUpdateGuidance(db, {
        issue: {
          id: issueRef.id,
          companyId: agent.companyId,
          originKind: issueContext.originKind,
          originId: issueContext.originId ?? null,
          assigneeAgentId: issueContext.assigneeAgentId ?? null,
        },
        agentId: agent.id,
        runId: run.id,
      })
      : null,
    // The dashboard conversation's instructions, rebuilt from the person's dashboard each wake; they differ by mode.
    responsibilityDashboardGuidance: experimentalInstanceSettings.enableResponsibilities === true && issueRef && issueContext
      && issueContext.originKind === RESPONSIBILITY_DASHBOARD_ORIGIN_KIND
      ? await loadDashboardConversationGuidance(db, {
        issue: {
          id: issueRef.id,
          companyId: agent.companyId,
          originKind: issueContext.originKind,
          originId: issueContext.originId ?? null,
          assigneeAgentId: issueContext.assigneeAgentId ?? null,
        },
        agentId: agent.id,
      })
      : null,
    // On other work under a responsibility this agent reports on: a short reminder to refresh its status.
    responsibilityStatusReminder: experimentalInstanceSettings.enableResponsibilities === true && issueRef && issueContext
      && !isConversation(issueContext) && (issueRef.workMode ?? "standard") === "standard"
      && issueContext.originKind !== RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND
      ? await loadStatusRefreshReminder(db, {
        issue: {
          id: issueRef.id,
          companyId: agent.companyId,
          projectId: issueRef.projectId ?? null,
          originKind: issueContext.originKind ?? null,
          assigneeAgentId: issueContext.assigneeAgentId ?? null,
        },
        agentId: agent.id,
      })
      : null,
    conversationConfirmations: issueRef && isConversation(issueContext)
      ? await getConversationConfirmationContext({ db, companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id })
      : null,
    onboardingChat: issueContext?.originKind === "onboarding_chat",
    onboardingGreeting: context.wakeReason === "onboarding_chat_greeting",
    issue: issueRef
      ? {
          id: issueRef.id,
          identifier: issueRef.identifier,
          title: issueRef.title,
          titleNeedsGeneration: issueContext?.titleNeedsGeneration,
          workMode: issueRef.workMode,
          conversationAgentId: issueContext?.conversationAgentId,
          executionPolicy: issueContext?.executionPolicy,
          description: issueRef.description,
        }
      : null,
    ancestors: issueAncestors,
    wakeComment: safeWakeCommentContext,
    wakeComments: safeWakeComments,
    attachmentOmissions: proprioWakePayload?.attachmentOmissions,
    externalChatProvider: proprioWakePayload?.externalChatProvider,
    slackCommand: issueContext?.chatAssignedAgentId === agent.id
      ? issueContext.chatSlackCommand
      : null,
    nativeRunner: agent.adapterType === "proprio_runner",
    interaction: {
      kind: readNonEmptyString(context.interactionKind),
      status: readNonEmptyString(context.interactionStatus),
    },
    planReview: proprioWakePayload?.planReviewContext?.interaction
      ? {
          status: proprioWakePayload.planReviewContext.interaction.status,
          reason: proprioWakePayload.planReviewContext.interaction.result?.reason,
        }
      : null,
    acceptedPlanContinuation:
      readNonEmptyString(context.workspaceRefreshReason) ===
        "accepted_plan_confirmation" &&
      Object.keys(parseObject(context.acceptedPlanWakeRouting)).length ===
        0,
    acceptedPlan: (() => {
      const accepted = parseObject(
        parseObject(context.planReviewInteraction).acceptedTargetRevision,
      );
      const revisionId = readNonEmptyString(accepted.revisionId);
      if (!revisionId) return null;
      return {
        documentId: readNonEmptyString(accepted.documentId),
        revisionId,
        revisionNumber:
          typeof accepted.revisionNumber === "number"
            ? accepted.revisionNumber
            : null,
      };
    })(),
  };
  const taskPlan = issueRef && !isConversation(issueContext)
    ? await getTaskPlanContext({
        db,
        companyId: agent.companyId,
        issueId: issueRef.id,
        approvedRevisionId: taskMarkdownInput.acceptedPlan?.revisionId,
        exposeLowTrustRaw,
      })
    : null;
  // Unlike the frozen initial communication preferences, live-call context
  // must also reach resumed turns. Rebuild it from server records each wake.
  const liveVoiceTaskPrefix = liveVoiceGuidance ? `${liveVoiceGuidance}\n\n` : "";
  context.proprioCasesEnabled = experimentalInstanceSettings.enableCases === true;
  context.proprioResponsibilitiesEnabled = experimentalInstanceSettings.enableResponsibilities === true;
  const workflowCase = issueRef && experimentalInstanceSettings.enableCases
    ? await getCaseExecutionContext(db, { companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id, runId: run.id, exposeLowTrustRaw })
    : null;
  if (workflowCase) context.proprioCase = workflowCase;
  else delete context.proprioCase;
  const assignmentPrefix = liveVoiceTaskPrefix + caseExecutionMarkdown(workflowCase);
  // Experimental standing checks (enableResponsibilities): a timer wake with
  // no task carries the agent's active standing checks, rebuilt each wake.
  const standingChecks = !issueRef && experimentalInstanceSettings.enableResponsibilities === true
    && readNonEmptyString(context.wakeReason) === "heartbeat_timer"
    ? await loadStandingCheckGuidance(db, { companyId: agent.companyId, agentId: agent.id })
    : null;
  // A wake with no task builds no task markdown; never let that read as "null".
  const markdown = (options: { includeDescription?: boolean; includeWakeComments?: boolean }) =>
    assignmentPrefix
      + [buildProprioTaskMarkdown({ ...taskMarkdownInput, taskPlan, ...options }), standingChecks].filter(Boolean).join("\n\n")
      + chatCompletionInstruction(context);
  let taskMarkdown = markdown({});
  let taskMarkdownAssignment = markdown({ includeWakeComments: false });
  const taskMarkdownCompact = markdown({ includeDescription: false });
  const taskMarkdownAssignmentCompact = markdown({ includeDescription: false, includeWakeComments: false });
  if (issueRef) {
    context.proprioIssue = {
      id: issueRef.id,
      identifier: issueRef.identifier,
      title: issueRef.title,
      description: isConversation(issueContext) ? null : issueRef.description,
      workMode: issueRef.workMode,
    };
  } else {
    delete context.proprioIssue;
  }
  if (wakeCommentContext) {
    context.proprioWakeComment = safeWakeCommentContext;
  } else {
    delete context.proprioWakeComment;
  }
  if (taskMarkdown) {
    context.proprioTaskMarkdown = taskMarkdown;
  } else {
    delete context.proprioTaskMarkdown;
  }
  if (taskMarkdownAssignment) {
    context.proprioTaskMarkdownAssignment = taskMarkdownAssignment;
  } else {
    delete context.proprioTaskMarkdownAssignment;
  }
  if (taskMarkdownCompact && taskMarkdownCompact !== taskMarkdown) {
    context.proprioTaskMarkdownCompact = taskMarkdownCompact;
  } else {
    delete context.proprioTaskMarkdownCompact;
  }
  if (taskMarkdownAssignmentCompact && taskMarkdownAssignmentCompact !== taskMarkdownAssignment) {
    context.proprioTaskMarkdownAssignmentCompact = taskMarkdownAssignmentCompact;
  } else {
    delete context.proprioTaskMarkdownAssignmentCompact;
  }
  context.proprioTaskCommunicationGuidance = [context.proprioTaskCommunicationGuidance, FAST_RESPONSE_AGENT_GUIDANCE].filter(Boolean).join("\n\n");
  if (issueRef) {
    const redactedWakeContext = await createRunSecretRedactionRegistry(
      db,
    ).redactForIssue(agent.companyId, issueRef.id, {
      proprioIssue: context.proprioIssue,
      proprioCase: context.proprioCase,
      proprioWakeComment: context.proprioWakeComment,
      proprioTaskCommunicationGuidance: context.proprioTaskCommunicationGuidance,
      proprioTaskMarkdown: context.proprioTaskMarkdown,
      proprioTaskMarkdownCompact: context.proprioTaskMarkdownCompact,
      proprioTaskMarkdownAssignment: context.proprioTaskMarkdownAssignment,
      proprioTaskMarkdownAssignmentCompact: context.proprioTaskMarkdownAssignmentCompact,
    });
    context.proprioIssue = redactedWakeContext.proprioIssue;
    if (redactedWakeContext.proprioCase) context.proprioCase = redactedWakeContext.proprioCase;
    context.proprioTaskCommunicationGuidance = redactedWakeContext.proprioTaskCommunicationGuidance;
    if (redactedWakeContext.proprioWakeComment) {
      context.proprioWakeComment =
        redactedWakeContext.proprioWakeComment;
    }
    if (redactedWakeContext.proprioTaskMarkdown) {
      context.proprioTaskMarkdown =
        redactedWakeContext.proprioTaskMarkdown;
    }
    if (redactedWakeContext.proprioTaskMarkdownCompact) {
      context.proprioTaskMarkdownCompact =
        redactedWakeContext.proprioTaskMarkdownCompact;
    }
    if (redactedWakeContext.proprioTaskMarkdownAssignment) {
      context.proprioTaskMarkdownAssignment =
        redactedWakeContext.proprioTaskMarkdownAssignment;
    }
    if (redactedWakeContext.proprioTaskMarkdownAssignmentCompact) {
      context.proprioTaskMarkdownAssignmentCompact =
        redactedWakeContext.proprioTaskMarkdownAssignmentCompact;
    }
  }
  if (issueRef) {
    const digest = (value: string | null | undefined) =>
      value?.trim()
        ? createHash("sha256")
            .update(value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""))
            .digest("hex")
        : null;
    const redactedIssue = parseObject(context.proprioIssue);
    context.proprioTurnContext = {
      version: 1,
      assignment: {
        owner: "task_markdown",
        description: {
          id: issueRef.id,
          revision: digest(readNonEmptyString(redactedIssue.description)),
        },
      },
      events: {
        owner: "wake_prompt",
        comments: safeWakeComments.map((comment) => ({
          id: comment.id,
          revision: digest(comment.body),
        })),
      },
    } satisfies ProprioTurnContext;
  } else {
    delete context.proprioTurnContext;
  }
  const pinnedSkillTest = pinnedSkillTestContext
    ? { key: pinnedSkillTestContext.skillKey, versionId: pinnedSkillTestContext.skillVersionId } : null;
  return { continuationSummary, executionContinuation, proprioWakePayload, safeWakeComments, safeWakeCommentContext, pinnedSkillTest };
}
