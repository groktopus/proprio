import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const indexMediaTypes = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Validate the multi-platform index before it becomes a signed build contract. */
export function standardImageDigest(bytes) {
  const index = JSON.parse(bytes.toString("utf8"));
  assert.equal(index.schemaVersion, 2);
  assert.ok(indexMediaTypes.includes(index.mediaType));
  assert.ok(Array.isArray(index.manifests));
  for (const architecture of ["amd64", "arm64"]) {
    const matches = index.manifests.filter(item => item.platform?.os === "linux" && item.platform?.architecture === architecture);
    assert.equal(matches.length, 1, `Expected exactly one linux/${architecture} image`);
    assert.match(matches[0].digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(matches[0].size) && matches[0].size > 0);
  }
  return sha256(bytes);
}

/**
 * Platform image digests covered by the build legs' native PID 1 probe. Each
 * leg probes the digest it pushed; that is a per-leg index (image plus
 * provenance) or, without provenance, the image manifest itself. `legs` maps
 * each probed digest to its registry bytes.
 */
export function verifiedImageDigests(legs) {
  const verified = new Set();
  for (const [digest, bytes] of legs) {
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(sha256(bytes), digest, "Verified image bytes do not match their digest");
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (!indexMediaTypes.includes(manifest.mediaType)) { verified.add(digest); continue; }
    for (const item of manifest.manifests ?? []) {
      if (item.platform?.os === "linux" && /^sha256:[a-f0-9]{64}$/.test(item.digest ?? "")) verified.add(item.digest);
    }
  }
  return verified;
}

/** Sign only an index whose every Linux image passed the build-leg probe. */
export function assertIndexUsesVerifiedImages(indexBytes, verified) {
  standardImageDigest(indexBytes);
  const index = JSON.parse(indexBytes.toString("utf8"));
  for (const item of index.manifests.filter(entry => entry.platform?.os === "linux")) {
    assert.ok(verified.has(item.digest),
      `linux/${item.platform.architecture} image ${item.digest} did not pass the build-leg orphan-reaping probe`);
  }
}

/** Read registry bytes directly; CLI stdout formatting is not artifact content. */
export async function resolveStandardImageDigest(_sha, _fetchImpl, { missing = "error" } = {}) {
  if (missing === "return-null") return null;
  throw new Error("Proprio has no published application images.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const verifiedFlag = process.argv.indexOf("--verified-digests");
  const verifiedDigests = verifiedFlag > 0 ? await readVerifiedDigests(process.argv[verifiedFlag + 1]) : undefined;
  const digest = process.argv[2] === "--resolve" ? await resolveStandardImageDigest(process.argv[3], fetch, { verifiedDigests }) : standardImageDigest(await readFile(process.argv[2]));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
  console.log(digest);
}
