import { resolveGrokDisableWebSearch } from "../../vendor/proprio-runner/index.js";
import { agentHarnessType, normalizeClaudeRunnerOptions } from "@groktopus/shared";
import { resolveClaudeEffort, resolveGrokEffort, resolveQualifiedAcpxProfile } from "../../vendor/proprio-runner/index.js";
import {
  isProprioRunnerProvider,
  PROPRIO_RUNNER_PERMISSION_CAPABILITIES,
  PROPRIO_RUNNER_ACPX_PROFILES,
  resolveProprioRunnerPermissionMode,
  resolveProprioRunnerCursorMode,
  resolveProprioRunnerPiThinkingLevel,
  type ProprioRunnerProvider,
} from "@groktopus/adapter-utils";
import {
  codexCliVersionAtLeast,
  codexLocalReasoningEffortsForModel,
  isCodexLocalKnownModel,
  minimumCodexCliVersionForModel,
} from "@groktopus/adapter-codex-local";
import {
  AGENTCORE_QUALIFIED_MODEL,
  CLAUDE_MANAGED_QUALIFIED_MODEL,
} from "../provider-profile-qualification.js";
import { resolveAcpxQualification, resolveAntigravityCandidateAdmission, resolveKimiCandidateAdmission, type AcpxQualificationCandidate } from "./acpx-qualification.js";
import { compatibleCodexModel } from "./codex-model-fallback.js";
import {
  claudeCliVersionAtLeast,
  claudeCodeVersionForAgentSdk,
  minimumClaudeCliVersionForModel,
} from "@groktopus/adapter-claude-local/server";
import { parseNativeCursorCloudConfig, type NativeCursorCloudConfig } from "../../vendor/proprio-runner/index.js";

export const QUALIFIED_OPENCODE_RUNNER_VERSION = "1.18.34" as const;
export const DEFAULT_OPENCODE_RUNNER_MODEL =
  "openrouter/deepseek/deepseek-v4-flash-0731" as const;
export const CLAUDE_MANAGED_BETA_VERSION = "managed-agents-2026-04-01" as const;

export function resolveConfiguredClaudeEffort(config: { modelReasoningEffort?: unknown; reasoningEffort?: unknown; effort?: unknown }):
  "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return resolveClaudeEffort("claude", config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort);
}

export const DEFAULT_ACPX_RUNNER_MODELS = {
  grok: "grok-4.7",
  claude: "claude-opus-5-5",
  // These profiles require explicit configuration. Admission belongs to the runner.
  codex: null,
  cursor: null,
  copilot: null,
  pi: null,
  kimi: null,
} as const;

export type QualifiedProprioRunnerAcpxAgent =
  keyof typeof DEFAULT_ACPX_RUNNER_MODELS;
type AdmittedProprioRunnerAcpxAgent = QualifiedProprioRunnerAcpxAgent | AcpxQualificationCandidate | "antigravity";

export type ProprioRunnerProviderProfile =
  | { provider: "cursor_cloud"; backend: "cursor_cloud_api"; model: string }
  | { provider: "muse"; backend: "muse_external"; model: null; museBindingId: string }
  | { provider: "grok_bot"; backend: "grok_bot_mcp"; model: null; externalBindingId: string }
  | { provider: "openai_dot"; backend: "openai_dot_mcp"; model: null; dotBindingId: string }
  | {
      provider: "codex";
      backend: "codex_app_server";
      model: string | null;
    }
  | {
      provider: "opencode";
      backend: "opencode_server";
      model: string;
    }
  | {
      provider: "claude_managed";
      backend: "claude_managed_agents_api";
      managedProfileId: string;
      model: string | null;
      maxSessionListCostUsd: number | null;
    }
  | {
      provider: "aws_agentcore";
      backend: "aws_agentcore_harness_api";
      agentCoreProfileId: string;
      model: string | null;
      maxEstimatedSessionCostUsd: number | null;
    }
  | {
      provider: "acpx";
      backend: "acpx_runtime";
      model: string;
      acpxAgent: AdmittedProprioRunnerAcpxAgent;
    };

export type ProprioRunnerNativeProviderInput =
  | { provider: "cursor_cloud"; model: string; cursorCloud: NativeCursorCloudConfig }
  | { provider: "muse"; model: null; museBinding: import("../../vendor/proprio-runner/index.js").MuseBindingSnapshot }
  | { provider: "grok_bot"; model: null; dotBinding: import("../../vendor/proprio-runner/index.js").DotBindingSnapshot }
  | { provider: "openai_dot"; model: null; dotBinding: import("../../vendor/proprio-runner/index.js").DotBindingSnapshot }
  | {
      provider: "codex";
      model: string | null;
      homeMode?: "isolated" | "preconfigured";
      codexApprovalPolicy: "never" | "on-request" | "untrusted";
      codexReasoningEffort?: string;
      codexWebSearch?: "disabled";
    }
  | {
      provider: "opencode";
      model: string;
      opencodePermissionMode: "allow" | "ask" | "deny";
    }
  | {
      provider: "claude_managed";
      model: string;
      managedProfile: {
        profileId: string;
        anthropicAgentId: string;
        agentVersion: string;
        environmentId: string;
        betaVersion: typeof CLAUDE_MANAGED_BETA_VERSION;
      };
      maxSessionListCostUsd: number;
    }
  | {
      provider: "aws_agentcore";
      model: string;
      agentCoreProfile: {
        profileId: string;
        region: string;
        accountId: string;
        harnessArn: string;
        harnessVersion: string;
        endpointArn: string;
        endpointQualifier: string;
        agentRuntimeArn: string;
        memoryArn: string;
        memoryId: string;
        invocationRoleArn: string;
        contextBucket: string;
        contextPrefix: string;
        contextKmsKeyArn: string;
        qualificationRevision: string;
        eventExpiryDays: 90;
      };
      maxEstimatedSessionCostUsd: number;
      invocationLimits: {
        maxIterations: number;
        maxOutputTokens: number;
        timeoutSeconds: number;
      };
    }
  | {
      provider: "acpx";
      model: string;
      acpxAgent: AdmittedProprioRunnerAcpxAgent;
      homeMode?: "isolated" | "preconfigured";
      acpxPermissionMode: "approve-all" | "approve-proprio" | "approve-reads" | "deny-all";
      acpxSessionMode?: "agent" | "plan" | "ask";
      piThinkingLevel?: "off" | "low" | "high" | "max";
      claudeEffort?: "low" | "medium" | "high" | "xhigh" | "max";
      grokEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      grokDisableWebSearch?: boolean;
    };

export class ProprioRunnerProviderProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProprioRunnerProviderProfileError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function resolveProprioRunnerCursorCloudConfig(config: Record<string, unknown>): NativeCursorCloudConfig {
  const unsupportedEnvironment = Object.keys(asRecord(config.env)).filter(key => key !== "CURSOR_API_KEY");
  if (unsupportedEnvironment.length) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_cursor_cloud_config_invalid",
      `Cursor Cloud with Proprio Runner only supports CURSOR_API_KEY in agent environment settings. Configure hosted secrets in your Cursor Cloud environment instead of ${unsupportedEnvironment.join(", ")}.`);
  }
  for (const [current, legacy] of [["cloudEnvType", "runtimeEnvType"], ["cloudEnvName", "runtimeEnvName"], ["repoRef", "repoStartingRef"], ["prUrl", "repoPullRequestUrl"]]) {
    if (config[current] !== undefined && config[legacy] !== undefined && config[current] !== config[legacy]) {
      throw new ProprioRunnerProviderProfileError("proprio_runner_cursor_cloud_config_invalid", `Choose one matching value for ${current} and ${legacy}.`);
    }
  }
  const unsupported = ["codexPermissionMode", "opencodePermissionMode", "acpxPermissionMode", "acpxSessionMode", "command", "extraArgs", "promptTemplate", "bootstrapPromptTemplate", "modelReasoningEffort", "reasoningEffort", "effort", "modelParams", "executionPlacement", "providerApiPlacement", "controllerPlacement", "apiOnly", "cwd", "workspaceRuntime", "workspaceStrategy"]
    .filter(key => config[key] !== undefined && config[key] !== "" && !(Array.isArray(config[key]) && config[key].length === 0));
  if (config.lifecycleMode !== undefined && config.lifecycleMode !== "per_turn") unsupported.push("lifecycleMode");
  if (config.homeMode === "preconfigured") unsupported.push("homeMode");
  if (unsupported.length) throw new ProprioRunnerProviderProfileError("proprio_runner_cursor_cloud_config_invalid", `Cursor Cloud cannot honor these settings: ${unsupported.join(", ")}.`);
  const repoUrl = optionalString(config.repoUrl);
  const startingRef = optionalString(config.repoRef ?? config.repoStartingRef);
  const prUrl = optionalString(config.prUrl ?? config.repoPullRequestUrl);
  const envName = optionalString(config.cloudEnvName ?? config.runtimeEnvName);
  try {
    return parseNativeCursorCloudConfig({
      schema: "proprio.cursor-cloud.config.v1",
      repos: repoUrl ? [{ url: repoUrl, ...(startingRef ? { startingRef } : {}), ...(prUrl ? { prUrl } : {}) }] : [],
      env: { type: config.cloudEnvType ?? config.runtimeEnvType ?? "cloud", ...(envName ? { name: envName } : {}) },
      ...Object.fromEntries(["workOnCurrentBranch", "autoCreatePR", "skipReviewerRequest"].filter(key => config[key] !== undefined).map(key => [key, config[key]])),
      ...(config.cursorCloudTimeoutMs !== undefined ? { timeoutMs: config.cursorCloudTimeoutMs } : {}),
    });
  } catch {
    throw new ProprioRunnerProviderProfileError("proprio_runner_cursor_cloud_config_invalid", "Cursor Cloud requires an HTTPS repository or named Cursor cloud environment, cloud-hosted execution, and supported settings. Its timeout must be between 1 second and 1 hour.");
  }
}

/** Configuration can be saved before pairing; task admission requires a binding. */
export function validateProprioRunnerDotConfig(config: Record<string, unknown>, requireBinding = true): string | null {
  const bindingId = optionalString(config.dotBindingId);
  if ((requireBinding && !bindingId) || (bindingId && !/^[0-9a-f-]{36}$/i.test(bindingId))
      || config.allowUnmeteredProvider !== true || (config.lifecycleMode && config.lifecycleMode !== "per_turn")
      || optionalString(config.model)) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_dot_config_invalid", "Dot requires per-turn lifecycle and explicit externally billed, unmetered-provider acknowledgement. Pair a binding before assigning work.");
  }
  return bindingId;
}

/** Closed personal runtime configuration; model and workspace grants are excluded. */
export function validateProprioRunnerMuseConfig(config: Record<string, unknown>, requireBinding = true): string | null {
  const bindingId = optionalString(config.museBindingId);
  if ((requireBinding && !bindingId) || (bindingId && !/^[0-9a-f-]{36}$/i.test(bindingId))
      || config.allowUnmeteredProvider !== true || (config.lifecycleMode && config.lifecycleMode !== "per_turn")
      || optionalString(config.model) || config.dotWorkspaceAccess === true || config.dotAttachmentAccess === true) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_muse_config_invalid", "Muse requires a paired personal-agent binding, per-turn lifecycle and unavailable-usage acknowledgement.");
  }
  return bindingId;
}

export function validateProprioRunnerGrokConfig(config: Record<string, unknown>, requireBinding = true): string | null {
  const bindingId = optionalString(config.externalBindingId);
  if ((requireBinding && !bindingId) || (bindingId && !/^[0-9a-f-]{36}$/i.test(bindingId))
      || config.allowUnmeteredProvider !== true || (config.lifecycleMode && config.lifecycleMode !== "per_turn")
      || optionalString(config.model) || config.dotWorkspaceAccess === true || config.dotAttachmentAccess === true
      || optionalString(config.cwd) || optionalString(config.command)) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_grok_config_invalid", "Grok Bot requires a bound per-turn work session and an explicit acknowledgement of unreported provider spending. Proprio workspace, shell and third-party app tools are unavailable.");
  }
  return bindingId;
}

/** A task may change a Runner model (and supported effort), but not provider identity. */
export function projectProprioRunnerTaskConfig(
  backend: "codex_app_server" | "opencode_server" | "acpx_runtime" | "cursor_cloud_api",
  agentConfig: unknown,
  taskOverrides: unknown,
  managedModel?: string,
): Record<string, unknown> {
  const base = asRecord(agentConfig);
  const task = asRecord(taskOverrides);
  const config = { ...base };
  // The server resolves a connection's model namespace after task overrides.
  // Carry that model into durable input without allowing routing to change the harness.
  const model = optionalString(managedModel) ?? optionalString(task.model);
  const grok = backend === "acpx_runtime" && agentHarnessType("proprio_runner", base) === "grok_local";
  const supportsEffort = backend === "codex_app_server" || grok || (backend === "acpx_runtime" && agentHarnessType("proprio_runner", base) === "claude_local");
  const effortKey = supportsEffort
    ? ["modelReasoningEffort", "reasoningEffort", "effort"].find((key) => key in task)
    : undefined;
  if (supportsEffort && ((model !== null && model !== optionalString(base.model)) || effortKey !== undefined)) {
    delete config.modelReasoningEffort;
    delete config.reasoningEffort;
    delete config.effort;
  }
  if (model !== null) config.model = model;
  if (effortKey !== undefined) config[grok ? "reasoningEffort" : "modelReasoningEffort"] = task[effortKey];
  return config;
}

function positiveNumberOrNull(
  value: unknown,
  code: string,
  message: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProprioRunnerProviderProfileError(code, message);
  }
  return parsed;
}

function boundedPositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  code: string,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum
  ) {
    throw new ProprioRunnerProviderProfileError(
      code,
      `${label} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function assertPermissionMode(
  provider: ProprioRunnerProvider,
  config: Record<string, unknown>,
): void {
  const capability = PROPRIO_RUNNER_PERMISSION_CAPABILITIES[provider];
  if (!capability.configurable) return;
  const configured = config[capability.configKey];
  if (
    configured !== undefined
    && resolveProprioRunnerPermissionMode(provider, configured) !== configured
  ) {
    if (provider === "codex") {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_codex_permission_mode_unqualified",
        "Proprio Runner currently supports Codex only with codexPermissionMode set to never. Update the agent configuration before starting a new native run.",
      );
    }
    throw new ProprioRunnerProviderProfileError(
      "runner_permission_mode_invalid",
      `${capability.configKey} is not supported by ${provider}.`,
    );
  }
}

/**
 * Rebind a persisted Claude Managed run only to the still-qualified profile
 * and the profile's current company secret. The secret itself may rotate, but
 * the agent configuration must rotate its binding to the same profile-owned
 * secret before recovery can continue.
 */
export function assertManagedProfileRecoveryBinding(input: {
  adapterConfig: unknown;
  snapshot: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
  };
  stored: {
    id: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
    apiKeySecretId: string;
  };
}): void {
  const { snapshot, stored } = input;
  if (
    snapshot.profileId !== stored.id
    || snapshot.anthropicAgentId !== stored.anthropicAgentId
    || snapshot.agentVersion !== stored.agentVersion
    || snapshot.environmentId !== stored.environmentId
    || snapshot.betaVersion !== stored.betaVersion
  ) {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_claude_managed_recovery_identity_mismatch",
      "The persisted Claude Managed identity no longer matches its qualified profile.",
    );
  }
  const rawBinding = asRecord(asRecord(input.adapterConfig).env).ANTHROPIC_API_KEY;
  const boundSecretId = asRecord(rawBinding).secretId;
  if (boundSecretId !== stored.apiKeySecretId) {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_claude_managed_recovery_secret_mismatch",
      "The persisted Claude Managed run is not bound to its profile's current API-key secret.",
    );
  }
}

/** Revalidate the operator's AWS profile revocation and immutable identity on recovery. */
export function assertAgentCoreProfileRecoveryBinding(input: {
  snapshot: {
    profileId: string;
    region: string;
    accountId: string;
    harnessArn: string;
    harnessVersion: string;
    endpointArn: string;
    endpointQualifier: string;
    agentRuntimeArn: string;
    memoryArn: string;
    memoryId: string;
    invocationRoleArn: string;
    contextBucket: string;
    contextPrefix: string;
    contextKmsKeyArn: string;
    qualificationRevision: string;
    eventExpiryDays: number;
  };
  stored: {
    id: string;
    configuration: Record<string, unknown>;
  };
}): void {
  const { snapshot, stored } = input;
  const configuration = asRecord(stored.configuration);
  const fields = [
    "region",
    "accountId",
    "harnessArn",
    "harnessVersion",
    "endpointArn",
    "endpointQualifier",
    "agentRuntimeArn",
    "memoryArn",
    "memoryId",
    "invocationRoleArn",
    "contextBucket",
    "contextPrefix",
    "contextKmsKeyArn",
    "qualificationRevision",
    "eventExpiryDays",
  ] as const;
  if (
    snapshot.profileId !== stored.id
    || fields.some((field) => snapshot[field] !== configuration[field])
  ) {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_aws_agentcore_recovery_identity_mismatch",
      "The persisted AWS AgentCore identity no longer matches its qualified profile.",
    );
  }
}

export function claudeRunnerUnsupportedSettings(config: Record<string, unknown>): string[] {
  config = normalizeClaudeRunnerOptions(config).config;
  const unsupported = ["chrome", "agentCommand", "acpAgentCommand", "stateDir", "acpStateDir", "warmHandleIdleMs", "acpWarmHandleIdleMs", "extraArgs", "args", "filesystemScope", "filesystemExtraPaths", "filesystemSandboxCommand", "networkScope", "networkAllowlist", "maxTurnsPerRun", "permissionMode", "acpPermissionMode"]
    .filter(key => config[key] !== undefined && config[key] !== false && config[key] !== "" && config[key] !== 0 && !(Array.isArray(config[key]) && config[key].length === 0));
  if (config.command && config.command !== "claude") unsupported.push("command");
  if (config.mode && config.mode !== "persistent") unsupported.push("mode");
  if (config.acpMode && config.acpMode !== "persistent") unsupported.push("acpMode");
  if (config.engine && !["auto", "cli", "acp"].includes(String(config.engine))) unsupported.push("engine");
  if (config.nonInteractivePermissions && config.nonInteractivePermissions !== "deny") unsupported.push("nonInteractivePermissions");
  if (config.acpNonInteractivePermissions && config.acpNonInteractivePermissions !== "deny") unsupported.push("acpNonInteractivePermissions");
  if (config.dangerouslySkipPermissions === false) unsupported.push("dangerouslySkipPermissions");
  return unsupported;
}

/**
 * Resolve the immutable provider identity used for a fresh Proprio Runner
 * selection. The persisted adapterConfig is the authority; runtimeConfig is
 * deliberately not consulted so model-profile or migration metadata cannot
 * silently switch the harness selected for a run.
 */
export function resolveProprioRunnerProviderProfile(
  adapterConfig: unknown,
  context: { companyId?: string } = {},
): ProprioRunnerProviderProfile {
  const config = asRecord(adapterConfig);
  const candidate = config.provider ?? "codex";
  if (!isProprioRunnerProvider(candidate)) {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_provider_unsupported",
      "Proprio Runner provider must be Codex, OpenCode, Claude Managed, AWS AgentCore, or ACPX.",
    );
  }

  if (candidate === "cursor_cloud") {
    const model = optionalString(config.model);
    if (!model) throw new ProprioRunnerProviderProfileError("proprio_runner_cursor_cloud_model_required", "Cursor Cloud requires an explicit model. Select a model before testing or assigning work.");
    resolveProprioRunnerCursorCloudConfig(config);
    return { provider: "cursor_cloud", backend: "cursor_cloud_api", model };
  }

  if (candidate === "muse") {
    const bindingId = validateProprioRunnerMuseConfig(config)!;
    return { provider: "muse", backend: "muse_external", model: null, museBindingId: bindingId };
  }
  if (candidate === "grok_bot") {
    return { provider: "grok_bot", backend: "grok_bot_mcp", model: null, externalBindingId: validateProprioRunnerGrokConfig(config)! };
  }
  if (candidate === "openai_dot") {
    const bindingId = validateProprioRunnerDotConfig(config)!;
    return { provider: "openai_dot", backend: "openai_dot_mcp", model: null, dotBindingId: bindingId };
  }
  if (candidate === "acpx" && agentHarnessType("proprio_runner", config) === "claude_local") {
    const unsupported = claudeRunnerUnsupportedSettings(config);
    if (unsupported.length) throw new ProprioRunnerProviderProfileError("agent_runner_config_incompatible",
      `Proprio Runner cannot honor these settings: ${unsupported.join(", ")}. Remove them before retrying.`);
  }
  assertPermissionMode(candidate, config);
  try {
    resolveProprioRunnerCursorMode(candidate, config.acpxAgent, config.acpxSessionMode);
  } catch (error) {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_mode_invalid",
      error instanceof Error ? error.message : "Invalid Cursor session mode",
    );
  }
  try { if (candidate === "acpx" && agentHarnessType("proprio_runner", config) === "claude_local") resolveConfiguredClaudeEffort(config); } catch (error) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_claude_effort_invalid", error instanceof Error ? error.message : "Invalid Claude effort");
  }
  try { if (candidate === "acpx" && config.acpxAgent === "grok") resolveGrokEffort("grok", config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort); } catch (error) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_grok_effort_invalid", error instanceof Error ? error.message : "Invalid Grok effort");
  }
  try { if (candidate === "acpx" && config.acpxAgent === "grok") resolveGrokDisableWebSearch("grok", config.disableWebSearch); } catch (error) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_grok_search_invalid", error instanceof Error ? error.message : "Invalid Grok search policy");
  }
  try { resolveProprioRunnerPiThinkingLevel(candidate, config.acpxAgent, config.piThinkingLevel); } catch (error) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_pi_thinking_invalid", error instanceof Error ? error.message : "Invalid Pi thinking level");
  }
  const model = optionalString(config.model);
  if (candidate === "codex") {
    return {
      provider: "codex",
      backend: "codex_app_server",
      model,
    };
  }

  if (candidate === "opencode") {
    if (!model || !model.includes("/") || model.endsWith("/")) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_opencode_model_invalid",
        "Proprio Runner OpenCode requires model in provider/model form.",
      );
    }
    return {
      provider: "opencode",
      backend: "opencode_server",
      model,
    };
  }

  if (candidate === "claude_managed") {
    const managedProfileId = optionalString(config.managedProfileId);
    if (!managedProfileId) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_managed_profile_required",
        "Proprio Runner Claude Managed requires a company managed-agent profile.",
      );
    }
    if (config.managedAgentsRetentionAcknowledged !== true) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_managed_retention_required",
        "Proprio Runner Claude Managed requires acknowledgement of stateful beta retention.",
      );
    }
    if (model !== null && model !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_managed_model_unqualified",
        `The Claude Managed profile requires exact model ${CLAUDE_MANAGED_QUALIFIED_MODEL}.`,
      );
    }
    return {
      provider: "claude_managed",
      backend: "claude_managed_agents_api",
      managedProfileId,
      model,
      maxSessionListCostUsd: positiveNumberOrNull(
        config.maxSessionListCostUsd,
        "proprio_runner_claude_managed_spend_cap_invalid",
        "Proprio Runner Claude Managed requires a positive session spend ceiling when overridden.",
      ),
    };
  }

  if (candidate === "aws_agentcore") {
    const agentCoreProfileId = optionalString(config.agentCoreProfileId);
    if (!agentCoreProfileId) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_aws_agentcore_profile_required",
        "Proprio Runner AWS AgentCore requires a company remote-agent profile.",
      );
    }
    if (config.agentCoreRetentionAcknowledged !== true) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_aws_agentcore_retention_required",
        "Proprio Runner AWS AgentCore requires acknowledgement of 90-day Memory retention.",
      );
    }
    if (model !== null && model !== AGENTCORE_QUALIFIED_MODEL) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_aws_agentcore_model_unqualified",
        `The AWS AgentCore profile requires exact model ${AGENTCORE_QUALIFIED_MODEL}.`,
      );
    }
    return {
      provider: "aws_agentcore",
      backend: "aws_agentcore_harness_api",
      agentCoreProfileId,
      model,
      maxEstimatedSessionCostUsd: positiveNumberOrNull(
        config.maxEstimatedSessionCostUsd,
        "proprio_runner_aws_agentcore_spend_cap_invalid",
        "Proprio Runner AWS AgentCore requires a positive estimated session spend ceiling when overridden.",
      ),
    };
  }

  const acpxAgent = config.acpxAgent ?? "claude";
  if (acpxAgent === "copilot" && (!model || ["auto", "default"].includes(model.toLowerCase()))) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_acpx_model_required", "GitHub Copilot requires an explicit model ID; there is no default model.");
  }
  const pendingAcpxProfile = PROPRIO_RUNNER_ACPX_PROFILES.find(profile => profile.value === acpxAgent && !profile.qualified);
  if (pendingAcpxProfile) {
    if (!model) throw new ProprioRunnerProviderProfileError("proprio_runner_acpx_model_required", `${pendingAcpxProfile.label} requires an explicit model ID; there is no default model.`);
    if (pendingAcpxProfile.value === "antigravity") {
      try {
        if (resolveAntigravityCandidateAdmission({ companyId: context.companyId, model }, process.env)) {
          return { provider: "acpx", backend: "acpx_runtime", model, acpxAgent: "antigravity" };
        }
      } catch {
        throw new ProprioRunnerProviderProfileError("proprio_runner_acpx_qualification_invalid", "Antigravity candidate admission requires the authorized company, exact model and runtime identity.");
      }
    }
    if (pendingAcpxProfile.value === "kimi") {
      try {
        if (resolveKimiCandidateAdmission({ companyId: context.companyId, model }, process.env)) {
          return { provider: "acpx", backend: "acpx_runtime", model, acpxAgent: "kimi" };
        }
      } catch {
        throw new ProprioRunnerProviderProfileError("proprio_runner_acpx_qualification_invalid", "Kimi candidate admission requires the authorized company, exact model, target and runtime identity.");
      }
    }
    // Qualification authority belongs to the isolated server operator. Never
    // read this allowlist from adapter config, credential refs, or run env.
    let qualification: AcpxQualificationCandidate | undefined;
    try {
      qualification = resolveAcpxQualification({ kind: "acpx", agent: pendingAcpxProfile.value, model }, process.env);
    } catch {
      throw new ProprioRunnerProviderProfileError("proprio_runner_acpx_qualification_invalid", "ACPX qualification requires an exact host-authorized candidate and model.");
    }
    if (qualification) {
      return { provider: "acpx", backend: "acpx_runtime", model, acpxAgent: qualification };
    }
    throw new ProprioRunnerProviderProfileError("proprio_runner_acpx_agent_unavailable", `${pendingAcpxProfile.label} is awaiting native Runner acceptance. Its profile is not enabled for production runs.`);
  }
  if ((acpxAgent === "cursor" || acpxAgent === "pi" || acpxAgent === "kimi") && !model) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_acpx_model_required", "This ACPX agent requires an explicit model ID; there is no default model.");
  }
  if (acpxAgent !== "claude" && acpxAgent !== "codex" && acpxAgent !== "grok" && acpxAgent !== "cursor" && acpxAgent !== "copilot" && acpxAgent !== "pi" && acpxAgent !== "kimi") {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_acpx_agent_unavailable",
      "Proprio Runner ACPX requires a qualified agent profile.",
    );
  }
  const selectedModel = acpxAgent === "grok" && model === "grok-build"
    ? DEFAULT_ACPX_RUNNER_MODELS.grok
    : model || DEFAULT_ACPX_RUNNER_MODELS[acpxAgent] || "";
  let qualifiedProfile: ReturnType<typeof resolveQualifiedAcpxProfile>;
  try {
    qualifiedProfile = resolveQualifiedAcpxProfile(acpxAgent, selectedModel);
  } catch (error) {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_acpx_model_unqualified",
      error instanceof Error ? error.message : "Proprio Runner ACPX requires an admitted model.",
    );
  }
  if (acpxAgent === "claude") {
    // The provider pack runs the Claude Code its Agent SDK bundles; name the gap instead of
    // letting an older CLI fail the turn with an opaque backend error.
    const minimum = minimumClaudeCliVersionForModel(selectedModel);
    const bundled = claudeCodeVersionForAgentSdk(qualifiedProfile.agentRuntimeVersion);
    if (minimum && bundled && !claudeCliVersionAtLeast(bundled, minimum)) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_cli_version_incompatible",
        `${selectedModel} requires Claude Code ${minimum} or newer; this Proprio Runner bundles Claude Code ${bundled}. Choose another model or use the legacy Claude runner until the Runner is updated.`,
      );
    }
  }
  if (acpxAgent === "codex") {
    // ACPX Codex runs the qualified runtime pin, so the backend would reject a newer model.
    const minimum = minimumCodexCliVersionForModel(selectedModel);
    const bundled = qualifiedProfile.agentRuntimeVersion;
    if (minimum && bundled && !codexCliVersionAtLeast(bundled, minimum)) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_codex_cli_version_incompatible",
        `${selectedModel} requires Codex ${minimum} or newer; this Proprio Runner bundles Codex ${bundled}. Choose another model or use the legacy Codex runner until the Runner is updated.`,
      );
    }
  }
  return {
    provider: "acpx",
    backend: "acpx_runtime",
    model: selectedModel,
    acpxAgent,
  };
}

export function supportsProprioRunnerPreconfiguredHome(adapterConfig: unknown, options: { companyId?: string } = {}): boolean {
  const config = asRecord(adapterConfig);
  const profile = resolveProprioRunnerProviderProfile(config, options);
  return profile.provider === "codex" || (profile.provider === "acpx" && profile.acpxAgent === "claude"
    && (config.acpxPermissionMode === undefined || config.acpxPermissionMode === "approve-all"));
}

/**
 * Project the operator-owned adapter configuration and a qualified stored
 * profile into the closed native execution descriptor. Editable adapter
 * configuration can select a stored profile, but it cannot replace that
 * profile's immutable remote resource identity.
 */
export function resolveProprioRunnerNativeProviderInput(input: {
  companyId?: string;
  backend: ProprioRunnerProviderProfile["backend"];
  adapterConfig: unknown;
  /** Verified image CLI version for a fresh remote Codex run only. */
  codexCliVersion?: string | null;
  museBinding?: import("../../vendor/proprio-runner/index.js").MuseBindingSnapshot;
  dotBinding?: import("../../vendor/proprio-runner/index.js").DotBindingSnapshot;
  managedProfile?: {
    id: string;
    profileKey: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
    defaultModel: string;
    defaultMaxListCostCents: number;
  } | null;
  agentCoreProfile?: {
    id: string;
    profileKey: string;
    configuration: Record<string, unknown>;
  } | null;
}): ProprioRunnerNativeProviderInput {
  const config = asRecord(input.adapterConfig);
  const profile = resolveProprioRunnerProviderProfile(config, { companyId: input.companyId });
  if (config.homeMode !== undefined && config.homeMode !== "isolated" && config.homeMode !== "preconfigured") {
    throw new ProprioRunnerProviderProfileError("proprio_runner_home_mode_invalid", "homeMode must be isolated or preconfigured");
  }
  const preconfigured = config.homeMode === "preconfigured";
  if (preconfigured && profile.provider !== "codex" && !(profile.provider === "acpx" && ["claude", "codex"].includes(profile.acpxAgent))) {
    throw new ProprioRunnerProviderProfileError("proprio_runner_home_mode_unsupported", "Preconfigured home supports native Codex and ACPX Claude only");
  }
  if (preconfigured && profile.provider === "acpx" && config.acpxPermissionMode !== undefined && config.acpxPermissionMode !== "approve-all") {
    throw new ProprioRunnerProviderProfileError("proprio_runner_home_permission_mode_unsupported", "Preconfigured home currently requires ACPX approve-all; local permission rules still apply");
  }
  if (preconfigured && profile.provider === "acpx" && profile.acpxAgent === "codex") {
    throw new ProprioRunnerProviderProfileError("proprio_runner_home_state_boundary_unsupported", "preconfigured ACPX Codex cannot protect Runner state; use native Codex or isolated mode");
  }
  if (profile.backend !== input.backend) {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_provider_changed",
      "Proprio Runner provider changed after this run selected its native backend.",
    );
  }
  if (profile.provider === "cursor_cloud") {
    return { provider: "cursor_cloud", model: profile.model, cursorCloud: resolveProprioRunnerCursorCloudConfig(config) };
  }
  if (profile.provider === "muse") {
    if (!input.museBinding || input.museBinding.bindingId !== profile.museBindingId) throw new ProprioRunnerProviderProfileError("proprio_runner_muse_binding_unavailable", "Muse binding must be resolved by the server after normal admission.");
    return { provider: "muse", model: null, museBinding: input.museBinding };
  }
  if (profile.provider === "grok_bot") {
    if (!input.dotBinding || input.dotBinding.bindingId !== profile.externalBindingId) throw new ProprioRunnerProviderProfileError("proprio_runner_grok_binding_unavailable", "The Grok binding must be resolved by the server after normal admission.");
    return { provider: "grok_bot", model: null, dotBinding: input.dotBinding };
  }
  if (profile.provider === "openai_dot") {
    if (!input.dotBinding || input.dotBinding.bindingId !== profile.dotBindingId) throw new ProprioRunnerProviderProfileError("proprio_runner_dot_binding_unavailable", "Dot binding must be resolved by the server after normal admission.");
    return { provider: "openai_dot", model: null, dotBinding: input.dotBinding };
  }
  if (profile.provider === "opencode") {
    return {
      provider: "opencode",
      model: profile.model,
      opencodePermissionMode: resolveProprioRunnerPermissionMode(
        "opencode",
        config.opencodePermissionMode,
      ) as "allow" | "ask" | "deny",
    };
  }
  if (profile.provider === "acpx") {
    return {
      provider: "acpx",
      model: profile.model,
      acpxAgent: profile.acpxAgent,
      ...(profile.acpxAgent === "claude" ? { claudeEffort: resolveConfiguredClaudeEffort(config) } : {}),
      ...(profile.acpxAgent === "grok" ? { grokEffort: resolveGrokEffort("grok", config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort), grokDisableWebSearch: resolveGrokDisableWebSearch("grok", config.disableWebSearch) } : {}),
      ...(profile.acpxAgent === "pi" ? { piThinkingLevel: resolveProprioRunnerPiThinkingLevel("acpx", "pi", config.piThinkingLevel) } : {}),
      ...(profile.acpxAgent === "cursor" ? {
        acpxSessionMode: resolveProprioRunnerCursorMode("acpx", "cursor", config.acpxSessionMode),
      } : {}),
      ...(preconfigured ? { homeMode: "preconfigured" as const } : {}),
      acpxPermissionMode: resolveProprioRunnerPermissionMode(
        "acpx",
        config.acpxPermissionMode,
      ) as "approve-all" | "approve-proprio" | "approve-reads" | "deny-all",
    };
  }
  if (profile.provider === "claude_managed") {
    const stored = input.managedProfile;
    if (
      !stored
      || (
        profile.managedProfileId !== stored.id
        && profile.managedProfileId !== stored.profileKey
      )
    ) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_managed_profile_mismatch",
        "The qualified Claude Managed profile does not match the adapter selection.",
      );
    }
    if (stored.betaVersion !== CLAUDE_MANAGED_BETA_VERSION) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_managed_beta_unqualified",
        "The Claude Managed profile beta version is not qualified.",
      );
    }
    const model = profile.model ?? optionalString(stored.defaultModel);
    const maxSessionListCostUsd = profile.maxSessionListCostUsd
      ?? stored.defaultMaxListCostCents / 100;
    if (!model) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_managed_model_invalid",
        "The Claude Managed profile requires a model.",
      );
    }
    if (model !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_managed_model_unqualified",
        `The Claude Managed profile requires exact model ${CLAUDE_MANAGED_QUALIFIED_MODEL}.`,
      );
    }
    if (!Number.isFinite(maxSessionListCostUsd) || maxSessionListCostUsd <= 0) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_claude_managed_spend_cap_invalid",
        "The Claude Managed profile requires a positive session spend ceiling.",
      );
    }
    return {
      provider: "claude_managed",
      model,
      managedProfile: {
        profileId: stored.id,
        anthropicAgentId: stored.anthropicAgentId,
        agentVersion: stored.agentVersion,
        environmentId: stored.environmentId,
        betaVersion: CLAUDE_MANAGED_BETA_VERSION,
      },
      maxSessionListCostUsd,
    };
  }
  if (profile.provider === "aws_agentcore") {
    const stored = input.agentCoreProfile;
    if (
      !stored
      || (
        profile.agentCoreProfileId !== stored.id
        && profile.agentCoreProfileId !== stored.profileKey
      )
    ) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_aws_agentcore_profile_mismatch",
        "The qualified AWS AgentCore profile does not match the adapter selection.",
      );
    }
    const remote = asRecord(stored.configuration);
    const required = (key: string): string => {
      const value = optionalString(remote[key]);
      if (!value) {
        throw new ProprioRunnerProviderProfileError(
          "proprio_runner_aws_agentcore_profile_invalid",
          `The qualified AWS AgentCore profile is missing ${key}.`,
        );
      }
      return value;
    };
    if (remote.eventExpiryDays !== 90) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_aws_agentcore_retention_unqualified",
        "The qualified AWS AgentCore profile must retain Memory events for exactly 90 days.",
      );
    }
    const maxEstimatedSessionCostUsd = profile.maxEstimatedSessionCostUsd
      ?? positiveNumberOrNull(
        remote.defaultMaxEstimatedSessionCostUsd,
        "proprio_runner_aws_agentcore_spend_cap_invalid",
        "The AWS AgentCore profile requires a positive estimated session spend ceiling.",
      );
    if (maxEstimatedSessionCostUsd === null) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_aws_agentcore_spend_cap_invalid",
        "The AWS AgentCore profile requires a positive estimated session spend ceiling.",
      );
    }
    const model = profile.model ?? required("defaultModel");
    if (model !== AGENTCORE_QUALIFIED_MODEL) {
      throw new ProprioRunnerProviderProfileError(
        "proprio_runner_aws_agentcore_model_unqualified",
        `The AWS AgentCore profile requires exact model ${AGENTCORE_QUALIFIED_MODEL}.`,
      );
    }
    return {
      provider: "aws_agentcore",
      model,
      agentCoreProfile: {
        profileId: stored.id,
        region: required("region"),
        accountId: required("accountId"),
        harnessArn: required("harnessArn"),
        harnessVersion: required("harnessVersion"),
        endpointArn: required("endpointArn"),
        endpointQualifier: required("endpointQualifier"),
        agentRuntimeArn: required("agentRuntimeArn"),
        memoryArn: required("memoryArn"),
        memoryId: required("memoryId"),
        invocationRoleArn: required("invocationRoleArn"),
        contextBucket: required("contextBucket"),
        contextPrefix: required("contextPrefix"),
        contextKmsKeyArn: required("contextKmsKeyArn"),
        qualificationRevision: required("qualificationRevision"),
        eventExpiryDays: 90,
      },
      maxEstimatedSessionCostUsd,
      invocationLimits: {
        maxIterations: boundedPositiveInteger(
          config.maxIterations,
          8,
          8,
          "proprio_runner_aws_agentcore_max_iterations_invalid",
          "AWS AgentCore maxIterations",
        ),
        maxOutputTokens: boundedPositiveInteger(
          config.maxOutputTokens,
          4_096,
          4_096,
          "proprio_runner_aws_agentcore_max_output_tokens_invalid",
          "AWS AgentCore maxOutputTokens",
        ),
        timeoutSeconds: boundedPositiveInteger(
          config.timeoutSeconds,
          300,
          300,
          "proprio_runner_aws_agentcore_timeout_invalid",
          "AWS AgentCore timeoutSeconds",
        ),
      },
    };
  }
  const effort = config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort;
  const allowedEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (effort !== undefined && effort !== null && effort !== "" && (
    typeof effort !== "string" || !allowedEfforts.includes(effort)
    || (profile.model && isCodexLocalKnownModel(profile.model)
      && !codexLocalReasoningEffortsForModel(profile.model).includes(effort as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"))
  )) {
    throw new ProprioRunnerProviderProfileError(
      "proprio_runner_codex_effort_invalid",
      "Proprio Runner Codex reasoning effort is not supported for this model.",
    );
  }
  return {
    provider: "codex",
    model: compatibleCodexModel(profile.model, input.codexCliVersion ?? null),
    ...(preconfigured ? { homeMode: "preconfigured" as const } : {}),
    codexApprovalPolicy: resolveProprioRunnerPermissionMode(
      "codex",
      config.codexPermissionMode,
    ) as "never" | "on-request" | "untrusted",
    ...(typeof effort === "string" && effort ? { codexReasoningEffort: effort } : {}),
    ...(config.search === false ? { codexWebSearch: "disabled" as const } : {}),
  };
}
