import os from "node:os";
import path from "node:path";

export const DEFAULT_PROPRIO_INSTANCE_ID = "default";
export const PROPRIO_CONFIG_BASENAME = "config.json";
export const PROPRIO_ENV_FILENAME = ".env";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveProprioHomeDir(homeOverride?: string): string {
  const raw = homeOverride?.trim() || process.env.PROPRIO_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return path.resolve(os.homedir(), ".proprio");
}

export function resolveProprioInstanceId(instanceIdOverride?: string): string {
  const raw = instanceIdOverride?.trim() || process.env.PROPRIO_INSTANCE_ID?.trim() || DEFAULT_PROPRIO_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid PROPRIO_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveProprioInstanceRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveProprioHomeDir(input.homeDir), "instances", resolveProprioInstanceId(input.instanceId));
}

export function resolveProprioInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveProprioInstanceRoot(input), PROPRIO_CONFIG_BASENAME);
}

export function resolveProprioConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return resolveProprioInstanceConfigPath(input);
}

export function resolveProprioEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), PROPRIO_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveProprioInstanceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveProprioInstanceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveProprioInstanceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveProprioInstanceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveProprioInstanceRoot(input), "data", "backups");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
