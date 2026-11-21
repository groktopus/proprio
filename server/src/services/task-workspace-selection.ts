import { and, inArray, isNull } from "drizzle-orm";
import { executionWorkspaces } from "@groktopus/db";

export function taskWorkspaceSelectableCondition() {
  return and(
    inArray(executionWorkspaces.status, ["active", "idle"]),
    isNull(executionWorkspaces.closedAt),
  )!;
}
