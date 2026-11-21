import { pathToFileURL } from "node:url";

export async function reuseCanaryImage() {
  throw new Error("Proprio is not publishing canary images yet.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await reuseCanaryImage();
}
