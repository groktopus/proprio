import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedWorkspaceDependencyNames,
  checkReleaseBootstrap,
} from '../check-pr-release-bootstrap.mjs';

const MANIFEST_PATH = 'scripts/release-package-manifest.json';

function encodeManifest(entries) {
  return { content: Buffer.from(JSON.stringify(entries)).toString('base64') };
}

function stubGitHub({ base = [], head = [] }) {
  return async (path) => {
    if (path.includes('ref=refs%2Fpull%2F')) return encodeManifest(head);
    if (path.includes(`/contents/`)) return encodeManifest(base);
    throw new Error(`unexpected fetch: ${path}`);
  };
}

const manifestChangedFile = { filename: MANIFEST_PATH, status: 'modified' };

test('does nothing (and fetches nothing) when the manifest is untouched', async () => {
  const result = await checkReleaseBootstrap(
    [{ filename: 'server/src/index.ts', status: 'modified' }],
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: async () => { throw new Error('should not fetch'); },
      registryPackageExists: async () => { throw new Error('should not look up'); },
    }
  );

  assert.deepEqual(result, { passed: true, informational: [] });
});

test('notices a new publishFromCi:true package that is missing from npm', async () => {
  const result = await checkReleaseBootstrap(
    [manifestChangedFile],
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: stubGitHub({
        base: [{ dir: 'a', name: '@groktopus/existing', publishFromCi: true }],
        head: [
          { dir: 'a', name: '@groktopus/existing', publishFromCi: true },
          { dir: 'b', name: '@groktopus/brand-new', publishFromCi: true },
        ],
      }),
      registryPackageExists: async (name) => name !== '@groktopus/brand-new',
    }
  );

  assert.equal(result.informational.length, 1);
  assert.match(result.informational[0], /@proprio\/brand-new/);
  assert.match(result.informational[0], /release:bootstrap-package -- @proprio\/brand-new --publish/);
  assert.match(result.informational[0], /No contributor action/);
});

test('stays quiet when the new package already exists on npm', async () => {
  const result = await checkReleaseBootstrap(
    [manifestChangedFile],
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: stubGitHub({
        base: [],
        head: [{ dir: 'b', name: '@groktopus/already-bootstrapped', publishFromCi: true }],
      }),
      registryPackageExists: async () => true,
    }
  );

  assert.deepEqual(result.informational, []);
});

test('notices a publishFromCi flip from false to true on a missing package', async () => {
  const result = await checkReleaseBootstrap(
    [manifestChangedFile],
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: stubGitHub({
        base: [{ dir: 'b', name: '@groktopus/flipped', publishFromCi: false }],
        head: [{ dir: 'b', name: '@groktopus/flipped', publishFromCi: true }],
      }),
      registryPackageExists: async () => false,
    }
  );

  assert.equal(result.informational.length, 1);
  assert.match(result.informational[0], /@proprio\/flipped/);
});

test('notices a publishFromCi:false package that published packages newly depend on', async () => {
  const files = [
    manifestChangedFile,
    {
      filename: 'server/package.json',
      status: 'modified',
      patch: '@@ -1 +1 @@\n+    "@groktopus/adapter-kimi-local": "workspace:*",',
    },
  ];

  const result = await checkReleaseBootstrap(
    files,
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: stubGitHub({
        base: [],
        head: [{ dir: 'b', name: '@groktopus/adapter-kimi-local', publishFromCi: false }],
      }),
      registryPackageExists: async () => false,
    }
  );

  assert.equal(result.informational.length, 1);
  assert.match(result.informational[0], /depend on it/);
  assert.match(result.informational[0], /"publishFromCi": true/);
  assert.match(result.informational[0], /drop the workspace dependency/);
});

test('notices a newly added dependency on an existing unpublished package even when the manifest is untouched', async () => {
  const files = [
    {
      filename: 'server/package.json',
      status: 'modified',
      patch: '@@ -1 +1 @@\n+    "@groktopus/adapter-hermes-gateway": "workspace:*",',
    },
  ];

  const manifest = [{ dir: 'g', name: '@groktopus/adapter-hermes-gateway', publishFromCi: false }];
  const result = await checkReleaseBootstrap(
    files,
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: stubGitHub({ base: manifest, head: manifest }),
      registryPackageExists: async () => false,
    }
  );

  assert.equal(result.informational.length, 1);
  assert.match(result.informational[0], /@proprio\/adapter-hermes-gateway/);
  assert.match(result.informational[0], /depend on it/);
});

test('stays quiet for a publishFromCi:false package nothing depends on', async () => {
  const result = await checkReleaseBootstrap(
    [manifestChangedFile],
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: stubGitHub({
        base: [],
        head: [{ dir: 'b', name: '@groktopus/deliberately-private', publishFromCi: false }],
      }),
      registryPackageExists: async () => { throw new Error('should not look up'); },
    }
  );

  assert.deepEqual(result.informational, []);
});

test('never looks up names outside the @proprio scope', async () => {
  const lookedUp = [];
  const result = await checkReleaseBootstrap(
    [manifestChangedFile],
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: stubGitHub({
        base: [],
        head: [
          { dir: 'x', name: '@evil/probe', publishFromCi: true },
          { dir: 'y', name: 'unscoped-name', publishFromCi: true },
          { dir: 'z', name: '@groktopus/UPPER', publishFromCi: true },
        ],
      }),
      registryPackageExists: async (name) => {
        lookedUp.push(name);
        return false;
      },
    }
  );

  assert.deepEqual(lookedUp, []);
  assert.deepEqual(result.informational, []);
});

test('stays quiet when the registry lookup fails', async () => {
  const result = await checkReleaseBootstrap(
    [manifestChangedFile],
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: stubGitHub({
        base: [],
        head: [{ dir: 'b', name: '@groktopus/brand-new', publishFromCi: true }],
      }),
      registryPackageExists: async () => { throw new Error('registry down'); },
    }
  );

  assert.deepEqual(result, { passed: true, informational: [] });
});

test('treats a missing base manifest as empty (every head entry is new)', async () => {
  const result = await checkReleaseBootstrap(
    [manifestChangedFile],
    'token',
    'groktopus/proprio',
    9967,
    'master',
    {
      fetchFromGitHub: async (path) => {
        if (path.includes('ref=refs%2Fpull%2F')) {
          return encodeManifest([{ dir: 'b', name: '@groktopus/brand-new', publishFromCi: true }]);
        }
        throw new Error('404 base manifest');
      },
      registryPackageExists: async () => false,
    }
  );

  assert.equal(result.informational.length, 1);
});

test('addedWorkspaceDependencyNames reads only added lines of package.json patches', () => {
  const names = addedWorkspaceDependencyNames([
    {
      filename: 'server/package.json',
      patch: [
        '@@ -1,3 +1,4 @@',
        '     "@groktopus/context-line": "workspace:*",',
        '-    "@groktopus/removed-dep": "workspace:*",',
        '+    "@groktopus/added-dep": "workspace:*",',
      ].join('\n'),
    },
    { filename: 'ui/src/index.ts', patch: '+    "@groktopus/not-a-pkg-json": "workspace:*",' },
    { filename: 'node_modules/x/package.json', patch: '+    "@groktopus/vendored": "workspace:*",' },
  ]);

  assert.deepEqual([...names], ['@groktopus/added-dep']);
});
