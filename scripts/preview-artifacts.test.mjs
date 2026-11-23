import test from "node:test";
import { readExternalReleaseFile, testExternalReleaseContract } from "./test-external-release-contract.mjs";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { previewManifest, assertMetadata, validateRequest, versionFor, tarManifest, planArtifacts, packageExists, imageExists, publishPreview, publishImage } from "./preview-artifacts.mjs";

const sha = "a".repeat(40);
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const manifest = (name) => previewManifest({ name, version: "0.0.0", dependencies: name.endsWith("/db") ? { "@groktopus/shared": "workspace:*" } : {}, publishConfig: { exports: { ".": "./dist/index.js" } } }, sha);
function pack(pkg) {
  const b = Buffer.from(JSON.stringify(pkg)); const h = Buffer.alloc(512);
  h.write("package/package.json"); h.write(b.length.toString(8).padStart(11, "0"), 124, 11); h[156] = 48;
  const padded = Buffer.alloc(Math.ceil(b.length / 512) * 512); b.copy(padded);
  return gzipSync(Buffer.concat([h, padded, Buffer.alloc(1024)]));
}

test("preview request requires immutable SHA and correlation UUID", () => {
  validateRequest(sha, id);
  for (const ref of ["master", "origin/master", "a".repeat(7), "$(unsafe)", "A".repeat(40)]) assert.throws(() => versionFor(ref));
  assert.throws(() => validateRequest(sha, "not-a-request"));
});

test("preview manifests carry exact source, isolated versions and shared dependency", () => {
  const pkg = manifest("@groktopus/db");
  assert.equal(pkg.version, `0.0.0-preview.g${sha}`);
  assert.equal(pkg.dependencies["@groktopus/shared"], pkg.version);
  assert.deepEqual(pkg.exports, { ".": "./dist/index.js" });
  assertMetadata(pkg, "@groktopus/db", sha);
  assert.throws(() => assertMetadata({ ...pkg, gitHead: "b".repeat(40) }, pkg.name, sha));
  assert.throws(() => assertMetadata({ ...pkg, dependencies: { "@groktopus/shared": "latest" } }, pkg.name, sha));
  assert.deepEqual(tarManifest(pack(pkg)), pkg);
});

testExternalReleaseContract("preview workflow separates branch compilation from trusted publishing", () => {
  const workflow = readExternalReleaseFile(".github/workflows/release.yml");
  const builder = workflow.split("  package_preview:")[1].split("  publish_preview:")[0];
  const publisher = workflow.split("  publish_preview:")[1].split("  image_preview:")[0];
  const image = workflow.split("  image_preview:")[1].split("  publish_image_preview:")[0];
  const imagePublisher = workflow.split("  publish_image_preview:")[1].split("  result_preview:")[0];
  assert.doesNotMatch(builder, /id-token: write|packages: write|secrets\./);
  assert.doesNotMatch(publisher, /ref: \$\{\{ inputs.source_ref|working-directory: source|pnpm install/);
  assert.match(publisher, /environment: npm-canary/);
  assert.match(image, /PROPRIO_BUILD_COMMIT=\$\{\{ inputs.source_ref \}\}/);
  assert.doesNotMatch(image, /cache-(?:to|from):|canary-cloud|latest-cloud|packages: write|secrets\./);
  assert.doesNotMatch(imagePublisher, /ref: \$\{\{ inputs.source_ref|docker\/build-push-action|pnpm install/);
  assert.match(imagePublisher, /publish-image/);
  assert.match(imagePublisher, /environment: npm-canary/);
  assert.match(imagePublisher, /github.ref == 'refs\/heads\/master'/);
  assert.match(publisher, /github.ref == 'refs\/heads\/master'/);
  assert.doesNotMatch(workflow.split("  verify_canary:")[0], /uses: [^\n]+@v\d/);
  assert.match(workflow, /Stack deploy \{0\} build/);
});

testExternalReleaseContract("manual migrator and branch preview retain their npm publisher and concurrency", () => {
  const release = readExternalReleaseFile(".github/workflows/release.yml");
  assert.match(release, /\(inputs.channel == 'preview' \|\| inputs.channel == 'cloud-migrator'\) && format\('\{0\}-\{1\}', inputs.channel, inputs.source_ref\)/);
  const publisher = release.split("  publish_preview:")[1].split("  image_preview:")[0];
  assert.match(publisher, /group: preview-package-publish-\$\{\{ inputs.source_ref \}\}/);
  assert.match(publisher, /cancel-in-progress: false/);
  assert.match(release, /PLAN_COMMAND: \$\{\{ inputs.channel == 'cloud-migrator' && 'plan-migrator' \|\| 'plan' \}\}/);
  const result = release.split("  result_preview:")[1].split("  verify_canary:")[0];
  assert.match(result, /always\(\) && inputs.channel == 'preview'/);
});

test("source checkout refuses preview distribution until a publisher is configured", async () => {
  const expected = /preview distribution is not configured/;
  await assert.rejects(planArtifacts(sha), expected);
  await assert.rejects(packageExists("@groktopus/db", sha), expected);
  await assert.rejects(imageExists(sha), expected);
  await assert.rejects(publishPreview("preview", sha), expected);
  await assert.rejects(publishImage("preview-image.tar", sha), expected);
});
