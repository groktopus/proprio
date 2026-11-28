#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Advisory check that lock content was not edited by hand. `pr-trusted.yml` enforces the
 * same rule with `lockfile-trust.mjs`, which also verifies Dependabot commit signatures.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';
import { DEPENDABOT_LOGIN, hasVerifiedRefreshAppCommits, LOCKFILES, REFRESH_APP_FILES, REFRESH_BRANCH, REFRESH_PR_AUTHOR, REPORT_LOCK_FILES } from './lockfile-trust.mjs';

export function checkLockfile(files, prAuthor, prBranch, { refreshPrAuthor = REFRESH_PR_AUTHOR, headRepo = '', baseRepo = '',
  commits = [], baseSha = '', headSha = '' } = {}) {
  const changed = files.map(f => f.filename);
  const lockfilesChanged = changed.filter(f => LOCKFILES.includes(f));
  const proofChanged = changed.filter(f => REPORT_LOCK_FILES.includes(f));
  if (lockfilesChanged.length === 0 && proofChanged.length === 0) return { passed: true, failures: [] };

  const sameRepo = Boolean(headRepo) && headRepo === baseRepo;
  const onlyProofFiles = proofChanged.length > 0 && changed.every(f => REFRESH_APP_FILES.includes(f));
  const verifiedCommits = commits.map(c => ({ sha: c.sha, parents: (c.parents ?? []).map(p => p.sha),
    login: c.author?.login, verified: c.appSignatureVerified === true }));
  const verifiedRefreshApp = hasVerifiedRefreshAppCommits(verifiedCommits, refreshPrAuthor, baseSha, headSha);
  if (sameRepo && onlyProofFiles && refreshPrAuthor && prAuthor === refreshPrAuthor && prBranch === REFRESH_BRANCH && verifiedRefreshApp) {
    return { passed: true, failures: [] };
  }
  if (prAuthor === DEPENDABOT_LOGIN && proofChanged.length === 0) return { passed: true, failures: [] };

  const edited = [...lockfilesChanged, ...proofChanged].map(f => `\`${f}\``).join(', ');
  return {
    passed: false,
    failures: [
      `You have changes to ${edited} — \`pr.yml\` will hard-fail this PR because only the lockfile refresh workflow and Dependabot may change lock content. ` +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'The refresh bot regenerates every managed lockfile after your PR merges.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '', {
    refreshPrAuthor: REFRESH_PR_AUTHOR,
    headRepo: process.env.PR_HEAD_REPO ?? '',
    baseRepo: process.env.PR_BASE_REPO ?? '',
    commits: JSON.parse(process.env.PR_COMMITS ?? '[]'),
    baseSha: process.env.PR_BASE_SHA ?? '',
    headSha: process.env.PR_HEAD_SHA ?? '',
  });
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
