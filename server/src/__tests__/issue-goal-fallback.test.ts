import { describe, expect, it } from "vitest";
import {
  resolveIssueGoalBinding,
  resolveIssueGoalId,
  resolveNextIssueGoalId,
} from "../services/issue-goal-fallback.ts";

describe("issue goal fallback", () => {
  it("assigns the company goal when creating an issue without project or goal", () => {
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-1");
  });

  it("keeps an explicit goal when creating an issue", () => {
    expect(
      resolveIssueGoalId({
        projectId: null,
        goalId: "goal-2",
        projectGoalId: "goal-3",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-2");
  });

  it("inherits the project goal when creating a project-linked issue", () => {
    expect(
      resolveIssueGoalId({
        projectId: "project-1",
        goalId: null,
        projectGoalId: "goal-2",
        defaultGoalId: "goal-1",
      }),
    ).toBe("goal-2");
  });

  it("does not force a company goal when the project has no goal", () => {
    expect(
      resolveIssueGoalId({
        projectId: "project-1",
        goalId: null,
        projectGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toBeNull();
  });

  it("backfills the company goal on update for legacy no-project issues", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: null,
        currentProjectGoalId: null,
        defaultGoalId: "goal-1",
      }),
    ).toEqual({ goalId: "goal-1", goalOrigin: "unknown" });
  });

  it("switches from the company fallback to the project goal when a project is added later", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: null,
        currentGoalId: "goal-1",
        currentProjectGoalId: null,
        projectId: "project-1",
        goalId: null,
        projectGoalId: "goal-2",
        defaultGoalId: "goal-1",
      }),
    ).toEqual({ goalId: "goal-2", goalOrigin: "inherited" });
  });

  it("backfills the project goal for legacy project-linked issues on update", () => {
    expect(
      resolveNextIssueGoalId({
        currentProjectId: "project-1",
        currentGoalId: null,
        currentProjectGoalId: "goal-2",
        defaultGoalId: "goal-1",
      }),
    ).toEqual({ goalId: "goal-2", goalOrigin: "unknown" });
  });

  it("preserves an explicit goal across project fallback changes", () => {
    expect(resolveNextIssueGoalId({
        currentProjectId: "project-1",
        currentGoalId: "goal-explicit",
        currentProjectGoalId: "goal-2",
        projectId: "project-2",
        projectGoalId: "goal-3",
        defaultGoalId: "goal-1",
        currentGoalOrigin: "explicit",
      }),
    ).toEqual({ goalId: "goal-explicit", goalOrigin: "explicit" });
  });

  it("preserves an explicit selection even when it matched the old project default", () => {
    expect(resolveNextIssueGoalId({
      currentProjectId: "project-a",
      currentGoalId: "goal-a",
      currentProjectGoalId: "goal-a",
      projectId: "project-b",
      projectGoalId: "goal-b",
      defaultGoalId: "company-goal",
      currentGoalOrigin: "explicit",
    })).toEqual({ goalId: "goal-a", goalOrigin: "explicit" });
  });

  it("moves inherited selections to the destination project's default", () => {
    expect(resolveNextIssueGoalId({
      currentProjectId: "project-a",
      currentGoalId: "goal-a",
      currentProjectGoalId: "goal-a",
      projectId: "project-b",
      projectGoalId: "goal-b",
      defaultGoalId: "company-goal",
      currentGoalOrigin: "inherited",
    })).toEqual({ goalId: "goal-b", goalOrigin: "inherited" });
  });

  it("records explicit selections and treats a cleared goal as inherited", () => {
    expect(resolveIssueGoalBinding({
      projectId: "project-a",
      goalId: "goal-a",
      projectGoalId: "goal-a",
      defaultGoalId: "company-goal",
    })).toEqual({ goalId: "goal-a", goalOrigin: "explicit" });
    expect(resolveNextIssueGoalId({
      currentProjectId: "project-a",
      currentGoalId: "goal-a",
      currentProjectGoalId: "goal-a",
      projectId: "project-a",
      projectGoalId: "goal-a",
      goalId: null,
      defaultGoalId: "company-goal",
      currentGoalOrigin: "explicit",
    })).toEqual({ goalId: "goal-a", goalOrigin: "inherited" });
  });

  it("retains the legacy fallback heuristic when origin is unknown", () => {
    expect(resolveNextIssueGoalId({
      currentProjectId: "project-a",
      currentGoalId: "goal-a",
      currentProjectGoalId: "goal-a",
      projectId: "project-b",
      projectGoalId: "goal-b",
      defaultGoalId: "company-goal",
      currentGoalOrigin: "unknown",
    })).toEqual({ goalId: "goal-b", goalOrigin: "unknown" });
    expect(resolveNextIssueGoalId({
      currentProjectId: "project-a",
      currentGoalId: "goal-c",
      currentProjectGoalId: "goal-a",
      projectId: "project-b",
      projectGoalId: "goal-b",
      defaultGoalId: "company-goal",
      currentGoalOrigin: "unknown",
    })).toEqual({ goalId: "goal-c", goalOrigin: "unknown" });
  });
});
