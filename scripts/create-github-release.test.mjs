import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

const sourceRoot = new URL("../", import.meta.url);
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const releaseScript = readFileSync(new URL("./create-github-release.sh", import.meta.url), "utf8");
const releaseLib = readFileSync(new URL("./release-lib.sh", import.meta.url), "utf8");
const evidenceVerifier = readFileSync(new URL("./ci/durable-work-release-evidence.mjs", import.meta.url), "utf8");
const pathPolicy = readFileSync(new URL("./ci/durable-work-acceptance.mjs", import.meta.url), "utf8");
const ciDiff = readFileSync(new URL("../.github/scripts/ci-diff.mjs", import.meta.url), "utf8");

const fixtures = [];
after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function createFixture({ changedPath = "packages/db/src/migrations/0502_stormy_sumo.sql", existingRelease = false, missingEvidence = false, remoteTagMismatch = false, wrongReportSha = false, sourcePrerelease = false, interruptedRelease = false, unverifiedAsset = false, skippedPredecessor = false } = {}) {
  const migrationChanged = /^packages\/db\/src\/migrations\/[^/]+\.sql$/.test(changedPath);
  const root = mkdtempSync(join(tmpdir(), "proprio-source-release-gate-"));
  fixtures.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const git = (...args) => execFileSync(realGit, args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Source release gate test");
  git("config", "user.email", "source-release@example.test");

  const write = (path, contents) => {
    const target = join(root, path);
    mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    writeFileSync(target, contents);
  };
  write("scripts/create-github-release.sh", releaseScript);
  write("scripts/release-lib.sh", releaseLib);
  write("scripts/ci/durable-work-release-evidence.mjs", evidenceVerifier);
  write("scripts/ci/durable-work-acceptance.mjs", pathPolicy);
  write(".github/scripts/ci-diff.mjs", ciDiff);
  write("cli/node_modules/tsx/dist/cli.mjs", `import { writeFileSync } from 'node:fs';\nconst out = process.argv[process.argv.indexOf('--out') + 1];\nwriteFileSync(out, '{}');\n`);
  write(".gitignore", "/bin/\n/calls.log\n/report.json\n");
  write("releases/v0.0.1.md", "baseline\n");
  write("README.md", "baseline\n");
  git("add", ".");
  git("commit", "-qm", "baseline source");
  git("tag", "v0.0.1");
  const baseSha = git("rev-parse", "HEAD").trim();

  write(changedPath, "candidate\n");
  const tag = sourcePrerelease ? (skippedPredecessor ? "v0.0.3" : "v0.0.2") : "v0.0.2-rc.1";
  write(`releases/${tag}.md`, "source prerelease notes\n");
  git("add", ".");
  git("commit", "-qm", "source candidate");
  if (!sourcePrerelease) git("tag", tag);
  const sourceSha = git("rev-parse", "HEAD").trim();
  git("remote", "add", "origin", "git@github.com:groktopus/proprio.git");

  const logPath = join(root, "calls.log");
  writeFileSync(logPath, "");
  const remoteTagCommit = remoteTagMismatch ? "c".repeat(40) : sourceSha;
  const pushed = join(bin, "pushed");
  const gitWrapper = `#!/bin/sh
case " $* " in
  *" ls-remote "*" refs/heads/main "*) printf '%s\\trefs/heads/main\\n' "${sourceSha}"; exit 0 ;;
  *" ls-remote "*" refs/tags/v0.0.1 "*) printf '%s\\trefs/tags/v0.0.1\\n' "${baseSha}"; exit 0 ;;
  *" ls-remote "*)
    if [ "${sourcePrerelease}" = true ] && [ "${remoteTagMismatch}" = false ] && [ ! -f "${pushed}" ]; then exit 2; fi
    printf '%s\\trefs/tags/${tag}\\n' "${remoteTagCommit}"; exit 0 ;;
  *" push "*)
    if [ -f "${bin}/notes-to-remove" ]; then rm -- "$(cat "${bin}/notes-to-remove")"; fi
    touch "${pushed}"; printf '%s\\n' "push $*" >> "$GH_LOG"; exit 0 ;;
esac
exec "${realGit}" "$@"
`;
  writeFileSync(join(bin, "git"), gitWrapper, { mode: 0o755 });

  const gh = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const log = process.env.GH_LOG;
appendFileSync(log, args.join(' ') + '\\n');
if (args[0] === 'api') {
  const endpoint = args[1] === '--paginate' ? args[2] : args[1];
  const draftPath = join('${bin}', 'draft');
  if (endpoint.endsWith('/releases?per_page=100')) {
    const releases = [{ tag_name: 'v0.0.1', prerelease: true, draft: false, assets: [] }];
    if (${skippedPredecessor}) releases.push({ tag_name: 'v0.0.2', prerelease: true, draft: false, assets: [] });
    if (existsSync(draftPath)) releases.push({ tag_name: '${tag}', prerelease: true, draft: true, assets: ${unverifiedAsset} ? ['other.tar.gz'] : [] });
    process.stdout.write(releases.map(release => JSON.stringify(release)).join('\\n'));
  }
  else
  if (endpoint.endsWith('/actions/workflows/linux-source-qualification.yml')) process.stdout.write(JSON.stringify({ id: 77, path: '.github/workflows/linux-source-qualification.yml' }));
  else if (endpoint.includes('/runs?')) process.stdout.write(JSON.stringify(process.env.MISSING_EVIDENCE === '1' ? { total_count: 0, workflow_runs: [] } : { total_count: 1, workflow_runs: [{ id: 55, workflow_id: 77, path: '.github/workflows/linux-source-qualification.yml', repository: { full_name: 'groktopus/proprio' }, head_repository: { full_name: 'groktopus/proprio' }, head_sha: '${sourceSha}', head_branch: 'main', event: 'workflow_dispatch', display_title: 'Source qualification ${sourceSha} from ${baseSha}', run_attempt: 1, status: 'completed', conclusion: 'success' }] }));
  else if (endpoint.includes('/jobs?')) process.stdout.write(JSON.stringify({ jobs: [{ id: 88, name: 'source-and-runner', status: 'completed', conclusion: 'success', run_id: 55, run_attempt: 1 }] }));
  else if (endpoint.includes('/artifacts?')) process.stdout.write(JSON.stringify({ total_count: 1, artifacts: [{ id: 99, name: 'durable-work-acceptance', expired: false }] }));
  else if (endpoint.endsWith('/actions/runs/55')) process.stdout.write(JSON.stringify({ id: 55, workflow_id: 77, path: '.github/workflows/linux-source-qualification.yml', repository: { full_name: 'groktopus/proprio' }, head_repository: { full_name: 'groktopus/proprio' }, head_sha: '${sourceSha}', head_branch: 'main', event: 'workflow_dispatch', display_title: 'Source qualification ${sourceSha} from ${baseSha}', run_attempt: 1, status: 'completed', conclusion: 'success' }));
  else process.exit(3);
} else if (args[0] === 'run' && args[1] === 'download') {
  const dir = args[args.indexOf('--dir') + 1]; mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'durable-work-acceptance.json'), process.env.REPORT);
} else if (args[0] === 'release' && args[1] === 'view') {
  if (existsSync(join('${bin}', 'draft'))) process.stdout.write('true');
  else if (process.env.EXISTING_RELEASE === '1') process.exit(0);
  else process.exit(1);
} else if (args[0] === 'release' && ['create', 'edit', 'upload'].includes(args[1])) {
  if (args.includes('--notes-file')) {
    const notes = readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
    writeFileSync(join('${bin}', 'notes-' + args[1]), notes);
  }
  if (args[1] === 'create' && ${interruptedRelease}) {
    writeFileSync(join('${bin}', 'draft'), '');
    process.exit(1);
  }
  process.stdout.write('stubbed release side effect\\n');
} else process.exit(4);
`;
  writeFileSync(join(bin, "gh"), gh, { mode: 0o755 });

  const cases = Object.fromEntries([
    "managed-update-rollback", "backup-restore-fresh-target", "migration-active-run-recovery",
    "interruption-restart-cancel-disk-pressure", "browser-task-readback",
  ].map(id => [id, { outcome: "passed", evidenceUrls: [`https://github.com/groktopus/proprio/actions/runs/55/attempts/1#${id}`] }]));
  cases["migration-active-run-recovery"] = migrationChanged
    ? { ...cases["migration-active-run-recovery"], previousReleaseSha: baseSha,
      schemaCandidateSha: sourceSha, elapsedRecoveryMs: 1000, observedDataLoss: 0 }
    : { ...cases["migration-active-run-recovery"], outcome: "not_applicable" };
  const report = { schema: "proprio.durable-work-qualification/v1", sourceSha: wrongReportSha ? "b".repeat(40) : sourceSha, baseSha, cases };
  const reportPath = join(root, "report.json");
  writeFileSync(reportPath, JSON.stringify(report));

  return {
    root, bin, git, sourceSha, baseSha, logPath, reportPath, existingRelease, missingEvidence,
    run(args = sourcePrerelease ? [tag.slice(1), "--previous-tag", "v0.0.1"] : ["0.0.2-rc.1"]) {
      return spawnSync("bash", [join(root, "scripts/create-github-release.sh"), ...args], {
        cwd: root, encoding: "utf8", env: {
          ...process.env,
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
          GH_LOG: logPath,
          GH_REPORT: reportPath,
          REPORT: JSON.stringify(report),
          EXISTING_RELEASE: existingRelease ? "1" : "0",
          MISSING_EVIDENCE: missingEvidence ? "1" : "0",
          PUBLISH_REMOTE: "origin",
        },
      });
    },
  };
}

test("blocks create and edit before the GitHub release side effect when exact evidence is absent", async t => {
  for (const existingRelease of [false, true]) await t.test(existingRelease ? "edit" : "create", () => {
    const fixture = createFixture({ existingRelease, missingEvidence: true });
    const result = fixture.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /source release is blocked/);
    const calls = readFileSync(fixture.logPath, "utf8");
    assert.match(calls, /release view/);
    assert.doesNotMatch(calls, /release (?:create|edit|upload)/);
  });
});

test("blocks when the remote publication tag differs from the checked out candidate", () => {
  const fixture = createFixture({ remoteTagMismatch: true });
  const result = fixture.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /remote tag .* points to/);
  assert.doesNotMatch(readFileSync(fixture.logPath, "utf8"), /release (?:create|edit|upload)/);
});

test("passes retained exact-source evidence immediately before create or edit", async t => {
  for (const existingRelease of [false, true]) await t.test(existingRelease ? "edit" : "create", () => {
    const fixture = createFixture({ existingRelease });
    const result = fixture.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = readFileSync(fixture.logPath, "utf8").trim().split("\n");
    const publication = calls.findIndex(line => line.startsWith(`release ${existingRelease ? "edit" : "create"} `));
    assert.ok(publication > 0);
    assert.ok(calls.slice(0, publication).some(line => line.includes("/actions/runs/55/artifacts")));
    assert.ok(calls.slice(publication + 1).some(line => line.startsWith("release upload ")));
  });
});

test("requires durable-work cases but migration proof is not applicable without a migration SQL delta", () => {
  const fixture = createFixture({ changedPath: "server/src/services/native-runtime/workspace.ts" });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = readFileSync(fixture.logPath, "utf8").trim().split("\n");
  assert.ok(calls.some(line => line.startsWith("api /repos/groktopus/proprio/actions/runs/55/artifacts")));
  assert.ok(calls.some(line => line.startsWith("release create ")));
});

test("unrelated candidate skips source qualification and 0.0.x prerelease dry-run stays non-publishing", () => {
  const unrelated = createFixture({ changedPath: "doc/GOAL.md", missingEvidence: true });
  const unrelatedResult = unrelated.run();
  assert.equal(unrelatedResult.status, 0, unrelatedResult.stdout + unrelatedResult.stderr);
  assert.doesNotMatch(readFileSync(unrelated.logPath, "utf8"), /api .*actions/);

  const dryRun = createFixture({ missingEvidence: true });
  const dryRunResult = dryRun.run(["0.0.2-rc.1", "--dry-run"]);
  assert.equal(dryRunResult.status, 0, dryRunResult.stdout + dryRunResult.stderr);
  assert.match(dryRunResult.stdout, /\[dry-run\] gh release create v0\.0\.2-rc\.1/);
  assert.doesNotMatch(readFileSync(dryRun.logPath, "utf8"), /release (?:create|edit|upload)/);
});

test("plain source version dry-run verifies exact Linux evidence without tagging", () => {
  const fixture = createFixture({ sourcePrerelease: true, changedPath: "doc/GOAL.md" });
  const result = fixture.run(["0.0.2", "--previous-tag", "v0.0.1", "--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[dry-run\] Verified v0\.0\.2/);
  const calls = readFileSync(fixture.logPath, "utf8");
  assert.match(calls, /actions\/runs\/55\/artifacts/);
  assert.doesNotMatch(calls, /(^push |release (?:create|edit|upload))/m);
});

test("plain source version refuses mismatched evidence before writing a tag", () => {
  const fixture = createFixture({ sourcePrerelease: true, wrongReportSha: true });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the source and previous-release SHAs/);
  assert.doesNotMatch(readFileSync(fixture.logPath, "utf8"), /(^push |release (?:create|edit|upload))/m);
});

test("plain source version refuses absent Linux evidence on an unrelated diff", () => {
  const fixture = createFixture({ sourcePrerelease: true, changedPath: "doc/GOAL.md", missingEvidence: true });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No trusted Linux source qualification run/);
  assert.doesNotMatch(readFileSync(fixture.logPath, "utf8"), /(^push |release (?:create|edit|upload))/m);
});

test("plain source version qualifies and snapshots the notes before publishing", () => {
  const fixture = createFixture({ sourcePrerelease: true });
  const originalNotes = join(fixture.bin, "reviewed-notes.md");
  writeFileSync(originalNotes, "source prerelease notes\n");
  writeFileSync(join(fixture.bin, "notes-to-remove"), originalNotes);
  const result = fixture.run(["0.0.2", "--previous-tag", "v0.0.1", "--notes-file", originalNotes]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = readFileSync(fixture.logPath, "utf8").trim().split("\n");
  const evidence = calls.findIndex(line => line.includes("/actions/runs/55/artifacts"));
  const push = calls.findIndex(line => line.startsWith("push "));
  const publish = calls.findIndex(line => line.startsWith("release create "));
  assert.ok(evidence >= 0 && evidence < push && push < publish, calls.join("\n"));
  assert.match(calls[push], new RegExp(`${fixture.sourceSha}:refs/tags/v0.0.2`));
  assert.match(calls[publish], /feature-catalog\.json .*--verify-tag --prerelease/);
  assert.equal(readFileSync(join(fixture.bin, "notes-create"), "utf8"), "source prerelease notes\n");
});

test("source publication cannot skip a newer published source release", () => {
  const fixture = createFixture({ sourcePrerelease: true, skippedPredecessor: true });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected previous published source tag v0\.0\.2/);
  assert.doesNotMatch(readFileSync(fixture.logPath, "utf8"), /(^push |release (?:create|edit|upload))/m);
});

test("a source publication retry reuses the remote tag and safe draft", () => {
  const fixture = createFixture({ sourcePrerelease: true, interruptedRelease: true });
  assert.notEqual(fixture.run().status, 0);
  const preview = fixture.run(["0.0.2", "--previous-tag", "v0.0.1", "--dry-run"]);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /Would finish draft/);
  const retry = fixture.run();
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  const calls = readFileSync(fixture.logPath, "utf8");
  assert.equal((calls.match(/^push /gm) ?? []).length, 1);
  assert.match(calls, /release edit .*--draft=false --prerelease/);
  const notes = readFileSync(join(fixture.bin, "notes-edit"), "utf8");
  assert.equal(notes, "source prerelease notes\n");
  assert.match(preview.stdout, /actions\/runs\/55\/attempts\/1/);
});

test("an interrupted draft with an unexpected asset fails closed in preview", () => {
  const fixture = createFixture({ sourcePrerelease: true, interruptedRelease: true, unverifiedAsset: true });
  assert.notEqual(fixture.run().status, 0);
  const preview = fixture.run(["0.0.2", "--previous-tag", "v0.0.1", "--dry-run"]);
  assert.notEqual(preview.status, 0);
  assert.match(preview.stderr, /existing release has an unverified asset/);
  assert.doesNotMatch(readFileSync(fixture.logPath, "utf8"), /release (?:edit|upload)/);
});

test("a mismatched Git push destination blocks qualified source publication", () => {
  const fixture = createFixture({ sourcePrerelease: true });
  fixture.git("remote", "set-url", "--push", "origin", "git@github.com:another/proprio.git");
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require canonical groktopus\/proprio fetch and push destinations/);
  assert.equal(readFileSync(fixture.logPath, "utf8"), "");
});
