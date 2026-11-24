// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { Issue, IssueExecutionReviewEvidence, IssueThreadInteraction } from "@groktopus/shared";
import { ExecutionReviewEvidence } from "./ExecutionReviewEvidence";

const issue = {
  id: "issue-1",
  identifier: "PAP-1",
  executionPolicy: {
    requiredQualityReview: { version: 1 as const, deliverables: [{ key: "copy", label: "Copy" }] },
    reviewTargetBinding: { source: "required_quality_review" as const },
  },
} as Issue;

const evidence = {
  requiredQualityReviewState: { required: true, satisfied: false, missing: [{ key: "copy", label: "Copy", reason: "stale" as const }] },
  executionDecisions: [{ id: "decision-1", createdAt: new Date(), stageType: "review" as const, outcome: "approved" as const,
    reviewTargetBinding: { version: 1 as const, requirementHash: "previous-requirements", deliverables: [{ key: "copy", label: "Copy",
      target: { type: "issue_document" as const, key: "copy", revisionId: "revision-1" } }] } }],
} satisfies IssueExecutionReviewEvidence;

const interactions = [{ id: "interaction-1", kind: "request_confirmation", status: "accepted", issueId: "issue-1",
  payload: { qualityReview: { key: "copy", requirementHash: "current-requirements" }, target: { type: "issue_document", key: "copy", revisionId: "revision-2" } },
} as IssueThreadInteraction];

describe("ExecutionReviewEvidence", () => {
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
