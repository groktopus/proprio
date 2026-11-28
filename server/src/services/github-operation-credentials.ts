import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { isUuidLike, type GitHubNativeEligibility, type GitHubNativeRequest } from "@groktopus/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  runIdentityContexts,
  type Db,
} from "@groktopus/db";
import { forbidden, HttpError } from "../errors.js";
import { captureRunCompletionIdentity, captureRunIdentity, type RunIdentityContext } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
  resolveManagedGitHubIdentitySelection,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";
import { authorizedRunGitHubRepository, githubNativeGitService, supportsNativeGitBackend } from "./github-native-git.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated";
  login?: string;
  reason?: string;
  repository?: string;
  connectionId?: string;
  grantId?: string;
  nativeGitGrantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};

type GitHubCredentialRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "nativeIssueId" | "issueId" | "runtimeMode" | "contextSnapshot" |
  "activeIdentityContextId" | "responsibleUserId">;

type GitHubCredentialRequest = { companyId: string; agentId: string; runId: string; expectedRepository?: string | null };

/** A raw GitHub token cannot enforce the low-trust read-only tool boundary. */
async function allowsGitHubCredentialExport(
  db: Db,
  run: GitHubCredentialRun,
) {
  const issueId =
    run.contextSnapshot?.issueId ??
    run.contextSnapshot?.taskId ??
    run.nativeIssueId;
  if (
    issueId !== undefined &&
    issueId !== null &&
    (typeof issueId !== "string" || !isUuidLike(issueId))
  )
    return false;
  const [agent] = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)),
    );
  if (!agent) return false;
  const [issue] =
    typeof issueId === "string"
      ? await db
          .select({
            companyId: issues.companyId,
            projectId: issues.projectId,
            executionPolicy: issues.executionPolicy,
            sourceTrust: issues.sourceTrust,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
      : [];
  if (issueId !== undefined && issueId !== null && !issue) return false;
  if (isLowTrustQuarantined(issue?.sourceTrust)) return false;
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" || !isUuidLike(projectId))
  )
    return false;
  const [project] =
    typeof projectId === "string"
      ? await db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.companyId, run.companyId),
            ),
          )
      : [];
  if (projectId !== undefined && projectId !== null && !project) return false;
  return (
    resolveCoreTrustPreset({
      companyId: run.companyId,
      agent,
      project,
      issue,
      run: {
        companyId: run.companyId,
        executionPolicy: run.contextSnapshot?.executionPolicy,
      },
    }).kind === "standard"
  );
}

async function saveGitHubSummary(
  db: Db,
  context: RunIdentityContext,
  summary: GitHubCredentialSummary,
) {
  if (isDeepStrictEqual(context.github, JSON.parse(JSON.stringify(summary)))) return;
  await db
    .update(runIdentityContexts)
    .set({ github: summary })
    .where(eq(runIdentityContexts.id, context.id));
}

/** Check an App grant without minting a credential or changing task authority. */
export async function githubNativeIntentEligibility(db: Db, input: {
  companyId: string; agentId: string; issueId: string; sourceRunId?: string | null;
  request: GitHubNativeRequest; lockAuthority?: boolean; requireLauncher?: boolean;
  identityContextId?: string | null; responsibleUserId?: string | null;
}): Promise<GitHubNativeEligibility> {
  if (!input.sourceRunId) return {
    status: "unavailable", code: "runtime_denied", reason: "Start a task run in Proprio Runner to request terminal Git.",
  };
  const [source] = await db.select({
    run: { id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId, runtimeMode: heartbeatRuns.runtimeMode,
      activeIdentityContextId: heartbeatRuns.activeIdentityContextId, responsibleUserId: heartbeatRuns.responsibleUserId,
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
        'issueId', ${heartbeatRuns.contextSnapshot}->'issueId', 'taskId', ${heartbeatRuns.contextSnapshot}->'taskId',
        'projectId', ${heartbeatRuns.contextSnapshot}->'projectId', 'executionPolicy', ${heartbeatRuns.contextSnapshot}->'executionPolicy')` },
    gitMode: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'githubAuthenticationMode'`,
    driverKind: heartbeatRuns.driverKind,
    identity: { status: runIdentityContexts.status, cause: runIdentityContexts.cause, responsibleUserId: runIdentityContexts.responsibleUserId },
  }).from(heartbeatRuns)
    .leftJoin(runIdentityContexts, and(eq(runIdentityContexts.id, heartbeatRuns.activeIdentityContextId),
      eq(runIdentityContexts.companyId, heartbeatRuns.companyId), eq(runIdentityContexts.runId, heartbeatRuns.id)))
    .where(and(eq(heartbeatRuns.id, input.sourceRunId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId)));
  const sourceTask = source?.run.nativeIssueId ?? source?.run.issueId
    ?? source?.run.contextSnapshot?.issueId ?? source?.run.contextSnapshot?.taskId;
  if (sourceTask !== input.issueId || source?.run.runtimeMode !== "native" || !supportsNativeGitBackend(source.driverKind)
    || !source.identity || source.identity.status !== "accepted"
    || (input.identityContextId && source.run.activeIdentityContextId !== input.identityContextId)
    || (input.responsibleUserId && source.identity.responsibleUserId !== input.responsibleUserId)
    || !await allowsGitHubCredentialExport(db, source.run)) {
    return { status: "unavailable", code: "runtime_denied",
      reason: "Terminal Git requires a standard-trust Proprio Runner execution." };
  }
  const repository = await authorizedRunGitHubRepository(db, source.run, {
    allowFinishedRun: true, lockWorkspace: input.lockAuthority,
  }).catch(error => {
    if (error instanceof HttpError && [403, 404].includes(error.status)) return null;
    throw error;
  });
  if (repository !== input.request.repository) return {
    status: "unavailable", code: "workspace_mismatch", reason: "The requested repository must match an accessible repository admitted for this task run.",
  };

  const managed = await resolveManagedGitHubIdentitySelection(db, input.companyId, {
    agentId: input.agentId, responsibleUserId: source.identity.cause === "company_default" ? null : source.identity.responsibleUserId,
    allowStandingDelegation: false,
  });
  if (managed.configured && !managed.mcpOnly) {
    if (managed.ambiguous) return {
      status: "unavailable", code: "ambiguous", reason: "More than one managed GitHub identity matches this run. Resolve the conflict in Connectors.",
    };
    if (!managed.grant) return {
      status: "unavailable", code: "managed_identity",
      reason: `${managed.error ?? "No eligible managed GitHub identity is available"}. Review managed GitHub access in Connectors.`,
    };
    if (!managed.grant.providerTenant?.github?.repositories?.some(repo => repo.fullName.toLowerCase() === input.request.repository)) {
      return { status: "unavailable", code: "managed_repository_denied",
        reason: "The selected managed GitHub identity has no verified access to this repository. Review its repository access in Connectors." };
    }
    return { status: "unavailable", code: "managed_identity",
      reason: "The run selects an existing managed identity. Verify this action for that identity in Connectors before using terminal Git." };
  }

  const eligible = await githubNativeGitService(db).eligibility(input.companyId, input.agentId, repository, input.request.operation, input.lockAuthority);
  if (eligible.status === "available" && input.requireLauncher && source.gitMode !== "managed") {
    return { status: "unavailable", code: "fresh_turn_required", reason: "The GitHub App is ready. Continue in a fresh task turn to load terminal Git access." };
  }
  return eligible;
}

/** Ambient credentials are never consulted by this path. */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: GitHubCredentialRequest,
) {
  return resolveActiveGitHubCredentials(db, input);
}

/** Only workspace preparation supplies this server-selected source. */
export async function resolveGitHubProjectCheckoutCredentials(
  db: Db, input: GitHubCredentialRequest & { projectCheckoutSourceId: string; expectedRepository: string },
) {
  return resolveActiveGitHubCredentials(db, input, input.projectCheckoutSourceId);
}

async function resolveActiveGitHubCredentials(db: Db, input: GitHubCredentialRequest, projectCheckoutSourceId?: string) {
  const { run, context } = await captureRunIdentity(db, input, { readScope: "github_credentials" });
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  return resolveCapturedGitHubCredentials(db, run, context, {
    expectedRepository: input.expectedRepository, projectCheckoutSourceId,
  });
}

export async function resolveGitHubCompletionCredentials(
  db: Db,
  input: { companyId: string; issueId: string; runId: string },
) {
  const [source] = await db.select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.nativeIssueId, input.issueId))).limit(1);
  if (!source) throw forbidden("GitHub completion requires the bound task run");
  const { run, context } = await captureRunCompletionIdentity(db, { ...input, agentId: source.agentId });
  if (!run.activeIdentityContextId && !context) return { status: "absent" as const, env: {} as Record<string, string> };
  if (!context || context.companyId !== run.companyId || context.status !== "accepted") {
    throw forbidden("GitHub completion requires the run's accepted identity");
  }
  return resolveCapturedGitHubCredentials(db, run, context, { verifyPullRequest: true });
}

async function resolveCapturedGitHubCredentials(db: Db, run: GitHubCredentialRun, context: RunIdentityContext,
  options: { expectedRepository?: string | null; projectCheckoutSourceId?: string; verifyPullRequest?: boolean }) {
  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  if (!(await allowsGitHubCredentialExport(db, run))) {
    summary = {
      status: "unavailable",
      reason:
        "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
    };
    await saveGitHubSummary(db, context, summary);
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      env,
    };
  }
  try {
    const resolved = await resolveManagedGitHubCredential(
      db,
      secretService(db),
      run.companyId,
      {
        agentId: run.agentId,
        heartbeatRunId: run.id,
        allowStandingDelegation: false,
        responsibleUserId:
          context?.cause === "company_default"
            ? null
            : (context?.responsibleUserId ?? null),
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
    if (resolved.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else if ((!resolved.configured || resolved.mcpOnly)
      && await githubNativeGitService(db).hasBinding(run.companyId, run.agentId)) {
      const currentRepository = () => authorizedRunGitHubRepository(db, run, {
        projectCheckoutSourceId: options.projectCheckoutSourceId, allowFinishedRun: options.verifyPullRequest,
      });
      const repository = await currentRepository();
      const scoped = githubNativeGitService(db);
      const eligibility = repository
        ? await scoped.eligibility(run.companyId, run.agentId,
          options.expectedRepository === undefined || options.expectedRepository === repository ? repository : null, "read")
        : { status: "unavailable" as const, reason: "GitHub App credentials require access to the run's authorized repository." };
      if (eligibility.status === "available") {
        const issued = await scoped.issueToken(run.companyId, run.agentId, repository, {
          mode: options.projectCheckoutSourceId ? "checkout" : options.verifyPullRequest ? "verify_pull_request" : "terminal",
          reauthorize: async () => {
            if (await currentRepository() !== repository || !await allowsGitHubCredentialExport(db, run)) {
              throw forbidden("Access to the task repository changed during credential issuance.");
            }
          },
        });
        summary = { status: "available", source: "dedicated", login: `${issued.grant.appSlug}[bot]`,
          nativeGitGrantId: issued.grant.id, repository: issued.grant.repository, authenticationMode: "managed" };
        env = buildGitAuthInvocation({ token: issued.token, source: "managed_connection", secretName: null }).env;
      } else {
        summary = { status: "unavailable", source: "dedicated", reason: eligibility.reason };
      }
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  }
  if (context) await saveGitHubSummary(db, context, summary);
  return {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
  };
}
