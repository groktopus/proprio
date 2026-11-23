import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withDirectoryPublicationLock } from "@groktopus/adapter-utils/workspace-restore-merge";
import { logger } from "../../middleware/logger.js";
import { removeRuntimeAssetTree, RUNTIME_ASSET_RETENTION_MS } from "./runtime-asset-retention.js";

const digestPattern = /^[a-f0-9]{64}$/u;
const unpublishedPattern = /^\.repository-(?:staging|retired)-([a-f0-9]{64})-[\w-]+$/u;
const nextSweep = new Map<string, number>();
const sweepIntervalMs = 60 * 60_000;

async function privateDirectory(parent: string, name: string): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid?.()) {
    throw new Error("Unsafe local Codex repository cache directory");
  }
  return directory;
}

async function plainDirectory(path: string) {
  try {
    const info = await lstat(path);
    return info.isDirectory() ? info : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function hasSessionReferences(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await hasSessionReferences(path)) return true;
    } else {
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1) return true;
    }
  }
  return false;
}

/** Prepare and prune under the same per-pin lock. The cache is disposable.
 * A session or its local checkpoint carries a separate link to every file. */
async function pruneExpiredRepositories(company: string) {
  const cutoff = Date.now() - RUNTIME_ASSET_RETENTION_MS;
  let removed = 0;
  for (const name of await readdir(company)) {
    const published = digestPattern.test(name);
    const digest = published ? name : unpublishedPattern.exec(name)?.[1];
    if (!digest) continue;
    const candidate = join(company, name);
    const info = await plainDirectory(candidate);
    if (!info || info.mtimeMs >= cutoff) continue;
    const didRemove = await withDirectoryPublicationLock(join(company, digest), async () => {
      const current = await plainDirectory(candidate);
      if (!current || current.mtimeMs >= cutoff || await hasSessionReferences(candidate)) return false;
      let retired = candidate;
      if (published) {
        // Remove the cache key atomically before changing or deleting bytes.
        // A dead sweeper can leave only an unpublished tree to reap later.
        retired = join(company, `.repository-retired-${digest}-${randomUUID()}`);
        await rename(candidate, retired);
      }
      await removeRuntimeAssetTree(retired);
      return true;
    });
    if (didRemove && ++removed >= 16) break;
  }
}

/** Only the controller can select the cache scope for an authorized native run. */
export function localCodexRepositoryCache(stateDirectory: string, companyId: string) {
  const companyKey = createHash("sha256").update(companyId).digest("hex");
  const rootName = ".codex-repositories";
  async function use<T>(digest: string, consume: (repository: string) => Promise<T>): Promise<T> {
    if (!digestPattern.test(digest)) throw new Error("Invalid pinned repository digest");
    const stateRoot = await realpath(stateDirectory);
    const cache = await privateDirectory(stateRoot, rootName);
    const company = await privateDirectory(cache, companyKey);
    const result = await withDirectoryPublicationLock(join(company, digest), consume);
    if ((nextSweep.get(company) ?? 0) <= Date.now()) {
      if (nextSweep.size >= 1_024) nextSweep.delete(nextSweep.keys().next().value!);
      nextSweep.set(company, Date.now() + sweepIntervalMs);
      void pruneExpiredRepositories(company)
        .catch(error => logger.warn({ err: error }, "Local Codex repository cache cleanup failed"));
    }
    return result;
  }
  return { rootPath: resolve(stateDirectory, rootName), use };
}
