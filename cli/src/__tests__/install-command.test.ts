import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CommandRunner,
  installCommand,
  installGitPayload,
  resolveGitHubRef,
  resolveGitInstallRequest,
  resolveGitInstallWorkspacePackages,
  resolveNpmInstallRequest,
  resolvePublishedVersion,
  runCommandWithDiagnostics,
} from "../commands/install.js";
import { uninstallCommand } from "../commands/uninstall.js";
import { resolveProprioInstanceId } from "../config/home.js";
import {
  INSTALL_MANIFEST_VERSION,
  flipCurrentAtomic,
  initializeInstallStore,
  payloadPathFor,
  readInstallManifest,
  resolveInstallStorePaths,
  withInstallStoreLock,
  writeInstallManifestAtomic,
} from "../install-store.js";
import { resolveCliVersion } from "../version.js";
import { systemdServiceName } from "../services/service-manager.js";

const ORIGINAL_ENV = { ...process.env };

describe("managed install commands", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "proprio-install-command-"));
    process.env = {
      ...ORIGINAL_ENV,
      HOME: path.join(root, "home"),
      PROPRIO_HOME: path.join(root, "home", ".proprio"),
      PATH: path.join(root, "bin"),
      SHELL: "/bin/bash",
    };
    fs.mkdirSync(process.env.HOME!, { recursive: true });
    fs.mkdirSync(process.env.PATH!, { recursive: true });
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(root, { recursive: true, force: true });
  });

  function stageFakeCorepack() {
    // Presence marker only. The Git packaging tests stub every command.
    const executable = path.join(process.env.PATH!, "corepack");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    return executable;
  }

  it("selects stable, canary, and exact-version npm sources", () => {
    expect(resolveNpmInstallRequest({})).toEqual({ spec: "latest", channel: "latest" });
    expect(resolveNpmInstallRequest({ canary: true })).toEqual({ spec: "canary", channel: "canary" });
    expect(resolveNpmInstallRequest({ version: "2026.720.0" })).toEqual({
      spec: "2026.720.0",
      channel: "pinned",
    });
    expect(() => resolveNpmInstallRequest({ canary: true, version: "1.2.3" })).toThrow();
    expect(() => resolveNpmInstallRequest({ version: "latest" })).toThrow();
  });

  it("parses npm view version output from npm 11 and npm 12", async () => {
    for (const stdout of ['"2026.916.1"\n', '[\n  "2026.916.1"\n]\n', "2026.916.1\n"]) {
      const runCommand = vi.fn(async () => ({ stdout, stderr: "" }));
      await expect(resolvePublishedVersion("latest", runCommand)).resolves.toBe("2026.916.1");
    }
    const multiple = vi.fn(async () => ({ stdout: '["2026.916.0","2026.916.1"]', stderr: "" }));
    await expect(resolvePublishedVersion("latest", multiple)).rejects.toThrow("unexpected version response");
  });

  it("resolves branch, tag, full SHA, and short SHA refs through GitHub", async () => {
    const sha = "a".repeat(40);
    const runCommand = vi.fn(async (_file: string, _args: string[]) => ({ stdout: JSON.stringify({ sha }), stderr: "" }));
    for (const ref of ["master", "v1.2.3", sha, sha.slice(0, 12)]) {
      await expect(resolveGitHubRef("groktopus/proprio", ref, runCommand)).resolves.toBe(sha);
    }
    expect(runCommand.mock.calls.map((call) => call[1].at(-1))).toEqual([
      "https://api.github.com/repos/paperclipai/paperclip/commits/master",
      "https://api.github.com/repos/paperclipai/paperclip/commits/v1.2.3",
      `https://api.github.com/repos/paperclipai/paperclip/commits/${sha}`,
      `https://api.github.com/repos/paperclipai/paperclip/commits/${sha.slice(0, 12)}`,
    ]);
  });

  it("supports fork overrides and classifies SHA refs as pinned", () => {
    expect(resolveGitInstallRequest({ ref: "feature/test", repo: "HenkDz/proprio" })).toEqual({ repo: "HenkDz/proprio", ref: "feature/test", pinned: false });
    expect(resolveGitInstallRequest({ ref: "abcdef1" })).toEqual({ repo: "groktopus/proprio", ref: "abcdef1", pinned: true });
    expect(() => resolveGitInstallRequest({ repo: "HenkDz/proprio" })).toThrow("requires --ref");
  });

  it("requires explicit non-interactive consent before resolving git refs", async () => {
    const runCommand = vi.fn();

    await expect(installCommand({ ref: "master", repo: "HenkDz/proprio" }, { runCommand }))
      .rejects.toThrow("Re-run with --yes");

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("reuses a SHA-keyed git payload without downloading or rebuilding", async () => {
    const sha = "b".repeat(40);
    const paths = resolveInstallStorePaths();
    const payloadPath = payloadPathFor(paths, "git", sha.slice(0, 12));
    const packageRoot = path.join(payloadPath, "node_modules", "proprio");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.3.1" }));
    fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "#!/usr/bin/env node\n");
    const runCommand = vi.fn(async (_file: string, _args: string[]) => ({ stdout: "0.3.1\n", stderr: "" }));
    await expect(installGitPayload("groktopus/proprio", sha, runCommand, paths)).resolves.toEqual({ payloadPath, reused: true, version: "0.3.1" });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0]?.[0]).toBe(process.execPath);
  });

  const createGitCheckoutRunCommand = (sha: string) =>
    vi.fn(async (file: string, args: string[], _options?: Parameters<CommandRunner>[2]) => {
      if (file === "curl" && !args.includes("--output")) return { stdout: JSON.stringify({ sha }), stderr: "" };
      if (file === "curl") { fs.writeFileSync(args[args.indexOf("--output") + 1], "archive"); return { stdout: "", stderr: "" }; }
      if (file === "tar") {
        const checkout = args[args.indexOf("-C") + 1];
        const packages = [
          { dir: "packages/shared", name: "@groktopus/shared", packageJson: { name: "@groktopus/shared", version: "0.3.1" } },
          { dir: "packages/db", name: "@groktopus/db", packageJson: { name: "@groktopus/db", version: "0.3.1", dependencies: { "@groktopus/shared": "workspace:*" }, bundleDependencies: ["embedded-postgres"] } },
          { dir: "server", name: "@groktopus/server", packageJson: { name: "@groktopus/server", version: "0.3.1", dependencies: { "@groktopus/db": "workspace:*" } } },
        ];
        fs.mkdirSync(path.join(checkout, "cli"), { recursive: true });
        fs.writeFileSync(path.join(checkout, "cli", "package.json"), JSON.stringify({ version: "0.3.1" }));
        fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
        fs.writeFileSync(path.join(checkout, "scripts", "release-package-manifest.json"), JSON.stringify(packages.map(({ dir, name }) => ({ dir, name }))));
        for (const workspacePackage of packages) {
          fs.mkdirSync(path.join(checkout, workspacePackage.dir), { recursive: true });
          fs.writeFileSync(path.join(checkout, workspacePackage.dir, "package.json"), JSON.stringify(workspacePackage.packageJson));
        }
        return { stdout: "", stderr: "" };
      }
      if (path.basename(file) === "corepack") {
        if (args.includes("pack")) {
          const destination = args[args.indexOf("--pack-destination") + 1];
          const packageDir = args[args.indexOf("--dir") + 1];
          const packageName = packageDir === "server" ? "proprio-server" : "proprio-shared";
          fs.writeFileSync(path.join(destination, `${packageName}-0.3.1.tgz`), "package");
        }
        return { stdout: "", stderr: "" };
      }
      if (file === "bash") return { stdout: "", stderr: "" };
      if (file === "npm" && args[0] === "pack") {
        const packageName = args[1]?.includes("workspace-package-") ? "proprio-db" : "proprio";
        fs.writeFileSync(path.join(args[args.indexOf("--pack-destination") + 1], `${packageName}-0.3.1.tgz`), "package");
        return { stdout: "", stderr: "" };
      }
      if (file === "npm" && args[0] === "install") { const prefix = args[args.indexOf("--prefix") + 1]; const packageRoot = path.join(prefix, "node_modules", "proprio"); fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true }); fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.3.1" })); fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "#!/usr/bin/env node\n"); return { stdout: "", stderr: "" }; }
      if (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs")) {
        fs.mkdirSync(args[2], { recursive: true });
        fs.writeFileSync(path.join(args[2], "package.json"), JSON.stringify({ name: "@groktopus/db", version: "0.3.1" }));
        return { stdout: "", stderr: "" };
      }
      if (file === process.execPath) return { stdout: "0.3.1\n", stderr: "" };
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    });

  it.each(["missing", "directory", "non-executable file"])(
    "stops Git-source install before archive fetch or managed-store writes when Corepack is %s",
    async (state) => {
      const corepack = path.join(process.env.PATH!, "corepack");
      if (state === "directory") fs.mkdirSync(corepack);
      if (state === "non-executable file") fs.writeFileSync(corepack, "", { mode: 0o600 });
      const paths = resolveInstallStorePaths();
      const fixture = createGitCheckoutRunCommand("e".repeat(40));
      const runCommand = vi.fn(async (file: string, args: string[], options?: Parameters<CommandRunner>[2]) =>
        path.basename(file) === "corepack" ? runCommandWithDiagnostics(file, args, options) : fixture(file, args, options));

      await expect(installCommand({ ref: "main", yes: true }, { runCommand }))
        .rejects.toThrow(/requires Corepack on PATH.*corepack --version/);
      expect(runCommand.mock.calls.map(([file, args]) => [file, args.at(-1)])).toEqual([
        ["curl", "https://api.github.com/repos/groktopus/proprio/commits/main"],
      ]);
      expect(fs.existsSync(paths.proprioHome)).toBe(false);
      expect(fs.existsSync(paths.shimPath)).toBe(false);
    },
  );

  it("rejects a missing Corepack before the uncached Git payload builder writes or downloads", async () => {
    const paths = resolveInstallStorePaths();
    const runCommand = vi.fn(async () => { throw new Error("Unexpected attempt to run a command"); });

    await expect(installGitPayload("groktopus/proprio", "f".repeat(40), runCommand, paths))
      .rejects.toThrow("Git-source installation requires Corepack on PATH");
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.proprioHome)).toBe(false);
  });

  it("preserves filesystem resolution for symlink-relative PATH components", async () => {
    const usr = path.join(root, "usr");
    fs.mkdirSync(path.join(usr, "bin"), { recursive: true });
    fs.mkdirSync(path.join(usr, "local", "bin"), { recursive: true });
    const link = path.join(root, "merged-bin");
    fs.symlinkSync(path.join(usr, "bin"), link);
    process.env.PATH = path.join(usr, "local", "bin");
    const executable = stageFakeCorepack();
    process.env.PATH = `${link}/../local/bin`;

    const runCommand = createGitCheckoutRunCommand("9".repeat(40));
    await installCommand({ ref: "main", yes: true }, { runCommand });

    const corepackCalls = runCommand.mock.calls.filter(([file]) => path.basename(file) === "corepack");
    expect(corepackCalls).not.toHaveLength(0);
    for (const [file] of corepackCalls) {
      expect(path.isAbsolute(file)).toBe(true);
      expect(fs.realpathSync.native(file)).toBe(fs.realpathSync.native(executable));
    }
  });

  it("does not recreate the store if uninstall wins after cache discovery without Corepack", async () => {
    const sha = "8".repeat(40);
    const paths = resolveInstallStorePaths();
    const corepack = stageFakeCorepack();
    const fixture = createGitCheckoutRunCommand(sha);
    await installCommand({ ref: "main", yes: true }, { runCommand: fixture });
    fs.unlinkSync(corepack);

    const cachedPayload = payloadPathFor(paths, "git", sha.slice(0, 12));
    const exists = fs.existsSync.bind(fs);
    const withoutCorepack = createGitCheckoutRunCommand(sha);
    const observeCache = vi.spyOn(fs, "existsSync").mockImplementation((target) => {
      const present = exists(target);
      if (target === cachedPayload && present) {
        // Deterministically simulate the other process completing uninstall
        // immediately after this process observes the cache entry.
        fs.unlinkSync(paths.shimPath);
        fs.rmSync(paths.cliRoot, { recursive: true });
      }
      return present;
    });
    try {
      await expect(installCommand({ ref: "main", yes: true }, { runCommand: withoutCorepack }))
        .rejects.toThrow("requires Corepack on PATH");
    } finally {
      observeCache.mockRestore();
    }
    expect(withoutCorepack).toHaveBeenCalledOnce();
    expect(fs.existsSync(paths.cliRoot)).toBe(false);
    expect(fs.existsSync(paths.shimPath)).toBe(false);
  });

  it("installs a GitHub branch through codeload and reuses the resolved SHA", async () => {
    const corepack = stageFakeCorepack();
    const sha = "c".repeat(40);
    const runCommand = createGitCheckoutRunCommand(sha);
    await installCommand({ ref: "master", repo: "HenkDz/proprio", yes: true }, { runCommand });
    // An already-built payload can still be activated without Corepack.
    fs.unlinkSync(corepack);
    await installCommand({ ref: "master", repo: "HenkDz/proprio", yes: true }, { runCommand });
    const manifest = readInstallManifest(resolveInstallStorePaths());
    expect(manifest).toMatchObject({ source: "git", repo: "HenkDz/proprio", ref: "master", sha });
    expect(manifest?.payloadPath).toContain(path.join("git", sha.slice(0, 12)));
    expect(runCommand.mock.calls.filter(([command, args]) => command === "curl" && args.includes("--output"))).toHaveLength(1);
    expect(runCommand.mock.calls.filter(([command, args]) => command === corepack && args[1] === "install")).toHaveLength(1);
    expect(runCommand.mock.calls.filter(([command, args]) => command === corepack && args.includes("pack"))).toHaveLength(2);
    expect(runCommand.mock.calls.filter(([command, args]) => command === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs"))).toHaveLength(1);
    expect(runCommand.mock.calls.filter(([command, args]) => command === "npm" && args[0] === "pack")).toHaveLength(2);
    const installCall = runCommand.mock.calls.find(([command, args]) => command === "npm" && args[0] === "install");
    expect(installCall?.[1].filter((arg) => arg.endsWith(".tgz"))).toHaveLength(4);
  });

  it("builds git checkouts with NODE_ENV cleared so ambient production mode keeps devDependencies", async () => {
    const corepack = stageFakeCorepack();
    process.env.PATH = path.relative(process.cwd(), path.dirname(corepack));
    process.env.NODE_ENV = "production";
    const sha = "d".repeat(40);
    const runCommand = createGitCheckoutRunCommand(sha);
    await expect(installGitPayload("groktopus/proprio", sha, runCommand, resolveInstallStorePaths())).resolves.toMatchObject({ version: "0.3.1", reused: false });
    const corepackCalls = runCommand.mock.calls.filter(([file]) => path.basename(file) === "corepack");
    for (const [file] of corepackCalls) {
      expect(path.isAbsolute(file)).toBe(true);
      expect(fs.realpathSync.native(file)).toBe(fs.realpathSync.native(corepack));
    }
    const buildCalls = runCommand.mock.calls.filter(([file, args]) =>
      file === "bash" ||
      path.basename(file) === "corepack" ||
      (file === "npm" && args[0] === "pack") ||
      (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs")));
    expect(buildCalls).toHaveLength(9);
    for (const call of buildCalls) {
      const env = call[2]?.env;
      expect(env, `${call[0]} ${call[1].join(" ")} must run with an explicit env`).toBeDefined();
      expect(env, `${call[0]} ${call[1].join(" ")} must not inherit NODE_ENV`).not.toHaveProperty("NODE_ENV");
    }
    const uiPackCall = buildCalls.find(([file, , options]) => path.basename(file) === "corepack" && options?.env?.PROPRIO_RELEASE_REUSE_UI_DIST === "1");
    expect(uiPackCall).toBeDefined();
  });

  it("resolves the complete server workspace dependency closure in dependency order", () => {
    const checkout = path.join(root, "checkout");
    const packages = [
      { dir: "packages/shared", name: "@groktopus/shared", dependencies: {} },
      { dir: "packages/db", name: "@groktopus/db", dependencies: { "@groktopus/shared": "workspace:*" } },
      { dir: "server", name: "@groktopus/server", dependencies: { "@groktopus/db": "workspace:*" } },
    ];
    fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "scripts", "release-package-manifest.json"), JSON.stringify(packages.map(({ dir, name }) => ({ dir, name }))));
    for (const workspacePackage of packages) {
      fs.mkdirSync(path.join(checkout, workspacePackage.dir), { recursive: true });
      fs.writeFileSync(path.join(checkout, workspacePackage.dir, "package.json"), JSON.stringify({ name: workspacePackage.name, dependencies: workspacePackage.dependencies }));
    }

    expect(resolveGitInstallWorkspacePackages(checkout).map(({ name }) => name)).toEqual([
      "@groktopus/shared",
      "@groktopus/db",
      "@groktopus/server",
    ]);
  });

  it("includes child-process stderr in command failures", async () => {
    await expect(runCommandWithDiagnostics(process.execPath, ["-e", "process.stderr.write('unsupported workspace dependency\\n'); process.exit(1)"]))
      .rejects.toThrow("unsupported workspace dependency");
  });

  it("installs through the shim, reports provenance, and uninstalls without deleting user data", async () => {
    const version = "2026.720.0";
    const runCommand = vi.fn(async (file: string, args: string[], _options?: unknown) => {
      if (file === "npm" && args[0] === "view") return { stdout: JSON.stringify(version), stderr: "" };
      if (file === "npm" && args[0] === "install") {
        const prefix = args[args.indexOf("--prefix") + 1];
        const entrypoint = path.join(prefix, "node_modules", "proprio", "dist", "index.js");
        fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
        fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
        return { stdout: "", stderr: "" };
      }
      if (file === process.execPath && args.at(-1) === "--version") {
        return { stdout: `${version}\n`, stderr: "" };
      }
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    });

    await installCommand({}, { runCommand, now: () => new Date("2026-07-22T18:00:00.000Z") });

    const paths = resolveInstallStorePaths();
    const manifest = readInstallManifest(paths);
    expect(manifest?.version).toBe(version);
    expect(manifest?.channel).toBe("latest");
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(manifest!.payloadPath));
    expect(fs.existsSync(paths.shimPath)).toBe(true);
    const installCall = runCommand.mock.calls.find(
      ([file, args]) => file === "npm" && args[0] === "install",
    );
    expect(installCall?.[1]).toContain("--@proprio:registry=https://registry.npmjs.org");
    const installOptions = installCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(installOptions?.env?.npm_config_userconfig).toContain(".npmrc-");
    const entrypoint = path.join(manifest!.payloadPath, "node_modules", "proprio", "dist", "index.js");
    expect(resolveCliVersion(entrypoint)).toContain(`managed npm latest; payload ${manifest!.payloadPath}`);

    const userData = path.join(process.env.PROPRIO_HOME!, "instances", "default", "keep.txt");
    fs.mkdirSync(path.dirname(userData), { recursive: true });
    fs.writeFileSync(userData, "keep");
    const uninstallService = vi.fn(async () => {
      expect(fs.existsSync(paths.shimPath)).toBe(true);
    });
    await uninstallCommand({
      detectServiceManager: vi.fn(async () => ({
        supported: true as const,
        manager: {
          status: vi.fn(async () => ({ installed: true, active: true })),
          uninstall: uninstallService,
        } as never,
      })),
    });

    expect(uninstallService).toHaveBeenCalledOnce();
    expect(fs.existsSync(paths.cliRoot)).toBe(false);
    expect(fs.existsSync(paths.shimPath)).toBe(false);
    expect(fs.readFileSync(userData, "utf8")).toBe("keep");
  });

  it("refuses to remove the shared CLI while another instance service is installed", async () => {
    const paths = resolveInstallStorePaths();
    const otherUnitPath = path.join(process.env.HOME!, ".config", "systemd", "user", systemdServiceName("team-a"));
    fs.mkdirSync(path.dirname(otherUnitPath), { recursive: true });
    fs.writeFileSync(otherUnitPath, "unit");

    await expect(uninstallCommand({
      detectServiceManager: vi.fn(async () => ({
        supported: true as const,
        manager: { status: vi.fn(async () => ({ installed: false, active: false })) } as never,
      })),
      platform: "linux",
      userHomeDir: process.env.HOME!,
    })).rejects.toThrow("other instance services are installed");

    expect(fs.existsSync(paths.cliRoot)).toBe(false);
    expect(fs.existsSync(otherUnitPath)).toBe(true);
  });

  it("preserves the managed install when an existing systemd unit cannot be checked", async () => {
    const paths = resolveInstallStorePaths();
    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, "managed shim");
    const unitPath = path.join(
      process.env.HOME!,
      ".config",
      "systemd",
      "user",
      systemdServiceName(resolveProprioInstanceId()),
    );
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "unit");

    await expect(uninstallCommand({
      detectServiceManager: vi.fn(async () => ({
        supported: false as const,
        reason: "No usable systemd user manager was detected",
      })),
      platform: "linux",
      userHomeDir: process.env.HOME!,
    })).rejects.toThrow("Cannot verify or remove the background service");

    expect(fs.existsSync(paths.shimPath)).toBe(true);
    expect(fs.existsSync(unitPath)).toBe(true);
  });

  it("rejects a symlinked installs root before npm writes outside the store", async () => {
    const paths = resolveInstallStorePaths();
    const outside = path.join(root, "outside");
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, paths.installsRoot, "dir");
    const runCommand = vi.fn(async () => ({ stdout: JSON.stringify("2026.720.0"), stderr: "" }));

    await expect(installCommand({}, { runCommand })).rejects.toThrow("non-directory install-store path");
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses to uninstall an unverified cli directory", async () => {
    const paths = resolveInstallStorePaths();
    const unrelatedFile = path.join(paths.cliRoot, "keep.txt");
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.writeFileSync(unrelatedFile, "keep");

    await expect(uninstallCommand()).rejects.toThrow("unverified install store");
    expect(fs.readFileSync(unrelatedFile, "utf8")).toBe("keep");
  });

  it("refuses to uninstall while another store mutation holds the lock", async () => {
    const paths = resolveInstallStorePaths();
    const payloadPath = payloadPathFor(paths, "npm", "2026.720.0");
    initializeInstallStore(paths);
    fs.mkdirSync(payloadPath, { recursive: true });
    flipCurrentAtomic(payloadPath, paths);
    writeInstallManifestAtomic({
      schemaVersion: INSTALL_MANIFEST_VERSION,
      source: "npm",
      version: "2026.720.0",
      channel: "latest",
      payloadPath,
      installedAt: "2026-07-22T18:00:00.000Z",
      previous: [],
    }, paths);

    const uninstall = vi.fn(async () => undefined);
    const detectServiceManager = vi.fn(async () => ({
      supported: true as const,
      manager: { status: async () => ({ installed: true, active: true }), uninstall } as never,
    }));
    await withInstallStoreLock(
      async () => {
        await expect(uninstallCommand({ detectServiceManager })).rejects.toThrow("already running");
        expect(uninstall).not.toHaveBeenCalled();
      },
      paths,
    );
    expect(fs.existsSync(paths.lockPath)).toBe(false);
  });

  it("refuses a symlinked git payload root before downloading", async () => {
    stageFakeCorepack();
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const outside = path.join(root, "outside-git"); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(paths.installsRoot, "git"));
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(installGitPayload("groktopus/proprio", "4".repeat(40), runCommand, paths)).rejects.toThrow("unsafe payload root");
    expect(runCommand).not.toHaveBeenCalled();
  });

});
