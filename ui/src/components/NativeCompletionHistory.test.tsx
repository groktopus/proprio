// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { NativeCompletionHistoryEntry } from "@groktopus/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityApi } from "@/api/activity";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { NativeCompletionHistory, TaskCompletionHistoryDisclosure } from "./NativeCompletionHistory";

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

    const earlier: NativeCompletionHistoryEntry = { ...history[0]!, id: "prior-assessment",
      assessment: { ...history[0]!.assessment!, id: "prior-assessment",
        priorDecisionId: null, supersedesAssessmentId: null },
      decision: { ...history[0]!.decision!, id: "prior-decision", supersedesDecisionId: null },
      contract: { ...history[0]!.contract!, revision: 1, supersedesContractId: null },
    };
    act(() => root.render(<NativeCompletionHistory entries={[...history, earlier]} isLoading={false} error={false} onRetry={vi.fn()} />));
    const related = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Open earlier decision and assessment");
    expect(related).toBeDefined();
    act(() => related!.click());
    expect(document.activeElement).toBe(container.querySelectorAll("article")[1]);

    const separateAssessment: NativeCompletionHistoryEntry = {
      ...earlier, id: "separate-assessment", assessment: { ...earlier.assessment!, id: "separate-assessment" }, decision: null,
    };
    const latest: NativeCompletionHistoryEntry = {
      ...history[0]!, assessment: { ...history[0]!.assessment!, supersedesAssessmentId: "separate-assessment" },
    };
    act(() => root.render(<NativeCompletionHistory entries={[latest, earlier, separateAssessment]} isLoading={false} error={false} onRetry={vi.fn()} />));
    const decisions = Array.from(container.querySelectorAll("button"));
    const priorDecision = decisions.find(button => button.textContent === "Open earlier decision and evidence");
    const priorAssessment = decisions.find(button => button.textContent === "Open earlier assessment");
    expect(priorDecision).toBeDefined();
    expect(priorAssessment).toBeDefined();
    const before = window.location.href;
    act(() => priorDecision!.click());
    expect(document.activeElement).toBe(container.querySelectorAll("article")[1]);
    act(() => priorAssessment!.click());
    expect(document.activeElement).toBe(container.querySelectorAll("article")[2]);
    expect(window.location.href).toBe(before);
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

  it("links a long decision history with one pass over the saved decisions", () => {
    const entryCount = 180;
    let decisionIdsRead = 0;
    const entries: NativeCompletionHistoryEntry[] = Array.from({ length: entryCount }, (_, index) => ({
      id: `assessment-${index}`, runId: `run-${index}`, createdAt: "2026-05-01T12:00:00.000Z",
      contract: null, result: null, assessment: null, lineageGaps: [],
      decision: {
        get id() {
          decisionIdsRead += 1;
          if (decisionIdsRead > entryCount) throw new Error("Repeatedly scanned earlier completion decisions");
          return `decision-${index}`;
        },
        applicationState: "proposed", fromStatus: "in_progress", toStatus: "done",
        reasonCode: "completion_evidence_incomplete", statusAction: null, policyVersion: "arbiter-v1",
        supersedesDecisionId: index + 1 < entryCount ? `decision-${index + 1}` : null,
        createdAt: "2026-05-01T12:00:00.000Z", appliedAt: null,
      },
    }));

    act(() => root.render(<NativeCompletionHistory entries={entries} isLoading={false} error={false} onRetry={vi.fn()} />));

    expect(decisionIdsRead).toBe(entryCount);
    expect(container.querySelectorAll("article button")).toHaveLength(entryCount - 1);
  });

  it("loads default Task Properties history on disclosure and hides it after access is denied", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const history = vi.spyOn(activityApi, "completionHistoryForIssue").mockResolvedValue([{
      id: "saved-assessment", runId: "saved-run", createdAt: "2026-05-01T12:00:00.000Z",
      result: {
        id: "result", disposition: "done", summary: "Private verification detail",
        schemaStatus: "accepted", createdAt: "2026-05-01T12:00:00.000Z",
      },
      contract: null, assessment: null, decision: null, lineageGaps: [],
    }]);
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={client}><TaskCompletionHistoryDisclosure issueId="task-1" /></QueryClientProvider>);
      });
      expect(history).not.toHaveBeenCalled();
      await act(async () => {
        const details = container.querySelector("details")!;
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      });
      await act(async () => {
        await client.refetchQueries({ queryKey: queryKeys.issues.completionHistory("task-1") });
      });
      expect(history).toHaveBeenCalledWith("task-1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(container.textContent).toContain("Private verification detail");

      history.mockRejectedValue(new ApiError("Forbidden", 403, null));
      await act(async () => {
        await client.invalidateQueries({ queryKey: queryKeys.issues.activity("task-1") });
      });

      await vi.waitFor(async () => {
        await act(async () => {});
        expect(container.textContent).toContain("Completion history could not be loaded.");
        expect(container.textContent).not.toContain("Private verification detail");
      });
      expect(client.getQueryData(queryKeys.issues.completionHistory("task-1"))).toEqual([]);
      history.mockRejectedValue(new ApiError("Service unavailable", 503, null));
      await act(async () => {
        await client.invalidateQueries({ queryKey: queryKeys.issues.activity("task-1") });
      });
      expect(container.textContent).not.toContain("Private verification detail");
    } finally {
      history.mockRestore();
      client.clear();
    }
  });

  it("waits for a fresh authorized read when reopening a cached disclosure", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const readHistory = vi.spyOn(activityApi, "completionHistoryForIssue").mockImplementation(() => new Promise(() => {}));
    client.setQueryData(queryKeys.issues.completionHistory("task-1"), [{
      id: "old-assessment", createdAt: "2026-05-01T12:00:00.000Z", runId: "old-run",
      result: { summary: "Previously readable evidence" },
      contract: null, assessment: null, decision: null, lineageGaps: [],
    }]);
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={client}><TaskCompletionHistoryDisclosure issueId="task-1" /></QueryClientProvider>);
      });
      await act(async () => {
        const details = container.querySelector("details")!;
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      });
      expect(readHistory).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Loading completion history");
      expect(container.textContent).not.toContain("Previously readable evidence");
    } finally {
      readHistory.mockRestore();
      client.clear();
    }
  });
});
