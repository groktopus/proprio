import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyPullRequest,
  configuredRefreshAppLogin,
  hasVerifiedRefreshAppCommits,
  findDependabotLockCommit,
  findMergedDependabotPull,
  isReviewedMainBootstrap,
  REVIEWED_MAIN_BOOTSTRAP,
  isDependabotCommit,
  isGitHubSignedCommit,
  LOCKFILES,
  PROVIDER_LOCKFILES,
} from '../lockfile-trust.mjs';

const repo = 'groktopus/proprio';
const refreshAppLogin = 'proprio-lock-refresh-test[bot]';
const base = { author: 'someuser', headRepo: repo, baseRepo: repo, headRef: 'fix/bug', dependabotLockCommits: {},
  refreshPrAuthor: refreshAppLogin };
const hash = (value) => createHash('sha256').update(value).digest('hex');
function validRefreshProof(lockText) {
  return {
    'tests/runner-e2e/report-lock.json': JSON.stringify({ inputSha256: hash(lockText), outputSha256: hash(lockText),
      patchSha256: hash(''), basis: 'fixture' }) + '\n',
    'tests/runner-e2e/report-lock.patch': '',
  };
}

test('allows a pull request that does not change lock content', () => {
  assert.deepEqual(
    { ...classifyPullRequest({ ...base, changedPaths: ['server/src/index.ts'] }), reason: undefined },
    { allowed: true, writer: 'none', reason: undefined },
  );
});

test('blocks a contributor lockfile change', () => {
  const result = classifyPullRequest({ ...base, changedPaths: ['pnpm-lock.yaml'] });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /pnpm-lock\.yaml/);
});

test('blocks a contributor change to the reporting-lock proof', () => {
  const result = classifyPullRequest({ ...base, changedPaths: ['tests/runner-e2e/report-lock.patch'] });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /report-lock\.patch/);
});

test('blocks a contributor branch named like the refresh branch', () => {
  for (const headRepo of [repo, 'someone/proprio']) {
    const result = classifyPullRequest({ ...base, headRepo, headRef: 'chore/refresh-lockfile', changedPaths: ['pnpm-lock.yaml'] });
    assert.equal(result.allowed, false, headRepo);
  }
});

test('blocks the refresh author and branch from a fork', () => {
  const result = classifyPullRequest({ ...base, author: refreshAppLogin, headRepo: 'someone/proprio',
    headRef: 'chore/refresh-lockfile', changedPaths: ['pnpm-lock.yaml'] });
  assert.equal(result.allowed, false);
});

test('does not accept github-actions[bot] as a substitute for the configured refresh App', () => {
  const result = classifyPullRequest({ ...base, author: 'github-actions[bot]', headRef: 'chore/refresh-lockfile',
    changedPaths: ['tests/runner-e2e/report-lock.json'] });
  assert.equal(result.allowed, false);
});

test('allows the verified refresh App to change only the reporting proof pair', () => {
  const result = classifyPullRequest({ ...base, author: refreshAppLogin, headRef: 'chore/refresh-lockfile',
    refreshAppCommitsVerified: true, changedPaths: ['tests/runner-e2e/report-lock.json', 'tests/runner-e2e/report-lock.patch',
      'tests/runner-e2e/source-sdk-public-inputs.json'] });
  assert.equal(result.allowed, true);
  assert.equal(result.writer, 'refresh-bot');
});

test('App refresh identity cannot authorize managed lockfiles or unrelated files', () => {
  for (const changedPaths of [
    ['pnpm-lock.yaml', 'tests/runner-e2e/report-lock.json'],
    ['tests/runner-e2e/report-lock.json', 'README.md'],
  ]) {
    const result = classifyPullRequest({ ...base, author: refreshAppLogin, headRef: 'chore/refresh-lockfile',
      refreshAppCommitsVerified: true, changedPaths });
    assert.equal(result.allowed, false, changedPaths.join(', '));
  }
});

test('refresh App commits must be signed and attributed to the configured App', () => {
  const chain = [{ sha: 'head', parents: ['base'], login: refreshAppLogin, committer: 'web-flow', verified: true }];
  assert.equal(hasVerifiedRefreshAppCommits(chain, refreshAppLogin, 'base', 'head'), true);
  assert.equal(hasVerifiedRefreshAppCommits([{ ...chain[0], verified: false }], refreshAppLogin, 'base', 'head'), false);
  assert.equal(hasVerifiedRefreshAppCommits([{ ...chain[0], login: 'someuser' }], refreshAppLogin, 'base', 'head'), false);
  assert.equal(hasVerifiedRefreshAppCommits([{ ...chain[0], parents: ['other'] }], refreshAppLogin, 'base', 'head'), false);
  assert.equal(hasVerifiedRefreshAppCommits([], refreshAppLogin, 'base', 'head'), false);
});

test('does not trust the generic Actions bot or an absent App identity as the refresh writer', () => {
  for (const author of ['github-actions[bot]', refreshAppLogin]) {
    const result = classifyPullRequest({ ...base, author, refreshPrAuthor: '', headRef: 'chore/refresh-lockfile',
      changedPaths: ['tests/runner-e2e/report-lock.json'] });
    assert.equal(result.allowed, false, author);
  }
});

test('accepts only a configured App bot login, not reserved automation identities', () => {
  assert.equal(configuredRefreshAppLogin('runner-lock-refresh[bot]'), 'runner-lock-refresh[bot]');
  assert.equal(configuredRefreshAppLogin('github-actions[bot]'), '');
  assert.equal(configuredRefreshAppLogin('dependabot[bot]'), '');
  assert.equal(configuredRefreshAppLogin('Runner Lock Refresh'), '');
  assert.equal(configuredRefreshAppLogin(''), '');
});

test('allows a Dependabot lockfile that matches a verified Dependabot commit', () => {
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]', headRef: 'dependabot/npm_and_yarn/zod-4.6.6',
    changedPaths: ['package.json', 'pnpm-lock.yaml'], dependabotLockCommits: { 'pnpm-lock.yaml': 'abc123' } });
  assert.equal(result.allowed, true);
  assert.equal(result.writer, 'dependabot');
});

test('blocks a Dependabot lockfile that no verified Dependabot commit produced', () => {
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]', changedPaths: ['pnpm-lock.yaml'] });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /@dependabot recreate/);
});

test('blocks a Dependabot pull request that changes the reporting-lock proof', () => {
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]', dependabotLockCommits: { 'pnpm-lock.yaml': 'abc123' },
    changedPaths: ['pnpm-lock.yaml', 'tests/runner-e2e/report-lock.json'] });
  assert.equal(result.allowed, false);
});

test('blocks a Dependabot author from a fork', () => {
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]', headRepo: 'someone/proprio',
    dependabotLockCommits: { 'pnpm-lock.yaml': 'abc123' }, changedPaths: ['pnpm-lock.yaml'] });
  assert.equal(result.allowed, false);
});

test('guards the sandbox provider lockfiles as well as the root lockfile', () => {
  assert.deepEqual(LOCKFILES, ['pnpm-lock.yaml', ...PROVIDER_LOCKFILES]);
  for (const file of PROVIDER_LOCKFILES) {
    const result = classifyPullRequest({ ...base, changedPaths: [file] });
    assert.equal(result.allowed, false, file);
    assert.ok(result.reason.includes(file), result.reason);
  }
});

test('dedicated report App cannot change provider lockfiles', () => {
  const result = classifyPullRequest({ ...base, author: refreshAppLogin, headRef: 'chore/refresh-lockfile',
    changedPaths: LOCKFILES });
  assert.equal(result.allowed, false);
  assert.equal(result.writer, 'none');
});

test('allows a Dependabot provider lockfile that matches a verified Dependabot commit', () => {
  const [file] = PROVIDER_LOCKFILES;
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]',
    changedPaths: ['packages/plugins/sandbox-providers/e2b/package.json', file], dependabotLockCommits: { [file]: 'abc123' } });
  assert.equal(result.allowed, true);
  assert.equal(result.writer, 'dependabot');
});

test('blocks a Dependabot pull request when any changed lockfile is unverified', () => {
  const [file] = PROVIDER_LOCKFILES;
  const result = classifyPullRequest({ ...base, author: 'dependabot[bot]',
    changedPaths: ['pnpm-lock.yaml', file], dependabotLockCommits: { 'pnpm-lock.yaml': 'abc123', [file]: null } });
  assert.equal(result.allowed, false);
  assert.ok(result.reason.startsWith(`${file} does not match`), result.reason);
});

test('finds only verified Dependabot commits that hold the exact lockfile', () => {
  const blobs = { a: 'lock-1', b: 'lock-2', c: 'lock-2', d: 'lock-2' };
  const lockBlobAt = (sha) => blobs[sha] ?? null;
  const commits = [
    { sha: 'a', login: 'dependabot[bot]', committer: 'web-flow', verified: true },
    { sha: 'b', login: 'dependabot[bot]', committer: 'web-flow', verified: false },
    { sha: 'c', login: 'someuser', committer: 'web-flow', verified: true },
  ];
  assert.equal(findDependabotLockCommit({ lockBlob: 'lock-2', commits, lockBlobAt }), null);
  assert.equal(findDependabotLockCommit({ lockBlob: 'lock-1', commits, lockBlobAt }), 'a');
  assert.equal(findDependabotLockCommit({ lockBlob: 'lock-2', lockBlobAt,
    commits: [...commits, { sha: 'd', login: 'dependabot[bot]', committer: 'web-flow', verified: true }] }), 'd');
  assert.equal(findDependabotLockCommit({ lockBlob: null, commits, lockBlobAt }), null);
});

test('requires a Dependabot author with GitHub as the verified committer', () => {
  assert.equal(isDependabotCommit({ login: 'dependabot[bot]', committer: 'web-flow', verified: true }), true);
  // A collaborator can sign with their own key and set Dependabot as the author.
  assert.equal(isDependabotCommit({ login: 'dependabot[bot]', committer: 'someuser', verified: true }), false);
  assert.equal(isDependabotCommit({ login: 'dependabot[bot]', committer: null, verified: true }), false);
  assert.equal(isDependabotCommit({ login: 'dependabot[bot]', committer: 'web-flow', verified: false }), false);
  assert.equal(isDependabotCommit({ login: 'someuser', committer: 'web-flow', verified: true }), false);
});

test('ignores a lockfile commit with a spoofed Dependabot author', () => {
  const lockBlobAt = () => 'lock-1';
  const spoofed = [{ sha: 'x', login: 'dependabot[bot]', committer: 'someuser', verified: true }];
  assert.equal(findDependabotLockCommit({ lockBlob: 'lock-1', commits: spoofed, lockBlobAt }), null);
});

test('finds the merged Dependabot pull request for a master commit', () => {
  const pull = (overrides) => ({ number: 1, user: { login: 'dependabot[bot]' }, merged_at: '2026-11-05T00:00:00Z',
    merge_commit_sha: 'm', base: { ref: 'master' }, ...overrides });
  assert.equal(findMergedDependabotPull([pull({})], 'm', 'master')?.number, 1);
  assert.equal(findMergedDependabotPull([pull({ merged_at: null })], 'm', 'master'), null);
  assert.equal(findMergedDependabotPull([pull({ user: { login: 'someuser' } })], 'm', 'master'), null);
  assert.equal(findMergedDependabotPull([pull({ merge_commit_sha: 'other' })], 'm', 'master'), null);
  assert.equal(findMergedDependabotPull([pull({ base: { ref: 'release' } })], 'm', 'master'), null);
});

test('admits only the exact signed #125 main lock bootstrap', () => {
  const input = { repository: 'groktopus/proprio', defaultBranch: 'main',
    lockCommit: '7d7c362107390b8f9778ba061c867d5401ede31e',
    pull: { number: 125, merged_at: '2026-11-23T17:30:16Z',
      merge_commit_sha: '7d7c362107390b8f9778ba061c867d5401ede31e', base: { ref: 'main' } },
    githubSigned: true, lockSha256: '535010469947806e6b8f0edff97bd211ca96b573dccd81dd08556e3f7b43b337' };
  assert.equal(isReviewedMainBootstrap(input), true);
  assert.deepEqual(REVIEWED_MAIN_BOOTSTRAP, { repository: input.repository, branch: input.defaultBranch,
    lockCommit: input.lockCommit, pullRequest: 125, lockSha256: input.lockSha256 });
  for (const [key, value] of Object.entries({ repository: 'other/repo', defaultBranch: 'master', lockCommit: 'other',
    githubSigned: false, lockSha256: '0'.repeat(64), pull: { ...input.pull, number: 124 } })) {
    assert.equal(isReviewedMainBootstrap({ ...input, [key]: value }), false, key);
  }
  for (const pull of [{ ...input.pull, merged_at: null }, { ...input.pull, base: { ref: 'release' } },
    { ...input.pull, merge_commit_sha: 'other' }]) {
    assert.equal(isReviewedMainBootstrap({ ...input, pull }), false);
  }
});

test('trusts only merge commits that GitHub created and signed', () => {
  assert.equal(isGitHubSignedCommit({ committer: { login: 'web-flow' }, commit: { verification: { committer: 'web-flow', verified: true } } }), true);
  assert.equal(isGitHubSignedCommit({ committer: { login: 'web-flow' }, commit: { verification: { committer: 'web-flow', verified: false } } }), false);
  assert.equal(isGitHubSignedCommit({ committer: { login: 'someuser' }, commit: { verification: { committer: 'web-flow', verified: true } } }), false);
  assert.equal(isGitHubSignedCommit(null), false);
});

// Run the `pr` command against a real git history, with a stub `gh` that lists the PR commits.
function runPrCheck(build, refreshAppLogin = '', signature = { isValid: true, wasSignedByGitHub: true }) {
  const root = mkdtempSync(path.join(tmpdir(), 'lockfile-trust-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = (author, files) => {
      for (const [file, contents] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), contents);
      }
      git('add', '.');
      git('-c', `user.name=${author}`, '-c', `user.email=${author}@example.invalid`, 'commit', '-qm', author);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    const baseLock = 'lock: base\n';
    const baseSha = commit('base', {
      'pnpm-lock.yaml': baseLock, 'package.json': '{}\n',
      'tests/runner-e2e/report-lock.json': JSON.stringify({ inputSha256: hash(baseLock), outputSha256: hash(baseLock),
        patchSha256: hash(''), basis: 'initial' }) + '\n',
      'tests/runner-e2e/report-lock.patch': '',
      'tests/runner-e2e/source-sdk-public-inputs.json': JSON.stringify({ lockSha256: hash(baseLock), inputs: {} }) + '\n',
      'tests/runner-e2e/prepare-report-lock.mjs': readFileSync(path.resolve('tests/runner-e2e/prepare-report-lock.mjs')),
    });
    const { author, commits, headRef } = build(commit, baseSha);
    const bin = path.join(root, '.bin');
    execFileSync('mkdir', [bin]);
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$1" = api ] && [ "$2" = graphql ]; then printf "%s\\n" "$GH_GRAPHQL_STUB_OUTPUT"; else printf "%s\\n" "$GH_STUB_OUTPUT"; fi\n');
    chmodSync(path.join(bin, 'gh'), 0o755);
    const output = path.join(root, '.output');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [path.resolve('.github/scripts/lockfile-trust.mjs'), 'pr'], {
      cwd: root, encoding: 'utf8',
    env: { ...process.env, LOCKFILE_REFRESH_APP_LOGIN: refreshAppLogin, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: repo,
        PR_NUMBER: '7', BASE_SHA: baseSha, HEAD_SHA: git('rev-parse', 'HEAD'), PR_AUTHOR: author, HEAD_REPO: repo,
        HEAD_REF: headRef ?? 'dependabot/npm_and_yarn/zod', GH_STUB_OUTPUT: commits.map((entry) => JSON.stringify(entry)).join('\n'),
        GH_GRAPHQL_STUB_OUTPUT: JSON.stringify({ data: { repository: { object: { signature } } } }) },
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('pr command admits a Dependabot lockfile after a later non-lockfile commit', () => {
  const result = runPrCheck((commit) => {
    const sha = commit('dependabot', { 'pnpm-lock.yaml': 'lock: dependabot\n', 'package.json': '{"zod":"4.6.6"}\n' });
    commit('maintainer', { 'notes.md': 'fix\n' });
    return { author: 'dependabot[bot]', commits: [{ sha, login: 'dependabot[bot]', committer: 'web-flow', verified: true }] };
  });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.output, /^writer=dependabot$/m);
});

test('pr command blocks a lockfile edited after the Dependabot commit', () => {
  const result = runPrCheck((commit) => {
    const sha = commit('dependabot', { 'pnpm-lock.yaml': 'lock: dependabot\n' });
    const edit = commit('maintainer', { 'pnpm-lock.yaml': 'lock: edited\n' });
    return { author: 'dependabot[bot]', commits: [
      { sha, login: 'dependabot[bot]', committer: 'web-flow', verified: true },
      { sha: edit, login: 'maintainer', committer: 'web-flow', verified: true },
    ] };
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Untrusted lockfile change/);
});

test('pr command blocks a lockfile commit whose Dependabot author another committer signed', () => {
  const result = runPrCheck((commit) => {
    const sha = commit('maintainer', { 'pnpm-lock.yaml': 'lock: spoofed\n' });
    return { author: 'dependabot[bot]', commits: [{ sha, login: 'dependabot[bot]', committer: 'maintainer', verified: true }] };
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Untrusted lockfile change/);
});

test('pr command checks each lockfile a Dependabot pull request changes', () => {
  const [file] = PROVIDER_LOCKFILES;
  const admitted = runPrCheck((commit) => {
    const sha = commit('dependabot', { [file]: 'lock: dependabot\n', 'package.json': '{"zod":"4.6.6"}\n' });
    return { author: 'dependabot[bot]', commits: [{ sha, login: 'dependabot[bot]', committer: 'web-flow', verified: true }] };
  });
  assert.equal(admitted.status, 0, admitted.stdout);
  assert.match(admitted.output, /^writer=dependabot$/m);

  const edited = runPrCheck((commit) => {
    const sha = commit('dependabot', { 'pnpm-lock.yaml': 'lock: dependabot\n', [file]: 'lock: dependabot\n' });
    const edit = commit('maintainer', { [file]: 'lock: edited\n' });
    return { author: 'dependabot[bot]', commits: [
      { sha, login: 'dependabot[bot]', committer: 'web-flow', verified: true },
      { sha: edit, login: 'maintainer', committer: 'web-flow', verified: true },
    ] };
  });
  assert.equal(edited.status, 1, edited.stdout);
  assert.ok(edited.stdout.includes(`${file} does not match`), edited.stdout);
});

test('pr command blocks a contributor change to a provider lockfile', () => {
  const result = runPrCheck((commit) => {
    commit('someuser', { [PROVIDER_LOCKFILES[1]]: 'lock: contributor\n' });
    return { author: 'someuser', commits: [] };
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /^writer=none$/m);
});

test('pr command blocks a contributor lockfile change', () => {
  const result = runPrCheck((commit) => {
    commit('someuser', { 'pnpm-lock.yaml': 'lock: contributor\n' });
    return { author: 'someuser', commits: [] };
  });
  assert.equal(result.status, 1);
  assert.match(result.output, /^writer=none$/m);
});

test('pr command trusts the configured App only as the actual same-repository author on the fixed branch', () => {
  const permitted = runPrCheck((commit, baseSha) => {
    const sha = commit('refresh-app', validRefreshProof('lock: base\n'));
    return { author: refreshAppLogin, headRef: 'chore/refresh-lockfile', commits: [{ sha, parents: [baseSha],
      login: refreshAppLogin, committer: 'web-flow', verified: true }] };
  }, refreshAppLogin);
  assert.equal(permitted.status, 0, permitted.stdout);
  assert.match(permitted.output, /^writer=refresh-bot$/m);

  const spoofed = runPrCheck((commit) => {
    commit('github-actions[bot]', { 'tests/runner-e2e/report-lock.json': '{"proof":"new"}\n' });
    return { author: 'github-actions[bot]', headRef: 'chore/refresh-lockfile', commits: [] };
  }, refreshAppLogin);
  assert.equal(spoofed.status, 1);
  assert.match(spoofed.stdout, /Untrusted lockfile change/);

  const invalidProof = runPrCheck((commit, baseSha) => {
    const sha = commit('refresh-app', { 'tests/runner-e2e/report-lock.json': '{"inputSha256":"wrong"}\n',
      'tests/runner-e2e/report-lock.patch': '' });
    return { author: refreshAppLogin, headRef: 'chore/refresh-lockfile', commits: [{ sha, parents: [baseSha],
      login: refreshAppLogin, committer: 'web-flow', verified: true }] };
  }, refreshAppLogin);
  assert.equal(invalidProof.status, 1);
  assert.match(invalidProof.stdout, /does not validate against the exact base lock/);

  const unsigned = runPrCheck((commit, baseSha) => {
    const sha = commit('refresh-app', validRefreshProof('lock: base\n'));
    return { author: refreshAppLogin, headRef: 'chore/refresh-lockfile', commits: [{ sha, parents: [baseSha],
      login: refreshAppLogin, committer: 'web-flow', verified: true }] };
  }, refreshAppLogin, { isValid: true, wasSignedByGitHub: false });
  assert.equal(unsigned.status, 1);
  assert.match(unsigned.stdout, /Do not commit/);
});

test('the PR workflow runs the trust policy from the exact trusted base', () => {
  const pr = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
  assert.match(pr, /git show "\$BASE_SHA:\.github\/scripts\/lockfile-trust\.mjs" > "\$policy"/);
  assert.match(pr, /test "\$\(git rev-parse HEAD\)" = "\$BASE_SHA"/);
  assert.match(pr, /git fetch --no-tags origin "\$PR_HEAD_REF"/);
  assert.match(pr, /test "\$fetched_head" = "\$HEAD_SHA"/);
  assert.match(pr, /BASE_SHA="\$BASE_SHA" node "\$policy" pr/);
  assert.match(pr, /PROPRIO_CI_PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.doesNotMatch(pr, /github\.head_ref != 'chore\/refresh-lockfile'/);
});

// Run the pull_request_target policy step with an exact base and fetched PR head.
function runPolicyStep({ baseSha, headSha, author, headRef, root }) {
  execFileSync('git', ['-C', root, 'checkout', '--quiet', '--detach', baseSha]);
  const workflow = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
  const step = workflow.split('      - name: Block untrusted lockfile edits\n')[1];
  const lines = step.split('\n');
  const start = lines.findIndex((line) => line === '        run: |') + 1;
  const end = lines.findIndex((line, index) => index >= start && line.trim() !== '' && !line.startsWith('          '));
  const script = lines.slice(start, end).map((line) => line.slice(10)).join('\n');
  const output = path.join(root, '.output');
  writeFileSync(output, '');
  const runnerTemp = path.join(mkdtempSync(path.join(tmpdir(), 'policy-runner-')), 'temp');
  symlinkSync(mkdtempSync(path.join(tmpdir(), 'policy-runner-real-')), runnerTemp);
  const result = spawnSync('bash', ['-e', '-c', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: repo, BASE_SHA: baseSha, HEAD_SHA: headSha, PR_NUMBER: '1',
      PR_AUTHOR: author, HEAD_REPO: repo, HEAD_REF: headRef, PR_HEAD_REF: 'refs/pull/1/head' },
  });
  return { status: result.status, stdout: result.stdout + result.stderr, output: readFileSync(output, 'utf8') };
}

test('the policy step loads policy from the exact trusted base and verifies the exact PR head', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lockfile-policy-step-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = (message) => {
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'master');
    git('remote', 'add', 'origin', root);
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock: base\n');
    commit('base before the policy');
    // The PR head is deliberately based before the policy was added to main.
    git('checkout', '-q', '-b', 'chore/refresh-lockfile');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock: contributor\n');
    const head = commit('contributor lockfile');
    git('checkout', '-q', 'master');
    execFileSync('mkdir', ['-p', path.join(root, '.github/scripts')]);
    writeFileSync(path.join(root, '.github/scripts/lockfile-trust.mjs'), readFileSync('.github/scripts/lockfile-trust.mjs'));
    const currentBase = commit('add the policy');
    git('update-ref', 'refs/pull/1/head', head);

    const blocked = runPolicyStep({ root, baseSha: currentBase, headSha: head, author: 'someuser', headRef: 'chore/refresh-lockfile' });
    assert.equal(blocked.status, 1, blocked.stdout);
    assert.match(blocked.stdout, /Untrusted lockfile change/);

    // A docs-only PR passes through the policy loaded from the exact base.
    git('checkout', '-q', '-b', 'docs', currentBase);
    writeFileSync(path.join(root, 'notes.md'), 'docs\n');
    const docs = commit('docs only');
    git('update-ref', 'refs/pull/1/head', docs);
    const movedHead = runPolicyStep({ root, baseSha: currentBase, headSha: head, author: 'someuser', headRef: 'docs' });
    assert.equal(movedHead.status, 1, JSON.stringify(movedHead));
    assert.match(movedHead.stdout, /differs from event head/, JSON.stringify(movedHead));

    const allowed = runPolicyStep({ root, baseSha: currentBase, headSha: docs, author: 'someuser', headRef: 'docs' });
    assert.equal(allowed.status, 0, allowed.stdout);
    assert.match(allowed.stdout, /does not change lock content/);
    assert.match(allowed.output, /^writer=none$/m);

    // A missing base policy is a hard failure, never a permissive legacy fallback.
    const missingPolicy = runPolicyStep({ root, baseSha: git('rev-parse', 'master^'), headSha: head, author: 'someuser', headRef: 'chore/refresh-lockfile' });
    assert.equal(missingPolicy.status, 1);
    assert.match(missingPolicy.stdout, /Trusted base .* is missing lockfile-trust\.mjs/);
    assert.doesNotMatch(missingPolicy.output, /^writer=/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the policy step fails when the loaded policy exits without reporting a writer', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lockfile-policy-silent-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = (message) => {
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q', '-b', 'master');
    git('remote', 'add', 'origin', root);
    execFileSync('mkdir', ['-p', path.join(root, '.github/scripts')]);
    writeFileSync(path.join(root, '.github/scripts/lockfile-trust.mjs'), 'process.exit(0);\n');
    const baseSha = commit('a policy that skips its checks');
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lock: contributor\n');
    const head = commit('contributor lockfile');
    git('update-ref', 'refs/pull/1/head', head);

    const result = runPolicyStep({ root, baseSha, headSha: head, author: 'someuser', headRef: 'feature' });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /did not report a lockfile writer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
