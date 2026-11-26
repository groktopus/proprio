// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { DialogProvider } from "@/context/DialogContext";
import { PanelProvider } from "@/context/PanelContext";
import { ToastProvider } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { AgentDetailPage } from "./AgentDetailPage";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "TEST" }],
    selectedCompanyId: "company-1",
  }),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

it("renders the New task action on the loaded agent overview", () => {
  const client = new QueryClient();
  client.setQueryData([...queryKeys.agents.detail("reviewer"), "company-1"], {
    id: "agent-1",
    companyId: "company-1",
    name: "Reviewer",
    urlKey: "reviewer",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
  });

  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/TEST/agents/reviewer/overview"]}>
        <BreadcrumbProvider companyName="Test company">
          <PanelProvider>
            <ToastProvider>
              <DialogProvider>
                <TooltipProvider>
                  <Routes>
                    <Route path="/:companyPrefix/agents/:agentId/:tab" element={<AgentDetailPage />} />
                  </Routes>
                </TooltipProvider>
              </DialogProvider>
            </ToastProvider>
          </PanelProvider>
        </BreadcrumbProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const container = document.createElement("div");
  container.innerHTML = markup;
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("header button"));
  const newTaskButton = buttons.find((button) => button.textContent?.trim() === "New task");
  expect(newTaskButton?.disabled).toBe(false);
  expect(newTaskButton?.querySelector('svg[aria-hidden="true"] rect')?.getAttribute("fill")).toBe("var(--proprio-mark-background)");
});
