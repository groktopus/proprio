// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act as reactAct, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseHandoffView, IssueCaseLink } from "@/api/cases";
import { IssueCasesPanel } from "./IssueCasesPanel";

function act(callback: () => void) {
  flushSync(callback);
}

const mockCasesApi = vi.hoisted(() => ({ listForIssue: vi.fn(), listHandoffs: vi.fn() }));
const mockInstanceApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));

vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceApi }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (...segments: string[]) =>
    `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await reactAct(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    flushSync(() => {});
  });
}

const links: IssueCaseLink[] = [
  {
    id: "l1",
    role: "work",
    createdAt: "2026-07-07T00:00:00.000Z",
    case: { id: "c1", identifier: "PAP-C7", title: "Launch post", caseType: "blog_post", status: "in_review",
      workIssueId: "issue-1", phase: "implementation" },
  },
  {
    id: "l2",
    role: "reference",
    createdAt: "2026-07-07T00:00:00.000Z",
    case: { id: "c2", identifier: "PAP-C8", title: "Unrelated reference", caseType: "blog_post", status: "in_progress", workIssueId: "another-issue" },
  },
];

const task = { id: "issue-1", identifier: "PAP-1", title: "Review launch", status: "in_progress" };

const decidedHandoff: CaseHandoffView = {
  workflowTransition: null,
  id: "handoff-1", companyId: "company-1", caseId: "c1", issueId: "issue-1", version: 2,
  fromAgentId: null, destinationKind: "agent", toAgentId: null, phase: "verification",
  instructions: "Review the saved requirements.", commentId: null, actorType: "user", actorId: "board-user",
  sourceRunId: null, responsibleUserId: null, expectedIssueStatusVersion: 1, appliedIssueStatusVersion: 2,
  wakeupRequestId: "wake-1", idempotencyKey: "handoff-key", inputFingerprint: "fingerprint",
  offerContract: {
    schema: "proprio.case-handoff-offer.v1", expectedDeliverable: "A verified launch post",
    prerequisites: ["Check the published source"],
    requirementRevision: { id: "requirement-revision-2", revision: 2, canonicalSha256: "sha256:revision" },
    requirementsDigest: "sha256:requirements", workflowTransition: null,
    decisionOwner: { type: "agent", id: "recipient-agent" }, accountableOwner: { type: "agent", id: "source-agent" },
  },
  recipientDecision: { outcome: "accepted", actorType: "agent", actorId: "recipient-agent", handoffVersion: 2,
    requirementRevisionId: "requirement-revision-2", requirementsDigest: "sha256:requirements",
    decidedAt: "2026-07-08T10:00:00.000Z", reasonCode: "requirements_accepted" },
  state: "delivered", attemptCount: 1, nextAttemptAt: "2026-07-08T10:00:00.000Z", leaseExpiresAt: null,
  lastErrorCode: null, lastError: null, createdAt: "2026-07-08T09:00:00.000Z",
  assignmentAppliedAt: "2026-07-08T09:30:00.000Z", deliveredAt: "2026-07-08T10:00:00.000Z",
  completedAt: null, cancelledAt: null, updatedAt: "2026-07-08T10:00:00.000Z",
  fromAgentName: "Source agent", toAgentName: "Recipient agent",
};

describe("IssueCasesPanel", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCasesApi.listForIssue.mockReset();
    mockCasesApi.listHandoffs.mockReset();
    mockInstanceApi.getExperimental.mockReset();
  });
  afterEach(() => container.remove());

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueCasesPanel task={task} />
        </QueryClientProvider>,
      );
    });
    await flush();
    return root;
  }

  it("renders nothing when the Cases flag is off", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableCases: false });
    mockCasesApi.listForIssue.mockResolvedValue(links);
    const root = await render();
    expect(container.textContent).toBe("");
    expect(mockCasesApi.listForIssue).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("renders linked cases with role + status when enabled", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableCases: true });
    mockCasesApi.listForIssue.mockResolvedValue(links);
    const root = await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Cases");
    expect(text).toContain("PAP-C7");
    expect(text).toContain("Launch post");
    expect(text).toContain("work");
    expect(text).toContain("in review");
    expect(container.querySelector('a[href="/PAP/cases/PAP-C7"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("loads versioned decisions only when the primary Case disclosure opens", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableCases: true });
    mockCasesApi.listForIssue.mockResolvedValue(links);
    mockCasesApi.listHandoffs.mockResolvedValue({ items: [decidedHandoff], nextCursor: null });
    const root = await render();

    expect(mockCasesApi.listForIssue).toHaveBeenCalledWith(task.id);
    expect(container.querySelector('a[href="/PAP/cases/PAP-C7"]')).not.toBeNull();
    expect(container.querySelector('a[href="/PAP/cases/PAP-C8"]')).not.toBeNull();
    const disclosures = [...container.querySelectorAll("summary")];
    expect(disclosures.map(summary => summary.textContent?.trim())).toEqual(["Show handoff decisions"]);
    expect(container.querySelector('[aria-label="Case handoffs"]')).toBeNull();
    expect(mockCasesApi.listHandoffs).not.toHaveBeenCalled();

    act(() => disclosures[0]!.click());
    await flush();
    expect(mockCasesApi.listHandoffs).toHaveBeenCalledWith("c1", null);
    const history = container.querySelector('[aria-label="Case handoffs"]');
    expect(history?.textContent).toContain("Expected deliverable: A verified launch post");
    expect(history?.textContent).toContain("Requirement revision 2");
    expect(history?.textContent).toContain("Accepted · Requirements Accepted");
    expect(history?.querySelector('a[href="/issues/PAP-1"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("renders nothing when enabled but no cases are linked", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableCases: true });
    mockCasesApi.listForIssue.mockResolvedValue([]);
    const root = await render();
    expect(container.textContent).toBe("");
    act(() => root.unmount());
  });
});
