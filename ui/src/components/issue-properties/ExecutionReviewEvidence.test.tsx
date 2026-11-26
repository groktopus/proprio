// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import type { Issue, IssueExecutionReviewEvidence, IssueExecutionReviewTargetBinding } from "@groktopus/shared";
import { ExecutionReviewEvidence, TaskExecutionReviewEvidence } from "./ExecutionReviewEvidence";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const issue = { id: "issue-1", identifier: "PAP-1", executionPolicy: null } as Issue;
const submittedBinding: IssueExecutionReviewTargetBinding = {
  version: 1, requirementHash: "previous-requirements",
  deliverables: [{ key: "copy", label: "Copy", target: { type: "issue_document", key: "copy", revisionId: "revision-1" } }],
};
const historicalEvidence: IssueExecutionReviewEvidence = {
  submittedSignoff: null,
  currentRequests: [],
  requiredQualityReviewState: { required: false, satisfied: true, missing: [] },
  executionDecisions: [{ id: "decision-1", stageType: "review", outcome: "approved", reviewTargetBinding: submittedBinding }],
  nextCursor: null,
};

describe("ExecutionReviewEvidence", () => {
  it("shows exactly what was submitted when a newer output already has quality approval", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const evidence: IssueExecutionReviewEvidence = {
      ...historicalEvidence,
      submittedSignoff: { stale: true, binding: submittedBinding },
      requiredQualityReviewState: { required: true, satisfied: true, missing: [] },
      currentRequests: [{ key: "copy", label: "Copy", interactionId: "request-2", outdated: false,
        requirementHash: "current-requirements", target: { type: "issue_document", key: "copy", revisionId: "revision-2" } }],
    };
    try {
      act(() => root.render(<ExecutionReviewEvidence issueHref="/issues/PAP-1" evidence={evidence} />));
      expect(container.textContent).toContain("Submitted for signoff");
      expect(container.textContent).toContain("Document copy · revision revision-1");
      expect(container.textContent).toContain("Requirements SHA-256 previous-requirements");
      expect(container.textContent).toContain("Document copy · revision revision-2");
      expect(container.querySelector("output")?.textContent).toContain("Request changes and submit the current outputs for a new review.");
      expect(container.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-1#interaction-request-2");

      act(() => root.render(<ExecutionReviewEvidence issueHref="/issues/PAP-1" evidence={{
        ...evidence, currentRequests: [{ ...evidence.currentRequests[0]!, outdated: true }],
      }} />));
      expect(container.querySelector("a")?.textContent?.trim()).toBe("Open previous review request");
    } finally {
      act(() => root.unmount());
    }
  });

  it("loads and pages historical decisions on demand, then clears them after access is denied", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const olderBinding = { ...submittedBinding, requirementHash: "oldest-requirements" };
    const getEvidence = vi.spyOn(issuesApi, "executionReviewEvidence").mockImplementation(async (_id, cursor) => cursor
      ? { ...historicalEvidence, executionDecisions: [{ id: "older", stageType: "approval", outcome: "approved", reviewTargetBinding: olderBinding }] }
      : { ...historicalEvidence, nextCursor: "decision-1" });
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={client}>
          <TaskExecutionReviewEvidence issue={issue} />
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
      expect(getEvidence).toHaveBeenCalledWith(issue.id, null, expect.any(AbortSignal));
      await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(container.textContent).toContain("Requirements SHA-256 oldest-requirements");
      });
      expect(getEvidence).toHaveBeenCalledWith(issue.id, "decision-1", expect.any(AbortSignal));

      getEvidence.mockRejectedValue(new ApiError("Forbidden", 403, null));
      const key = queryKeys.issues.executionReviewEvidence(issue.id, "decision-1");
      await act(async () => { await client.invalidateQueries({ queryKey: key }); });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(container.textContent).not.toContain("oldest-requirements");
        expect(client.getQueryData(key)).toMatchObject({ executionDecisions: [] });
      });
    } finally {
      act(() => root.unmount());
      getEvidence.mockRestore();
      client.clear();
    }
  });
});
