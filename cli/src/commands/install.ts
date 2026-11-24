import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from "@groktopus/shared/node-version";
import { isExecutableFile } from "../utils/executable-file.js";
import {
  addManagedPathBlock,
  assertManagedShimWritable,
  buildNextManifest,
  flipCurrentAtomic,
  payloadPathFor,
  pruneInstallPayloads,
  readInstallManifest,
  resolveInstallStorePaths,
  withInstallStoreLock,
  writeInstallManifestAtomic,
  writeManagedShim,
  type InstallChannel,
  type InstallRecord,
  type InstallStorePaths,
} from "../install-store.js";

const execFileAsync = promisify(execFile);
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_GITHUB_REPO = "groktopus/proprio";
const RELEASE_RUNTIME_SKILLS_PACKAGES = new Set([
  "@groktopus/server",
  "@groktopus/adapter-claude-local",
  "@groktopus/adapter-codex-local",
]);
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type InstallOptions = { canary?: boolean; version?: string; ref?: string; repo?: string; yes?: boolean };

export type CommandRunner = (
  file: string,
  args: string[],
  options?: Parameters<typeof execFileAsync>[2],
) => Promise<{ stdout: string; stderr: string }>;

type ReleasePackageEntry = { dir: string; name: string };

const PACKAGE_DEPENDENCY_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
type PackageManifest = {
  version: string;
  files?: string[];
  bundleDependencies?: string[];
  bundledDependencies?: string[];
} & Partial<Record<(typeof PACKAGE_DEPENDENCY_SECTIONS)[number], Record<string, string>>>;

export async function runCommandWithDiagnostics(
  file: string,
  args: string[],
  options?: Parameters<typeof execFileAsync>[2],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(file, args, { ...options, encoding: "utf8" });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
    if (!stderr || (error instanceof Error && error.message.includes(stderr))) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`, { cause: error });
  }
}

export function resolveGitInstallWorkspacePackages(checkoutPath: string): ReleasePackageEntry[] {
  const manifestPath = path.join(checkoutPath, "scripts", "release-package-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ReleasePackageEntry[];
  const packageByName = new Map(manifest.map((entry) => [entry.name, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ReleasePackageEntry[] = [];

  const visit = (packageName: string): void => {
    if (visited.has(packageName)) return;
    if (visiting.has(packageName)) throw new Error(`Circular workspace dependency while staging ${packageName}.`);
    const entry = packageByName.get(packageName);
    if (!entry) throw new Error(`Git install cannot stage workspace dependency ${packageName}; it is missing from scripts/release-package-manifest.json.`);
    visiting.add(packageName);
    const packageJson = JSON.parse(fs.readFileSync(path.join(checkoutPath, entry.dir, "package.json"), "utf8")) as Record<string, unknown>;
    for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
      const dependencies = packageJson[section];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const dependencyName of Object.keys(dependencies)) {
        if (dependencyName.startsWith("@groktopus/")) visit(dependencyName);
      }
    }
    visiting.delete(packageName);
    visited.add(packageName);
    ordered.push(entry);
  };

  visit("@groktopus/server");
  return ordered;
}

function pinBundledWorkspaceDependencies(
  stagedPackage: string,
  source: PackageManifest,
  versions: ReadonlyMap<string, string>,
): void {
  // Older source archives stage workspace references at the bundled package's own version.
  const manifestPath = path.join(stagedPackage, "package.json");
  const staged = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest;
  for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
    const dependencies = staged[section];
    if (!dependencies) continue;
    for (const [name, specifier] of Object.entries(source[section] ?? {})) {
      const version = versions.get(name);
      if (version === undefined || !specifier.startsWith("workspace:") || dependencies[name] === undefined) continue;
      const range = specifier.slice("workspace:".length);
      if (range === "*" || range === "^" || range === "~") {
        dependencies[name] = range === "*" ? version : `${range}${version}`;
      } else {
        dependencies[name] = range;
      }
    }
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(staged, null, 2)}\n`);
}

export function assertSupportedNodeVersion(): void {
  if (!isSupportedNodeVersion(process.versions.node)) {
    throw new Error(`Installing or updating Proprio requires Node.js ${MINIMUM_NODE_VERSION} or newer (found ${process.version} at ${process.execPath}). Put a supported Node bin directory first on PATH and run 'pnpm proprio install --yes' to re-pin an existing managed install.`);
  }
}

export function resolveNpmInstallRequest(options: InstallOptions): {
  spec: string;
  channel: InstallChannel;
} {
  if (options.canary && options.version) throw new Error("Choose either --canary or --version, not both.");
  if (options.version) {
    const version = options.version.trim();
    if (!EXACT_VERSION_PATTERN.test(version)) {
      throw new Error(`--version requires an exact published version, received '${options.version}'.`);
    }
    return { spec: version, channel: "pinned" };
  }
  return options.canary ? { spec: "canary", channel: "canary" } : { spec: "latest", channel: "latest" };
}

export async function resolvePublishedVersion(_spec: string, _runCommand: CommandRunner): Promise<string> {
  throw new Error("Proprio has no published npm distribution yet. Use the source checkout; registry installation and updates are disabled.");
}

export function resolveGitInstallRequest(options: InstallOptions): { repo: string; ref: string; pinned: boolean } | null {
  if (!options.ref && !options.repo) return null;
  if (!options.ref) throw new Error("--repo requires --ref.");
  if (options.canary || options.version) throw new Error("--ref cannot be combined with --canary or --version.");
  const repo = (options.repo ?? DEFAULT_GITHUB_REPO).trim();
  const ref = options.ref.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`--repo must be an owner/name GitHub repository, received '${repo}'.`);
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) throw new Error(`Invalid GitHub ref '${options.ref}'.`);
  return { repo, ref, pinned: /^[0-9a-f]{7,40}$/i.test(ref) };
}

async function runGitHubCurl(
  args: string[],
  runCommand: CommandRunner,
  options?: Parameters<CommandRunner>[2],
): Promise<{ stdout: string; stderr: string }> {
  // Anonymous GitHub requests are rate-limited per source IP (CI runners and
  // corporate NAT exhaust the shared quota); honor an ambient token when present.
  // The token travels via a curl --config file so it never appears in process args.
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) return runCommand("curl", args, options);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "proprio-gh-"));
  const configFile = path.join(configDir, "headers");
  try {
    fs.writeFileSync(configFile, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
    return await runCommand("curl", ["--config", configFile, ...args], options);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

export async function resolveGitHubRef(repo: string, ref: string, runCommand: CommandRunner): Promise<string> {
  let result: { stdout: string; stderr: string };
  try {
    result = await runGitHubCurl(["--fail", "--silent", "--show-error", "--location", "--header", "Accept: application/vnd.github+json", "--header", "User-Agent: proprio-install", `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`], runCommand, { maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const shaAlias = /^(?:[0-9a-f]{40})(?:\^0)?$/i.exec(ref);
    if (token || !shaAlias || !/(?:returned error: (?:403|429)|API rate limit exceeded|secondary rate limit)/i.test(detail)) throw error;

    // GitHub's anonymous REST quota is shared by hosted runners. When it is
    // exhausted, resolve only immutable full SHAs through Git's public smart
    // transport. Isolate HOME and disable credential helpers/prompts so this
    // fallback cannot pick up credentials from a developer or runner account.
    const sha = ref.replace(/\^0$/, "").toLowerCase();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proprio-public-ref-"));
    const repoPath = path.join(tempRoot, "repo.git");
    const isolatedHome = path.join(tempRoot, "home");
    fs.mkdirSync(isolatedHome, { mode: 0o700 });
    const networkEnv = Object.fromEntries(
      ["LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]
        .flatMap((key) => process.env[key] ? [[key, process.env[key]!] as const] : []),
    );
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: isolatedHome,
      ...networkEnv,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_ALLOW_PROTOCOL: "https",
    };
    try {
      await runCommand("git", ["init", "--bare", repoPath], { env, maxBuffer: 4 * 1024 * 1024 });
      await runCommand("git", ["-C", repoPath, "-c", "credential.helper=", "-c", "core.askPass=", "fetch", "--depth=1", "--filter=blob:none", "--no-tags", "--no-recurse-submodules", `https://github.com/${repo}.git`, sha], { env, maxBuffer: 4 * 1024 * 1024 });
      const fetched = await runCommand("git", ["-C", repoPath, "rev-parse", "FETCH_HEAD^{commit}"], { env, maxBuffer: 1024 * 1024 });
      if (fetched.stdout.trim().toLowerCase() !== sha) throw new Error(`GitHub returned a different commit while resolving ${repo}@${ref}.`);
      return sha;
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  let sha: unknown;
  try { sha = (JSON.parse(result.stdout) as { sha?: unknown }).sha; } catch { throw new Error(`GitHub returned an invalid response while resolving ${repo}@${ref}.`); }
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`GitHub did not return a full commit SHA for ${repo}@${ref}.`);
  return sha.toLowerCase();
}

function payloadEntrypoint(payloadPath: string): string {
  return path.join(payloadPath, "node_modules", "proprio", "dist", "index.js");
}

export async function smokePayload(payloadPath: string, expectedVersion: string, runCommand: CommandRunner): Promise<void> {
  const entrypoint = payloadEntrypoint(payloadPath);
  if (!fs.existsSync(entrypoint)) throw new Error(`Installed package is missing its CLI entrypoint: ${entrypoint}`);
  const result = await runCommand(process.execPath, [entrypoint, "--version"], { maxBuffer: 1024 * 1024 });
  const reportedVersion = result.stdout.trim().split(/\s+/)[0];
  if (reportedVersion !== expectedVersion) {
    throw new Error(`Installed CLI smoke check reported ${reportedVersion || "no version"}; expected ${expectedVersion}.`);
  }
}

export async function installNpmPayload(
  version: string,
  runCommand: CommandRunner,
  paths = resolveInstallStorePaths(),
): Promise<{ payloadPath: string; reused: boolean }> {
  const payloadPath = payloadPathFor(paths, "npm", version);
  if (fs.existsSync(payloadPath)) {
    await smokePayload(payloadPath, version, runCommand);
    return { payloadPath, reused: true };
  }
  const sourceRoot = path.dirname(payloadPath);
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to install into unsafe payload root ${sourceRoot}.`);
  }
  fs.chmodSync(paths.cliRoot, 0o700);
  fs.chmodSync(paths.installsRoot, 0o700);
  fs.chmodSync(sourceRoot, 0o700);
  const stagingPath = path.join(sourceRoot, `.${version}.tmp-${process.pid}-${Date.now()}`);
  const npmUserConfigPath = path.join(sourceRoot, `.npmrc-${process.pid}-${Date.now()}`);
  fs.rmSync(stagingPath, { recursive: true, force: true });
  try {
    fs.writeFileSync(
      npmUserConfigPath,
      `registry=${PUBLIC_NPM_REGISTRY}\n@proprio:registry=${PUBLIC_NPM_REGISTRY}\n`,
      { mode: 0o600 },
    );
    await runCommand(
      "npm",
      [
        "install",
        "--prefix",
        stagingPath,
        `proprio@${version}`,
        `--registry=${PUBLIC_NPM_REGISTRY}`,
        `--@proprio:registry=${PUBLIC_NPM_REGISTRY}`,
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: sourceRoot,
        env: { ...process.env, npm_config_userconfig: npmUserConfigPath },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    await smokePayload(stagingPath, version, runCommand);
    fs.renameSync(stagingPath, payloadPath);
    return { payloadPath, reused: false };
  } finally {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    fs.rmSync(npmUserConfigPath, { force: true });
  }
}

function gitBuildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  // Source builds need devDependencies (esbuild, typescript); ambient NODE_ENV=production
  // makes pnpm/npm omit them, so the checkout build must not inherit it.
  delete env.NODE_ENV;
  return env;
}

function gitPayloadPath(sha: string, paths: InstallStorePaths): string {
  return payloadPathFor(paths, "git", sha.slice(0, 12));
}

async function findGitBuildCorepack(): Promise<string | null> {
  const searchPath = process.env.PATH;
  if (!searchPath) return null;
  for (const directory of searchPath.split(path.delimiter)) {
    // Make relative entries independent of the build cwd, without lexically
    // collapsing ".." before the OS has followed symlinks in a PATH entry.
    const absoluteDirectory = path.isAbsolute(directory) ? directory : `${process.cwd()}${path.sep}${directory}`;
    const executable = `${absoluteDirectory}${path.sep}corepack`;
    if (await isExecutableFile(executable)) return executable;
  }
  return null;
}

function missingGitBuildCorepack(): Error {
  return new Error(
    "Git-source installation requires Corepack on PATH. " +
      "Install Corepack for the Node.js version in use and verify that `corepack --version` works before retrying.",
  );
}

export async function installGitPayload(repo: string, sha: string, runCommand: CommandRunner, paths = resolveInstallStorePaths()): Promise<{ payloadPath: string; reused: boolean; version: string }> {
  const payloadPath = gitPayloadPath(sha, paths);
  const identifier = path.basename(payloadPath);
  if (fs.existsSync(payloadPath)) {
    const metadata = JSON.parse(fs.readFileSync(path.join(payloadPath, "node_modules", "proprio", "package.json"), "utf8")) as { version: string };
    await smokePayload(payloadPath, metadata.version, runCommand);
    return { payloadPath, reused: true, version: metadata.version };
  }
  const corepack = await findGitBuildCorepack();
  if (!corepack) throw missingGitBuildCorepack();
  const sourceRoot = path.dirname(payloadPath);
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to install into unsafe payload root ${sourceRoot}.`);
  }
  fs.chmodSync(paths.cliRoot, 0o700);
  fs.chmodSync(paths.installsRoot, 0o700);
  fs.chmodSync(sourceRoot, 0o700);
  const stagingRoot = path.join(sourceRoot, `.${identifier}.tmp-${process.pid}-${Date.now()}`);
  const checkoutPath = path.join(stagingRoot, "source");
  const archivePath = path.join(stagingRoot, "source.tar.gz");
  const stagedPayload = path.join(stagingRoot, "payload");
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(checkoutPath, { recursive: true, mode: 0o700 });
  // Workspace build scripts invoke bare `pnpm`; on a machine where pnpm exists only
  // through corepack, nothing puts it on PATH, so provision a shim into the staging dir.
  const pnpmShimDir = path.join(stagingRoot, "pnpm-bin");
  fs.mkdirSync(pnpmShimDir, { recursive: true, mode: 0o700 });
  const buildEnv = (extra: NodeJS.ProcessEnv = {}) =>
    gitBuildEnv({
      PATH: [pnpmShimDir, process.env.PATH].filter(Boolean).join(path.delimiter),
      PROPRIO_BUILD_COMMIT: sha,
      GIT_CEILING_DIRECTORIES: [stagingRoot, process.env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter),
      ...extra,
    });
  try {
    await runGitHubCurl(["--fail", "--silent", "--show-error", "--location", "--output", archivePath, `https://codeload.github.com/${repo}/tar.gz/${sha}`], runCommand, { maxBuffer: 4 * 1024 * 1024 });
    await runCommand("tar", ["-xzf", archivePath, "--strip-components=1", "-C", checkoutPath], { maxBuffer: 4 * 1024 * 1024 });
    await runCommand(corepack, ["enable", "pnpm", "--install-directory", pnpmShimDir], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 4 * 1024 * 1024 });
    await runCommand(corepack, ["pnpm", "install", "--frozen-lockfile"], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 32 * 1024 * 1024 });
    await runCommand("bash", ["scripts/build-npm.sh", "--skip-checks", "--skip-typecheck"], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 32 * 1024 * 1024 });
    await runCommand(corepack, ["pnpm", "-r", "--filter", "@groktopus/server...", "--if-present", "run", "build"], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 32 * 1024 * 1024 });
    const metadata = JSON.parse(fs.readFileSync(path.join(checkoutPath, "cli", "package.json"), "utf8")) as { version: string };
    const workspacePackages = resolveGitInstallWorkspacePackages(checkoutPath).map((entry) => {
      const packageDir = path.join(checkoutPath, entry.dir);
      const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as PackageManifest;
      return { ...entry, packageDir, packageJson };
    });
    const workspaceVersions = new Map(workspacePackages.map(({ name, packageJson }) => [name, packageJson.version]));
    for (const [index, workspacePackage] of workspacePackages.entries()) {
      const { packageDir, packageJson } = workspacePackage;
      const skillsPath = path.join(packageDir, "skills");
      if (RELEASE_RUNTIME_SKILLS_PACKAGES.has(workspacePackage.name)
        && packageJson.files?.includes("skills") && !fs.existsSync(skillsPath)) {
        fs.cpSync(path.join(checkoutPath, "skills"), skillsPath, { recursive: true });
      }
      const bundledDependencies = packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? [];
      if (bundledDependencies.length > 0) {
        // Staging a bundled package copies its files before npm's prepack hook runs.
        if (workspacePackage.name === "@groktopus/server" && packageJson.files?.includes("ui-dist")) {
          await runCommand(corepack, ["pnpm", "--filter", "@groktopus/server", "run", "prepare:ui-dist"], {
            cwd: checkoutPath,
            env: buildEnv({ PROPRIO_RELEASE_REUSE_UI_DIST: "1" }),
            maxBuffer: 32 * 1024 * 1024,
          });
        }
        const stagedPackage = path.join(stagingRoot, `workspace-package-${index}`);
        await runCommand(process.execPath, [path.join(checkoutPath, "scripts", "prepare-bundled-package.mjs"), packageDir, stagedPackage], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 32 * 1024 * 1024 });
        pinBundledWorkspaceDependencies(stagedPackage, packageJson, workspaceVersions);
        await runCommand("npm", ["pack", stagedPackage, "--ignore-scripts", "--pack-destination", stagingRoot], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 16 * 1024 * 1024 });
      } else {
        await runCommand(corepack, ["pnpm", "--dir", workspacePackage.dir, "pack", "--pack-destination", stagingRoot], { cwd: checkoutPath, env: buildEnv({ PROPRIO_RELEASE_REUSE_UI_DIST: "1" }), maxBuffer: 32 * 1024 * 1024 });
      }
    }
    await runCommand("npm", ["pack", "--pack-destination", stagingRoot], { cwd: path.join(checkoutPath, "cli"), env: buildEnv(), maxBuffer: 16 * 1024 * 1024 });
    const tarballs = fs.readdirSync(stagingRoot).filter((entry) => entry.endsWith(".tgz"));
    const cliTarball = tarballs.find((entry) => entry === `proprio-${metadata.version}.tgz`);
    const workspaceTarballs = tarballs.filter((entry) => entry !== cliTarball);
    if (!cliTarball || workspaceTarballs.length !== workspacePackages.length) {
      throw new Error(`Git install packaging produced ${workspaceTarballs.length} workspace tarballs; expected ${workspacePackages.length}.`);
    }
    // Keep npm's native executables out of group and world write access.
    await runCommand("sh", [
      "-c", 'umask g-w,o-w && exec "$@"', "proprio-npm-install",
      "npm", "install", "--prefix", stagedPayload, path.join(stagingRoot, cliTarball),
      ...workspaceTarballs.map((entry) => path.join(stagingRoot, entry)), "--no-audit", "--no-fund",
    ], { cwd: stagingRoot, maxBuffer: 32 * 1024 * 1024 });
    await smokePayload(stagedPayload, metadata.version, runCommand);
    fs.renameSync(stagedPayload, payloadPath);
    return { payloadPath, reused: false, version: metadata.version };
  } finally { fs.rmSync(stagingRoot, { recursive: true, force: true }); }
}

function pathContains(directory: string): boolean {
  const normalized = path.resolve(directory);
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).some((entry) => path.resolve(entry) === normalized);
}

function shellRcPath(): string | null {
  const home = process.env.HOME;
  if (!home) return null;
  const shell = path.basename(process.env.SHELL ?? "");
  if (shell === "bash") return path.join(home, ".bashrc");
  if (shell === "zsh") return path.join(home, ".zshrc");
  return null;
}

async function ensureShimOnPath(options: InstallOptions): Promise<void> {
  const paths = resolveInstallStorePaths();
  const binDir = path.dirname(paths.shimPath);
  if (pathContains(binDir)) return;
  const manualInstruction = `export PATH="$HOME/.local/bin:$PATH"`;
  const rcPath = shellRcPath();
  if (!process.stdin.isTTY || !process.stdout.isTTY || !rcPath) {
    console.log(pc.yellow(`Add Proprio to PATH for this shell:\n  ${manualInstruction}`));
    return;
  }
  const confirmed = options.yes === true ? true : await p.confirm({ message: `Add ~/.local/bin to PATH in ${rcPath}?`, initialValue: true });
  if (p.isCancel(confirmed) || !confirmed) {
    console.log(pc.yellow(`PATH was not changed. Run:\n  ${manualInstruction}`));
    return;
  }
  const changed = addManagedPathBlock(rcPath);
  console.log(changed ? pc.green(`Updated ${rcPath}.`) : pc.dim(`${rcPath} already contains the PATH block.`));
}

async function confirmGitInstall(options: InstallOptions, repo: string, ref: string): Promise<void> {
  const warning = `Installing ${repo}@${ref} executes dependency and build scripts from that repository.`;
  console.log(pc.yellow(`Warning: ${warning}`));
  if (options.yes === true) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${warning} Re-run with --yes to consent in non-interactive environments.`);
  }
  const confirmed = await p.confirm({
    message: `${warning} Continue?`,
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    throw new Error("Git-ref install cancelled before downloading or executing repository code.");
  }
}

export async function installCommand(
  options: InstallOptions,
  dependencies: { runCommand?: CommandRunner; now?: () => Date } = {},
): Promise<void> {
  assertSupportedNodeVersion();
  const runCommand = dependencies.runCommand ?? runCommandWithDiagnostics;
  const gitRequest = resolveGitInstallRequest(options);
  if (gitRequest) {
    await confirmGitInstall(options, gitRequest.repo, gitRequest.ref);
    const sha = await resolveGitHubRef(gitRequest.repo, gitRequest.ref, runCommand);
    const paths = resolveInstallStorePaths();
    // Without Corepack we can only activate a cached payload. Lock an existing
    // store without initializing it, in case uninstall wins after cache discovery.
    const payloadPath = gitPayloadPath(sha, paths);
    const cacheOnly = !(await findGitBuildCorepack());
    if (cacheOnly && !fs.existsSync(payloadPath)) throw missingGitBuildCorepack();
    const installed = await withInstallStoreLock(async () => {
      assertManagedShimWritable(paths);
      const currentManifest = readInstallManifest(paths);
      const payload = await installGitPayload(gitRequest.repo, sha, runCommand, paths);
      const record: InstallRecord = { source: "git", version: payload.version, channel: "pinned", repo: gitRequest.repo, ref: gitRequest.ref, sha, payloadPath: payload.payloadPath, installedAt: (dependencies.now?.() ?? new Date()).toISOString() };
      const nextManifest = buildNextManifest(record, currentManifest);
      const oldTarget = fs.existsSync(paths.currentPath) ? fs.readlinkSync(paths.currentPath) : null;
      flipCurrentAtomic(payload.payloadPath, paths);
      try { writeInstallManifestAtomic(nextManifest, paths); } catch (error) { if (oldTarget) flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths); else fs.rmSync(paths.currentPath, { force: true }); throw error; }
      writeManagedShim(paths); pruneInstallPayloads(nextManifest, paths); return payload;
    }, paths, { initialize: cacheOnly ? "existing-only" : true }).catch((error: unknown) => {
      if (cacheOnly && (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && !fs.existsSync(payloadPath)) {
        throw missingGitBuildCorepack();
      }
      throw error;
    });
    await ensureShimOnPath(options);
    console.log(pc.green(`${installed.reused ? "Activated cached" : "Installed"} proprio git payload ${sha.slice(0, 12)}.`));
    return;
  }
  const request = resolveNpmInstallRequest(options);
  console.log(`Resolving proprio@${request.spec} from ${PUBLIC_NPM_REGISTRY}...`);
  const version = await resolvePublishedVersion(request.spec, runCommand);
  console.log(`Installing proprio@${version}...`);

  const paths = resolveInstallStorePaths();
  const installed = await withInstallStoreLock(async () => {
    assertManagedShimWritable(paths);
    const currentManifest = readInstallManifest(paths);
    const payload = await installNpmPayload(version, runCommand, paths);
    const record: InstallRecord = {
      source: "npm",
      version,
      channel: request.channel,
      payloadPath: payload.payloadPath,
      installedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    };
    const nextManifest = buildNextManifest(record, currentManifest);
    const oldTarget = fs.existsSync(paths.currentPath) ? fs.readlinkSync(paths.currentPath) : null;
    flipCurrentAtomic(payload.payloadPath, paths);
    try {
      writeInstallManifestAtomic(nextManifest, paths);
    } catch (error) {
      if (oldTarget) flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths);
      else fs.rmSync(paths.currentPath, { force: true });
      throw error;
    }
    writeManagedShim(paths);
    pruneInstallPayloads(nextManifest, paths);
    return payload;
  }, paths);
  await ensureShimOnPath(options);

  console.log(pc.green(`${installed.reused ? "Activated cached" : "Installed"} proprio ${version} (${request.channel}).`));
  console.log(pc.dim(`Payload: ${installed.payloadPath}`));
  console.log(`Run ${pc.cyan("proprio --version")} to verify the managed install.`);
}
