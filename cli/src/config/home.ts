import path from "node:path";
import {
  expandHomePrefix,
  resolveDefaultBackupDir as resolveSharedDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir as resolveSharedDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir as resolveSharedDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath as resolveSharedDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir as resolveSharedDefaultStorageDir,
  resolveHomeAwarePath,
  resolveProprioConfigPathForInstance,
  resolveProprioHomeDir,
  resolveProprioInstanceId,
  resolveProprioInstanceRoot as resolveSharedProprioInstanceRoot,
} from "@groktopus/shared/home-paths";

export {
  expandHomePrefix,
  resolveHomeAwarePath,
  resolveProprioHomeDir,
  resolveProprioInstanceId,
};

export function resolveProprioInstanceRoot(instanceId?: string): string {
  return resolveSharedProprioInstanceRoot({ instanceId });
}

export function resolveDefaultConfigPath(instanceId?: string): string {
  return resolveProprioConfigPathForInstance({ instanceId });
}

export function resolveDefaultContextPath(): string {
  return path.resolve(resolveProprioHomeDir(), "context.json");
}

export function resolveDefaultCliAuthPath(): string {
  return path.resolve(resolveProprioHomeDir(), "auth.json");
}

export function resolveDefaultEmbeddedPostgresDir(instanceId?: string): string {
  return resolveSharedDefaultEmbeddedPostgresDir({ instanceId });
}

export function resolveDefaultLogsDir(instanceId?: string): string {
  return resolveSharedDefaultLogsDir({ instanceId });
}

export function resolveDefaultSecretsKeyFilePath(instanceId?: string): string {
  return resolveSharedDefaultSecretsKeyFilePath({ instanceId });
}

export function resolveDefaultStorageDir(instanceId?: string): string {
  return resolveSharedDefaultStorageDir({ instanceId });
}

export function resolveDefaultBackupDir(instanceId?: string): string {
  return resolveSharedDefaultBackupDir({ instanceId });
}

export function describeLocalInstancePaths(instanceId?: string) {
  const resolvedInstanceId = resolveProprioInstanceId(instanceId);
  const instanceRoot = resolveProprioInstanceRoot(resolvedInstanceId);
  return {
    homeDir: resolveProprioHomeDir(),
    instanceId: resolvedInstanceId,
    instanceRoot,
    configPath: resolveDefaultConfigPath(resolvedInstanceId),
    embeddedPostgresDataDir: resolveDefaultEmbeddedPostgresDir(resolvedInstanceId),
    backupDir: resolveDefaultBackupDir(resolvedInstanceId),
    logDir: resolveDefaultLogsDir(resolvedInstanceId),
    secretsKeyFilePath: resolveDefaultSecretsKeyFilePath(resolvedInstanceId),
    storageDir: resolveDefaultStorageDir(resolvedInstanceId),
  };
}
