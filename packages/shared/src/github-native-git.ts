import { z } from "zod";

export const githubNativeRepositorySchema = z.string().trim().max(140)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
  .refine(value => ![".", ".."].includes(value.split("/")[1]!))
  .transform(value => value.toLowerCase());

export const githubNativeOperationSchema = z.enum(["read", "push", "create_pull_request"]);
export const githubNativeRequestSchema = z.object({
  repository: githubNativeRepositorySchema,
  operation: githubNativeOperationSchema,
}).strict();
export type GitHubNativeRequest = z.infer<typeof githubNativeRequestSchema>;

export type GitHubNativeOperation = z.infer<typeof githubNativeOperationSchema>;

export const githubNativeSetupSchema = z.object({
  agentId: z.string().guid(),
  repository: githubNativeRepositorySchema,
  appId: z.string().trim().regex(/^[1-9][0-9]{0,15}$/),
  privateKey: z.string().trim().min(1).max(16384),
  push: z.boolean(),
  pullRequests: z.boolean(),
}).strict();
export type GitHubNativeSetupInput = z.infer<typeof githubNativeSetupSchema>;

export interface GitHubNativeGrantSummary {
  id: string;
  agentId: string;
  repository: string;
  appSlug: string;
  push: boolean;
  pullRequests: boolean;
  verifiedAt: string;
  revokedAt: string | null;
}

export type GitHubNativeEligibility =
  | { status: "available"; grant: GitHubNativeGrantSummary }
  | { status: "unavailable"; reason: string; code: "no_identity" | "ambiguous" | "repository_denied" | "action_denied" | "runtime_denied" | "workspace_mismatch" | "managed_identity" | "revoked" };
