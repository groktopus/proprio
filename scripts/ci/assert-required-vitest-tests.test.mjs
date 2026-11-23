import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRequiredVitestTests } from './assert-required-vitest-tests.mjs';
const required = { 'server/fixture.test.ts': ['database round trip'] };
const report = (assertionResults) => ({ testResults: [{ name: '/checkout/server/fixture.test.ts', assertionResults }] });
test('accepts the required file and passing case', () => {
  assert.doesNotThrow(() => assertRequiredVitestTests(report([{ title: 'database round trip', status: 'passed' }]), required));
});
test('rejects skipped, failed, absent, and duplicate required cases', () => {
  for (const cases of [[], [{ title: 'database round trip', status: 'pending' }], [{ title: 'database round trip', status: 'failed' }],
    Array(2).fill({ title: 'database round trip', status: 'passed' })]) {
    assert.throws(() => assertRequiredVitestTests(report(cases), required));
  }
});
test('rejects missing or ambiguous files', () => {
  assert.throws(() => assertRequiredVitestTests({ testResults: [] }, required));
  const file = report([{ title: 'database round trip', status: 'passed' }]).testResults[0];
  assert.throws(() => assertRequiredVitestTests({ testResults: [file, file] }, required));
});

test('distinguishes equal titles in parameterized suites by full name', () => {
  const report = {
    testResults: [{
      name: '/repo/server/security.test.ts',
      assertionResults: [
        { title: 'denies access', fullName: 'v1 denies access', status: 'passed' },
        { title: 'denies access', fullName: 'v2 denies access', status: 'skipped' },
      ],
    }],
  };
  assert.doesNotThrow(() => assertRequiredVitestTests(report, {
    'server/security.test.ts': ['v1 denies access'],
  }));
  assert.throws(() => assertRequiredVitestTests(report, {
    'server/security.test.ts': ['v1 denies access', 'v2 denies access'],
  }), /v2 denies access/);
});
