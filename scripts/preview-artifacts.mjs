#!/usr/bin/env node
// Trusted release tooling. Packaging runs without publish credentials; publishing
// accepts only the two fixed package artifacts and never executes their scripts.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, renameSync, appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { materializePublishManifest, prepareBundledPackage } from "./prepare-bundled-package.mjs";

export const versionFor = (sha) => {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("Preview builds require a full immutable commit SHA.");
  return `0.0.0-preview.g${sha}`;
};
export function validateRequest(sha, requestId) {
  versionFor(sha);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId ?? "")) throw new Error("A correlation UUID is required.");
}

export function previewManifest(pkg, sha) {
  if (!["@groktopus/shared", "@groktopus/db"].includes(pkg.name)) throw new Error("Unexpected preview package.");
  const version = versionFor(sha);
  const exact = structuredClone(pkg);
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(exact[section] ?? {})) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) exact[section][name] = version;
    }
  }
  const result = materializePublishManifest({ ...exact, version });
  result.gitHead = sha;
  result.proprioPreviewCommit = sha;
  if (pkg.name === "@groktopus/db") result.dependencies = { ...result.dependencies, "@groktopus/shared": version };
  return result;
}

export function assertMetadata(pkg, name, sha) {
  if (pkg?.publishConfig !== undefined || pkg?.name !== name || pkg.version !== versionFor(sha) || pkg.gitHead !== sha || pkg.proprioPreviewCommit !== sha ||
      (name === "@groktopus/db" && pkg.dependencies?.["@groktopus/shared"] !== versionFor(sha))) {
    throw new Error("Preview package identity or dependency pin mismatch.");
  }
}

export function tarManifest(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  let manifest;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((v) => v === 0)) break;
    const field = (start, size) => h.subarray(start, start + size).toString("utf8").split("\0")[0].trim();
    const sizeText = field(124, 12);
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid package archive.");
    const size = Number.parseInt(sizeText, 8);
    if (offset + 512 + size > tar.length) throw new Error("Truncated package archive.");
    const name = `${field(345, 155) ? field(345, 155) + "/" : ""}${field(0, 100)}`;
    if (!name.startsWith("package/") || name.split("/").some((part) => part === "." || part === "..") || ![0, 48, 53].includes(h[156])) throw new Error("Unsupported package archive entry.");
    if (name === "package/package.json") {
      if (manifest || ![0, 48].includes(h[156])) throw new Error("Invalid package manifest entry.");
      manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!manifest) throw new Error("Missing package manifest.");
  return manifest;
}

const notPublished = () => { throw new Error("Proprio preview distribution is not configured."); };
export async function packageExists() { notPublished(); }
export async function planArtifacts() { notPublished(); }
export async function imageExists() { notPublished(); }
export async function publishImage() { notPublished(); }

export function packPreview(source, output, sha, { exec = execFileSync } = {}) {
  versionFor(sha);
  source = path.resolve(source); output = path.resolve(output);
  if (exec("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() !== sha) throw new Error("Source checkout differs from the requested commit.");
  mkdirSync(output, { recursive: true });
  for (const short of ["shared", "db"]) {
    exec("pnpm", ["--filter", `@groktopus/${short}`, "build"], { cwd: source, stdio: "inherit" });
    const packageDir = path.join(source, "packages", short);
    const originalText = readFileSync(path.join(packageDir, "package.json"), "utf8");
    const original = JSON.parse(originalText);
    const pkg = previewManifest(original, sha);
    const staging = path.join(output, `package-${short}`);
    if ((pkg.bundleDependencies ?? []).length) {
      // The established helper materializes patched embedded-postgres instead
      // of publishing pnpm's dependency symlinks.
      writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(pkg));
      try { prepareBundledPackage(packageDir, staging, { sourceRoot: source }); }
      finally { writeFileSync(path.join(packageDir, "package.json"), originalText); }
    } else {
      mkdirSync(staging, { recursive: true });
      cpSync(path.join(packageDir, "dist"), path.join(staging, "dist"), { recursive: true });
      writeFileSync(path.join(staging, "package.json"), JSON.stringify(pkg));
    }
    const packed = JSON.parse(exec("npx", ["--yes", "npm@10.9.7", "pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: staging, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
    renameSync(path.join(output, path.basename(packed[0].filename)), path.join(output, `${short}.tgz`));
    assertMetadata(tarManifest(readFileSync(path.join(output, `${short}.tgz`))), `@groktopus/${short}`, sha);
  }
}

export async function publishPreview() { notPublished(); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "plan" || command === "plan-migrator") {
      const [sha, requestId, migrator] = args;
      validateRequest(sha, requestId);
      if (process.env.GITHUB_REF !== "refs/heads/master") throw new Error("Preview workflow definitions must run from master.");
      const { image, packages } = await planArtifacts(sha, {
        image: command === "plan", migrator: command === "plan-migrator" || migrator === "true",
      });
      appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\npackages=${packages}\n`);
    } else if (command === "pack") packPreview(...args);
    else if (command === "publish") await publishPreview(...args);
    else if (command === "publish-image") await publishImage(...args);
    else if (command === "result") {
      const [sha, requestId] = args;
      validateRequest(sha, requestId);
      if (!await imageExists(sha)) throw new Error("Cloud image is still missing.");
      if (process.env.PREVIEW_MIGRATOR === "true" && !(await packageExists("@groktopus/shared", sha) && await packageExists("@groktopus/db", sha))) throw new Error("Preview packages are still missing.");
      mkdirSync("stack-deploy-result", { recursive: true });
      writeFileSync("stack-deploy-result/result.json", JSON.stringify({ version: 1, stage: "build", requestId, sha, status: "ready" }) + "\n");
    } else throw new Error("Expected plan, plan-migrator, pack, publish, publish-image, or result.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
