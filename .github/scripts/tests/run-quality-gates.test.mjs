import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingComment, verifyRefreshAppCommitSignatures } from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'groktopus/proprio', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/groktopus/proprio/issues/6469/comments?per_page=100&page=1',
    '/repos/groktopus/proprio/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'groktopus/proprio', 6469);

  assert.equal(comment, null);
});

test('refresh App signature lookup binds GraphQL signature fields to the exact commit SHA', async () => {
  const sha = 'a'.repeat(40);
  let call;
  const commits = [{ sha, author: { login: 'proprio-lock-refresh[bot]' } }];
  const result = await verifyRefreshAppCommitSignatures('groktopus/proprio', commits, 'token', async (...args) => {
    call = args;
    return { data: { repository: { object: { signature: { isValid: true, wasSignedByGitHub: true } } } } };
  });
  assert.equal(call[0], '/graphql');
  assert.equal(call[1], 'token');
  const request = JSON.parse(call[2].body);
  assert.equal(request.variables.oid, sha);
  assert.match(request.query, /signature\{isValid wasSignedByGitHub\}/);
  assert.equal(result[0].appSignatureVerified, true);

  const unsigned = await verifyRefreshAppCommitSignatures('groktopus/proprio', commits, 'token', async () => ({
    data: { repository: { object: { signature: { isValid: true, wasSignedByGitHub: false } } } },
  }));
  assert.equal(unsigned[0].appSignatureVerified, false);
  const multiple = await verifyRefreshAppCommitSignatures('groktopus/proprio', [commits[0], commits[0]], 'token', async () => {
    assert.fail('signature lookup must reject multi-commit refresh chains without a query');
  });
  assert.deepEqual(multiple.map(c => c.appSignatureVerified), [false, false]);
});
