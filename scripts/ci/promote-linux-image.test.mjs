import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("./promote-linux-image.sh", import.meta.url));
const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const source = "c".repeat(40);

function fixture(t, { existing = "", rejectPublic = false, tagSha = source, tagType = "commit", tagObjectSha = "e".repeat(40), publishedTag = "v0.0.3", isDraft = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "proprio-image-promotion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "log");
  writeFileSync(log, "");
  writeFileSync(path.join(root, "gh"), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$LOG"
case "$1:$2" in
  release:view)
    if [ -z "$PUBLISHED_TAG" ]; then echo 'release not found' >&2; exit 1; fi
    printf '%s %s\\n' "$PUBLISHED_TAG" "$IS_DRAFT" ;;
  attestation:verify) ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  writeFileSync(path.join(root, "git"), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$LOG"
if [ "$3" != ls-remote ] || [ "$4" != --exit-code ] || [ "$5" != --tags ] \
  || [ "$6" != https://github.com/groktopus/proprio.git ] \
  || [ "$7" != refs/tags/v0.0.3 ] || [ "$8" != 'refs/tags/v0.0.3^{}' ]; then exit 99; fi
if [ "$TAG_TYPE" = tag ]; then
  printf 'peeled %s %s\\n' "$TAG_OBJECT_SHA" "$TAG_SHA" >> "$LOG"
  printf '%s\\trefs/tags/v0.0.3\\n%s\\trefs/tags/v0.0.3^{}\\n' "$TAG_OBJECT_SHA" "$TAG_SHA"
else
  printf '%s\\trefs/tags/v0.0.3\\n' "$TAG_SHA"
fi
`, { mode: 0o700 });
  writeFileSync(path.join(root, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$LOG"
if [ "$1" = --config ]; then
  if [ -n "$REJECT_PUBLIC" ]; then exit 9; fi
  shift 2
fi
case "$3:$4" in
  inspect:ghcr.io/groktopus/proprio@*) printf '%s\\n' "$DIGEST" ;;
  inspect:*:linux-0.0.3)
    if [ -f "$TAG" ]; then cat "$TAG"
    elif [ -n "$EXISTING" ]; then printf '%s\\n' "$EXISTING"
    else echo "manifest unknown" >&2; exit 1; fi ;;
  create:--prefer-index=false) printf '%s\\n' "$DIGEST" > "$TAG" ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  return {
    run: qualified => spawnSync("bash", [command, source, digest, qualified, "linux-0.0.3"], {
      encoding: "utf8",
      env: { PATH: `${root}:${process.env.PATH}`, LOG: log,
        TAG: path.join(root, "tag"), DIGEST: digest, EXISTING: existing, REJECT_PUBLIC: rejectPublic ? "1" : "",
        TAG_SHA: tagSha, TAG_TYPE: tagType, TAG_OBJECT_SHA: tagObjectSha,
        PUBLISHED_TAG: publishedTag, IS_DRAFT: isDraft ? "true" : "false" },
    }),
    calls: () => readFileSync(log, "utf8"),
  };
}

test("missing qualification or a different digest blocks all external calls", t => {
  const f = fixture(t);
  assert.notEqual(f.run("").status, 0);
  assert.notEqual(f.run(otherDigest).status, 0);
  assert.equal(f.calls(), "");
});

test("promotion verifies both signatures and reuses the tested digest", t => {
  const f = fixture(t);
  const result = f.run(digest);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = f.calls();
  const attestations = calls.split("\n").filter(call => call.includes("attestation verify"));
  const [provenance, sbom] = attestations;
  assert.match(provenance, /attestation verify .*--source-digest/);
  assert.match(sbom, /https:\/\/spdx\.dev\/Document/);
  assert.ok(f.calls().includes("gh release view v0.0.3 --repo groktopus/proprio --json tagName,isDraft --jq .tagName + \" \" + (.isDraft | tostring)"));
  assert.match(calls, /git -C .* ls-remote --exit-code --tags https:\/\/github.com\/groktopus\/proprio\.git/);
  assert.ok(calls.includes(`--tag ghcr.io/groktopus/proprio:linux-0.0.3 ghcr.io/groktopus/proprio@${digest}`));
});

test("a missing release or source tag mismatch blocks registry operations", t => {
  const missingRelease = fixture(t, { publishedTag: "" });
  const missingResult = missingRelease.run(digest);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /release not found/);
  assert.match(missingRelease.calls(), /gh release view v0\.0\.3/);
  assert.doesNotMatch(missingRelease.calls(), /git -C|docker /);

  const wrongSource = fixture(t, { tagSha: "d".repeat(40) });
  assert.notEqual(wrongSource.run(digest).status, 0);
  assert.doesNotMatch(wrongSource.calls(), /attestation verify|docker /);
});

test("a draft source release blocks registry operations", t => {
  const draftRelease = fixture(t, { isDraft: true });
  const result = draftRelease.run(digest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Publish the matching GitHub source release v0\.0\.3/);
  assert.doesNotMatch(draftRelease.calls(), /git -C|attestation verify|docker /);
});

test("annotated release tags are resolved from their distinct tag object to the peeled commit", t => {
  const annotated = fixture(t, { tagType: "tag", tagObjectSha: "d".repeat(40) });
  const result = annotated.run(digest);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(annotated.calls().includes(`peeled ${"d".repeat(40)} ${source}`));
});

test("a conflicting tag or private candidate blocks promotion", t => {
  const conflicting = fixture(t, { existing: otherDigest });
  assert.notEqual(conflicting.run(digest).status, 0);
  assert.doesNotMatch(conflicting.calls(), /imagetools create/);
  const privateCandidate = fixture(t, { rejectPublic: true });
  assert.notEqual(privateCandidate.run(digest).status, 0);
  assert.doesNotMatch(privateCandidate.calls(), /imagetools create/);
});
