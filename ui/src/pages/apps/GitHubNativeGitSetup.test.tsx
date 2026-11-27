// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { GitHubNativeGitSetup } from "./GitHubNativeGitSetup";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), list: vi.fn() }));
vi.mock("@/api/client", () => ({ api: mocks }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.list } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));

it("verifies the named agent and selected permissions and clears the private key", async () => {
  const agentId = "9fa7c563-b595-4286-8954-37fcd61cf302";
  mocks.get.mockResolvedValue([]);
  mocks.list.mockResolvedValue([{ id: agentId, name: "Engineer", adapterType: "proprio_runner", status: "active" }]);
  mocks.post.mockResolvedValue({});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><GitHubNativeGitSetup companyId="company" /></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.querySelector("form")).not.toBeNull()); });
    const form = container.querySelector("form")!;
    (form.elements.namedItem("agent") as HTMLSelectElement).value = agentId;
    (form.elements.namedItem("repository") as HTMLInputElement).value = "Acme/Repo";
    (form.elements.namedItem("appId") as HTMLInputElement).value = "123";
    (form.elements.namedItem("push") as HTMLInputElement).checked = true;
    const key = form.elements.namedItem("key") as HTMLTextAreaElement;
    key.value = "synthetic-private-key";
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.post).toHaveBeenCalledWith("/companies/company/github-native-git", {
      agentId, repository: "acme/repo", appId: "123", privateKey: "synthetic-private-key", push: true, pullRequests: false,
    });
    expect(key.value).toBe("");
    expect(container.textContent).toContain("GitHub verified the repository");
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  }
});
