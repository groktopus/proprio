// @vitest-environment jsdom

import type { AnchorHTMLAttributes } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DependencyDiagnosis } from "@groktopus/shared";
import { queryKeys } from "@/lib/queryKeys";
import { DependencyDiagnosisNotice } from "./DependencyDiagnosisNotice";

const requestDependencyInvestigation = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({ issuesApi: { requestDependencyInvestigation } }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diagnosis: DependencyDiagnosis = {
  state: "active",
  dependencyPath: [
    { issueId: "child-id", identifier: "CHA-8", title: "Ship the migration", status: "blocked" },
  ],
  cause: { kind: "retry_exhausted", issueId: "child-id" },
  nextOwner: { type: "board", name: "The board" },
  nextAction: "Ask the parent assignee to investigate.",
  wake: { idempotencyKey: "stable-wake-key", status: "not_requested" },
  canInvestigate: true,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

async function render(currentDiagnosis: DependencyDiagnosis | null, canRequest = true, diagnosisError: string | null = null, onRetryDiagnosis?: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <DependencyDiagnosisNotice issueId="parent-id" diagnosis={currentDiagnosis} canRequest={canRequest}
          diagnosisError={diagnosisError} onRetryDiagnosis={onRetryDiagnosis} />
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("DependencyDiagnosisNotice", () => {
  it("shows the dependency cause, path, next action, and parent wake state", async () => {
    const node = await render(diagnosis);
    const notice = node.querySelector("[data-testid='dependency-diagnosis-notice']")!;

    expect(notice.textContent).toContain("Dependency in progress");
    expect(notice.textContent).toContain("Cause: Retry Exhausted — CHA-8: Ship the migration");
    expect(notice.querySelector("a")?.getAttribute("href")).toContain("CHA-8");
    expect(notice.textContent).toContain("Next: The board");
    expect(notice.textContent).toContain("Ask the parent assignee to investigate.");
    expect(notice.textContent).toContain("No diagnostic wake has been requested.");
    expect(notice.querySelector("button")?.textContent).toContain("Ask assignee to investigate");
  });

  it("uses the authorized blocker task’s display status", async () => {
    const node = await render(diagnosis);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <DependencyDiagnosisNotice issueId="parent-id" canRequest
            diagnosis={{ ...diagnosis, dependencyPath: [{ ...diagnosis.dependencyPath[0]!, status: "in_progress" }] }}
            blockerSummaries={[{ id: "child-id", title: "Ship the migration", identifier: "CHA-8",
              status: "in_progress", displayStatus: "monitoring", priority: "medium", assigneeAgentId: null, assigneeUserId: null }]} />
        </QueryClientProvider>,
      );
    });
    expect(node.querySelector("[aria-label='Dependency path']")?.textContent).toContain("(Monitoring)");
  });

  it("reuses the server's idempotency key after a lost response and invalidates parent detail on acceptance", async () => {
    requestDependencyInvestigation.mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ accepted: true, message: "Accepted" });
    const node = await render(diagnosis);
    client.setQueryData(queryKeys.issues.detail("parent-id"), { id: "parent-id" });
    const button = node.querySelector<HTMLButtonElement>("button")!;

    await act(async () => { button.click(); });
    const retry = await vi.waitFor(() => {
      const button = [...node.querySelectorAll("button")].find(item => item.textContent === "Try again");
      expect(button).toBeDefined();
      return button!;
    });
    expect(node.textContent).toContain("If the response was lost, retrying will use the same request.");
    await act(async () => { retry.click(); });

    expect(requestDependencyInvestigation).toHaveBeenNthCalledWith(1, "parent-id", { idempotencyKey: "stable-wake-key" });
    expect(requestDependencyInvestigation).toHaveBeenNthCalledWith(2, "parent-id", { idempotencyKey: "stable-wake-key" });
    await vi.waitFor(() => expect(node.textContent).toContain("Request accepted."));
    expect(client.getQueryState(queryKeys.issues.detail("parent-id"))?.isInvalidated).toBe(true);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <DependencyDiagnosisNotice issueId="parent-id" canRequest diagnosis={{
            ...diagnosis, wake: { ...diagnosis.wake, status: "running" },
          }} />
        </QueryClientProvider>,
      );
    });
    expect(node.textContent).toContain("The parent assignee is investigating.");
    expect(node.textContent).not.toContain("Request accepted.");
  });

  it("shows an admission refusal and retains its server explanation", async () => {
    requestDependencyInvestigation.mockResolvedValue({ accepted: false, message: "The task was reassigned." });
    const node = await render(diagnosis);
    await act(async () => { node.querySelector("button")!.click(); });

    await vi.waitFor(() => expect(node.querySelector("[role='alert']")?.textContent).toBe("The task was reassigned."));
  });

  it("keeps a stale request refusal visible after the current diagnosis changes or clears", async () => {
    requestDependencyInvestigation.mockResolvedValue({ accepted: false, message: "The task was reassigned." });
    const node = await render(diagnosis);
    await act(async () => { node.querySelector("button")!.click(); });
    for (const current of [{ ...diagnosis, wake: { ...diagnosis.wake, idempotencyKey: "different-key" } }, null]) {
      await act(async () => {
        root!.render(
          <QueryClientProvider client={client}>
            <DependencyDiagnosisNotice issueId="parent-id" diagnosis={current} canRequest />
          </QueryClientProvider>,
        );
      });
      expect(node.querySelector("[role='alert']")?.textContent).toBe("The task was reassigned.");
    }
  });

  it.each([
    [{ ...diagnosis, canInvestigate: false }, true],
    [diagnosis, false],
  ] as const)("keeps the explanation visible without offering an unauthorized action", async (currentDiagnosis, canRequest) => {
    const node = await render(currentDiagnosis, canRequest);
    expect(node.textContent).toContain("Ask the parent assignee to investigate.");
    expect(node.querySelector("button")).toBeNull();
  });

  it("renders nothing when no diagnosis is available", async () => {
    const node = await render(null);
    expect(node.querySelector("[data-testid='dependency-diagnosis-notice']")).toBeNull();
  });

  it("shows a retryable read error when the diagnosis query fails", async () => {
    const onRetry = vi.fn();
    const node = await render(null, true, "offline", onRetry);
    expect(node.querySelector("[role='alert']")?.textContent).toContain("Could not load dependency diagnosis: offline");
    await act(async () => { node.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each([
    ["exhausted", "The parent wake has exhausted its attempts."],
    ["completed", "The parent diagnostic turn completed."],
  ] as const)("explains a %s parent wake after the task detail reloads", async (status, expected) => {
    const node = await render({ ...diagnosis, wake: { ...diagnosis.wake, status } });
    expect(node.querySelector("[data-testid='dependency-parent-wake-state']")?.textContent).toBe(expected);
  });
});
