// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import type { Issue, IssueExecutionReviewEvidence, IssueThreadInteraction } from "@groktopus/shared";
import { ExecutionReviewEvidence, TaskExecutionReviewEvidence } from "./ExecutionReviewEvidence";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issue = {
  id: "issue-1",
  identifier: "PAP-1",
  executionPolicy: {
    requiredQualityReview: { version: 1 as const, deliverables: [{ key: "copy", label: "Copy" }] },
    reviewTargetBinding: { source: "required_quality_review" as const },
  },
} as Issue;

const evidence = {
  submittedSignoffStale: false,
  requiredQualityReviewState: { required: true, satisfied: false, missing: [{ key: "copy", label: "Copy", reason: "stale" as const }] },
  executionDecisions: [{ id: "decision-1", createdAt: new Date(), stageType: "review" as const, outcome: "approved" as const,
    reviewTargetBinding: { version: 1 as const, requirementHash: "previous-requirements", deliverables: [{ key: "copy", label: "Copy",
      target: { type: "issue_document" as const, key: "copy", revisionId: "revision-1" } }] } }],
} satisfies IssueExecutionReviewEvidence;

const interactions = [{ id: "interaction-1", kind: "request_confirmation", status: "accepted", issueId: "issue-1",
  payload: { qualityReview: { key: "copy", requirementHash: "current-requirements" }, target: { type: "issue_document", key: "copy", revisionId: "revision-2" } },
} as IssueThreadInteraction];

describe("ExecutionReviewEvidence", () => {
  it("keeps the submitted target visible after a newer artifact receives human quality approval", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const submittedBinding = evidence.executionDecisions[0]!.reviewTargetBinding;
    const activeIssue = { ...issue, executionState: { status: "pending", reviewTargetBinding: submittedBinding } } as Issue;
    const currentEvidence = {
      ...evidence,
      executionDecisions: [],
      requiredQualityReviewState: { required: true, satisfied: true, missing: [] },
      submittedSignoffStale: true,
    };
    act(() => root.render(<ExecutionReviewEvidence issue={activeIssue} evidence={currentEvidence} interactions={interactions} />));
    expect(container.textContent).toContain("Submitted for signoff");
    expect(container.textContent).toContain("Document copy · revision revision-1");
    expect(container.textContent).toContain("Requirements SHA-256 previous-requirements");
    expect(container.textContent).toContain("Request changes and submit the current outputs for a new review.");
    act(() => root.unmount());
  });

  it("loads historical evidence on demand and withholds it after access is denied", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const getEvidence = vi.spyOn(issuesApi, "executionReviewEvidence").mockResolvedValue(evidence);
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={client}>
          <TaskExecutionReviewEvidence issue={{ ...issue, executionPolicy: null }} />
        </QueryClientProvider>);
      });
      expect(getEvidence).not.toHaveBeenCalled();
      const disclosure = container.querySelector("details")!;
      await act(async () => {
        disclosure.open = true;
        disclosure.dispatchEvent(new Event("toggle"));
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(container.textContent).toContain("Requirements SHA-256 previous-requirements");
      });
      expect(getEvidence).toHaveBeenCalledWith(issue.id, expect.any(AbortSignal));

      getEvidence.mockRejectedValue(new ApiError("Forbidden", 403, null));
      await act(async () => {
        await client.invalidateQueries({ queryKey: queryKeys.issues.executionReviewEvidence(issue.id) });
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(container.textContent).not.toContain("previous-requirements");
        expect(client.getQueryData(queryKeys.issues.executionReviewEvidence(issue.id))).toMatchObject({ executionDecisions: [] });
      });
    } finally {
      act(() => root.unmount());
      getEvidence.mockRestore();
      client.clear();
    }
  });

  it("shows required artifact bindings, stale review recovery, and persisted decision targets", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<ExecutionReviewEvidence issue={issue} evidence={evidence} interactions={interactions} />));
    const summary = container.querySelector("details");
    if (summary) summary.open = true;

    expect(container.textContent).toContain("Document copy · revision revision-2");
    expect(container.textContent).toContain("Requirements SHA-256 current-requirements");
    expect(container.querySelector("a")?.getAttribute("href"))
      .toBe("/issues/PAP-1#interaction-interaction-1");
    expect(container.textContent).toContain("Document copy · revision revision-1");
    expect(container.textContent).toContain("Requirements SHA-256 previous-requirements");

    act(() => root.render(<ExecutionReviewEvidence issue={{ ...issue, executionPolicy: null }} evidence={evidence} interactions={interactions} />));
    expect(container.textContent).toContain("Requirements SHA-256 previous-requirements");
    expect(container.textContent).not.toContain("Requirements SHA-256 current-requirements");
    act(() => root.unmount());
  });
});
