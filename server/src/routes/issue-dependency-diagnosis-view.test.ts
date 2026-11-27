import { describe, expect, it } from "vitest";
import type { ParentDependencyDiagnosis } from "../services/recovery/parent-dependency-diagnosis.js";
import { dependencyDiagnosisForViewer } from "./issue-dependency-diagnosis-view.js";

const diagnosis: ParentDependencyDiagnosis = {
  state: "no_execution_path",
  dependencyPath: [
    { issueId: "child", identifier: "TASK-2", title: "Child", status: "blocked" },
    { issueId: "grandchild", identifier: "TASK-3", title: "Grandchild", status: "blocked" },
  ],
  cause: { kind: "no_execution_path", issueId: "grandchild", recoveryActionId: "private-action" },
  nextOwner: { type: "agent", id: "agent", name: "Grandchild owner" },
  nextAction: "Check the task named Grandchild.",
  wake: { idempotencyKey: "opaque", status: "not_requested", wakeupRequestId: "private-wake" },
  canInvestigate: true,
};

describe("dependency diagnosis visibility", () => {
  it("withholds the cause, owner details and path beyond an unreadable issue", () => {
    expect(dependencyDiagnosisForViewer(diagnosis, new Set(["grandchild"]), true)).toEqual({
      state: "restricted",
      dependencyPath: [],
      cause: { kind: "restricted_dependency", issueId: null },
      nextOwner: { type: "board" },
      nextAction: "Ask a board member with access to check the dependency.",
      wake: { status: "not_requested" },
      canInvestigate: false,
    });
  });

  it("shows authorized details while respecting task mutation permission", () => {
    expect(dependencyDiagnosisForViewer(diagnosis, new Set(["child", "grandchild"]), false)).toEqual({
      ...diagnosis,
      cause: { kind: diagnosis.cause.kind, issueId: diagnosis.cause.issueId },
      nextOwner: { type: "agent", name: "Grandchild owner" },
      wake: { status: "not_requested" },
      canInvestigate: false,
    });
    expect(dependencyDiagnosisForViewer(diagnosis, new Set(["child", "grandchild"]), true).wake)
      .toEqual({ status: "not_requested", idempotencyKey: "opaque" });
  });
});
