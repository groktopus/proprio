import { z } from "zod";
import type { providerTraceStore } from "./provider-trace-store.js";

export interface RunEvidenceDeletionRecord {
  traceId: string;
  runId: string;
  companyId: string;
  deletedAt: string;
}

interface RunEvidenceDeletionWindow {
  recoveryPoint: string;
  coversThrough: string;
}

type RestoreTraceStore = Pick<ReturnType<typeof providerTraceStore>, "reconcileDeletion">;

const timestamp = z.iso.datetime({ offset: true });

function timestampMicros(value: unknown) {
  if (typeof value !== "string" || !timestamp.safeParse(value).success) return NaN;
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "";
  if (fraction.length > 6) return NaN;
  return Date.parse(value) * 1_000 + Number(fraction.padEnd(6, "0").slice(3));
}

export function validateRunEvidenceDeletionRecords(
  records: readonly RunEvidenceDeletionRecord[],
  window?: RunEvidenceDeletionWindow,
) {
  const seen = new Set<string>();
  const recoveryPoint = window ? timestampMicros(window.recoveryPoint) : 0;
  const coversThrough = window ? timestampMicros(window.coversThrough) : 0;
  if (window && (!Number.isFinite(recoveryPoint) || !Number.isFinite(coversThrough) || coversThrough < recoveryPoint)) {
    throw new Error("invalid_run_evidence_deletion_window");
  }
  for (const record of records) {
    const deletedAt = timestampMicros(record?.deletedAt);
    if (!record || !isUuid(record.traceId) || !isUuid(record.runId) || !isUuid(record.companyId)
      || typeof record.deletedAt !== "string" || !Number.isFinite(deletedAt)) {
      throw new Error("invalid_run_evidence_deletion_record");
    }
    if (window && (deletedAt <= recoveryPoint || deletedAt > coversThrough)) {
      throw new Error("run_evidence_deletion_outside_manifest_window");
    }
    const traceId = record.traceId.toLowerCase();
    if (seen.has(traceId)) throw new Error("duplicate_run_evidence_deletion_record");
    seen.add(traceId);
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
    reconciliationPending: Array<{ traceId: string; error: "reconciliation_failed" | "cleanup_grace_period" | "object_cleanup_unconfirmed" }>;
    missing: string[];
    mismatched: string[];
  } = { reconciled: [], reconciliationPending: [], missing: [], mismatched: [] };
  for (const record of records) {
    const traceId = record.traceId.toLowerCase();
    try {
      const status = await traces.reconcileDeletion({
        traceId,
        runId: record.runId.toLowerCase(),
        companyId: record.companyId.toLowerCase(),
        deletedAt: new Date(record.deletedAt),
      });
      if (status.status === "cleaned") result.reconciled.push(traceId);
      else if (status.status === "missing") result.missing.push(traceId);
      else if (status.status === "mismatch") result.mismatched.push(traceId);
      else result.reconciliationPending.push({ traceId, error: status.reason });
    } catch {
      result.reconciliationPending.push({ traceId, error: "reconciliation_failed" });
    }
  }
  return result;
}
