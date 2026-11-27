import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repo = 'groktopus/proprio';
const appLogin = 'proprio-lock-refresh-test[bot]';
const branch = 'chore/refresh-lockfile';
const proof = {
  'tests/runner-e2e/report-lock.json': '{"inputSha256":"base","outputSha256":"output"}\n',
  'tests/runner-e2e/report-lock.patch': 'trusted proof patch\n',
  'tests/runner-e2e/source-sdk-public-inputs.json': '{"lockSha256":"output","inputs":{"pnpm-lock.yaml":"base"}}\n',
};

function fixture({ orphan = false, openPrAuthor = '' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'report-lock-publish-'));
  const bare = path.join(root, 'remote.git'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
  const statePath = path.join(root, 'github-state.json');
  const state = { prs: [], commits: {}, commitCalls: 0, createdPrs: 0 };
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['init', '-q', work]);
  git('-C', work, 'config', 'user.name', 'Fixture');
  git('-C', work, 'config', 'user.email', 'fixture@example.invalid');
  mkdirSync(path.join(work, 'tests/runner-e2e'), { recursive: true });
  writeFileSync(path.join(work, 'pnpm-lock.yaml'), 'lock: base\n');
  writeFileSync(path.join(work, 'tests/runner-e2e/report-lock.json'), '{"base":true}\n');
  writeFileSync(path.join(work, 'tests/runner-e2e/report-lock.patch'), '');
  writeFileSync(path.join(work, 'tests/runner-e2e/source-sdk-public-inputs.json'), '{"lockSha256":"old","inputs":{"pnpm-lock.yaml":"base"}}\n');
  git('-C', work, 'add', '.'); git('-C', work, 'commit', '-qm', 'base');
  const baseSha = git('-C', work, 'rev-parse', 'HEAD');
  git('-C', work, 'branch', '-M', 'main');
  git('-C', work, 'remote', 'add', 'origin', bare); git('-C', work, 'push', '-q', '-u', 'origin', 'main');
  git('--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  if (orphan) {
    git('-C', work, 'checkout', '-qb', branch);
    for (const [file, content] of Object.entries(proof)) writeFileSync(path.join(work, file), content);
    git('-C', work, 'add', '.'); git('-C', work, 'commit', '-qm', 'verified fixture commit');
    const sha = git('-C', work, 'rev-parse', 'HEAD');
    git('-C', work, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    state.commits[sha] = { author: appLogin, verified: true, parent: baseSha };
    git('-C', work, 'checkout', '-q', 'main');
  }

  for (const [file, content] of Object.entries(proof)) writeFileSync(path.join(work, file), content);
  if (openPrAuthor) {
    const sha = git('-C', bare, 'rev-parse', `refs/heads/${branch}`);
    state.prs.push({ number: 7, user: { login: openPrAuthor }, head: { ref: branch, sha, repo: { full_name: repo } }, base: { ref: 'main' } });
  }
  writeFileSync(statePath, JSON.stringify(state));
  mkdirSync(bin);
  const fakeGh = path.join(bin, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs'); const cp = require('node:child_process');
const a=process.argv.slice(2), stateFile=process.env.GH_STATE, bare=process.env.GH_BARE, state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state));
const git=(...x)=>cp.execFileSync('git',x,{encoding:'utf8'}).trim();
if(a[0]==='api' && a[1].startsWith('repos/groktopus/proprio/pulls?')) { process.stdout.write(JSON.stringify(state.prs)); }
else if(a[0]==='api' && a.includes('--method') && a.includes('POST')) { const ref=a.find(x=>x.startsWith('ref='))?.slice(4), sha=a.find(x=>x.startsWith('sha='))?.slice(4); git('--git-dir',bare,'update-ref',ref,sha); process.stdout.write('{}'); }
else if(a[0]==='api' && a.includes('graphql')) {
  const inputFile=a[a.indexOf('--input')+1], body=JSON.parse(fs.readFileSync(inputFile,'utf8')), input=body.variables.input; state.commitCalls++;
  if(!input.branch || input.branch.repositoryNameWithOwner !== '${repo}' || !input.branch.branchName || 'branchName' in input || 'repositoryNameWithOwner' in input) { process.stderr.write('invalid nested branch schema'); process.exit(3); }
  const decoded=Object.fromEntries(input.fileChanges.additions.map(f=>{const bytes=Buffer.from(f.contents,'base64');if(bytes.toString('base64')!==f.contents){process.stderr.write('contents must be Base64String');process.exit(4);}return [f.path,bytes.toString('utf8')];}));
  state.additionPaths=Object.keys(decoded).sort(); state.decodedContents=decoded; state.graphqlBranch=input.branch; state.graphqlMessage=input.message.body; save();
  const clone=process.env.GH_CLONE; cp.execFileSync('git',['clone','-q',bare,clone]); cp.execFileSync('git',['-C',clone,'checkout','-q','--detach',input.expectedHeadOid]); cp.execFileSync('git',['-C',clone,'checkout','-qb',input.branch.branchName]);
  cp.execFileSync('git',['-C',clone,'config','user.name','Fixture App']); cp.execFileSync('git',['-C',clone,'config','user.email','fixture-app@example.invalid']);
  for(const [file,contents] of Object.entries(decoded)){const p=require('node:path').join(clone,file);fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,contents);}
  cp.execFileSync('git',['-C',clone,'add','tests/runner-e2e/report-lock.json','tests/runner-e2e/report-lock.patch','tests/runner-e2e/source-sdk-public-inputs.json']); cp.execFileSync('git',['-C',clone,'commit','-qm',input.message.headline]);
  const sha=git('-C',clone,'rev-parse','HEAD'), parent=git('-C',clone,'rev-parse','HEAD^'); cp.execFileSync('git',['-C',clone,'push','-q','origin','HEAD:refs/heads/'+input.branch.branchName]);
  state.commits[sha]={author:process.env.APP_LOGIN,verified:true,parent}; save();
  process.stdout.write(JSON.stringify({data:{createCommitOnBranch:{commit:{oid:sha,signature:{isValid:true,wasSignedByGitHub:true}}}}}));
}
else if(a[0]==='api' && a[1].includes('/commits/')) { const sha=a[1].split('/').pop(), c=state.commits[sha]; if(!c){process.stderr.write('missing commit');process.exit(1);} if(a.includes('--jq')) process.stdout.write([c.author,c.verified,1,c.parent].join('\\t')); else process.stdout.write(JSON.stringify({author:{login:c.author},commit:{verification:{verified:c.verified}},parents:[{sha:c.parent}]})); }
else if(a[0]==='pr' && a[1]==='create') {const sha=git('--git-dir',bare,'rev-parse','refs/heads/${branch}');state.prs=[{number:7,user:{login:process.env.APP_LOGIN},head:{ref:'${branch}',sha,repo:{full_name:'${repo}'}},base:{ref:'main'}}];state.prBody=a[a.indexOf('--body')+1];state.createdPrs++;save();process.stdout.write('https://github.com/${repo}/pull/7');}
else {process.stderr.write('unexpected gh invocation: '+JSON.stringify(a));process.exit(2);}
`);
  chmodSync(fakeGh, 0o755);
  return { root, bare, work, statePath, state, baseSha, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(f) {
  const result = spawnSync('bash', [path.resolve('.github/scripts/publish-runner-report-lock-pr.sh')], {
    cwd: f.work, encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, GH_STATE: f.statePath,
      GH_BARE: f.bare, GH_CLONE: path.join(f.root, 'mutation-clone'), APP_LOGIN: appLogin, BASE_SHA: f.baseSha,
      REPOSITORY: repo, RUNNER_TEMP: f.root, GH_TOKEN: 'fixture-only' },
  });
  f.state = JSON.parse(readFileSync(f.statePath, 'utf8'));
  return result;
}

test('creates a GitHub-signed App commit and fixed PR, then repeats idempotently', () => {
  const f = fixture();
  try {
    const first = run(f);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(f.state.commitCalls, 1);
    assert.equal(f.state.createdPrs, 1);
    assert.deepEqual(f.state.additionPaths, Object.keys(proof).sort());
    assert.deepEqual(f.state.graphqlBranch, { repositoryNameWithOwner: repo, branchName: branch });
    assert.deepEqual(f.state.decodedContents, proof, 'GraphQL Base64String payloads must decode to the exact three desired file bytes');
    assert.match(f.state.graphqlMessage, /trusted main lock/);
    assert.match(f.state.prBody, /trusted main lock/);
    const second = run(f);
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.equal(f.state.commitCalls, 1);
    assert.equal(f.state.createdPrs, 1);
  } finally { f.cleanup(); }
});

test('recovers an orphan only when its verified single commit has exact base and proof bytes', () => {
  const f = fixture({ orphan: true });
  try {
    const result = run(f);
    assert.ok(result.status === 0, `status=${result.status} stderr=${result.stderr} stdout=${result.stdout}`);
    assert.equal(f.state.commitCalls, 0);
    assert.equal(f.state.createdPrs, 1);
  } finally { f.cleanup(); }
});

test('rejects an orphan owned by another author without changing its branch', () => {
  const f = fixture({ orphan: true });
  try {
    const sha = execFileSync('git', ['--git-dir', f.bare, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
    f.state.commits[sha].author = 'other-app[bot]'; writeFileSync(f.statePath, JSON.stringify(f.state));
    const before = sha, result = run(f);
    const after = execFileSync('git', ['--git-dir', f.bare, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
    assert.notEqual(result.status, 0);
    assert.equal(after, before);
    assert.equal(f.state.createdPrs, 0);
  } finally { f.cleanup(); }
});

test('rejects a stale-base orphan and a same-App orphan with different proof bytes', () => {
  for (const kind of ['stale-parent', 'different-proof']) {
    const f = fixture({ orphan: true });
    try {
      const sha = execFileSync('git', ['--git-dir', f.bare, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
      if (kind === 'stale-parent') f.state.commits[sha].parent = '1'.repeat(40);
      else writeFileSync(path.join(f.work, 'tests/runner-e2e/report-lock.json'), '{"other":"bytes"}\n');
      writeFileSync(f.statePath, JSON.stringify(f.state));
      const result = run(f);
      const after = execFileSync('git', ['--git-dir', f.bare, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
      assert.notEqual(result.status, 0, kind);
      assert.equal(after, sha, kind);
      assert.equal(f.state.createdPrs, 0, kind);
      assert.equal(f.state.commitCalls, 0, kind);
    } finally { f.cleanup(); }
  }
});
