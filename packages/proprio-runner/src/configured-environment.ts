import { AGENT_OBSERVABILITY_ENV_KEYS } from "./drivers/agent-observability.js";
/** Names minted by the controller from the resolved task configuration.
 * Values remain in the process environment, never in argv or this manifest.
 * Do not mint this projection from ambient process.env.
 */
export const CONFIGURED_ENVIRONMENT_KEYS = "PROPRIO_CONFIGURED_ENV_KEYS";
/** Names, never values, of configured entries the controller resolved from secrets. */
export const SECRET_ENVIRONMENT_KEYS = "PROPRIO_SECRET_ENV_KEYS";

/** Certificate-trust variable names preserved across environment policies.
 * Sandboxes inject these at execution time, after controller-side policy
 * construction, so policies allow the names even when no value exists yet.
 * Values stay in the process environment, never in argv or configuration. */
export const CERTIFICATE_ENVIRONMENT_KEYS = [
  "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS",
  "DENO_CERT", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
] as const;

export const GENERATED_RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  CONFIGURED_ENVIRONMENT_KEYS,
  SECRET_ENVIRONMENT_KEYS,
  ...AGENT_OBSERVABILITY_ENV_KEYS,
  "PROPRIO_AGENT_ID", "PROPRIO_AGENT_KEY_ID", "PROPRIO_AGENT_PUBLIC_KEY", "PROPRIO_AGENT_PRIVATE_KEY",
  "PROPRIO_API_KEY", "PROPRIO_API_URL", "PROPRIO_API_BRIDGE_MODE", "PROPRIO_COMPANY_ID", "PROPRIO_INSTANCE_ID",
  "PROPRIO_RUNTIME_NOTIFICATION_HELPER", "PROPRIO_RUNTIME_NOTIFICATION_CONTEXT", "PROPRIO_RUN_ID", "PROPRIO_NORMALIZED_SESSION_ID", "PROPRIO_RUNNER_INSTANCE_ID", "PROPRIO_RUNNER_BOOTSTRAP_TICKET", "PROPRIO_TASK_ID", "PROPRIO_APPROVAL_ID", "PROPRIO_APPROVAL_STATUS", "PROPRIO_LINKED_ISSUE_IDS",
  "PROPRIO_WAKE_REASON", "PROPRIO_WAKE_COMMENT_ID", "PROPRIO_WAKE_PAYLOAD_JSON", "PROPRIO_EXECUTION_MODE",
  "PROPRIO_WORKSPACES_JSON", "PROPRIO_WORKSPACE_ID", "PROPRIO_WORKSPACE_CWD", "PROPRIO_WORKSPACE_SOURCE",
  "PROPRIO_WORKSPACE_REPO_URL", "PROPRIO_WORKSPACE_REPO_REF", "PROPRIO_WORKSPACE_BRANCH",
  "PROPRIO_WORKSPACE_WORKTREE_PATH", "PROPRIO_WORKSPACE_REALIZATION_MODE", "PROPRIO_WORKSPACE_AUTHORITATIVE_ROOT",
  "PROPRIO_RUNTIME_PRIMARY_URL", "PROPRIO_RUNTIME_SERVICES_JSON", "PROPRIO_RUNTIME_SERVICE_INTENTS_JSON",
  "PROPRIO_AGENT_MESSAGE_KEY", "PROPRIO_HARNESS_CHECKOUT_KEY", "PROPRIO_EXTERNAL_CHAT_EXECUTION_BOUND_KEY",
  "PROPRIO_NATIVE_MCP_STDIO", "PROPRIO_NATIVE_MCP_PROXY",
  "PROPRIO_NATIVE_MCP_NAME", "PROPRIO_NATIVE_MCP_URL", "PROPRIO_NATIVE_MCP_TOKEN", "PROPRIO_AI_PROVIDER_KEY",
  "PROPRIO_PROVIDER_TRACE_PATH", "PROPRIO_PROVIDER_TRACE_MAX_BYTES", "PROPRIO_ACPX_CREDENTIAL_BINDING",
  "PROPRIO_RUNNER_NETWORK_ACCESS", "PROPRIO_RUNNER_NETWORK_ROOTS", "PROPRIO_RUNNER_EXTERNAL_SANDBOX",
  "PROPRIO_GITHUB_AUTH_MODE", "PROPRIO_GITHUB_HOST_HOME", "PROPRIO_GIT_METADATA_ROOTS",
  "PROPRIO_GITHUB_BROKER_TOKEN", "PROPRIO_GITHUB_BROKER_URL", "PROPRIO_GITHUB_BRIDGE_TOKEN", "PROPRIO_GITHUB_LAUNCHER_DIR",
]);

export const PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS: readonly string[] = [
  "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK", "OPENROUTER_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN", "KIMI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PROPRIO_GIT_TOKEN",
];

const RESERVED_KEYS = new Set([
  "PATH", "HOME", "USERPROFILE", "CODEX_HOME", "AGENT_HOME", "SHELL", "NODE_OPTIONS", "NODE_PATH",
  "PYTHONPATH", "PYTHONHOME", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "BASH_ENV", "ENV", "ZDOTDIR", "GH_CONFIG_DIR",
  ...PROVIDER_CREDENTIAL_ENVIRONMENT_KEYS,
]);

function eligibleKey(key: string): boolean {
  const upper = key.toUpperCase();
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
    && !GENERATED_RUNTIME_ENVIRONMENT_KEYS.has(upper)
    && !RESERVED_KEYS.has(upper)
    && !/^(?:LD_|DYLD_|GIT_CONFIG_|PROPRIO_(?:RUNNER_|NATIVE_|GITHUB_|ACPX_|CURSOR_CLOUD_|VERIFIED_))/.test(upper);
}

function checkedNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length > 128 || names.some(name => typeof name !== "string" || !eligibleKey(name))
    || new Set(names).size !== names.length) throw new Error("Invalid configured environment projection");
  return (names as string[]).sort();
}

/** Mint at the server's resolved configuration boundary, before host inheritance.
 * `secretKeys` marks which configured entries came from secrets; only their
 * names cross the boundary, beside the values the projection already carries. */
export function configuredEnvironmentProjection(source: NodeJS.ProcessEnv, secretKeys: Iterable<string> = []): NodeJS.ProcessEnv {
  const names = checkedNames(Object.keys(source).filter(key => source[key] !== undefined && eligibleKey(key)));
  const projection = configuredEnvironment({ ...source, [CONFIGURED_ENVIRONMENT_KEYS]: JSON.stringify(names) });
  const secret = new Set(secretKeys);
  const secretNames = names.filter(name => secret.has(name) && projection[name] !== "");
  if (secretNames.length > 0) projection[SECRET_ENVIRONMENT_KEYS] = JSON.stringify(secretNames);
  return projection;
}

/**
 * Configured secret names and values for output custody. A projection from a
 * controller that predates this marker carries none. A malformed marker is
 * refused rather than read as "no secrets".
 */
export function configuredSecretEnvironment(source: NodeJS.ProcessEnv | undefined): Array<{ name: string; value: string }> {
  const raw = source?.[SECRET_ENVIRONMENT_KEYS];
  if (raw === undefined) return [];
  const configured = configuredEnvironment(source);
  let names: string[];
  try {
    if (Buffer.byteLength(raw) > 20_000) throw new Error("oversized");
    names = checkedNames(JSON.parse(raw));
  } catch { throw new Error("Invalid secret environment projection"); }
  // Boundaries may narrow the configured projection after minting; a secret
  // entry that no longer crosses has no value to protect.
  return names.flatMap(name => typeof configured[name] === "string" && configured[name] !== "" ? [{ name, value: configured[name]! }] : []);
}

/** Accept only an explicitly supplied, controller-minted projection. */
export function configuredEnvironment(source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const raw = source?.[CONFIGURED_ENVIRONMENT_KEYS];
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw) > 20_000) throw new Error("Invalid configured environment projection");
  let names: string[];
  try { names = checkedNames(JSON.parse(raw)); } catch { throw new Error("Invalid configured environment projection"); }
  const result: NodeJS.ProcessEnv = {};
  let bytes = 0;
  for (const name of names) {
    const value = source?.[name];
    if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid configured environment value");
    const size = Buffer.byteLength(name) + Buffer.byteLength(value);
    bytes += size;
    if (size > 65_536 || bytes > 262_144) throw new Error("Configured environment exceeds its bounded launch size");
    result[name] = value;
  }
  result[CONFIGURED_ENVIRONMENT_KEYS] = JSON.stringify(names);
  // The secret-name marker travels with the projection it describes.
  const secret = source?.[SECRET_ENVIRONMENT_KEYS];
  if (secret !== undefined) result[SECRET_ENVIRONMENT_KEYS] = secret;
  return result;
}

export function configuredEnvironmentKeys(source: NodeJS.ProcessEnv | undefined): string[] {
  return Object.keys(configuredEnvironment(source)).filter(key => key !== CONFIGURED_ENVIRONMENT_KEYS && key !== SECRET_ENVIRONMENT_KEYS).sort();
}
