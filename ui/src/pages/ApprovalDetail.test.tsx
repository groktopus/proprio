// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ApprovalDetail } from "./ApprovalDetail";

const getApprovalMock = vi.hoisted(() => vi.fn());
const listCommentsMock = vi.hoisted(() => vi.fn());
const listIssuesMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/approvals", () => ({
  approvalsApi: {
    get: getApprovalMock,
    listComments: listCommentsMock,
    listIssues: listIssuesMock,
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
    resubmit: vi.fn(),
    addComment: vi.fn(),
  },
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]), remove: vi.fn() } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const approval = {
  id: "approval-1",
  companyId: "company-1",
  type: "request_board_approval",
  status: "pending",
  payload: { title: "Review this request", summary: "Needs a decision" },
  requestedByAgentId: null,
  decisionNote: null,
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
};

describe("ApprovalDetail read states", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getApprovalMock.mockResolvedValue(approval);
    listCommentsMock.mockResolvedValue([{ id: "comment-1", body: "Prior discussion", authorAgentId: null, createdAt: approval.createdAt }]);
    listIssuesMock.mockResolvedValue([{ id: "issue-1", identifier: "PAP-1", title: "Follow up", status: "todo" }]);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("keeps decision controls and identifies failed context sections", async () => {
    listCommentsMock.mockRejectedValueOnce(new ApiError("Unavailable", 503, null));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(<QueryClientProvider client={client}><ApprovalDetail /></QueryClientProvider>);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Review this request");
    expect(container.textContent).toContain("Comments unavailable");
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).toContain("Approve");
    expect(container.textContent).toContain("Follow up");
    await act(async () => root.unmount());
  });

  it("shows a retryable page state when the approval read fails", async () => {
    getApprovalMock.mockRejectedValueOnce(new ApiError("Unavailable", 503, null));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(<QueryClientProvider client={client}><ApprovalDetail /></QueryClientProvider>);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Connection interrupted");
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).not.toContain("Approval not found.");
    await act(async () => root.unmount());
  });
});
