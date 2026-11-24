import { describe, expect, it, vi } from "vitest";
import {
  reconcileRunEvidenceDeletions,
  validateRunEvidenceDeletionRecords,
  type RunEvidenceDeletionRecord,
} from "./run-evidence-restore-reconciliation.js";

describe("run evidence restore deletion reconciliation", () => {
  const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const deletedTraceId = "11111111-1111-4111-8111-111111111111";
  const deletedRunId = "22222222-2222-4222-8222-222222222222";
  const unrelatedTraceId = "33333333-3333-4333-8333-333333333333";
  const unrelatedRunId = "44444444-4444-4444-8444-444444444444";

  it("reapplies an older deletion while leaving unrelated trace evidence readable", async () => {
    const rows = new Map([
      [deletedTraceId, { id: deletedTraceId, runId: deletedRunId, companyId, deletedAt: null as Date | null, payload: "private" }],
      [unrelatedTraceId, { id: unrelatedTraceId, runId: unrelatedRunId, companyId, deletedAt: null as Date | null, payload: "keep" }],
    ]);
    const reconcileDeletion = vi.fn(async (record: Omit<RunEvidenceDeletionRecord, "deletedAt"> & { deletedAt: Date }) => {
      const row = rows.get(record.traceId);
      if (!row) return { status: "missing" as const };
      if (row.runId !== record.runId || row.companyId !== record.companyId) return { status: "mismatch" as const };
      row.deletedAt = record.deletedAt;
      return { status: "cleaned" as const };
    });
    const store = { reconcileDeletion };
    const record: RunEvidenceDeletionRecord = {
      traceId: deletedTraceId, runId: deletedRunId, companyId, deletedAt: "2026-11-23T13:00:00.000Z",
    };

    await expect(reconcileRunEvidenceDeletions(store, [record])).resolves.toEqual({
      reconciled: [deletedTraceId], reconciliationPending: [], missing: [], mismatched: [],
    });
    const deleted = rows.get(deletedTraceId);
    const unrelated = rows.get(unrelatedTraceId);
    expect(deleted?.deletedAt).not.toBeNull();
    expect(deleted?.payload).toBe("private");
    expect(unrelated).toMatchObject({ deletedAt: null, payload: "keep" });
    expect(reconcileDeletion).toHaveBeenCalledOnce();
    expect(reconcileDeletion).toHaveBeenCalledWith({ ...record, deletedAt: new Date(record.deletedAt) });
  });

  it("reports target-specific missing, mismatched, and cleanup-pending records", async () => {
    const store = {
      reconcileDeletion: vi.fn(async ({ traceId }: Omit<RunEvidenceDeletionRecord, "deletedAt"> & { deletedAt: Date }) => {
        if (traceId === "55555555-5555-4555-8555-555555555555") return { status: "missing" as const };
        if (traceId === "66666666-6666-4666-8666-666666666666") return { status: "mismatch" as const };
        throw new Error("provider unavailable");
      }),
    };
    const missingId = "55555555-5555-4555-8555-555555555555";
    const mismatchId = "66666666-6666-4666-8666-666666666666";
    const pendingId = "77777777-7777-4777-8777-777777777777";
    const records = [missingId, mismatchId, pendingId].map((traceId, index) => ({
      traceId,
      runId: ["88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"][index]!,
      companyId,
      deletedAt: "2026-11-23T13:00:00.000Z",
    }));
    await expect(reconcileRunEvidenceDeletions(store, records)).resolves.toEqual({
      reconciled: [], reconciliationPending: [{ traceId: pendingId, error: "reconciliation_failed" }],
      missing: [missingId], mismatched: [mismatchId],
    });
  });

  it("validates UUID identities and deletion timestamps against the declared window", () => {
    const valid = {
      traceId: deletedTraceId, runId: deletedRunId, companyId, deletedAt: "2026-11-23T13:00:00.000Z",
    };
    const window = { recoveryPoint: "2026-11-23T12:00:00.000Z", coversThrough: "2026-11-23T14:00:00.000Z" };
    expect(() => validateRunEvidenceDeletionRecords([valid], window)).not.toThrow();
    expect(() => validateRunEvidenceDeletionRecords([{ ...valid, traceId: "not-a-uuid" }], window)).toThrow("invalid_run_evidence_deletion_record");
    expect(() => validateRunEvidenceDeletionRecords([{ ...valid, deletedAt: window.recoveryPoint }], window)).toThrow("run_evidence_deletion_outside_manifest_window");
    expect(() => validateRunEvidenceDeletionRecords([{ ...valid, deletedAt: "2026-11-23T15:00:00.000Z" }], window)).toThrow("run_evidence_deletion_outside_manifest_window");
  });
});
