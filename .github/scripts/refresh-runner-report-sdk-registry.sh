#!/usr/bin/env bash
set -euo pipefail

workspace="${GITHUB_WORKSPACE:-$PWD}"
base_sha="$BASE_SHA"
runner_temp="$RUNNER_TEMP"
registry=tests/runner-e2e/source-sdk-public-inputs.json
proof_json=tests/runner-e2e/report-lock.json
proof_patch=tests/runner-e2e/report-lock.patch

[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$workspace" rev-parse HEAD)" = "$base_sha"
snapshot="$(mktemp -d "$runner_temp/runner-report-sdk-snapshot.XXXXXX")"
rmdir "$snapshot"
trap 'rm -rf "$snapshot"' EXIT

# Clone the committed base, then add only candidate proof data as a local
# scratch commit. Nothing from the source workspace's working tree is copied.
git clone --quiet --local --no-hardlinks "$workspace" "$snapshot"
git -C "$snapshot" checkout --quiet --detach "$base_sha"
for file in "$proof_json" "$proof_patch"; do
  install -D -m 0644 "$workspace/$file" "$snapshot/$file"
done
git -C "$snapshot" add -- "$proof_json" "$proof_patch"
git -C "$snapshot" -c user.name='Local SDK registry snapshot' \
  -c user.email='local-snapshot@users.noreply.github.com' \
  -c core.hooksPath=/dev/null commit -qm 'scratch: candidate Runner reporting proof'
snapshot_sha="$(git -C "$snapshot" rev-parse HEAD)"

changed="$(git -C "$snapshot" diff --name-only "$base_sha..$snapshot_sha")"
[[ -n "$changed" ]] || { echo 'Reporting proof is unchanged; no SDK registry refresh is needed.'; exit 0; }
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    "$proof_json"|"$proof_patch") ;;
    *) echo "::error::Scratch proof snapshot contains unexpected path: $file"; exit 1 ;;
  esac
done <<< "$changed"

# This script is from the exact main snapshot. It reads committed inputs only and
# writes only the SDK registry from the scratch revision.
node "$snapshot/tests/runner-e2e/source-sdk-public-inputs.mjs" "$snapshot_sha" --write
node "$snapshot/tests/runner-e2e/source-sdk-public-inputs.mjs" "$snapshot_sha" --check

# Independently compare the candidate to the expected git-tree pins and policy.
BASE_SHA="$base_sha" SNAPSHOT_SHA="$snapshot_sha" GITHUB_WORKSPACE="$snapshot" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
const base = process.env.BASE_SHA;
const revision = process.env.SNAPSHOT_SHA;
const registryPath = 'tests/runner-e2e/source-sdk-public-inputs.json';
const proofPath = 'tests/runner-e2e/report-lock.json';
const sourceRoots = ['packages/shared/src', 'packages/plugins/sdk/src'];
const buildInputs = ['package.json', 'packages/plugins/sdk/package.json', 'packages/plugins/sdk/tsconfig.json',
  'packages/shared/package.json', 'packages/shared/tsconfig.json', 'pnpm-lock.yaml',
  'scripts/ensure-plugin-build-deps.mjs', 'tsconfig.base.json', 'tsconfig.json'];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const parse = (rev, file) => JSON.parse(git('show', `${rev}:${file}`));
const baseline = parse(base, registryPath);
const candidate = JSON.parse(readFileSync(path.join(root, registryPath), 'utf8'));
const policy = parse(revision, proofPath);
assert.match(candidate.lockSha256, /^[a-f0-9]{64}$/);
assert.equal(candidate.lockSha256, policy.outputSha256, 'SDK registry must pin report-lock outputSha256');

const stableFields = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'inputs' && key !== 'lockSha256'));
assert.deepEqual(stableFields(candidate), stableFields(baseline), 'runtime SDK pins must stay unchanged');

const expected = {};
const entries = git('ls-tree', '-rz', revision, '--', ...sourceRoots, ...buildInputs).split('\0').filter(Boolean);
for (const entry of entries) {
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([A-Za-z0-9._/-]+)$/.exec(entry);
  assert.ok(match, `unexpected git tree entry ${entry}`);
  expected[match[3]] = match[2];
}
const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
assert.deepEqual(sorted(candidate.inputs), sorted(expected), 'SDK registry pins must match the exact scratch git tree');
NODE

install -D -m 0644 "$snapshot/$registry" "$workspace/$registry"
