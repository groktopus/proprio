import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetOverview,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
} from "@groktopus/shared";
import { api, type RequestOptions } from "./client";

export const budgetsApi = {
  overview: (companyId: string, options?: RequestOptions) =>
    api.get<BudgetOverview>(`/companies/${companyId}/budgets/overview`, { ...options, fresh: true, cache: "no-store" }),
  upsertPolicy: (companyId: string, data: BudgetPolicyUpsertInput) =>
    api.post<BudgetPolicySummary>(`/companies/${companyId}/budgets/policies`, data),
  resolveIncident: (companyId: string, incidentId: string, data: BudgetIncidentResolutionInput) =>
    api.post<BudgetIncident>(
      `/companies/${companyId}/budget-incidents/${encodeURIComponent(incidentId)}/resolve`,
      data,
    ),
};
