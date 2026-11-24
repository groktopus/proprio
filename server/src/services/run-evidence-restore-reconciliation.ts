export interface RunEvidenceDeletionRecord {
  traceId: string;
  runId: string;
  companyId: string;
  deletedAt: string;
}

export interface RunEvidenceDeletionWindow {
  recoveryPoint: string;
  coversThrough: string;
}

export interface RestoreTraceStore {
  reconcileDeletion(input: Omit<RunEvidenceDeletionRecord, "deletedAt"> & { deletedAt: Date }): Promise<{
    status: "cleaned" | "missing" | "mismatch";
  }>;
}

export function validateRunEvidenceDeletionRecords(
  records: readonly RunEvidenceDeletionRecord[],
  window?: RunEvidenceDeletionWindow,
) {
  const seen = new Set<string>();
  const recoveryPointMs = window ? Date.parse(window.recoveryPoint) : 0;
  const coversThroughMs = window ? Date.parse(window.coversThrough) : 0;
  if (window && (!Number.isFinite(recoveryPointMs) || !Number.isFinite(coversThroughMs) || coversThroughMs < recoveryPointMs)) {
    throw new Error("invalid_run_evidence_deletion_window");
  }
  for (const record of records) {
    const deletedAtMs = record && typeof record.deletedAt === "string" ? Date.parse(record.deletedAt) : NaN;
    if (!record || !isUuid(record.traceId) || !isUuid(record.runId) || !isUuid(record.companyId)
      || typeof record.deletedAt !== "string" || !Number.isFinite(deletedAtMs)) {
      throw new Error("invalid_run_evidence_deletion_record");
    }
    if (window && (deletedAtMs <= recoveryPointMs || deletedAtMs > coversThroughMs)) {
      throw new Error("run_evidence_deletion_outside_manifest_window");
    }
    if (seen.has(record.traceId)) throw new Error("duplicate_run_evidence_deletion_record");
    seen.add(record.traceId);
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Reapply externally retained deletion obligations while the restored instance is isolated. */
export async function reconcileRunEvidenceDeletions(
  traces: RestoreTraceStore,
  records: readonly RunEvidenceDeletionRecord[],
) {
  validateRunEvidenceDeletionRecords(records);
  const result: {
    reconciled: string[];
    reconciliationPending: Array<{ traceId: string; error: "reconciliation_failed" }>;
    missing: string[];
    mismatched: string[];
  } = { reconciled: [], reconciliationPending: [], missing: [], mismatched: [] };
  for (const record of records) {
    try {
      const status = await traces.reconcileDeletion({ ...record, deletedAt: new Date(record.deletedAt) });
      if (status.status === "cleaned") result.reconciled.push(record.traceId);
      else if (status.status === "missing") result.missing.push(record.traceId);
      else result.mismatched.push(record.traceId);
    } catch {
      result.reconciliationPending.push({ traceId: record.traceId, error: "reconciliation_failed" });
    }
  }
  return result;
}
