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

function fixture(t, { existing = "", rejectPublic = false, tagSha = source, tagType = "commit", publishedTag = "v0.0.3", isDraft = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "proprio-image-promotion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "log");
  writeFileSync(log, "");
  writeFileSync(path.join(root, "gh"), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$LOG"
case "$1:$2" in
  release:view) printf '%s %s\\n' "$PUBLISHED_TAG" "$IS_DRAFT" ;;
  api:repos/groktopus/proprio/git/ref/tags/v0.0.3) printf '%s %s\\n' "$TAG_SHA" "$TAG_TYPE" ;;
  api:repos/groktopus/proprio/git/tags/*) printf '%s commit\\n' "$TAG_SHA" ;;
  attestation:verify) ;;
  *) exit 99 ;;
esac
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
        TAG_SHA: tagSha, TAG_TYPE: tagType, PUBLISHED_TAG: publishedTag, IS_DRAFT: isDraft ? "true" : "false" },
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
  assert.match(calls, /gh api repos\/groktopus\/proprio\/git\/ref\/tags\/v0\.0\.3/);
  assert.ok(calls.includes(`--tag ghcr.io/groktopus/proprio:linux-0.0.3 ghcr.io/groktopus/proprio@${digest}`));
});

test("a missing release or source tag mismatch blocks registry operations", t => {
  const missingRelease = fixture(t, { publishedTag: "" });
  assert.notEqual(missingRelease.run(digest).status, 0);
  assert.doesNotMatch(missingRelease.calls(), /docker /);

  const wrongSource = fixture(t, { tagSha: "d".repeat(40) });
  assert.notEqual(wrongSource.run(digest).status, 0);
  assert.doesNotMatch(wrongSource.calls(), /attestation verify|docker /);
});

test("a draft source release blocks registry operations", t => {
  const draftRelease = fixture(t, { isDraft: true });
  assert.notEqual(draftRelease.run(digest).status, 0);
  assert.doesNotMatch(draftRelease.calls(), /gh api|attestation verify|docker /);
});

test("annotated release tags are resolved to their commit before promotion", t => {
  const annotated = fixture(t, { tagType: "tag" });
  const result = annotated.run(digest);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(annotated.calls().includes("gh api repos/groktopus/proprio/git/tags/"));
});

test("a conflicting tag or private candidate blocks promotion", t => {
  const conflicting = fixture(t, { existing: otherDigest });
  assert.notEqual(conflicting.run(digest).status, 0);
  assert.doesNotMatch(conflicting.calls(), /imagetools create/);
  const privateCandidate = fixture(t, { rejectPublic: true });
  assert.notEqual(privateCandidate.run(digest).status, 0);
  assert.doesNotMatch(privateCandidate.calls(), /imagetools create/);
});
