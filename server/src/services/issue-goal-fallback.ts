import type { IssueGoalOrigin } from "@groktopus/shared";
export type { IssueGoalOrigin } from "@groktopus/shared";

type MaybeId = string | null | undefined;

export function effectiveIssueGoalOrigin(input: {
  goalId: MaybeId;
  goalOrigin: IssueGoalOrigin;
  goalOriginGoalId?: MaybeId;
}): IssueGoalOrigin {
  return input.goalOriginGoalId === undefined || input.goalOriginGoalId === input.goalId
    ? input.goalOrigin
    : "unknown";
}

export function resolveIssueGoalBinding(input: {
  projectId: MaybeId;
  goalId: MaybeId;
  goalOrigin?: IssueGoalOrigin;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): { goalId: string | null; goalOrigin: IssueGoalOrigin } {
  const inherited = input.goalOrigin === "inherited";
  return {
    goalId: resolveIssueGoalId({ ...input, goalId: inherited ? null : input.goalId }),
    goalOrigin: input.goalOrigin ?? (input.goalId ? "explicit" : "inherited"),
  };
}

export function resolveIssueGoalId(input: {
  projectId: MaybeId;
  goalId: MaybeId;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  if (input.goalId) return input.goalId;
  if (input.projectId) return input.projectGoalId ?? null;
  return input.defaultGoalId ?? null;
}

export function resolveNextIssueGoalId(input: {
  currentProjectId: MaybeId;
  currentGoalId: MaybeId;
  currentProjectGoalId?: MaybeId;
  projectId?: MaybeId;
  goalId?: MaybeId;
  goalOrigin?: IssueGoalOrigin;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
  currentGoalOrigin?: IssueGoalOrigin;
  currentGoalOriginGoalId?: MaybeId;
}): { goalId: string | null; goalOrigin: IssueGoalOrigin } {
  const projectId =
    input.projectId !== undefined ? input.projectId : input.currentProjectId;
  const projectGoalId =
    input.projectGoalId !== undefined
      ? input.projectGoalId
      : projectId
        ? input.currentProjectGoalId
        : null;

  const resolveFallbackGoalId = (targetProjectId: MaybeId, targetProjectGoalId: MaybeId) => {
    if (targetProjectId) return targetProjectGoalId ?? null;
    return input.defaultGoalId ?? null;
  };

  if (input.goalId !== undefined) {
    const goalOrigin = input.goalOrigin ?? (input.goalId ? "explicit" : "inherited");
    return resolveIssueGoalBinding({
      projectId,
      goalId: input.goalId,
      goalOrigin,
      projectGoalId,
      defaultGoalId: input.defaultGoalId,
    });
  }

  const currentGoalOrigin = effectiveIssueGoalOrigin({
    goalId: input.currentGoalId,
    goalOrigin: input.currentGoalOrigin ?? "unknown",
    goalOriginGoalId: input.currentGoalOriginGoalId,
  });

  if (currentGoalOrigin === "explicit") {
    return { goalId: input.currentGoalId ?? null, goalOrigin: "explicit" };
  }

  if (currentGoalOrigin === "inherited") {
    return { goalId: resolveFallbackGoalId(projectId, projectGoalId), goalOrigin: "inherited" };
  }

  const currentFallbackGoalId = resolveFallbackGoalId(
    input.currentProjectId,
    input.currentProjectGoalId,
  );
  const nextFallbackGoalId = resolveFallbackGoalId(projectId, projectGoalId);

  if (!input.currentGoalId) {
    return { goalId: nextFallbackGoalId, goalOrigin: "unknown" };
  }

  if (input.currentGoalId === currentFallbackGoalId) {
    return { goalId: nextFallbackGoalId, goalOrigin: "unknown" };
  }

  return { goalId: input.currentGoalId, goalOrigin: "unknown" };
}
