import { requestedRunCancellation } from "./run-cancellation.js";
import { expect, it } from "vitest";
import { isAcknowledgedNativeReassignmentStop, isAcknowledgedNativeStop, isAcknowledgedOperatorRunStop } from "./acknowledged-native-stop.js";
const run = { id: "run", companyId: "company", nativeIssueId: "issue", status: "cancelled", resultJson: {
  cancelledByActorType: "user", cancelledByUserId: "board", nativeCancellation: {
    schema: "proprio.native-cancellation.v1", runId: "run", companyId: "company", issueId: "issue",
    scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
    intentAuditId: "intent", acknowledgementAuditId: "ack",
  },
} };
it("recognizes the native receipt used by the Stop button", () => {
  expect(isAcknowledgedNativeStop(run)).toBe(true);
});
it.each([{ runId: "other" }, { companyId: "other" }, { issueId: "other" }, { dispatchState: "pending" }, { dispatched: false },
  { scope: "subtree" }, { acknowledgementAuditId: undefined }])("refuses unrelated or incomplete receipts %j", change => {
  expect(isAcknowledgedNativeStop({ ...run, resultJson: { ...run.resultJson,
    nativeCancellation: { ...run.resultJson.nativeCancellation, ...change } } })).toBe(false);
});

it("recognizes an audited handoff without granting operator Stop semantics", () => {
  const handoff = { ...run, resultJson: { reassignmentStopRequested: true, nativeCancellation: run.resultJson.nativeCancellation } };
  expect(isAcknowledgedNativeReassignmentStop(handoff)).toBe(true);
  expect(isAcknowledgedNativeStop(handoff)).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop({ ...handoff, status: "running" })).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop(run)).toBe(false);
});
it.each([{ runId: "other" }, { companyId: "other" }, { issueId: "other" }, { dispatchState: "pending" }, { dispatched: false },
  { scope: "subtree" }, { acknowledgementAuditId: undefined }])("requires an audited handoff receipt %j", change => {
  expect(isAcknowledgedNativeReassignmentStop({ ...run, resultJson: { reassignmentStopRequested: true,
    nativeCancellation: { ...run.resultJson.nativeCancellation, ...change } } })).toBe(false);
});

it("accepts a finished operator Stop through the audited native receipt or the local controller acknowledgment", () => {
  const finishedAt = new Date();
  expect(isAcknowledgedOperatorRunStop({ ...run, finishedAt })).toBe(true);
  const cancellation = requestedRunCancellation(run.resultJson, "Cancelled by a board operator");
  const local = { ...run, finishedAt, resultJson: { ...run.resultJson, nativeCancellation: undefined,
    cancellation, executionCancellation: { state: "acknowledged", acknowledgedAt: finishedAt.toISOString() } } };
  expect(isAcknowledgedOperatorRunStop(local)).toBe(true);
  expect(isAcknowledgedOperatorRunStop({ ...local, finishedAt: null })).toBe(false);
  expect(isAcknowledgedOperatorRunStop({ ...local, resultJson: { ...local.resultJson,
    cancellation: { ...cancellation, source: "queued_message" } } })).toBe(false);
  expect(isAcknowledgedOperatorRunStop({ ...local, resultJson: { ...local.resultJson,
    executionCancellation: { state: "requested" } } })).toBe(false);
});
