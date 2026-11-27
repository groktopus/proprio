import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));
const refreshAppLogin = 'proprio-lock-refresh-test[bot]';
const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
const signedAppCommits = [{ sha: headSha, author: { login: refreshAppLogin }, committer: { login: 'web-flow' },
  commit: { verification: { verified: true } }, appSignatureVerified: true, parents: [{ sha: baseSha }] }];

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes only verified App proof changes on the exact base and fixed branch', () => {
  const result = checkLockfile(
    makeFiles(['tests/runner-e2e/report-lock.json', 'tests/runner-e2e/report-lock.patch',
      'tests/runner-e2e/source-sdk-public-inputs.json']),
    refreshAppLogin,
    'chore/refresh-lockfile',
    { refreshPrAuthor: refreshAppLogin, headRepo: 'groktopus/proprio', baseRepo: 'groktopus/proprio',
      commits: signedAppCommits, baseSha, headSha }
  );
  assert.equal(result.passed, true);
});

test('does not authorize App managed-lock edits, unsigned commits, or wrong-base chains', () => {
  const options = { refreshPrAuthor: refreshAppLogin, headRepo: 'groktopus/proprio', baseRepo: 'groktopus/proprio',
    commits: signedAppCommits, baseSha, headSha };
  assert.equal(checkLockfile(makeFiles(['pnpm-lock.yaml']), refreshAppLogin, 'chore/refresh-lockfile', options).passed, false);
  assert.equal(checkLockfile(makeFiles(['tests/runner-e2e/report-lock.json']), refreshAppLogin, 'chore/refresh-lockfile',
    { ...options, commits: [{ ...signedAppCommits[0], appSignatureVerified: false }] }).passed, false);
  assert.equal(checkLockfile(makeFiles(['tests/runner-e2e/report-lock.json']), refreshAppLogin, 'chore/refresh-lockfile',
    { ...options, baseSha: 'c'.repeat(40) }).passed, false);
});

test('does not trust generic Actions bot or missing refresh App identity', () => {
  for (const author of ['github-actions[bot]', refreshAppLogin]) {
    const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), author, 'chore/refresh-lockfile', { refreshPrAuthor: '' });
    assert.equal(result.passed, false, author);
  }
});

test('does not accept another author on the configured App branch', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'github-actions[bot]', 'chore/refresh-lockfile',
    { refreshPrAuthor: refreshAppLogin, headRepo: 'groktopus/proprio', baseRepo: 'groktopus/proprio' });
  assert.equal(result.passed, false);
});

test('does not trust the configured App author from a fork', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), refreshAppLogin, 'chore/refresh-lockfile',
    { refreshPrAuthor: refreshAppLogin, headRepo: 'fork/proprio', baseRepo: 'groktopus/proprio' });
  assert.equal(result.passed, false);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    refreshAppLogin,
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});

test('passes when Dependabot changes the lockfile', () => {
  assert.equal(checkLockfile(makeFiles(['pnpm-lock.yaml', 'package.json']), 'dependabot[bot]', 'dependabot/npm_and_yarn/zod-4.6.6').passed, true);
});

test('fails when Dependabot changes the reporting-lock proof', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml', 'tests/runner-e2e/report-lock.json']), 'dependabot[bot]', 'dependabot/npm_and_yarn/zod-4.6.6');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('report-lock.json'));
});

test('fails when a regular user changes the reporting-lock proof', () => {
  const result = checkLockfile(makeFiles(['tests/runner-e2e/report-lock.patch']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('report-lock.patch'));
});

test('fails when a regular user changes a sandbox provider lockfile', () => {
  for (const file of ['scripts/typecheck-sandbox-providers/pnpm-lock.yaml', 'packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml']) {
    const result = checkLockfile(makeFiles([file]), 'someuser', 'fix/bug');
    assert.equal(result.passed, false, file);
    assert.ok(result.failures[0].includes(file));
  }
});

test('passes when Dependabot changes a sandbox provider lockfile', () => {
  const files = makeFiles(['packages/plugins/sandbox-providers/daytona/package.json', 'packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml']);
  assert.equal(checkLockfile(files, 'dependabot[bot]', 'dependabot/npm_and_yarn/packages/plugins/sandbox-providers/daytona/zod-4.6.6').passed, true);
});
