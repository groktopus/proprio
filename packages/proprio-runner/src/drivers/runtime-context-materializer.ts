import { isOpenRouterUrl, openRouterCodexHeaders } from "./openrouter-attribution.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { codexObservabilityToml } from "./agent-observability.js";

import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";

async function assertSafeTree(root: string, child = ""): Promise<void> {
  const directory = child ? join(root, child) : root;
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink()) {
    throw new Error(
      `runtime context asset contains a symlink: ${child || "."}`,
    );
  }
  if (!directoryStat.isDirectory()) {
    throw new Error("runtime context asset root must be a directory");
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = child ? `${child}/${entry.name}` : entry.name;
    const stat = await lstat(join(root, childRelative));
    if (stat.isSymbolicLink()) {
      throw new Error(
        `runtime context asset contains a symlink: ${childRelative}`,
      );
    }
    if (stat.isDirectory()) await assertSafeTree(root, childRelative);
    else if (!stat.isFile()) {
      throw new Error(
        `runtime context asset contains an unsupported file: ${childRelative}`,
      );
    }
  }
}

function safeMaterializationTarget(root: string, runtimeName: string): string {
  const segments = runtimeName.split("/");
  if (
    runtimeName.startsWith("/")
    || runtimeName.includes("\\")
    || runtimeName.includes("\0")
    || segments.some((segment) => /[<>:"|?*\u0000-\u001f\u007f]/u.test(segment))
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments.some((segment) => !segment.replace(/[ .]+$/u, ""))
    || segments.some(isWin32ReservedPathSegment)
  ) {
    throw new Error("runtime context skill name must be a safe relative path");
  }
  const target = resolve(root, runtimeName);
  const relation = relative(resolve(root), target);
  if (
    relation === ""
    || relation === ".."
    || relation.startsWith(`..${sep}`)
    || isAbsolute(relation)
  ) {
    throw new Error("runtime context skill name must stay inside the skills home");
  }
  return target;
}

function isWin32ReservedPathSegment(segment: string): boolean {
  const basename = segment
    .normalize("NFC")
    .split(".", 1)[0]!
    .replace(/[ .]+$/u, "")
    .toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(
    basename,
  );
}

function portableRuntimeNameKey(runtimeName: string): string {
  // Skill assignments must remain unambiguous when the same context is moved
  // between the case-sensitive Linux runner and the case-insensitive default
  // filesystems on macOS or Windows. NFC also catches composed/decomposed
  // aliases, while per-segment trimming matches Win32's treatment of trailing
  // dots and spaces before either spelling reaches the staging tree.
  return runtimeName
    .normalize("NFC")
    .split("/")
    .map((segment) => segment.replace(/[ .]+$/u, ""))
    .join("/")
    .toLowerCase();
}

// The server's repository skill projection keeps the untouched pinned tree
// under this name. Only local Codex homes on the Linux ext filesystem family
// need the inode-saving layout. Other filesystems and transports keep copies.
const REPOSITORY_CONTENT_DIR = ".proprio-repository";
const LINUX_EXT_FILESYSTEM_MAGIC = 0xef53;

async function repositoryTreeDigest(root: string): Promise<string | null> {
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootStat?.isDirectory()) return null;

  const digest = createHash("sha256");
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        digest.update(JSON.stringify(["directory", relative(root, file)]));
        await visit(file);
        continue;
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error("runtime repository asset must be a regular file");
        const bytes = createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false })) bytes.update(chunk);
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error("runtime repository asset changed while staging skills");
        }
        digest.update(JSON.stringify(["file", relative(root, file), before.mode & 0o555, bytes.digest("hex")]));
      } finally {
        await handle.close();
      }
    }
  }
  await visit(root);
  return digest.digest("hex");
}

async function linkPrivateRepository(source: string, destination: string): Promise<void> {
  await mkdir(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const copied = join(source, entry.name);
    const alias = join(destination, entry.name);
    if (entry.isDirectory()) await linkPrivateRepository(copied, alias);
    else await link(copied, alias);
  }
}

async function protectStagedTree(root: string): Promise<void> {
  const rootHandle = await open(
    root,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) {
      throw new Error("staged runtime context root must be a directory");
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) {
        await protectStagedTree(child);
        continue;
      }
      const childHandle = await open(
        child,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const openedChild = await childHandle.stat();
        if (!openedChild.isFile()) {
          throw new Error("staged runtime context asset must be a regular file");
        }
        await childHandle.chmod(openedChild.mode & 0o555);
      } finally {
        await childHandle.close();
      }
    }
    // Seal directories only after their descendants. Traversal needs execute
    // permission, but provider processes must not be able to rewrite assigned
    // skills after the immutable snapshot has been published.
    await rootHandle.chmod(0o555);
  } finally {
    await rootHandle.close();
  }
}

async function unprotectMaterializedTree(root: string): Promise<void> {
  const rootHandle = await open(
    root,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) {
      throw new Error("materialized runtime context root must be a directory");
    }
    // Restore directory mutation before descending so every child can be
    // unlinked. Handles plus O_NOFOLLOW keep cleanup inside the sealed tree.
    await rootHandle.chmod(0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) {
        await unprotectMaterializedTree(child);
        continue;
      }
      const childHandle = await open(
        child,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const openedChild = await childHandle.stat();
        if (!openedChild.isFile()) {
          throw new Error("materialized runtime context asset must be a regular file");
        }
        if (openedChild.nlink === 1) await childHandle.chmod(0o600);
      } finally {
        await childHandle.close();
      }
    }
  } finally {
    await rootHandle.close();
  }
}

async function removeMaterializedTree(
  skillsHome: string,
  removeTree: (path: string) => Promise<void>,
): Promise<void> {
  const exists = await lstat(skillsHome).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!exists) return;
  await unprotectMaterializedTree(skillsHome);
  await removeTree(skillsHome);
}

/** Removes a previously sealed skills snapshot at an explicit lifecycle boundary. */
export async function releaseMaterializedNativeRuntimeSkills(
  skillsHome: string,
): Promise<void> {
  await removeMaterializedTree(
    skillsHome,
    (path) => rm(path, { recursive: true, force: true }),
  );
}

export async function materializeNativeRuntimeSkills(
  context: NativeRuntimeContextSnapshot | null,
  skillsHome: string,
  dependencies: {
    cloneFiles?: boolean;
    colocateRepositoryFiles?: boolean;
    /** Internal test seam for failed staging cleanup coverage. */
    removeTree?: (path: string) => Promise<void>;
    /** Internal test seam for publication failure coverage. */
    renameTree?: (source: string, destination: string) => Promise<void>;
  } = {},
): Promise<void> {
  const removeTree =
    dependencies.removeTree ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const renameTree = dependencies.renameTree ?? rename;
  if (context) {
    const runtimeNames = new Set<string>();
    for (const skill of context.skills) {
      safeMaterializationTarget(skillsHome, skill.runtimeName);
      const runtimeName = portableRuntimeNameKey(skill.runtimeName);
      if (runtimeNames.has(runtimeName)) {
        throw new Error("runtime context skill names must not overlap");
      }
      runtimeNames.add(runtimeName);
    }
    for (const runtimeName of runtimeNames) {
      const segments = runtimeName.split("/");
      for (let length = 1; length < segments.length; length += 1) {
        if (runtimeNames.has(segments.slice(0, length).join("/"))) {
          throw new Error("runtime context skill names must not overlap");
        }
      }
    }
    for (const skill of context.skills) {
      await assertSafeTree(skill.bundle.rootPath);
    }
  }

  const skillsHomeExists = await lstat(skillsHome).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (skillsHomeExists) {
    throw new Error(
      "runtime context skills home must be a fresh destination",
    );
  }

  const parent = dirname(skillsHome);
  const nonce = randomUUID();
  const stagingHome = join(parent, `.proprio-skills-staging-${nonce}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await mkdir(stagingHome, { mode: 0o700 });
  try {
    const colocate = dependencies.colocateRepositoryFiles && process.platform === "linux"
      && (context?.skills.length ?? 0) > 1 && (await statfs(stagingHome)).type === LINUX_EXT_FILESYSTEM_MAGIC;
    const repositories = new Map<string, string>();
    for (const skill of context?.skills ?? []) {
      const target = safeMaterializationTarget(stagingHome, skill.runtimeName);
      const sourceRepository = join(skill.bundle.rootPath, REPOSITORY_CONTENT_DIR);
      const stagedRepository = join(target, REPOSITORY_CONTENT_DIR);
      const digest = colocate && skill.versionId ? await repositoryTreeDigest(sourceRepository) : null;
      const existing = digest ? repositories.get(digest) : undefined;
      await cp(skill.bundle.rootPath, target, {
        recursive: true,
        ...(dependencies.cloneFiles ? { mode: constants.COPYFILE_FICLONE } : {}),
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
        ...(existing ? { filter: (source: string) => source !== sourceRepository } : {}),
      });
      // Link only a private staged copy. Source snapshots and other durable
      // homes must retain their own inode metadata and lifetimes.
      if (existing) await linkPrivateRepository(existing, stagedRepository);
      await assertSafeTree(target);
      await protectStagedTree(target);
      if (digest && !existing) {
        if (await repositoryTreeDigest(stagedRepository) !== digest) {
          throw new Error("runtime repository asset changed while copying skills");
        }
        repositories.set(digest, stagedRepository);
      }
    }

    // The caller supplies a new isolated home for each provider launch. Never
    // move an existing assignment out of its canonical path: a failed bounded
    // rollback cannot portably guarantee that name is restored on every
    // filesystem. Publication therefore targets only a fresh destination.
    await renameTree(stagingHome, skillsHome);
  } catch (error) {
    // Cleanup is best effort and must not replace the publication failure that
    // explains why no runtime snapshot was installed.
    await removeMaterializedTree(stagingHome, removeTree).catch(() => undefined);
    throw error;
  }
}

async function readSourceCodexAuth(sourceAuth: string): Promise<Buffer | null> {
  const handle = await open(
    sourceAuth,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ELOOP") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size > 1024 * 1024) {
      throw new Error("source Codex auth file exceeds the 1 MiB limit");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Copy only Proprio's value-free provider projection, never host tools or hooks. */
async function managedCodexProviderConfig(sourceHome?: string | null): Promise<string> {
  if (!sourceHome?.trim()) return "";
  const source = await readSourceCodexAuth(join(sourceHome, "config.toml"));
  if (!source) return "";
  let parsed;
  try { parsed = parseToml(source.toString("utf8")); } catch { return ""; }
  if (parsed.model_provider !== "proprio") return "";
  const providers = parsed.model_providers as Record<string, unknown> | undefined;
  const provider = providers?.proprio as Record<string, unknown> | undefined;
  if (!provider || typeof provider.base_url !== "string" || provider.wire_api !== "responses"
    || provider.requires_openai_auth !== false
    || (provider.env_key !== undefined && provider.env_key !== "PROPRIO_AI_PROVIDER_KEY")) {
    throw new Error("Invalid managed Codex provider configuration");
  }
  const url = new URL(provider.base_url);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid managed Codex provider URL");
  }
  return `model_provider = "proprio"\n[model_providers.proprio]\nname = "Proprio connection"\nbase_url = ${JSON.stringify(provider.base_url)}\nwire_api = "responses"\nrequires_openai_auth = false\n${provider.env_key ? 'env_key = "PROPRIO_AI_PROVIDER_KEY"\n' : ""}${isOpenRouterUrl(provider.base_url) ? openRouterCodexHeaders() : ""}`;
}

export async function prepareIsolatedCodexHome(input: {
  observability?: import("./agent-observability.js").ProviderObservabilityLaunch;
  context: NativeRuntimeContextSnapshot | null;
  codexHome: string;
  colocateRepositoryFiles?: boolean;
  sourceCodexHome?: string | null;
  apiKey?: string | null;
}): Promise<void> {
  try {
    // Copy-on-write cloning keeps distinct inodes and falls back to a regular
    // copy across filesystems or on local/remote storage without clone support.
    await materializeNativeRuntimeSkills(input.context, join(input.codexHome, "skills"), {
      cloneFiles: true, colocateRepositoryFiles: input.colocateRepositoryFiles,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOSPC" || code === "EDQUOT") {
      throw Object.assign(new Error("Native Codex could not stage assigned skills because local storage or quota is full.", {
        cause: error,
      }), { code });
    }
    throw error;
  }

  const providerConfig = await managedCodexProviderConfig(input.sourceCodexHome);
  await writeIsolatedCodexConfig(input, providerConfig);
  await writeIsolatedCodexAuth(input, providerConfig);
}

async function writeIsolatedCodexConfig(input: CodexAuthInput, providerConfig: string): Promise<void> {
  const configPath = join(input.codexHome, "config.toml");
  await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
  await chmod(input.codexHome, 0o700);
  const temporaryConfig = join(input.codexHome, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryConfig, [
      'cli_auth_credentials_store = "file"',
      providerConfig,
      codexObservabilityToml(input.observability?.otelConfig),
      // Codex shell snapshots serialize the provider process environment. The
      // native runner injects short-lived provider and MCP bindings, so a
      // snapshot would turn ephemeral credentials into durable session state.
      "[features]",
      "shell_snapshot = false",
      "",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    await rename(temporaryConfig, configPath);
    await chmod(configPath, 0o600);
  } finally { await rm(temporaryConfig, { force: true }); }
}

type CodexAuthInput = {
  codexHome: string;
  sourceCodexHome?: string | null;
  apiKey?: string | null;
  observability?: import("./agent-observability.js").ProviderObservabilityLaunch;
};

export async function prepareIsolatedCodexRecoveryHome(input: CodexAuthInput): Promise<void> {
  const providerConfig = await managedCodexProviderConfig(input.sourceCodexHome);
  await writeIsolatedCodexConfig(input, providerConfig);
  await writeIsolatedCodexAuth(input, providerConfig);
}

async function writeIsolatedCodexAuth(input: CodexAuthInput, providerConfig: string): Promise<void> {
  await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
  const targetAuth = join(input.codexHome, "auth.json");
  await rm(targetAuth, { force: true });
  if (providerConfig) return;
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    // The pinned Codex app-server authenticates API-key automation through its
    // login cache rather than the CLI-only CODEX_API_KEY path. Keep this file
    // owner-only in the disposable session home.
    await writeFile(
      targetAuth,
      JSON.stringify({ OPENAI_API_KEY: apiKey }),
      { mode: 0o600 },
    );
    await chmod(targetAuth, 0o600);
    return;
  }

  const sourceHome = input.sourceCodexHome?.trim();
  if (!sourceHome) return;
  const sourceAuth = await readSourceCodexAuth(join(sourceHome, "auth.json"));
  if (!sourceAuth) return;
  await writeFile(targetAuth, sourceAuth, { mode: 0o600 });
  await chmod(targetAuth, 0o600);
}
