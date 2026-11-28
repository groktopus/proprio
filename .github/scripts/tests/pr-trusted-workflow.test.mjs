import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
const trust = readFileSync('.github/scripts/lockfile-trust.mjs', 'utf8');

test('trusted PR policy is read-only and runs only for main pull requests', () => {
  assert.match(workflow, /pull_request_target:\n\s+branches: \[main\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|secrets\./);
  assert.match(workflow, /if: github\.repository == 'groktopus\/proprio'/);
  assert.match(workflow, /persist-credentials: true/);
  assert.match(workflow, /git fetch --no-tags origin "\$PR_HEAD_REF"/);
  assert.match(workflow, /lockfile-policy-status:[\s\S]*?if: always\(\) && github\.repository == 'groktopus\/proprio'/);
  assert.match(workflow, /lockfile-policy-status:[\s\S]*?permissions:\n\s+statuses: write/);
  const statusJob = workflow.split('  lockfile-policy-status:\n')[1];
  assert.match(statusJob, /needs: \[lockfile-policy\]/);
  assert.match(statusJob, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(statusJob, /POLICY_RESULT: \$\{\{ needs\.lockfile-policy\.result \}\}/);
  assert.match(statusJob, /state=failure[\s\S]*?POLICY_RESULT" == success/);
  assert.match(statusJob, /context 'proprio\/lockfile-trust'/);
  assert.match(statusJob, /statuses\/\$HEAD_SHA/);
  assert.doesNotMatch(statusJob, /actions\/checkout|git fetch|node .*\.mjs/);
});

test('policy is loaded from trusted base history, not the PR head', () => {
  assert.match(workflow, /git show "\$BASE_SHA:\.github\/scripts\/lockfile-trust\.mjs" > "\$policy"/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$BASE_SHA"/);
  assert.match(workflow, /git cat-file -e "\$BASE_SHA:\.github\/scripts\/lockfile-trust\.mjs"/);
  assert.match(workflow, /fetched_head="\$\(git rev-parse 'FETCH_HEAD\^\{commit\}'\)"/);
  assert.match(workflow, /test "\$fetched_head" = "\$HEAD_SHA"/);
  assert.match(workflow, /differs from event head \$HEAD_SHA/);
  assert.match(workflow, /BASE_SHA="\$BASE_SHA" node "\$policy" pr/);
  assert.match(workflow, /grep -q '\^writer=' "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /did not report a lockfile writer/);
  assert.match(workflow, /Trusted base \$BASE_SHA is missing lockfile-trust\.mjs/);
  assert.doesNotMatch(workflow, /rev-list|writer=none.*exit 0/);
  assert.match(workflow, /PROPRIO_CI_PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.match(workflow, /LOCKFILE_REFRESH_APP_LOGIN: \$\{\{ vars\.LOCKFILE_REFRESH_APP_LOGIN \}\}/);
  assert.match(trust, /query\(\$owner:String!,\$name:String!,\$oid:GitObjectID!\)/);
  assert.match(trust, /signature\{isValid wasSignedByGitHub\}/);
});

test('status publisher reports both verifier outcomes on the exact event head', () => {
  const statusJob = workflow.split('  lockfile-policy-status:\n')[1];
  const runBlock = statusJob.split('        run: |\n')[1];
  assert.ok(runBlock, 'status job must have an inline script and no checkout dependency');
  const script = runBlock.split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
  const root = mkdtempSync(path.join(tmpdir(), 'lockfile-status-'));
  try {
    const bin = path.join(root, 'bin');
    const curl = path.join(bin, 'curl');
    const capture = path.join(root, 'capture.json');
    const captureUrl = path.join(root, 'url.txt');
    mkdirSync(bin);
    writeFileSync(curl, '#!/bin/sh\ndata= url=\nfor arg do case "$arg" in @*) data="${arg#@}";; http*) url="$arg";; esac; done\ncp "$data" "$CAPTURE_BODY"\nprintf "%s" "$url" > "$CAPTURE_URL"\n');
    chmodSync(curl, 0o755);

    for (const [result, expectedState] of [['success', 'success'], ['failure', 'failure']]) {
      const runnerTemp = path.join(root, result);
      mkdirSync(runnerTemp);
      const proc = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { ...process.env,
        PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'test-token', HEAD_SHA: 'a'.repeat(40), POLICY_RESULT: result,
        API_URL: 'https://api.github.com', REPOSITORY: 'groktopus/proprio', RUN_URL: 'https://github.com/groktopus/proprio/actions/runs/3',
        RUNNER_TEMP: runnerTemp, CAPTURE_BODY: capture, CAPTURE_URL: captureUrl } });
      assert.equal(proc.status, 0, proc.stderr);
      const body = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(body.state, expectedState);
      assert.equal(body.context, 'proprio/lockfile-trust');
      assert.equal(readFileSync(captureUrl, 'utf8'), `https://api.github.com/repos/groktopus/proprio/statuses/${'a'.repeat(40)}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
