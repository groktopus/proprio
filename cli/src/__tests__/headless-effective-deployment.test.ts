import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as prompts from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDeploymentMode } from "../../../server/src/config-file.js";
import { bootstrapCeoInvite } from "../commands/auth-bootstrap-ceo.js";
import { onboard } from "../commands/onboard.js";
import type { ProprioConfig } from "../config/schema.js";

const createDb = vi.hoisted(() => vi.fn(() => { throw new Error("Any DB access is prohibited in this fixture"); }));
vi.mock("@groktopus/db", async importOriginal => ({
  ...await importOriginal<typeof import("@groktopus/db")>(), createDb,
}));
vi.mock("../commands/run.js", () => ({
  runCommand: vi.fn(() => { throw new Error("A server start is prohibited in this fixture"); }),
}));

describe("headless onboarding effective deployment contract", () => {
  let root: string;
  let config: string;
  let originalExitCode: typeof process.exitCode;
  const cwd = process.cwd();
  beforeEach(() => {
    originalExitCode = process.exitCode;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "proprio-effective-deployment-"));
    config = path.join(root, "instance", "config.json");
    process.chdir(root);
    for (const key of ["DATABASE_URL", "HOST", "PORT", "PROPRIO_CONFIG", "PROPRIO_INSTANCE_ID", "PROPRIO_BIND",
      "PROPRIO_DISABLE_CWD_ENV_FILE", "PROPRIO_BIND_HOST", "PROPRIO_TAILNET_BIND_HOST", "PROPRIO_DEPLOYMENT_MODE", "PROPRIO_DEPLOYMENT_EXPOSURE",
      "PROPRIO_PUBLIC_URL", "PROPRIO_AUTH_PUBLIC_BASE_URL", "PROPRIO_AUTH_BASE_URL_MODE", "PROPRIO_AUTH_DISABLE_SIGN_UP",
      "PROPRIO_AGENT_JWT_SECRET", "PROPRIO_TOOL_ACTION_SIGNING_SECRET", "PROPRIO_SECRETS_MASTER_KEY",
      "PROPRIO_SECRETS_MASTER_KEY_FILE", "BETTER_AUTH_URL", "BETTER_AUTH_BASE_URL"]) vi.stubEnv(key, undefined);
    vi.stubEnv("PROPRIO_HOME", path.join(root, "home"));
    createDb.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = originalExitCode;
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function saved() {
    return JSON.parse(fs.readFileSync(config, "utf8")) as ProprioConfig;
  }

  it("persists the server's explicit authenticated mode without inferring LAN for unattended setup", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    await onboard({ config, yes: true, invokedByRun: true });
    const raw = saved();
    expect(resolveDeploymentMode(raw)).toBe("authenticated");
    expect(raw.server).toMatchObject({ deploymentMode: "authenticated", bind: "loopback", host: "127.0.0.1" });
    expect(createDb).not.toHaveBeenCalled();
  });

  it("preserves explicit loopback, authenticated mode, exposure, and public URL together", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("PROPRIO_DEPLOYMENT_EXPOSURE", "public");
    vi.stubEnv("PROPRIO_AUTH_BASE_URL_MODE", "explicit");
    vi.stubEnv("PROPRIO_PUBLIC_URL", "https://proprio.example.invalid");
    vi.stubEnv("PROPRIO_AUTH_DISABLE_SIGN_UP", "true");
    await onboard({ config, yes: true, invokedByRun: true, bind: "loopback" });
    const raw = saved();
    expect(raw.server).toMatchObject({
      deploymentMode: resolveDeploymentMode(raw), exposure: "public", bind: "loopback", host: "127.0.0.1",
    });
    expect(raw.auth).toMatchObject({ baseUrlMode: "explicit", disableSignUp: true, publicBaseUrl: "https://proprio.example.invalid" });
    expect(createDb).not.toHaveBeenCalled();
  });

  it("refuses contradictory trusted-local and CLI LAN inputs without writing config", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "local_trusted");
    await expect(onboard({ config, yes: true, invokedByRun: true, bind: "lan" })).rejects.toThrow(/local_trusted.*loopback/);
    expect(fs.existsSync(config)).toBe(false);
    expect(createDb).not.toHaveBeenCalled();
  });

  it("rejects contradictory bind sources before writing the config", async () => {
    vi.stubEnv("PROPRIO_BIND", "lan");
    await expect(onboard({ config, yes: true, invokedByRun: true, bind: "loopback" }))
      .rejects.toThrow("--bind=loopback conflicts with PROPRIO_BIND=lan");
    expect(fs.existsSync(config)).toBe(false);
  });

  it("keeps the default local-trusted, private and loopback with no deployment inputs", async () => {
    await onboard({ config, yes: true, invokedByRun: true });
    const raw = saved();
    expect(raw.server).toMatchObject({
      deploymentMode: "local_trusted", exposure: "private", bind: "loopback", host: "127.0.0.1",
    });
    expect(resolveDeploymentMode(raw)).toBe("local_trusted");
    expect(createDb).not.toHaveBeenCalled();
  });

  it("honors the working-directory env file in both bootstrap entry points", async () => {
    fs.writeFileSync(path.join(root, ".env"), "PROPRIO_DEPLOYMENT_MODE=authenticated\n");
    await onboard({ config, yes: true, invokedByRun: true });
    expect(saved().server.deploymentMode).toBe("authenticated");
  });

  it("detects a working-directory mode override when the invite command starts fresh", async () => {
    await onboard({ config, yes: true, invokedByRun: true });
    fs.writeFileSync(path.join(root, ".env"), "PROPRIO_DEPLOYMENT_MODE=authenticated\n");
    const denial = vi.spyOn(prompts.log, "error").mockImplementation(() => {});
    await bootstrapCeoInvite({ config });
    expect(denial).toHaveBeenCalledWith(expect.stringContaining("PROPRIO_DEPLOYMENT_MODE selects authenticated"));
    expect(createDb).not.toHaveBeenCalled();
  });

  it("rejects an invalid deployment exposure before writing config or invites", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("PROPRIO_DEPLOYMENT_EXPOSURE", "invalid");
    await expect(onboard({ config, yes: true, invokedByRun: true })).rejects.toThrow("PROPRIO_DEPLOYMENT_EXPOSURE");
    expect(fs.existsSync(config)).toBe(false);
    await expect(bootstrapCeoInvite({ config })).rejects.toThrow("PROPRIO_DEPLOYMENT_EXPOSURE");
    expect(createDb).not.toHaveBeenCalled();
  });

  it("allows the invite command to reach the database for the newly saved authenticated mode", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("DATABASE_URL", "postgres://compose-secret@db:5432/proprio");
    await onboard({ config, yes: true, invokedByRun: true });
    createDb.mockClear();
    const denial = vi.spyOn(prompts.log, "error").mockImplementation(() => {});
    await bootstrapCeoInvite({ config });
    expect(createDb).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(denial.mock.calls.flat().join(" ")).toMatch(/Could not create bootstrap invite/);
    expect(denial.mock.calls.flat().join(" ")).not.toContain("Any DB access is prohibited");
  });

  it("creates the first admin invite from authenticated Compose environment without a saved config", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("PROPRIO_DEPLOYMENT_EXPOSURE", "public");
    vi.stubEnv("DATABASE_URL", "postgres://compose-secret@db:5432/proprio");
    vi.stubEnv("PROPRIO_PUBLIC_URL", "https://proprio.example.invalid/");
    const inserted: Array<Record<string, unknown>> = [];
    createDb.mockReturnValue({
      select: () => ({ from: () => ({ where: async () => [] }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => ({
        returning: async () => { inserted.push(value); return [{ expiresAt: new Date("2030-01-01T00:00:00.000Z") }]; },
      }) }),
      $client: { end: vi.fn(async () => undefined) },
    } as never);
    const invite = vi.spyOn(prompts.log, "message").mockImplementation(() => {});

    await bootstrapCeoInvite({});

    expect(createDb).toHaveBeenCalledWith("postgres://compose-secret@db:5432/proprio");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ inviteType: "bootstrap_ceo", allowedJoinTypes: "human", invitedByUserId: "system" });
    expect(invite).toHaveBeenCalledWith(expect.stringContaining("https://proprio.example.invalid/invite/pcp_bootstrap_"));
    expect(invite.mock.calls.flat().join(" ")).not.toContain("compose-secret");
  });

  it("uses the first nonblank public URL source when the primary variable is blank", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("PROPRIO_DEPLOYMENT_EXPOSURE", "public");
    vi.stubEnv("DATABASE_URL", "postgres://compose-secret@db:5432/proprio");
    vi.stubEnv("PROPRIO_PUBLIC_URL", "  ");
    vi.stubEnv("PROPRIO_AUTH_PUBLIC_BASE_URL", "https://fallback.example.invalid/");
    createDb.mockReturnValue({
      select: () => ({ from: () => ({ where: async () => [] }) }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      insert: () => ({ values: () => ({ returning: async () => [{ expiresAt: new Date("2030-01-01T00:00:00.000Z") }] }) }),
      $client: { end: vi.fn(async () => undefined) },
    } as never);
    const invite = vi.spyOn(prompts.log, "message").mockImplementation(() => {});

    await bootstrapCeoInvite({});

    expect(invite).toHaveBeenCalledWith(expect.stringContaining("https://fallback.example.invalid/invite/pcp_bootstrap_"));
  });

  it("fails nonzero when a configless bootstrap has no explicit deployment mode", async () => {
    const denial = vi.spyOn(prompts.log, "error").mockImplementation(() => {});
    await bootstrapCeoInvite({});
    expect(createDb).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(denial.mock.calls.flat().join(" ")).toMatch(/PROPRIO_DEPLOYMENT_MODE/);
  });

  it("fails nonzero when environment-backed authenticated bootstrap has no database URL", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    const denial = vi.spyOn(prompts.log, "error").mockImplementation(() => {});
    await bootstrapCeoInvite({});
    expect(createDb).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(denial.mock.calls.flat().join(" ")).toMatch(/DATABASE_URL/);
  });

  it("requires a public URL for a configless authenticated public bootstrap", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("PROPRIO_DEPLOYMENT_EXPOSURE", "public");
    vi.stubEnv("DATABASE_URL", "postgres://db:5432/proprio");
    const denial = vi.spyOn(prompts.log, "error").mockImplementation(() => {});
    await bootstrapCeoInvite({});
    expect(createDb).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(denial.mock.calls.flat().join(" ")).toMatch(/PROPRIO_PUBLIC_URL.*--base-url/);
  });

  it("fails nonzero without printing credentials when invite creation fails", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("DATABASE_URL", "postgres://do-not-print:secret@db:5432/proprio");
    createDb.mockReturnValue({
      select: () => ({ from: () => ({ where: async () => { throw new Error("postgres://do-not-print:secret@db:5432/proprio unavailable"); } }) }),
      $client: { end: vi.fn(async () => undefined) },
    } as never);
    const denial = vi.spyOn(prompts.log, "error").mockImplementation(() => {});

    await bootstrapCeoInvite({});

    expect(process.exitCode).toBe(1);
    expect(denial.mock.calls.flat().join(" ")).toContain("Could not create bootstrap invite");
    expect(denial.mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it("rejects an invalid environment-backed deployment mode before database access", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "invalid");
    await expect(bootstrapCeoInvite({})).rejects.toThrow("PROPRIO_DEPLOYMENT_MODE must be authenticated or local_trusted");
    expect(createDb).not.toHaveBeenCalled();
  });

  it("rejects an invalid public URL before database access without echoing credentials", async () => {
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("PROPRIO_DEPLOYMENT_EXPOSURE", "public");
    vi.stubEnv("PROPRIO_PUBLIC_URL", "https://admin:secret@example.invalid");
    vi.stubEnv("DATABASE_URL", "postgres://compose-secret@db:5432/proprio");
    await expect(bootstrapCeoInvite({})).rejects.toThrow("HTTP or HTTPS URL without credentials");
    expect(createDb).not.toHaveBeenCalled();
  });

  it("reports a stale bootstrap configuration without creating or revoking invites", async () => {
    await onboard({ config, yes: true, invokedByRun: true });
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "authenticated");
    const denial = vi.spyOn(prompts.log, "error").mockImplementation(() => {});
    await bootstrapCeoInvite({ config });
    expect(createDb).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(denial.mock.calls.flat().join(" ")).toMatch(/mode|configuration/i);
  });
  it("refuses to use stored authenticated mode if the environment explicitly selects trusted local", async () => {
    await onboard({ config, yes: true, invokedByRun: true });
    const raw = saved();
    raw.server.deploymentMode = "authenticated";
    fs.writeFileSync(config, JSON.stringify(raw), { mode: 0o600 });
    vi.stubEnv("PROPRIO_DEPLOYMENT_MODE", "local_trusted");
    const denial = vi.spyOn(prompts.log, "error").mockImplementation(() => {});
    await bootstrapCeoInvite({ config });
    expect(createDb).not.toHaveBeenCalled();
    expect(denial.mock.calls.flat().join(" ")).toMatch(/mode|configura/i);
  });
});
