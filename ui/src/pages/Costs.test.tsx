// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";
import { ApiError } from "../api/client";
import { CostByUserTable } from "../components/CostByUserTable";
import { queryKeys } from "@/lib/queryKeys";
import { MemoryRouter } from "react-router-dom";

function budgetInput(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find(candidate => candidate.textContent === labelText);
  if (!label || !(label.control instanceof HTMLInputElement)) throw new Error(`Missing input for ${labelText}`);
  return label.control;
}

function typeAmount(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function typeRootSearch(input: HTMLInputElement, value: string) {
  await act(async () => typeAmount(input, value));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 275)); });
}

const scopedAgentMock = vi.hoisted(() => vi.fn());
vi.mock("../api/agents", () => ({ agentsApi: { get: scopedAgentMock } }));

const resolveIncidentMock = vi.hoisted(() => vi.fn());
const upsertPolicyMock = vi.hoisted(() => vi.fn());
const boardAccessMock = vi.hoisted(() => vi.fn());
const budgetOverviewMock = vi.hoisted(() => vi.fn());
const issueListMock = vi.hoisted(() => vi.fn());
const issueSummariesMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const decisionHistoryMock = vi.hoisted(() => vi.fn());
const costsApiMocks = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byUser: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
  dataQuality: vi.fn(),
  retryAccounting: vi.fn(),
}));
const subscriptionsMocks = vi.hoisted(() => ({ report: vi.fn(), refresh: vi.fn(), update: vi.fn(), link: vi.fn() }));
vi.mock("../api/subscriptions", () => ({ subscriptionsApi: subscriptionsMocks }));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetOverviewMock(...args),
    upsertPolicy: upsertPolicyMock,
    resolveIncident: resolveIncidentMock,
  },
}));
vi.mock("../api/issues", () => ({ issuesApi: {
  list: (...args: unknown[]) => issueListMock(...args),
  summaries: (...args: unknown[]) => issueSummariesMock(...args),
} }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: (...args: unknown[]) => boardAccessMock(...args) } }));

vi.mock("../api/costs", () => ({ costsApi: costsApiMocks }));
vi.mock("../api/decision-models", () => ({ decisionModelsApi: { history: decisionHistoryMock } }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const surfaces = [
  ["streamlined", { embedded: true, hideBudgetsTab: true }],
  ["standalone", {}],
] as const;

describe("Shared Costs surfaces", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    scopedAgentMock.mockReset();
    issueListMock.mockReset();
    issueSummariesMock.mockReset().mockResolvedValue([]);
    boardAccessMock.mockResolvedValue({ userId: "operator", companyIds: ["company-1"], memberships: [{ companyId: "company-1", status: "active", membershipRole: "operator" }], source: "session", isInstanceAdmin: false });
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: "0", eventCount: 0, estimatedEventCount: 0, unpricedEventCount: 0 };
    subscriptionsMocks.report.mockResolvedValue({ canRefresh: false, asOf: "2026-10-08T00:00:00Z", accounts: [], monthlyTotals: [], activeCount: 0, unknownPriceCount: 0, unidentifiedAccountCount: 0, api: usage, subscription: usage, unknown: usage, unattributedSubscription: usage });
    decisionHistoryMock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    budgetOverviewMock.mockReset();
    budgetOverviewMock.mockResolvedValue({
      policies: [],
      activeIncidents: [],
      pendingApprovalCount: 0,
      pausedAgentCount: 0,
      pausedProjectCount: 0,
    });
  });

  it("shows readable task-tree policies with task links and hides mutations from viewers", async () => {
    const summary = {
      policyId: "tree-policy", companyId: "company-1", scopeType: "task_tree", scopeId: "root-task", scopeName: "Root task", metric: "billed_cents", windowKind: "lifetime",
      amount: 500, warnPercent: 65, hardStopEnabled: true, notifyEnabled: true, isActive: true, unpricedUsagePolicy: "block", reservationCents: "0.0000000",
      observedAmount: 0, remainingAmount: 500, utilizationPercent: 0, unpricedEventCount: 0, pendingRunCount: 0, status: "ok", paused: false, pauseReason: null,
    };
    budgetOverviewMock.mockResolvedValue({ policies: [summary], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/PRO/activity/budgets"]}><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Task budgets")); });
    expect(container.textContent).toContain("shared by the root task and its descendants");
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('a[href="/PRO/issues/root-task"]')).toBeTruthy()); });
    expect(container.querySelector('a[href="/PRO/issues/root-task"]')?.textContent).toContain("Root task");
    expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Update budget")).toBe(true);
    queryClient.clear();
    await act(async () => root.unmount());

    boardAccessMock.mockResolvedValue({ userId: "viewer", companyIds: ["company-1"], memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }], source: "session", isInstanceAdmin: false });
    const viewerClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={viewerClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Task budgets")); });
    expect(container.textContent).toContain("shared by the root task and its descendants");
    expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Update budget")).toBe(false);
    expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Set task budget")?.disabled).toBe(true);
    viewerClient.clear();
  });

  it("creates a lifetime policy for the explicitly selected root and amount", async () => {
    issueListMock.mockResolvedValue([{ id: "root-id", identifier: "PRO-10", title: "Prepare release" }]);
    upsertPolicyMock.mockResolvedValue({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Task budgets")); });
    await act(async () => { await vi.waitFor(() => expect(budgetInput(container, "Root task").disabled).toBe(false)); });
    const search = budgetInput(container, "Root task");
    await typeRootSearch(search, "Prepare");
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Prepare release")); });
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Prepare release"))!.click());
    const amount = budgetInput(container, "Lifetime limit (USD)");
    const create = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Set task budget")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(amount, "0.001");
      amount.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(create.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(amount, "25.50");
      amount.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Set task budget")!.click());
    await act(async () => { await vi.waitFor(() => expect(upsertPolicyMock).toHaveBeenCalledWith("company-1", {
      scopeType: "task_tree", scopeId: "root-id", windowKind: "lifetime", amount: 2550, createOnly: true,
    })); });
    expect(amount.value).toBe("");
    expect(create.disabled).toBe(true);
    queryClient.clear();
  });

  it("clears a selected root when a fresh search denies its access", async () => {
    issueListMock.mockResolvedValueOnce([{ id: "root-id", identifier: "PRO-10", title: "Private release plan" }]).mockResolvedValue([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Task budgets")); });
    await act(async () => { await vi.waitFor(() => expect(budgetInput(container, "Root task").disabled).toBe(false)); });
    const search = budgetInput(container, "Root task");
    await typeRootSearch(search, "Private");
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Private release plan")); });
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Private release plan"))!.click());
    expect(document.activeElement).toBe(budgetInput(container, "Lifetime limit (USD)"));
    const searchKey = queryKeys.issues.search("company-1", "Private", undefined, 20, "task-budget-roots");
    await act(async () => queryClient.resetQueries({ queryKey: searchKey }));
    expect(queryClient.getQueryData(searchKey)).toEqual({ pages: [[]], pageParams: [0] });
    await act(async () => { await vi.waitFor(() => expect(container.textContent).not.toContain("Private release plan")); });
    expect([...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Set task budget")?.disabled).toBe(true);
    queryClient.clear();
  });

  it("retires older in-flight budget reads and task searches during access changes", async () => {
    const empty = { policies: [], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 };
    let finishPriorSearch!: (rows: unknown[]) => void;
    issueListMock.mockImplementationOnce(() => new Promise(resolve => { finishPriorSearch = resolve; })).mockResolvedValue([]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(budgetInput(container, "Root task").disabled).toBe(false)); });
    await typeRootSearch(budgetInput(container, "Root task"), "release");
    await act(async () => { await vi.waitFor(() => expect(issueListMock).toHaveBeenCalledOnce()); });

    let finishPriorOverview!: (overview: unknown) => void;
    budgetOverviewMock.mockImplementationOnce(() => new Promise(resolve => { finishPriorOverview = resolve; })).mockResolvedValue(empty);
    const overviewKey = queryKeys.budgets.overview("company-1");
    const searchKey = queryKeys.issues.search("company-1", "release", undefined, 20, "task-budget-roots");
    await act(async () => { void queryClient.refetchQueries({ queryKey: overviewKey }); });
    await act(async () => { await vi.waitFor(() => expect(budgetOverviewMock).toHaveBeenCalledTimes(2)); });
    const priorOverviewSignal: AbortSignal = budgetOverviewMock.mock.calls[1]![1].signal;
    const priorSearchSignal: AbortSignal = issueListMock.mock.calls[0]![2].signal;
    await act(async () => {
      await Promise.all([
        queryClient.resetQueries({ queryKey: overviewKey }),
        queryClient.resetQueries({ queryKey: searchKey }),
      ]);
    });
    expect(priorOverviewSignal.aborted).toBe(true);
    expect(priorSearchSignal.aborted).toBe(true);
    expect(issueListMock.mock.calls[1]![2]).toMatchObject({ fresh: true, cache: "no-store" });
    await act(async () => {
      finishPriorSearch([{ id: "old-root", title: "Private release title" }]);
      finishPriorOverview({ ...empty, policies: [{ scopeType: "task_tree", scopeId: "old-root", scopeName: "Private release title" }] });
    });
    expect(queryClient.getQueryData(overviewKey)).toEqual(empty);
    expect(queryClient.getQueryData(searchKey)).toEqual({ pages: [[]], pageParams: [0] });
    expect(container.textContent).not.toContain("Private release title");
    queryClient.clear();
  });

  it("finds an eligible root beyond budgeted matches and reveals a competing lifetime policy", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `root-${index}`, identifier: `PRO-${index}`, title: `Budgeted release task ${index}`,
    }));
    const rootTask = { id: "monthly-root", identifier: "PRO-21", title: "Release with a monthly limit" };
    const policies = [...firstPage, rootTask].map(task => ({
      policyId: `policy-${task.id}`, companyId: "company-1", scopeType: "task_tree",
      scopeId: task.id, scopeName: task.title, metric: "billed_cents",
      windowKind: task.id === rootTask.id ? "calendar_month_utc" : "lifetime",
      amount: 500, warnPercent: 80, reservationCents: "0.0000000", observedAmount: 0, remainingAmount: 500,
      utilizationPercent: 0, unpricedEventCount: 0, pendingRunCount: 0, status: "ok", paused: false,
    }));
    const existing = { policies, activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 };
    issueListMock.mockImplementation((_companyId, filters) => Promise.resolve(filters.offset === 0 ? firstPage : [rootTask]));
    issueSummariesMock.mockResolvedValue([rootTask]);
    budgetOverviewMock.mockResolvedValue(existing);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(budgetInput(container, "Root task").disabled).toBe(false)); });
    const search = budgetInput(container, "Root task");
    await act(async () => { typeAmount(search, "re"); typeAmount(search, "relea"); });
    await typeRootSearch(search, "Release");
    expect(issueListMock).toHaveBeenCalledTimes(1);
    expect(issueListMock.mock.calls[0]?.[1]).toMatchObject({ q: "Release", offset: 0 });
    const more = () => [...container.querySelectorAll("button")].find(button => button.textContent === "More task results");
    await act(async () => { await vi.waitFor(() => expect(more()).toBeTruthy()); });
    await act(async () => more()!.click());
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Release with a monthly limit")); });
    const getChoice = () => [...container.querySelectorAll("button")].find(button => button.textContent?.includes(rootTask.title))!;
    await act(async () => getChoice().click());
    const amount = budgetInput(container, "Lifetime limit (USD)");
    expect(document.activeElement).toBe(amount);
    await act(async () => typeAmount(amount, "20.00"));

    let finishBudgetRefresh!: (data: unknown) => void;
    budgetOverviewMock.mockImplementationOnce(() => new Promise(resolve => { finishBudgetRefresh = resolve; }));
    const searchKey = queryKeys.issues.search("company-1", "Release", undefined, 20, "task-budget-roots");
    const overviewKey = queryKeys.budgets.overview("company-1");
    await act(async () => { void queryClient.resetQueries({ queryKey: overviewKey }); });
    await act(async () => queryClient.resetQueries({ queryKey: searchKey }));
    expect(budgetInput(container, "Lifetime limit (USD)")).toBe(amount);
    expect(amount.value).toBe("20.00");
    const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Set task budget")!;
    expect(queryClient.getQueryData(overviewKey)).toBeUndefined();
    await act(async () => { await vi.waitFor(() => expect(save.disabled).toBe(true)); });
    await act(async () => finishBudgetRefresh(existing));
    await act(async () => { await vi.waitFor(() => expect(save.disabled).toBe(false)); });
    expect(issueSummariesMock).toHaveBeenCalledWith("company-1", [rootTask.id], expect.objectContaining({ signal: expect.anything() }));

    const competingPolicy = { ...policies.at(-1)!, policyId: "winning-policy", windowKind: "lifetime", amount: 2500 };
    upsertPolicyMock.mockImplementationOnce(() => {
      budgetOverviewMock.mockResolvedValue({ ...existing, policies: [...policies, competingPolicy] });
      return Promise.reject(new ApiError("A budget policy already exists", 409, { code: "budget_policy_exists" }));
    });
    await act(async () => save.click());
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("This task already has a lifetime budget")); });
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Page 2 of 2")); });
    expect(container.textContent).toContain("$25.00");
    expect(upsertPolicyMock).toHaveBeenCalledWith("company-1", {
      scopeType: "task_tree", scopeId: rootTask.id, windowKind: "lifetime", amount: 2000, createOnly: true,
    });
    queryClient.clear();
  });

  it("keeps the task budget grid bounded with a large company policy set", async () => {
    const policies = Array.from({ length: 96 }, (_, index) => ({
      policyId: `policy-${index}`, companyId: "company-1", scopeType: "task_tree",
      scopeId: `root-${index}`, scopeName: `Release root ${index}`, metric: "billed_cents", windowKind: "lifetime",
      amount: 500, warnPercent: 80, reservationCents: "0.0000000", observedAmount: 0, remainingAmount: 500,
      utilizationPercent: 0, unpricedEventCount: 0, pendingRunCount: 0, status: "ok", paused: false,
    }));
    budgetOverviewMock.mockResolvedValue({ policies, activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    const taskLinks = () => [...container.querySelectorAll<HTMLAnchorElement>("a")].filter(link => link.textContent?.startsWith("Open root task:"));
    await act(async () => { await vi.waitFor(() => expect(taskLinks()).toHaveLength(12)); });
    expect(taskLinks()[0]!.textContent).toContain("Release root 0");
    const policyAmount = budgetInput(container, "Budget (USD)");
    const update = [...container.querySelectorAll("button")].find(button => button.textContent === "Update budget")!;
    await act(async () => typeAmount(policyAmount, "10.005"));
    expect(update.disabled).toBe(true);
    expect(policyAmount.getAttribute("aria-invalid")).toBe("true");
    await act(async () => typeAmount(policyAmount, "0.00"));
    expect(update.disabled).toBe(false);
    const next = [...container.querySelectorAll("button")].find(button => button.textContent === "Next budgets")!;
    await act(async () => next.click());
    expect(taskLinks()).toHaveLength(12);
    expect(taskLinks()[0]!.textContent).toContain("Release root 12");
    expect(container.textContent).toContain("Page 2 of 8");
    queryClient.clear();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it.each(["overview", "budgets"] as const)("explains unavailable Muse accounting on its scoped %s page", async (tab) => {
    scopedAgentMock.mockResolvedValue({ id: "muse-agent", name: "Researcher", adapterType: "proprio_runner", adapterConfig: { provider: "muse" } });
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={["/?agentId=muse-agent"]}><QueryClientProvider client={queryClient}><Costs embedded initialTab={tab} lockTab /></QueryClientProvider></MemoryRouter>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Researcher's Muse activity has no reported usage or cost")); });
    expect(scopedAgentMock).toHaveBeenCalledWith("muse-agent", "company-1");
    expect(container.textContent).toContain("Totals below show recorded organization charges only");
    expect(container.textContent).toContain("Proprio cannot enforce a Muse spend ceiling");
    queryClient.clear();
  });

  it("explains when scoped provider details cannot be loaded", async () => {
    scopedAgentMock.mockRejectedValue(new Error("unavailable"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={["/?agentId=muse-agent"]}><QueryClientProvider client={queryClient}><Costs embedded initialTab="budgets" lockTab /></QueryClientProvider></MemoryRouter>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Could not load agent details. Totals below show recorded organization costs.")); });
    expect(container.textContent).not.toContain("Muse activity has no reported");
    queryClient.clear();
  });

  it.each([0, 125])("shows $%s of known user spend while retaining an unpriced warning", async (costCents) => {
    root = createRoot(container);
    await act(async () => root.render(<CostByUserTable report={{ activeUserCount: 1, rows: [{
      userId: null, userName: null, userImage: null, runCount: 1, eventCount: 1, estimatedEventCount: 0, unpricedEventCount: 1,
      costCents, costCentsExact: `${costCents}.0000000`, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2,
    }] }} />));
    expect(container.querySelector("tbody tr td:last-child")?.textContent).toContain(costCents > 0 ? "$1.25" : "—");
    expect(container.textContent).toContain("1 unpriced charge");
  });

  it.each(surfaces)("labels other and unknown billing accurately on the %s surface", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 600, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const report = await subscriptionsMocks.report();
    subscriptionsMocks.report.mockResolvedValue({ ...report, unknown: { ...report.unknown,
      inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, costCents: "600", eventCount: 3,
    } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain(
      "Other billing usage: 150 tokens · $6.00 in recorded charges, included in the inference ledger.",
    )));
    expect(container.textContent).not.toContain("tokens have an unknown billing type");
  });

  it("renders a focused Budgets section without duplicate Costs chrome or spend queries", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(budgetOverviewMock).toHaveBeenCalledWith("company-1", { signal: expect.anything() });
        expect(container.textContent).toContain("Budget control plane");
      });
    });
    expect(container.textContent).not.toContain("Inference spend");
    expect(container.querySelector('[role="tab"]')).toBeFalsy();
    expect(setBreadcrumbsMock).not.toHaveBeenCalled();
    for (const mock of Object.values(costsApiMocks)) expect(mock).not.toHaveBeenCalled();
  });

  it.each(surfaces)("shows unknown billing separately from complete prices only on the %s Overview", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 21, budgetCents: 0, pricingComplete: true, unknownBillingEventCount: 1, unpricedEventCount: 0, pendingRunCount: 0 });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    costsApiMocks.dataQuality.mockResolvedValue({ canRetry: true, events: [{ id: "event", runId: "run", agentId: "agent", agentName: "Codie", reason: "unknown_billing", occurredAt: "2026-10-09T12:00:00Z" }], runs: [], hasMoreEvents: false, hasMoreRuns: false });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("1 billing type unknown")));
    expect(container.textContent).not.toContain("Totals include known charges only.");
    expect(costsApiMocks.dataQuality).not.toHaveBeenCalled();
    const button = (label: string) => [...container.querySelectorAll("button")].find(row => row.textContent === label)!;
    await act(async () => button("1 billing type unknown").click());
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Billing category unknown")));
    const [, from, to] = costsApiMocks.dataQuality.mock.lastCall!;
    expect(Number.isFinite(Date.parse(from))).toBe(true);
    expect(Number.isFinite(Date.parse(to))).toBe(true);
    await act(async () => button("Providers").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Providers");
    expect(container.textContent).not.toContain("1 billing type unknown");
    expect(container.textContent).not.toContain("Billing category unknown");
    await act(async () => button("Overview").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    expect(button("1 billing type unknown")).toBeDefined();
    await act(async () => button("All Time").click());
    await act(async () => vi.waitFor(() => expect(button("1 billing type unknown")).toBeDefined()));
    await act(async () => button("1 billing type unknown").click());
    await act(async () => vi.waitFor(() => expect(costsApiMocks.dataQuality).toHaveBeenLastCalledWith("company-1", undefined, undefined)));
    queryClient.clear();
  });

  it("opens linked decision history with real date bounds instead of report cache labels", async () => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={["/?tab=decisions"]}><QueryClientProvider client={queryClient}><Costs /></QueryClientProvider></MemoryRouter>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("No decision requests in this period")); });
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Decisions");
    const [companyId, from, to] = decisionHistoryMock.mock.lastCall!;
    expect(companyId).toBe("company-1");
    expect(Number.isFinite(Date.parse(from))).toBe(true);
    expect(Number.isFinite(Date.parse(to))).toBe(true);
    queryClient.clear();
  });

  it.each([
    ["reservation", 500, "agent"], ["unknown price", 500, "agent"], ["amount", 500, "agent"],
    ["amount", 0, "company"], ["amount", 0, "agent"], ["amount", 0, "project"],
  ] as const)("preserves other settings when editing %s from %s on a %s budget", async (field, previousAmount, scopeType) => {
    const summary = {
      policyId: "policy", companyId: "company-1", scopeType, scopeId: "agent", scopeName: "Worker", metric: "billed_cents", windowKind: "lifetime",
      amount: previousAmount, warnPercent: 65, hardStopEnabled: false, notifyEnabled: false, isActive: false, unpricedUsagePolicy: "allow", reservationCents: "2.0000000",
      observedAmount: 0, remainingAmount: 500, utilizationPercent: 0, unpricedEventCount: 0, pendingRunCount: 0, status: "ok", paused: false, pauseReason: null,
    };
    budgetOverviewMock.mockResolvedValue({ policies: [summary], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    upsertPolicyMock.mockResolvedValue({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('[aria-label="Reserve per run (USD)"]')).not.toBeNull()); });
    const advanced = container.querySelector("details")!;
    expect(advanced.open).toBe(false);
    if (field !== "amount") await act(async () => advanced.querySelector("summary")!.click());
    if (field === "unknown price") await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    else {
      const element = field === "reservation" ? container.querySelector<HTMLInputElement>('[aria-label="Reserve per run (USD)"]')! : container.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not([aria-label])')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "1");
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const label = field === "reservation" ? "Update reservation" : previousAmount === 0 ? "Set budget" : "Update budget";
      await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === label)!.click());
    }
    await act(async () => { await vi.waitFor(() => expect(upsertPolicyMock).toHaveBeenCalled()); });
    expect(upsertPolicyMock).toHaveBeenCalledWith("company-1", {
      scopeType: summary.scopeType, scopeId: summary.scopeId, metric: summary.metric, windowKind: summary.windowKind,
      ...(field === "amount" ? { amount: 100 } : field === "unknown price" ? { unpricedUsagePolicy: "block" } : { reservationCents: "100.0000000" }),
    });
    queryClient.clear();
  });

  it("shows a safe policy-save failure without losing the operator's settings", async () => {
    const policy = {
      policyId: "policy", companyId: "company-1", scopeType: "agent", scopeId: "agent", scopeName: "Worker", metric: "billed_cents", windowKind: "lifetime",
      amount: 500, warnPercent: 65, hardStopEnabled: false, notifyEnabled: false, isActive: false, unpricedUsagePolicy: "allow", reservationCents: "2.0000000",
      observedAmount: 0, remainingAmount: 500, utilizationPercent: 0, unpricedEventCount: 0, pendingRunCount: 0, status: "ok", paused: false, pauseReason: null,
    };
    budgetOverviewMock.mockResolvedValue({ policies: [policy], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0 });
    upsertPolicyMock.mockRejectedValueOnce(new Error("private SQL policy error"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()); });
    const reservation = container.querySelector<HTMLInputElement>('[aria-label="Reserve per run (USD)"]')!;
    const originalReservation = reservation.value;
    await act(async () => container.querySelector("details summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not update the budget policy")); });
    expect(container.textContent).toContain("Worker");
    expect(container.textContent).not.toContain("private SQL");
    expect(reservation.value).toBe(originalReservation);
    queryClient.clear();
  });

  it.each(surfaces)("shows failed budget actions on the %s Overview", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 200, budgetCents: 1000, pricingComplete: false });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    budgetOverviewMock.mockResolvedValue({ policies: [], activeIncidents: [{ id: "incident", companyId: "company-1", scopeType: "agent", scopeName: "Codie", status: "open", thresholdType: "hard", amountObserved: 200, amountLimit: 1000 }], pausedAgentCount: 1, pausedProjectCount: 0 });
    resolveIncidentMock.mockRejectedValue(new Error("private database error"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Raise budget & resume")); });
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Raise budget & resume")!.click());
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not update the budget")); });
    expect(resolveIncidentMock).toHaveBeenCalledWith("company-1", "incident", { action: "raise_budget_and_resume", amount: 1200 });
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Overview");
    expect(container.textContent).toContain("Check any pending runs or unpriced usage shown on this page");
    expect(container.textContent).not.toContain("private database error");
    queryClient.clear();
  });

  it("retries failed account discovery without discarding the last subscription report", async () => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const report = await subscriptionsMocks.report();
    subscriptionsMocks.report.mockResolvedValue({ ...report, canRefresh: true, activeCount: 1, monthlyTotals: [{ currency: "USD", amountCents: "2000", estimatedCount: 1 }] });
    subscriptionsMocks.refresh.mockRejectedValueOnce(new Error("private connection error")).mockResolvedValue({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs /></QueryClientProvider></MemoryRouter>));
    const retry = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry account check");
    await act(async () => { await vi.waitFor(() => expect(retry()).toBeDefined()); });
    expect(container.textContent).toContain("$20.00/month");
    expect(container.textContent).not.toContain("private connection error");
    await act(async () => retry()!.click());
    await act(async () => { await vi.waitFor(() => expect(retry()).toBeUndefined()); });
    expect(subscriptionsMocks.refresh).toHaveBeenCalledTimes(2);
    expect(subscriptionsMocks.refresh).toHaveBeenLastCalledWith("company-1");
    expect(container.textContent).toContain("$20.00/month");
    queryClient.clear();
  });

  it("keeps monthly subscription fees through date changes and failed background reloads", async () => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 200, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const report = await subscriptionsMocks.report();
    subscriptionsMocks.report.mockResolvedValue({ ...report, activeCount: 1, monthlyTotals: [{ currency: "USD", amountCents: "2000", estimatedCount: 1 }], api: { ...report.api, costCents: "200" } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs /></QueryClientProvider></MemoryRouter>));
    const card = (label: string) => [...container.querySelectorAll("div")].find(node => node.textContent === label)?.closest('[data-slot="card"]');
    await act(async () => { await vi.waitFor(() => expect(card("Subscriptions")?.textContent).toContain("$20.00/month")); });
    expect(card("API spend")?.textContent).toContain("$2.00");
    subscriptionsMocks.report.mockResolvedValue({ ...report, activeCount: 1, monthlyTotals: [{ currency: "USD", amountCents: "2000", estimatedCount: 1 }], api: { ...report.api, costCents: "300" } });
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "All Time")!.click());
    await act(async () => { await vi.waitFor(() => expect(card("API spend")?.textContent).toContain("$3.00")); });
    expect(card("Subscriptions")?.textContent).toContain("$20.00/month");
    expect(subscriptionsMocks.report).toHaveBeenLastCalledWith("company-1", undefined, undefined);
    subscriptionsMocks.report.mockRejectedValue(new Error("private provider failure"));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["cost-subscriptions"] }); });
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Showing the last loaded API and subscription usage")); });
    expect(card("API spend")?.textContent).toContain("$3.00");
    expect(card("Subscriptions")?.textContent).toContain("$20.00/month");
    expect(container.textContent).not.toContain("private provider failure");
    queryClient.clear();
  });

  it("compares monthly budgets only with month-to-date spend", async () => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 200, budgetCents: 1000, utilizationPercent: 20, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs /></QueryClientProvider></MemoryRouter>));
    const budgetCard = () => [...container.querySelectorAll("div")].find(node => node.textContent === "Budget")?.closest('[data-slot="card"]');
    await act(async () => { await vi.waitFor(() => expect(budgetCard()?.textContent).toContain("20%")); });
    expect(budgetCard()?.textContent).toContain("$2.00 of $10.00 this month");
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12000, budgetCents: 1000, utilizationPercent: 1200, pricingComplete: true });
    const subscriptionReport = await subscriptionsMocks.report();
    subscriptionsMocks.report.mockResolvedValue({ ...subscriptionReport, api: { ...subscriptionReport.api, costCents: "12000" } });
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "All Time")!.click());
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("$120.00")); });
    expect(budgetCard()?.textContent).toContain("$10.00");
    expect(budgetCard()?.textContent).toContain("Monthly limit");
    expect(container.textContent).not.toContain("1200%");
    expect(container.textContent).not.toContain("of monthly budget consumed");
    expect(costsApiMocks.summary).toHaveBeenLastCalledWith("company-1", undefined, undefined);
    queryClient.clear();
  });

  it.each(surfaces)("uses the displayed company cap for provider warnings on the %s page", async (_name, props) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T00:30:00Z"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
      costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
      costsApiMocks.summary.mockResolvedValue({ spendCents: 800, budgetCents: 1000, pricingComplete: true });
      const row = { model: "test", billingType: "metered_api", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
        apiRunCount: 1, subscriptionRunCount: 0, subscriptionInputTokens: 0, subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0 };
      costsApiMocks.byProvider.mockResolvedValue([
        { ...row, provider: "openai", biller: "openai", costCents: 100 },
        { ...row, provider: "google", biller: "google", costCents: 700 },
      ]);
      root = createRoot(container);
      await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} initialTab="providers" /></QueryClientProvider></MemoryRouter>));
      await act(async () => { await vi.waitFor(() => expect(container.querySelectorAll('[aria-label^="Period spend:"]')).toHaveLength(2)); });
      const bar = (percent: number) => container.querySelector(`[aria-label="Period spend: ${percent}%"]`)!.parentElement!;
      expect(bar(10).querySelector(".bg-destructive")).toBeNull();
      expect(bar(70).querySelector(".bg-destructive")).not.toBeNull();
      expect(container.textContent).toContain("10% of company budget");
      expect(container.textContent).toContain("70% of company budget");
      await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "All Time")!.click());
      await act(async () => { await vi.waitFor(() => expect(container.querySelector('[aria-label^="Period spend:"]')).toBeNull()); });
    } finally { queryClient.clear(); vi.useRealTimers(); }
  });

  it.each(surfaces)("explains missing costs and pending runs neutrally on the %s page", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12.4, budgetCents: 0, pricingComplete: false, unpricedEventCount: 2, pendingRunCount: 1 });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 1,
      currencies: [{ currency: "EUR", netCents: 100 }],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>);
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain("3 run costs unavailable"));
    });
    const notice = [...container.querySelectorAll("button")].find(button => button.textContent === "3 run costs unavailable")!.parentElement!;
    expect(notice.classList.contains("text-muted-foreground")).toBe(true);
    expect(notice.querySelector(".text-destructive")).toBeNull();
    expect(notice.classList.contains("text-destructive")).toBe(false);
    expect(notice.textContent).toBe("3 run costs unavailable");
    expect(costsApiMocks.dataQuality).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Finance headline totals are USD only");
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12.4, budgetCents: 0, pricingComplete: false, unpricedEventCount: 10, pendingRunCount: 0 });
    await act(async () => { await queryClient.invalidateQueries(); });
    await vi.waitFor(() => expect(notice.textContent).toBe("10 run costs unavailable"));
    expect(notice.textContent).not.toContain("awaiting cost data");
    expect(notice.textContent).not.toContain("0 runs");
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12.4, budgetCents: 0, pricingComplete: false, unpricedEventCount: 0, pendingRunCount: 1 });
    await act(async () => { await queryClient.invalidateQueries(); });
    await vi.waitFor(() => expect(notice.textContent).toBe("1 run cost unavailable"));
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12.4, budgetCents: 0, pricingComplete: true, unpricedEventCount: 0, pendingRunCount: 0 });
    await act(async () => { await queryClient.invalidateQueries(); });
    await vi.waitFor(() => expect(container.contains(notice)).toBe(false));
  });

  it.each(surfaces)("labels each agent, project, and expanded model independently on the %s page", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 600, budgetCents: 0, pricingComplete: true, estimatedEventCount: 3 });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const base = { costCents: 200, inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, apiRunCount: 2, subscriptionRunCount: 0, eventCount: 2 };
    costsApiMocks.byProject.mockResolvedValue([
      { ...base, projectId: "estimated-project", projectName: "Estimated project", estimatedEventCount: 2 },
      { ...base, projectId: "mixed-project", projectName: "Mixed project", estimatedEventCount: 1 },
      { ...base, projectId: "reported-project", projectName: "Reported project", estimatedEventCount: 0 },
    ]);
    costsApiMocks.byAgent.mockResolvedValue([
      { ...base, agentId: "codie", agentName: "Codie", estimatedEventCount: 2 },
      { ...base, agentId: "mixed", agentName: "Mixed", estimatedEventCount: 1 },
      { ...base, agentId: "reported", agentName: "Reported", estimatedEventCount: 0 },
      { ...base, agentId: "legacy", agentName: "Legacy", eventCount: undefined },
    ]);
    costsApiMocks.byAgentModel.mockResolvedValue([
      { ...base, agentId: "mixed", provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-astra", eventCount: 1, estimatedEventCount: 1 },
      { ...base, agentId: "mixed", provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-sol", eventCount: 1, estimatedEventCount: 0 },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>);
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[aria-label="Codie costs"]')).not.toBeNull());
    });
    const card = (name: string) => container.querySelector<HTMLElement>(`[aria-label="${name} costs"]`)!;
    expect(card("Codie").textContent).toContain("Estimated");
    expect(card("Codie").textContent).not.toContain("Partially estimated");
    expect(card("Mixed").textContent).toContain("Partially estimated");
    expect(card("Reported").textContent).not.toMatch(/Estimated|Partially estimated/);
    expect(card("Legacy").textContent).not.toMatch(/Estimated|Partially estimated/);
    const projectBadge = (name: string) => [...container.querySelectorAll("span")]
      .find(element => element.textContent === name)!.parentElement!.querySelector('[data-slot="badge"]');
    expect(projectBadge("Estimated project")?.textContent).toBe("Estimated");
    expect(projectBadge("Mixed project")?.textContent).toBe("Partially estimated");
    expect(projectBadge("Reported project")).toBeNull();
    expect(container.textContent).not.toContain("Includes 3 estimated charges.");
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
    expect(costsApiMocks.dataQuality).not.toHaveBeenCalled();
    await act(async () => card("Mixed").querySelector<HTMLElement>(".cursor-pointer")!.click());
    const breakdown = card("Mixed").querySelector(".border-l")!;
    expect(breakdown.textContent).toContain("gpt-6-astra");
    expect(breakdown.querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
    expect(breakdown.querySelector('[data-slot="badge"]')!.textContent).toBe("Estimated");
    // The count is for charges, not runs; it must not use apiRunCount or the
    // page-wide estimated count when determining whether a row is mixed.
    expect(breakdown.querySelector('[data-slot="badge"]')!.getAttribute("title")).toContain("1 estimated charge.");
  });

  it.each(surfaces)("preserves the %s heading, breadcrumbs and tab navigation", async (name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>);
    });
    const streamlined = name === "streamlined";
    expect(container.querySelector(streamlined ? "h2" : "h1")?.textContent).toBe("Costs");
    if (streamlined) {
      expect(container.querySelector("h1")).toBeNull();
      expect(setBreadcrumbsMock).not.toHaveBeenCalled();
    } else {
      expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Costs" }]);
    }
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(
      streamlined ? ["Overview", "Providers", "Billers", "Finance", "Decisions", "Fast responses"] : ["Overview", "Budgets", "Providers", "Billers", "Finance", "Decisions", "Fast responses"],
    );
  });

});
