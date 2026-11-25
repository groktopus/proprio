// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { NativeCompletionHistoryEntry } from "@groktopus/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeCompletionHistory } from "./NativeCompletionHistory";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("NativeCompletionHistory", () => {
  it("distinguishes policy claims from evidence checks and hides record identifiers", () => {
    const history: NativeCompletionHistoryEntry[] = [{
      id: "assessment-1",
      createdAt: "2026-05-01T12:00:00.000Z",
      runId: "run-1",
      contract: {
        id: "contract-1", revision: 2, policyVersion: "completion-policy-v2", risk: "medium",
        completionAuthority: "policy", incompleteCriteriaPolicy: "block",
        criteria: [{ id: "criterion-1", requirement: "All tests pass" }], supersedesContractId: "prior-contract",
      },
      result: {
        id: "result-1", disposition: "completed", summary: "The task is complete.",
        schemaStatus: "valid", createdAt: "2026-05-01T12:00:00.000Z",
      },
      assessment: {
        id: "assessment-1", policyVersion: "assessor-v3", triggerKind: "native_result",
        summary: "Requirements were assessed.", reportedDisposition: "completed",
        allCriteriaSatisfied: true, verificationPassed: false,
        criterionAssessments: [{
          criterionId: "criterion-1", claimStatus: "satisfied", outcome: "accepted", reasonCode: "claim_matches_policy",
          evidence: [{
            kind: "work_product", outcome: "accepted", visibility: "restricted", reasonCode: "outside_task_scope",
            label: "Supporting record is outside this task's readable scope.", recordId: "private-record-id",
          }],
        }],
        verificationAssessments: [{
          commandOrCheck: "pnpm test", claimStatus: "passed", outcome: "missing", reasonCode: "evidence_missing",
          reportedReasonCode: null,
          detail: "No test receipt was found.", evidence: {
            kind: "event", outcome: "accepted", visibility: "missing", reasonCode: "missing_event",
            label: "Supporting record is missing.",
          },
        }],
        priorDecisionId: "prior-decision", supersedesAssessmentId: "prior-assessment",
      },
      decision: {
        id: "decision-1", applicationState: "applied", fromStatus: "in_progress", toStatus: "done",
        reasonCode: "completion_policy_satisfied", statusAction: "complete", policyVersion: "assessor-v3",
        supersedesDecisionId: "prior-decision", createdAt: "2026-05-01T12:00:00.000Z", appliedAt: "2026-05-01T12:00:01.000Z",
      },
      lineageGaps: [],
    }];

    act(() => root.render(<NativeCompletionHistory entries={history} isLoading={false} error={false} onRetry={vi.fn()} />));

    expect(container.textContent).toContain("All tests pass");
    expect(container.textContent).toContain("Requirements revision 2");
    expect(container.textContent).toContain("Agent claim satisfied");
    expect(container.textContent).toContain("Policy assessment accepted");
    expect(container.textContent).toContain("Assessor policy assessor-v3");
    expect(container.textContent).toContain("Evidence verification failed");
    expect(container.textContent).toContain("No test receipt was found.");
    expect(container.textContent).toContain("Supersedes an earlier status decision.");
    expect(container.textContent).toContain("This policy replaces an earlier requirement set.");
    expect(container.textContent).not.toContain("private-record-id");
    expect(container.textContent).not.toContain("prior-decision");
    expect(container.querySelector("li > li")).toBeNull();
  });
});
