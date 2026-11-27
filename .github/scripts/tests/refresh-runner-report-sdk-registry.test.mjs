import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateRefreshProof } from '../lockfile-trust.mjs';

const registryPath = 'tests/runner-e2e/source-sdk-public-inputs.json';
const reportPath = 'tests/runner-e2e/report-lock.json';
const patchPath = 'tests/runner-e2e/report-lock.patch';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

test('scratch proof commit regenerates exactly the SDK input registry from the trusted generator', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'sdk-registry-writer-'));
  const source = process.cwd();
  const workspace = path.join(temp, 'workspace');
  try {
    execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', source, workspace]);
    const base = git(workspace, 'rev-parse', 'HEAD');
    const lock = execFileSync('git', ['show', `${base}:pnpm-lock.yaml`], { cwd: workspace });
    const lockSha = hash(lock);
    writeFileSync(path.join(workspace, reportPath), `${JSON.stringify({ inputSha256: lockSha, outputSha256: lockSha,
      patchSha256: hash(''), basis: 'synthetic trusted test policy' }, null, 2)}\n`);
    writeFileSync(path.join(workspace, patchPath), '');

    const run = spawnSync('bash', [path.resolve('.github/scripts/refresh-runner-report-sdk-registry.sh')], {
      cwd: source, encoding: 'utf8', env: { ...process.env, BASE_SHA: base, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp },
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);

    const original = JSON.parse(execFileSync('git', ['show', `${base}:${registryPath}`], { cwd: workspace, encoding: 'utf8' }));
    const candidate = JSON.parse(readFileSync(path.join(workspace, registryPath), 'utf8'));
    assert.equal(candidate.lockSha256, lockSha);
    const stable = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'inputs' && key !== 'lockSha256'));
    assert.deepEqual(stable(candidate), stable(original));

    const roots = ['packages/shared/src', 'packages/plugins/sdk/src'];
    const build = ['package.json', 'packages/plugins/sdk/package.json', 'packages/plugins/sdk/tsconfig.json',
      'packages/shared/package.json', 'packages/shared/tsconfig.json', 'pnpm-lock.yaml',
      'scripts/ensure-plugin-build-deps.mjs', 'tsconfig.base.json', 'tsconfig.json'];
    const expected = {};
    for (const entry of git(workspace, 'ls-tree', '-rz', base, '--', ...roots, ...build).split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      assert.ok(match, entry);
      expected[match[3]] = match[2];
    }
    assert.deepEqual(candidate.inputs, Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))));
    const changed = git(workspace, 'diff', '--name-only', base).split('\n').filter(Boolean).sort();
    assert.deepEqual(changed, [registryPath, reportPath].sort());
    assert.ok(readFileSync(path.join(workspace, patchPath)).length === 0, 'unchanged empty patch remains part of the generated proof pair');

    git(workspace, 'config', 'user.name', 'Fixture App');
    git(workspace, 'config', 'user.email', 'fixture-app@example.invalid');
    git(workspace, 'add', '--', reportPath, patchPath, registryPath);
    git(workspace, 'commit', '-qm', 'signed fixture App proof');
    const appHead = git(workspace, 'rev-parse', 'HEAD');
    assert.equal(validateRefreshProof(base, appHead, workspace), true, 'trusted-base generator must accept the exact registry bytes');

    const badRegistry = { ...candidate, lockSha256: 'f'.repeat(64) };
    writeFileSync(path.join(workspace, registryPath), `${JSON.stringify(badRegistry, null, 2)}\n`);
    git(workspace, 'add', '--', registryPath);
    git(workspace, 'commit', '-qm', 'tampered registry fixture');
    const badHead = git(workspace, 'rev-parse', 'HEAD');
    assert.equal(validateRefreshProof(base, badHead, workspace), false, 'registry lock pin must match report-lock output');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
