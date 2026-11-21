import type { ProviderPackIdentity } from "./remote-provider-pack-verification.js";

export const MAX_RETAINED_PACK_BYTES = 4 * 1024 ** 3;

export type RetainedPackProvenance = {
  schema: "proprio.retained-provider-pack-source.v1";
  sourceRevision: string;
  providerPackDigest: string;
  imageIndexDigest: string;
  imageManifestDigest: string;
  imageConfigDigest: string;
  transportLayerDigest: string;
  transportLayerBytes: number;
  runnerImage?: { inputsDigest: string; transportLayerDigests: string[] };
};
export async function receiveRetainedProviderPack(_input: {
  manifest: ProviderPackIdentity;
  directory: string;
  signal: AbortSignal;
}): Promise<RetainedPackProvenance> {
  throw new Error("No trusted OCI publisher has been configured for retained provider packs.");
}
