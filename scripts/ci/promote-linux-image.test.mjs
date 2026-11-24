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

function fixture(t, { existing = "", rejectPublic = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "proprio-image-promotion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "log");
  writeFileSync(log, "");
  writeFileSync(path.join(root, "gh"), '#!/bin/sh\nprintf "gh %s\\n" "$*" >> "$LOG"\n', { mode: 0o700 });
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
        TAG: path.join(root, "tag"), DIGEST: digest, EXISTING: existing, REJECT_PUBLIC: rejectPublic ? "1" : "" },
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
  const [provenance, sbom] = f.calls().split("\n");
  assert.match(provenance, /attestation verify .*--source-digest/);
  assert.match(sbom, /https:\/\/spdx\.dev\/Document/);
  assert.ok(f.calls().includes(`--tag ghcr.io/groktopus/proprio:linux-0.0.3 ghcr.io/groktopus/proprio@${digest}`));
});

test("a conflicting tag or private candidate blocks promotion", t => {
  const conflicting = fixture(t, { existing: otherDigest });
  assert.notEqual(conflicting.run(digest).status, 0);
  assert.doesNotMatch(conflicting.calls(), /imagetools create/);
  const privateCandidate = fixture(t, { rejectPublic: true });
  assert.notEqual(privateCandidate.run(digest).status, 0);
  assert.doesNotMatch(privateCandidate.calls(), /imagetools create/);
});
