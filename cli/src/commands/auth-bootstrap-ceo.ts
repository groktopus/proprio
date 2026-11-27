import { createHash, randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq, gt, isNull } from "drizzle-orm";
import { createDb, instanceUserRoles, invites } from "@groktopus/db";
import { DEPLOYMENT_MODES, inferBindModeFromHost, parseDeploymentExposure, resolveDeploymentMode } from "@groktopus/shared";
import { loadDeploymentEnv } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createInviteToken() {
  return `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
}

function resolveDbUrl(configPath?: string, explicitDbUrl?: string) {
  if (explicitDbUrl) return explicitDbUrl;
  const config = readConfig(configPath);
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  if (config?.database.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return `postgres://proprio:proprio@127.0.0.1:${port}/proprio`;
  }
  return null;
}

type BaseUrlResolution = { url: string; explicit: boolean };

function resolveBaseUrl(configPath?: string, explicitBaseUrl?: string): BaseUrlResolution {
  const normalize = (value: string, source: string) => {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(source + " must be an HTTP or HTTPS URL without credentials, query, or fragment");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      value.trim().includes("?") ||
      value.trim().includes("#")
    ) {
      throw new Error(source + " must be an HTTP or HTTPS URL without credentials, query, or fragment");
    }
    return value.trim().replace(/\/+$/, "");
  };
  const configured = explicitBaseUrl?.trim()
    ? { value: explicitBaseUrl, source: "--base-url" }
    : [
        { value: process.env.PROPRIO_PUBLIC_URL, source: "Configured public base URL" },
        { value: process.env.PROPRIO_AUTH_PUBLIC_BASE_URL, source: "Configured public base URL" },
        { value: process.env.BETTER_AUTH_URL, source: "Configured public base URL" },
        { value: process.env.BETTER_AUTH_BASE_URL, source: "Configured public base URL" },
      ].find(candidate => candidate.value?.trim());
  if (configured?.value?.trim()) {
    return { url: normalize(configured.value, configured.source), explicit: true };
  }
  const config = readConfig(configPath);
  if (config?.auth.baseUrlMode === "explicit" && config.auth.publicBaseUrl) {
    return { url: normalize(config.auth.publicBaseUrl, "Saved public base URL"), explicit: true };
  }
  const bind = config?.server.bind ?? inferBindModeFromHost(config?.server.host);
  const host = process.env.HOST?.trim() || (
    bind === "custom"
      ? config?.server.customBindHost ?? config?.server.host ?? "localhost"
      : config?.server.host ?? "localhost"
  );
  const port = Number(process.env.PORT) || config?.server.port || 3100;
  const publicHost = host === "0.0.0.0" || bind === "lan" ? "localhost" : host;
  return { url: normalize("http://" + publicHost + ":" + port, "Resolved public base URL"), explicit: false };
}

export async function bootstrapCeoInvite(opts: {
  config?: string;
  force?: boolean;
  expiresHours?: number;
  baseUrl?: string;
  dbUrl?: string;
}) {
  const configPath = resolveConfigPath(opts.config);
  loadDeploymentEnv(configPath);
  const config = readConfig(configPath);
  const deploymentExposure = parseDeploymentExposure(process.env.PROPRIO_DEPLOYMENT_EXPOSURE) ??
    config?.server.exposure ?? "private";
  const configuredMode = config?.server.deploymentMode;
  const modeFromEnv = process.env.PROPRIO_DEPLOYMENT_MODE?.trim() || undefined;
  if (modeFromEnv && !(DEPLOYMENT_MODES as readonly string[]).includes(modeFromEnv)) {
    throw new Error("PROPRIO_DEPLOYMENT_MODE must be authenticated or local_trusted");
  }
  if (!config && !modeFromEnv) {
    p.log.error(`No config found at ${configPath}. Set PROPRIO_DEPLOYMENT_MODE to match the running deployment.`);
    process.exitCode = 1;
    return;
  }

  const effectiveMode = resolveDeploymentMode(modeFromEnv, configuredMode);
  if (configuredMode && configuredMode !== effectiveMode) {
    p.log.error(
      `Deployment mode differs: ${configPath} selects ${configuredMode} but PROPRIO_DEPLOYMENT_MODE selects ${effectiveMode}. Match the saved setting to the running service and retry.`,
    );
    process.exitCode = 1;
    return;
  }

  if (effectiveMode !== "authenticated") {
    p.log.info("Deployment mode is local_trusted. Bootstrap CEO invite is only required for authenticated mode.");
    return;
  }

  const baseUrl = resolveBaseUrl(configPath, opts.baseUrl);
  if (!config && deploymentExposure === "public" && !baseUrl.explicit) {
    p.log.error("Could not resolve the public base URL for bootstrap. Set PROPRIO_PUBLIC_URL or pass --base-url.");
    process.exitCode = 1;
    return;
  }
  if (deploymentExposure === "public" && new URL(baseUrl.url).protocol !== "https:") {
    throw new Error("Public bootstrap invite URLs must use HTTPS.");
  }

  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error("Could not resolve database connection for bootstrap. Set DATABASE_URL or configure a database with proprio onboard.");
    process.exitCode = 1;
    return;
  }

  let closableDb: ReturnType<typeof createDb> | undefined;
  try {
    closableDb = createDb(dbUrl);
    const db = closableDb;
    const existingAdminCount = await db
      .select()
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .then((rows) => rows.length);

    if (existingAdminCount > 0 && !opts.force) {
      p.log.info("Instance already has an admin user. Use --force to generate a new bootstrap invite.");
      return;
    }

    const now = new Date();
    await db
      .update(invites)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(invites.inviteType, "bootstrap_ceo"),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
        ),
      );

    const token = createInviteToken();
    const expiresHours = Math.max(1, Math.min(24 * 30, opts.expiresHours ?? 72));
    const created = await db
      .insert(invites)
      .values({
        inviteType: "bootstrap_ceo",
        tokenHash: hashToken(token),
        allowedJoinTypes: "human",
        expiresAt: new Date(Date.now() + expiresHours * 60 * 60 * 1000),
        invitedByUserId: "system",
      })
      .returning()
      .then((rows) => rows[0]);

    const inviteUrl = baseUrl.url + "/invite/" + token;
    p.log.success("Created bootstrap CEO invite.");
    p.log.message(`Invite URL: ${pc.cyan(inviteUrl)}`);
    p.log.message(`Expires: ${pc.dim(created.expiresAt.toISOString())}`);
  } catch {
    p.log.error("Could not create bootstrap invite. Check the database connection and try again.");
    p.log.info("If using embedded-postgres, start the Proprio server and run this command again.");
    process.exitCode = 1;
  } finally {
    await closableDb?.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
