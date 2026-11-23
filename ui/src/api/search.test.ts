import { afterEach, expect, it, vi } from "vitest";
import { applyAssigneeToken, assigneeToken } from "../lib/search-filters";
import {
  applySearchFiltersToParams,
  parseSearchQuery,
  readSearchFiltersFromParams,
} from "../lib/search-query-parser";
import { searchApi } from "./search";
import { api } from "./client";

vi.mock("./client", () => ({ api: { get: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

it("keeps scheduled monitor waits in is:open search requests", async () => {
  const parsed = parseSearchQuery("is:open deployment", {});
  await searchApi.search("company-1", { q: parsed.query, ...parsed.filters });
  const url = new URL(vi.mocked(api.get).mock.calls[0]![0], "http://localhost");
  expect(url.searchParams.getAll("displayStatus")).toEqual(["backlog", "todo", "in_progress", "monitoring", "in_review", "blocked"]);
  expect(url.searchParams.get("q")).toBe("deployment");
});

it.each([
  ["none", "assigneeAgentId=unassigned"],
  ["agent:agent-1", "assigneeAgentId=agent-1"],
  ["user:user-1", "assigneeUserId=user-1"],
])("round-trips the board assignee choice %s and sends the correct search filter", async (choice, wireFilter) => {
  const params = new URLSearchParams();
  applySearchFiltersToParams(params, applyAssigneeToken({}, choice, "current-user"));

  const filters = readSearchFiltersFromParams(new URLSearchParams(params.toString()));
  expect(assigneeToken(filters, "current-user")).toBe(choice);
  await searchApi.search("company-1", { q: "needle", ...filters });
  expect(api.get).toHaveBeenCalledExactlyOnceWith(`/companies/company-1/search?q=needle&${wireFilter}`);
});
