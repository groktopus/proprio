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
    expect(container.textContent).toContain("Evidence not verified");
    expect(container.textContent).toContain("No test receipt was found.");
    expect(container.textContent).toContain("Supersedes an earlier status decision.");
    expect(container.textContent).toContain("This policy replaces an earlier requirement set.");
    expect(container.textContent).not.toContain("private-record-id");
    expect(container.textContent).not.toContain("prior-decision");
    expect(container.querySelector("li > li")).toBeNull();
  });

  it("matches assessments to requirements with one pass over the saved criteria", () => {
    const criterionCount = 120;
    let identifierReads = 0;
    const criteria = Array.from({ length: criterionCount }, (_, index) => ({
      id: `criterion-${index}`, requirement: `Requirement ${index}`,
    }));
    const criteriaAssessments = [...criteria].reverse().map(criterion => ({
      get criterionId() {
        identifierReads += 1;
        if (identifierReads > criterionCount) throw new Error("Repeatedly scanned completion assessments");
        return criterion.id;
      },
      claimStatus: "satisfied" as const,
      outcome: "accepted" as const,
      reasonCode: "criterion_evidence_accepted",
      evidence: [],
    }));
    const entry: NativeCompletionHistoryEntry = {
      id: "large-assessment", createdAt: "2026-05-01T12:00:00.000Z", runId: "run-1",
      contract: {
        id: "contract-1", revision: 1, policyVersion: "policy-v1", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
        criteria, supersedesContractId: null,
      },
      result: null, decision: null, lineageGaps: ["result", "decision"],
      assessment: {
        id: "large-assessment", policyVersion: "arbiter-v1", triggerKind: "native_result", summary: null,
        reportedDisposition: null, allCriteriaSatisfied: true, verificationPassed: null,
        criterionAssessments: criteriaAssessments, verificationAssessments: [], priorDecisionId: null,
        supersedesAssessmentId: null,
      },
    };

    act(() => root.render(<NativeCompletionHistory entries={[entry]} isLoading={false} error={false} onRetry={vi.fn()} />));

    expect(identifierReads).toBe(criterionCount);
    expect(container.querySelectorAll("section[aria-label='Completion policy'] li")).toHaveLength(criterionCount);
    expect(container.textContent).toContain("Requirement 119");
  });
});
