import { describe, expect, it } from "vitest";
import type { DependencyDiagnosis } from "@groktopus/shared";
import { dependencyDiagnosisForViewer } from "./issue-dependency-diagnosis-view.js";

const diagnosis: DependencyDiagnosis = {
  state: "no_execution_path",
  dependencyPath: [
    { issueId: "child", identifier: "TASK-2", title: "Child", status: "blocked" },
    { issueId: "grandchild", identifier: "TASK-3", title: "Grandchild", status: "blocked" },
  ],
  cause: { kind: "no_execution_path", issueId: "grandchild", recoveryActionId: "private-action" },
  nextOwner: { type: "agent", id: "agent", name: "Grandchild owner" },
  nextAction: "Check the task named Grandchild.",
  wake: { idempotencyKey: "opaque", status: "not_requested" },
  canInvestigate: true,
};

describe("dependency diagnosis visibility", () => {
  it("withholds the cause, owner details and path beyond an unreadable issue", () => {
    expect(dependencyDiagnosisForViewer(diagnosis, new Set(["grandchild"]), true)).toEqual({
      state: "no_execution_path",
      dependencyPath: [],
      cause: { kind: "restricted_dependency", issueId: null },
      nextOwner: { type: "agent" },
      nextAction: "Ask the task assignee to investigate the restricted dependency.",
      wake: diagnosis.wake,
      canInvestigate: true,
    });
  });

  it("shows authorized details while respecting task mutation permission", () => {
    expect(dependencyDiagnosisForViewer(diagnosis, new Set(["child", "grandchild"]), false)).toEqual({
      ...diagnosis,
      canInvestigate: false,
    });
  });
});
