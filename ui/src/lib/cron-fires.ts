/** Client-side schedule preview backed by the same routine cron utility as execution. */

import { nextRoutineCronFire, parseRoutineCron } from "@groktopus/shared/routine-cron";

export type ParsedCron = ReturnType<typeof parseRoutineCron>;

/** Parse a 5-field cron expression. Returns null when it cannot be parsed. */
export function parseCronExpression(expression: string | null | undefined): ParsedCron | null {
  if (!expression) return null;
  try {
    return parseRoutineCron(expression);
  } catch {
    return null;
  }
}

/** Compute upcoming occurrences using the same expression, timezone and reference clock as the server. */
export function nextCronFires(
  expression: string | null | undefined,
  count: number,
  options: { after?: Date; timeZone?: string } = {},
): Date[] {
  if (!parseCronExpression(expression) || count <= 0) return [];
  const timeZone = options.timeZone ?? "UTC";
  const fires: Date[] = [];
  let cursor = options.after ?? new Date();
  for (let i = 0; i < count; i++) {
    try {
      const next = nextRoutineCronFire(expression!, timeZone, cursor);
      if (!next) break;
      fires.push(next);
      cursor = next;
    } catch {
      return fires;
    }
  }
  return fires;
}

export type FireDisposition = "queued" | "coalesced" | "skipped";

export interface FirePreviewEntry {
  at: Date;
  disposition: FireDisposition;
  /** Short human label for the disposition (e.g. "queued", "would be coalesced"). */
  label: string;
  note: string | null;
}

const DISPOSITION_LABEL: Record<FireDisposition, string> = {
  queued: "queued",
  coalesced: "would be coalesced",
  skipped: "would be skipped",
};

/**
 * Annotate a list of upcoming fires with how the chosen concurrency policy would
 * treat each, assuming the previous run is still in flight when the next fires —
 * the worst case that makes the policy's behaviour legible (§3.5).
 *
 * Pure + deterministic so it can be unit-tested without a clock.
 */
export function previewFirePolicies(
  fires: Date[],
  concurrencyPolicy: string,
): FirePreviewEntry[] {
  return fires.map((at, index) => {
    if (index === 0) {
      return {
        at,
        disposition: "queued",
        label: DISPOSITION_LABEL.queued,
        note: "runs immediately",
      };
    }
    let disposition: FireDisposition;
    switch (concurrencyPolicy) {
      case "always_enqueue":
        disposition = "queued";
        break;
      case "skip_if_active":
        disposition = "skipped";
        break;
      case "coalesce_if_active":
      default:
        disposition = "coalesced";
        break;
    }
    return {
      at,
      disposition,
      label: DISPOSITION_LABEL[disposition],
      note: disposition === "queued" ? null : "if the previous run is still active",
    };
  });
}
