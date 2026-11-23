import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertRequiredVitestTests } from './assert-required-vitest-tests.mjs';

const serverTests = {
  'server/src/__tests__/agent-cross-tenant-authz-routes.test.ts': [
    'enforces company boundaries before mutating or reading agent keys',
    'does not disclose a cross-company resume target',
  ],
  'server/src/__tests__/agent-action-audit-routes.test.ts': [
    'denies agents and board users without the audit permission',
    'exports the audit feed as CSV and logs the export action',
  ],
  'server/src/services/board-auth.test.ts': [
    'authenticates the real pending, approved and revoked HTTP handshake without synthesizing an anonymous actor',
  ],
  'server/src/__tests__/plugin-install-route-security.test.ts': [
    'rejects npm installs outright',
  ],
  'server/src/__tests__/email-channels.integration.test.ts': [
    'isolates companies and inboxes, and revoked board membership fails queued sends without calling the provider',
  ],
  'server/src/__tests__/secrets-service.test.ts': [
    'denies runtime secret resolution outside the low-trust binding allowlist',
  ],
};

const runnerTests = {
  'packages/proprio-runner/src/protocol/auth-credentials.test.ts': [1, 2, 3].map(
    (version) => `PRP v${version} credential updates rejects secret material, missing fields, invalid revisions, and downgraded priority`,
  ),
  'packages/proprio-runner/src/semantic-tools/proprio-semantic-tools.test.ts': [
    'denies cross-company contexts and malformed protocol identities',
  ],
};

const reportDir = mkdtempSync(join(tmpdir(), 'proprio-security-tests-'));
try {
  const suites = [
    { name: 'server', pnpmArgs: [], required: serverTests },
    { name: 'runner', pnpmArgs: ['--filter', '@groktopus/proprio-runner'], required: runnerTests },
  ];
  for (const { name, pnpmArgs, required } of suites) {
    const reportPath = join(reportDir, `${name}.json`);
    const pattern = Object.values(required).flat().map((title) => RegExp.escape(title)).join('|');
    const result = spawnSync('pnpm', [
      ...pnpmArgs, 'exec', 'vitest', 'run', '--maxWorkers', '1',
      '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`,
      ...Object.keys(required).map((file) => resolve(file)), '-t', pattern,
    ], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Security regression run failed: ${name}`);
    assertRequiredVitestTests(JSON.parse(readFileSync(reportPath, 'utf8')), required);
  }
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
