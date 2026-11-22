import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

// Access alone also accepts directories; check for a regular executable file.
export async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return false;
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
