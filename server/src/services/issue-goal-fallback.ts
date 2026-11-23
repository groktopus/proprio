type MaybeId = string | null | undefined;

export type IssueGoalOrigin = "explicit" | "inherited" | "unknown";

export function resolveIssueGoalBinding(input: {
  projectId: MaybeId;
  goalId: MaybeId;
  goalOrigin?: IssueGoalOrigin;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): { goalId: string | null; goalOrigin: IssueGoalOrigin } {
  return {
    goalId: resolveIssueGoalId(input),
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
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
  currentGoalOrigin?: IssueGoalOrigin;
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
    return {
      goalId: input.goalId ?? resolveFallbackGoalId(projectId, projectGoalId),
      goalOrigin: input.goalId ? "explicit" : "inherited",
    };
  }

  if (input.currentGoalOrigin === "explicit") {
    return { goalId: input.currentGoalId ?? null, goalOrigin: "explicit" };
  }

  if (input.currentGoalOrigin === "inherited") {
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
