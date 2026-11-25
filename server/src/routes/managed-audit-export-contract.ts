import { z } from "zod";

// JavaScript Date normalizes timestamps to milliseconds. Reject finer input
// before conversion can silently round a requested exclusive/inclusive bound.
export const managedAuditTimestampSchema = z.iso.datetime({ offset: true }).refine(
  value => !/\.\d{4,}(?=Z|[+-]\d{2}:\d{2}$)/.test(value),
  "Timestamps must not have precision finer than milliseconds",
);

export const managedAuditExportWindowSchema = z.object({
  from: managedAuditTimestampSchema,
  to: managedAuditTimestampSchema,
});

export const managedAuditExportParamsSchema = z.object({
  companyId: z.guid(),
  exportId: z.guid(),
});

export const managedAuditExportPageQuerySchema = z.object({ cursor: z.string().max(75).optional() });

export const managedAuditExportReceiptSchema = z.object({
  exportId: z.guid(),
  source: z.literal("tool_gateway"),
  coverage: z.literal("initial_gateway_decisions"),
  sourceEpoch: z.guid(),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  watermark: z.string().regex(/^[a-f0-9]{64}$/),
  eventCount: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const managedAuditEventSchema = z.object({
  id: z.guid(), companyId: z.guid(), source: z.string(), schemaVersion: z.number().int(),
  eventType: z.string(), phase: z.string(), occurredAt: z.iso.datetime({ offset: true }),
  runId: z.guid().nullable(), taskId: z.guid().nullable(), invocationId: z.guid(),
  requestId: z.guid().nullable(), connectionId: z.guid().nullable(), actorType: z.string(),
  actorId: z.string(), decision: z.string(), status: z.string(), reasonCode: z.string().nullable(),
});

export const managedAuditExportPageSchema = managedAuditExportReceiptSchema.extend({
  events: z.array(managedAuditEventSchema),
  deliveredThrough: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
});

export const managedAuditExportErrorSchema = z.object({
  error: z.string(),
  details: z.object({ reasonCode: z.string() }).passthrough().optional(),
});
