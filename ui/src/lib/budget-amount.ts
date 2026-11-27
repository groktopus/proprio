import { upsertBudgetPolicySchema } from "@groktopus/shared";

export function parseBudgetDollarAmount(value: string, allowZero = false): number | null {
  const dollars = value.trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(dollars)) return null;
  const cents = Math.round(Number(dollars) * 100);
  return cents >= (allowZero ? 0 : 1) && upsertBudgetPolicySchema.shape.amount.safeParse(cents).success ? cents : null;
}
