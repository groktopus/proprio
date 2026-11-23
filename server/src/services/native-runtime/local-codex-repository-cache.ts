import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { withDirectoryPublicationLock } from "@groktopus/adapter-utils/workspace-restore-merge";

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

/** Only the controller can select the cache scope for an authorized native run. */
export function localCodexRepositoryCache(stateDirectory: string, companyId: string) {
  const companyKey = createHash("sha256").update(companyId).digest("hex");
  return async <T>(digest: string, consume: (repository: string) => Promise<T>): Promise<T> => {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid pinned repository digest");
    const stateRoot = await realpath(stateDirectory);
    const cache = await privateDirectory(stateRoot, ".codex-repositories");
    const company = await privateDirectory(cache, companyKey);
    return withDirectoryPublicationLock(join(company, digest), consume);
  };
}
