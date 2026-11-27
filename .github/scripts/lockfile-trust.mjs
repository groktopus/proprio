#!/usr/bin/env node
/**
 * lockfile-trust.mjs
 *
 * Decides who may change the dependency locks (LOCKFILES). Only trusted environments write them:
 * - the lockfile refresh workflow (`chore/refresh-lockfile`, opened by the configured dedicated App),
 * - Dependabot, when the exact bytes of each lockfile it changes come from a verified Dependabot commit.
 *
 * The reporting-lock proof (`tests/runner-e2e/report-lock.json` and `.patch`) can rewrite the
 * lock that paid evaluation jobs install, so it counts as lock content too. Only the refresh
 * workflow writes it. The refresh workflow renews the proof only when the current main lock has
 * recognized provenance: a verified Dependabot merge, or the exact reviewed one-time #125 bridge.
 *
 * Keep this file free of imports outside node:*. The PR policy job runs the copy from the current
 * base-branch tip, so a pull request cannot rewrite the check that judges it.
 *
 * Usage:
 *   node .github/scripts/lockfile-trust.mjs pr      # PR policy job
 *   node .github/scripts/lockfile-trust.mjs merged  # refresh workflow on master
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The root lockfile. The reporting-lock proof and the `merged` command follow this one only.
export const LOCKFILE = 'pnpm-lock.yaml';
// Sandbox providers stay out of the root workspace (see doc/test-infrastructure.md), so they have their own
// pnpm lockfiles. The refresh workflow regenerates these too, and its LOCKFILES env lists the same
// paths. Hand-managed pins, such as the Pi and Kimi distributions, are not listed.
export const PROVIDER_LOCKFILES = [
  'scripts/typecheck-sandbox-providers/pnpm-lock.yaml',
  'packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml',
];
export const LOCKFILES = [LOCKFILE, ...PROVIDER_LOCKFILES];
export const REPORT_LOCK_FILES = ['tests/runner-e2e/report-lock.json', 'tests/runner-e2e/report-lock.patch'];
export const SDK_PUBLIC_INPUTS_FILE = 'tests/runner-e2e/source-sdk-public-inputs.json';
export const REFRESH_APP_FILES = [...REPORT_LOCK_FILES, SDK_PUBLIC_INPUTS_FILE];
export const DEPENDABOT_LOGIN = 'dependabot[bot]';
export const REFRESH_BRANCH = 'chore/refresh-lockfile';
export const REVIEWED_MAIN_BOOTSTRAP = Object.freeze({
  repository: 'groktopus/proprio', branch: 'main',
  lockCommit: '7d7c362107390b8f9778ba061c867d5401ede31e', pullRequest: 125,
  lockSha256: '535010469947806e6b8f0edff97bd211ca96b573dccd81dd08556e3f7b43b337',
});
// No built-in writer identity: without the configured App login, no refresh PR author is trusted.
export function configuredRefreshAppLogin(value = process.env.LOCKFILE_REFRESH_APP_LOGIN ?? '') {
  return /^[a-z0-9][a-z0-9-]*\[bot\]$/.test(value) && !['github-actions[bot]', 'dependabot[bot]'].includes(value)
    ? value
    : '';
}
export const REFRESH_PR_AUTHOR = configuredRefreshAppLogin();
// GitHub commits and signs Dependabot commits as web-flow. A verified signature proves only who
// committed, and anyone can set the author field, so require GitHub as the committer as well.
export const GITHUB_COMMITTER_LOGIN = 'web-flow';

const RECREATE_HINT = 'Comment `@dependabot recreate` so Dependabot rebuilds the lockfile, instead of merging or editing it by hand.';

/**
 * True for a commit that Dependabot authored and GitHub committed and signed.
 * @param {{ login: string | null, committer: string | null, verified: boolean }} commit
 */
export function isDependabotCommit(commit) {
  return commit.login === DEPENDABOT_LOGIN && commit.committer === GITHUB_COMMITTER_LOGIN && commit.verified === true;
}

export function hasVerifiedRefreshAppCommits(commits, appLogin, baseSha, headSha) {
  if (!appLogin || commits.length === 0) return false;
  let parentSha = baseSha;
  for (const commit of commits) {
    if (commit.login !== appLogin || commit.verified !== true || commit.parents?.[0] !== parentSha ||
        commit.parents.length !== 1) return false;
    parentSha = commit.sha;
  }
  return parentSha === headSha;
}

/**
 * Find a Dependabot commit (see isDependabotCommit) in the pull request that holds exactly the
 * lockfile under review.
 * @param {{ lockBlob: string | null,
 *   commits: Array<{ sha: string, login: string | null, committer: string | null, verified: boolean }>,
 *   lockBlobAt: (sha: string) => string | null }} input
 */
export function findDependabotLockCommit({ lockBlob, commits, lockBlobAt }) {
  if (!lockBlob) return null;
  for (const commit of [...commits].reverse()) {
    if (!isDependabotCommit(commit)) continue;
    if (lockBlobAt(commit.sha) === lockBlob) return commit.sha;
  }
  return null;
}

/**
 * Classify the lock-content change in a pull request.
 * `dependabotLockCommits` maps each changed lockfile to the verified Dependabot commit that holds
 * its exact bytes, or to null.
 * @returns {{ allowed: boolean, writer: 'none' | 'dependabot' | 'refresh-bot', reason: string }}
 */
export function classifyPullRequest({ changedPaths, author, headRepo, baseRepo, headRef, dependabotLockCommits = {},
  refreshPrAuthor = REFRESH_PR_AUTHOR, refreshAppCommitsVerified = false }) {
  const changedLockfiles = LOCKFILES.filter((file) => changedPaths.includes(file));
  const proofChanged = changedPaths.some((file) => REPORT_LOCK_FILES.includes(file));
  if (changedLockfiles.length === 0 && !proofChanged) {
    return { allowed: true, writer: 'none', reason: 'The pull request does not change lock content.' };
  }

  const sameRepo = Boolean(headRepo) && headRepo === baseRepo;
  const onlyProofFiles = proofChanged && changedPaths.every((file) => REFRESH_APP_FILES.includes(file));
  if (sameRepo && onlyProofFiles && refreshPrAuthor && author === refreshPrAuthor && headRef === REFRESH_BRANCH && refreshAppCommitsVerified) {
    return { allowed: true, writer: 'refresh-bot', reason: 'The lockfile refresh workflow opened this pull request.' };
  }

  if (sameRepo && author === DEPENDABOT_LOGIN) {
    if (proofChanged) {
      return { allowed: false, writer: 'dependabot',
        reason: `Dependabot pull requests must not change ${REPORT_LOCK_FILES.join(' or ')}. The lockfile refresh renews the reporting-lock proof after merge.` };
    }
    const unverified = changedLockfiles.filter((file) => !dependabotLockCommits[file]);
    if (unverified.length > 0) {
      return { allowed: false, writer: 'dependabot',
        reason: `${unverified.join(', ')} does not match any verified Dependabot commit in this pull request. ${RECREATE_HINT}` };
    }
    return { allowed: true, writer: 'dependabot',
      reason: changedLockfiles.map((file) => `${file} matches verified Dependabot commit ${dependabotLockCommits[file]}.`).join(' ') };
  }

  const files = [...changedLockfiles, ...REPORT_LOCK_FILES.filter((file) => changedPaths.includes(file))];
  return { allowed: false, writer: 'none',
    reason: `Do not commit ${files.join(', ')} in pull requests. CI owns lockfile updates.` };
}

/**
 * True when GitHub created and signed the commit, as it does when it merges a pull request.
 * @param {any} commit Response of GET /repos/{repo}/commits/{sha}.
 */
export function isGitHubSignedCommit(commit) {
  return commit?.committer?.login === GITHUB_COMMITTER_LOGIN && commit?.commit?.verification?.verified === true;
}

/**
 * Pick the merged Dependabot pull request whose squash or merge commit is `commitSha`.
 * @param {Array<any>} pulls Response of GET /repos/{repo}/commits/{sha}/pulls.
 */
export function findMergedDependabotPull(pulls, commitSha, defaultBranch) {
  return pulls.find((pull) => pull?.user?.login === DEPENDABOT_LOGIN && Boolean(pull.merged_at) &&
    pull.merge_commit_sha === commitSha && pull?.base?.ref === defaultBranch) ?? null;
}

export function isReviewedMainBootstrap({ repository, defaultBranch, lockCommit, pull, githubSigned, lockSha256 }) {
  return repository === REVIEWED_MAIN_BOOTSTRAP.repository && defaultBranch === REVIEWED_MAIN_BOOTSTRAP.branch &&
    lockCommit === REVIEWED_MAIN_BOOTSTRAP.lockCommit && pull?.number === REVIEWED_MAIN_BOOTSTRAP.pullRequest &&
    Boolean(pull?.merged_at) && pull?.merge_commit_sha === REVIEWED_MAIN_BOOTSTRAP.lockCommit &&
    pull?.base?.ref === REVIEWED_MAIN_BOOTSTRAP.branch && githubSigned === true &&
    lockSha256 === REVIEWED_MAIN_BOOTSTRAP.lockSha256;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function tryRun(command, args) {
  try { return run(command, args); } catch { return null; }
}

function ghJsonLines(endpoint, jq) {
  const output = run('gh', ['api', '--paginate', endpoint, '--jq', jq]);
  return output ? output.split('\n').map((line) => JSON.parse(line)) : [];
}

function pullCommits(repository, number) {
  return ghJsonLines(`repos/${repository}/pulls/${number}/commits?per_page=100`,
    '.[] | {sha, parents: [.parents[].sha], login: .author.login, committer: .committer.login, verified: .commit.verification.verified}');
}

function isGitHubGraphqlSignedCommit(repository, sha) {
  const [owner, name] = repository.split('/');
  const query = 'query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{signature{isValid wasSignedByGitHub}}}}}';
  const result = JSON.parse(run('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`,
    '-F', `name=${name}`, '-F', `oid=${sha}`]));
  const signature = result?.data?.repository?.object?.signature;
  return signature?.isValid === true && signature?.wasSignedByGitHub === true;
}

export function validateRefreshProof(baseSha, headSha, repositoryRoot = process.cwd()) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'proprio-refresh-proof-'));
  const proofDir = path.join(temporary, 'tests/runner-e2e');
  mkdirSync(proofDir, { recursive: true });
  try {
    // Pull only data blobs from the event commits. Execute only preparation code from
    // the trusted base revision; never load code from the pull request head.
    writeFileSync(path.join(temporary, 'pnpm-lock.yaml'), execFileSync('git', ['show', `${baseSha}:pnpm-lock.yaml`], { cwd: repositoryRoot }));
    for (const file of REPORT_LOCK_FILES) {
      writeFileSync(path.join(temporary, file), execFileSync('git', ['show', `${headSha}:${file}`], { cwd: repositoryRoot }));
    }
    const trustedScript = path.join(proofDir, 'prepare-report-lock.mjs');
    writeFileSync(trustedScript, execFileSync('git', ['show', `${baseSha}:tests/runner-e2e/prepare-report-lock.mjs`], { cwd: repositoryRoot }));
    execFileSync(process.execPath, [trustedScript], { cwd: temporary, stdio: 'pipe' });

    const baselineRegistry = JSON.parse(execFileSync('git', ['show', `${baseSha}:${SDK_PUBLIC_INPUTS_FILE}`], { cwd: repositoryRoot, encoding: 'utf8' }));
    const candidateRegistryBytes = execFileSync('git', ['show', `${headSha}:${SDK_PUBLIC_INPUTS_FILE}`], { cwd: repositoryRoot });
    const candidateRegistry = JSON.parse(candidateRegistryBytes.toString('utf8'));
    const candidatePolicy = JSON.parse(execFileSync('git', ['show', `${headSha}:${REPORT_LOCK_FILES[0]}`], { cwd: repositoryRoot, encoding: 'utf8' }));
    const stableFields = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'inputs' && key !== 'lockSha256'));
    if (candidateRegistry.lockSha256 !== candidatePolicy.outputSha256 ||
        JSON.stringify(stableFields(candidateRegistry)) !== JSON.stringify(stableFields(baselineRegistry))) {
      throw new Error('SDK public input registry changed runtime pins or does not pin report-lock outputSha256');
    }

    const baselineRegistryBlob = execFileSync('git', ['rev-parse', `${baseSha}:${SDK_PUBLIC_INPUTS_FILE}`], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    const candidateRegistryBlob = execFileSync('git', ['rev-parse', `${headSha}:${SDK_PUBLIC_INPUTS_FILE}`], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
    if (baselineRegistryBlob !== candidateRegistryBlob) {
      const snapshot = path.join(temporary, 'repository');
      execFileSync('git', ['clone', '--quiet', '--local', '--no-hardlinks', repositoryRoot, snapshot], { stdio: 'pipe' });
      execFileSync('git', ['-C', snapshot, 'checkout', '--quiet', '--detach', baseSha], { stdio: 'pipe' });
      for (const file of [...REPORT_LOCK_FILES, SDK_PUBLIC_INPUTS_FILE]) {
        const bytes = execFileSync('git', ['show', `${headSha}:${file}`], { cwd: repositoryRoot });
        const filename = path.join(snapshot, file);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, bytes);
      }
      execFileSync('git', ['-C', snapshot, 'add', '--', ...REPORT_LOCK_FILES, SDK_PUBLIC_INPUTS_FILE], { stdio: 'pipe' });
      execFileSync('git', ['-C', snapshot, '-c', 'user.name=Trusted policy snapshot', '-c',
        'user.email=trusted-policy-snapshot@users.noreply.github.com', '-c', 'core.hooksPath=/dev/null',
        'commit', '-qm', 'scratch: validate trusted report artifacts'], { stdio: 'pipe' });
      const snapshotSha = execFileSync('git', ['-C', snapshot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const changed = execFileSync('git', ['-C', snapshot, 'diff', '--name-only', `${baseSha}..${snapshotSha}`],
        { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      if (changed.some(file => !REFRESH_APP_FILES.includes(file))) throw new Error('SDK validation snapshot contains an unexpected path');
      execFileSync(process.execPath, [path.join(snapshot, 'tests/runner-e2e/source-sdk-public-inputs.mjs'), snapshotSha, '--check'],
        { cwd: snapshot, stdio: 'pipe' });
    }
    return true;
  } catch (error) {
    console.log(`::error::Reporting-lock proof does not validate against the exact base lock: ${error.message}`);
    return false;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function checkPullRequest() {
  const repository = required('GITHUB_REPOSITORY');
  const baseSha = required('BASE_SHA');
  const headSha = required('HEAD_SHA');
  const author = required('PR_AUTHOR');
  // Diff against the merge base so recent base-branch commits are not counted as PR changes.
  const changedPaths = run('git', ['diff', '--name-only', `${baseSha}...${headSha}`]).split('\n').filter(Boolean);

  const dependabotLockCommits = {};
  const changedLockfiles = LOCKFILES.filter((file) => changedPaths.includes(file));
  const appLogin = configuredRefreshAppLogin();
  const proofChanged = changedPaths.some((file) => REPORT_LOCK_FILES.includes(file));
  const onlyProofFiles = proofChanged && changedPaths.every((file) => REFRESH_APP_FILES.includes(file));
  let verifiedRefreshApp = false;
  if (author === appLogin && onlyProofFiles && process.env.HEAD_REF === REFRESH_BRANCH) {
    const commits = pullCommits(repository, required('PR_NUMBER'));
    const signedCommits = commits.length === 1
      ? commits.map((commit) => ({ ...commit, verified: isGitHubGraphqlSignedCommit(repository, commit.sha) }))
      : [];
    verifiedRefreshApp = hasVerifiedRefreshAppCommits(signedCommits, appLogin, baseSha, headSha) &&
      validateRefreshProof(baseSha, headSha, process.cwd());
  }
  if (author === DEPENDABOT_LOGIN && changedLockfiles.length > 0) {
    const commits = pullCommits(repository, required('PR_NUMBER'));
    for (const file of changedLockfiles) {
      dependabotLockCommits[file] = findDependabotLockCommit({
        lockBlob: tryRun('git', ['rev-parse', `${headSha}:${file}`]),
        commits,
        lockBlobAt: (sha) => tryRun('git', ['rev-parse', `${sha}:${file}`]),
      });
    }
  }

  const result = classifyPullRequest({
    changedPaths, author, headRepo: process.env.HEAD_REPO ?? '', baseRepo: repository,
    headRef: process.env.HEAD_REF ?? '', dependabotLockCommits,
    refreshAppCommitsVerified: verifiedRefreshApp,
  });
  console.log(result.reason);
  writeOutputs({ writer: result.writer });
  if (!result.allowed) {
    console.log(`::error title=Untrusted lockfile change::${result.reason}`);
    process.exitCode = 1;
  }
}

/**
 * On main: report the committed lockfile's SHA-256 only for a verified Dependabot merge whose PR
 * head contains a verified Dependabot lock, or for the exact reviewed #125 bootstrap. Otherwise
 * report nothing. The merge can combine trusted lockfiles, so final bytes may differ from the PR.
 */
function checkMerged() {
  const repository = required('GITHUB_REPOSITORY');
  const head = required('GITHUB_SHA');
  const defaultBranch = process.env.DEFAULT_BRANCH || 'master';
  const lockCommit = run('gh', ['api', `repos/${repository}/commits?sha=${head}&path=${LOCKFILE}&per_page=1`, '--jq', '.[0].sha // empty']);
  const pulls = lockCommit
    ? JSON.parse(run('gh', ['api', `repos/${repository}/commits/${lockCommit}/pulls`]))
    : [];
  const pull = lockCommit
    ? findMergedDependabotPull(pulls, lockCommit, defaultBranch)
    : null;
  if (!pull && repository === REVIEWED_MAIN_BOOTSTRAP.repository && defaultBranch === REVIEWED_MAIN_BOOTSTRAP.branch &&
      lockCommit === REVIEWED_MAIN_BOOTSTRAP.lockCommit) {
    const bootstrapPull = pulls.find((candidate) => candidate?.number === REVIEWED_MAIN_BOOTSTRAP.pullRequest) ?? null;
    const commit = JSON.parse(run('gh', ['api', `repos/${repository}/commits/${lockCommit}`]));
    const lockSha256 = createHash('sha256').update(execFileSync('git', ['show', `HEAD:${LOCKFILE}`])).digest('hex');
    if (isReviewedMainBootstrap({ repository, defaultBranch, lockCommit, pull: bootstrapPull,
      githubSigned: isGitHubSignedCommit(commit), lockSha256 })) {
      console.log(`${LOCKFILE} on ${defaultBranch} matches the exact reviewed main bootstrap from #125.`);
      writeOutputs({ trusted_lock_sha256: lockSha256, dependabot_pr: '', lock_trust_basis: 'reviewed-main-bootstrap', bootstrap_pr: '125' });
      return;
    }
    writeOutputs({ trusted_lock_sha256: '', dependabot_pr: '', lock_trust_basis: 'none', bootstrap_pr: '' });
    return;
  }
  if (pull && !isGitHubSignedCommit(JSON.parse(run('gh', ['api', `repos/${repository}/commits/${lockCommit}`])))) {
    console.log(`::warning title=Unverified Dependabot merge::${lockCommit} is not a GitHub-signed merge of #${pull.number}. The reporting-lock proof is not renewed.`);
    writeOutputs({ trusted_lock_sha256: '', dependabot_pr: String(pull.number), lock_trust_basis: 'none', bootstrap_pr: '' });
    return;
  }
  if (!pull) {
    console.log(`The last ${LOCKFILE} change on ${defaultBranch} is not a merged Dependabot pull request.`);
    writeOutputs({ trusted_lock_sha256: '', dependabot_pr: '', lock_trust_basis: 'none', bootstrap_pr: '' });
    return;
  }

  // The checkout is shallow, so read each candidate's lockfile blob hash from the API.
  const lockBlobAt = (sha) => tryRun('gh', ['api', `repos/${repository}/git/trees/${sha}`,
    '--jq', `.tree[] | select(.path == "${LOCKFILE}") | .sha`]) || null;
  const verified = findDependabotLockCommit({
    lockBlob: lockBlobAt(pull.head.sha),
    commits: pullCommits(repository, pull.number),
    lockBlobAt,
  });
  if (!verified) {
    console.log(`::warning title=Unverified Dependabot lockfile::The ${LOCKFILE} at the head of #${pull.number} matches no verified Dependabot commit. The reporting-lock proof is not renewed.`);
    writeOutputs({ trusted_lock_sha256: '', dependabot_pr: String(pull.number), lock_trust_basis: 'none', bootstrap_pr: '' });
    return;
  }
  const lockSha256 = createHash('sha256').update(execFileSync('git', ['show', `HEAD:${LOCKFILE}`])).digest('hex');
  console.log(`${LOCKFILE} on ${defaultBranch} is GitHub's merge of verified Dependabot commit ${verified} from #${pull.number}.`);
  writeOutputs({ trusted_lock_sha256: lockSha256, dependabot_pr: String(pull.number), lock_trust_basis: 'dependabot', bootstrap_pr: '' });
}

// Compare real paths: the runner's temporary directory can sit behind a symlink.
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2];
  if (mode === 'pr') checkPullRequest();
  else if (mode === 'merged') checkMerged();
  else throw new Error('Usage: lockfile-trust.mjs pr|merged');
}
