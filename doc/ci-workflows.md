# CI workflows

This page describes workflows tracked in `.github/workflows/` at this revision.
It is not a specification for centrally managed workflows or past CI setups.

## Pull request workflows

### Stability smoke

`.github/workflows/stability-smoke.yml` runs for pull requests targeting `main`
from forks and branches in this repository, including PRs retargeted to
`main`. It checks out the exact PR head, verifies the event SHA without
persisting checkout credentials, and installs the workspace from the frozen
pnpm lockfile. Its checks include:

- `pnpm lint` for server, UI, and CLI source using the locked workspace version of Oxlint;
- the named authorization, credential lifecycle, and audit cases described in
  [Secure engineering](SECURE-ENGINEERING.md);
- the `AGENTS.md` local-link check and its Node test suite;
- the CLI service-onboarding test;
- managed service restart and same-version Git update validation;
- server cost-summary and database-backup tests, with named PostgreSQL assertions;
- Agent Chat supersession and Stop regressions across server and UI;
- company import rollback and retry after a late document write fails;
- the standalone release-registry test suite;
- native heartbeat replay cadence and settlement callback consumers;
- strict cron parsing and routine and plugin schedule recovery;
- late live-settlement metadata regressions;
- Team Catalog runtime preview parity and the install wizard tests;
- the server typecheck, Hermes adapter build, and server TypeScript build compilation.
- recovery of interrupted plugin jobs and preservation of active owners.

Named PostgreSQL and selected regression cases must report a passing result.
A platform skip does not satisfy those assertions.

The workflow has read-only repository permissions and a 25-minute timeout. It
is a focused smoke lane. The server typecheck and selected builds do not replace
repo-wide typecheck, release packaging, the full test suite, or E2E acceptance.
Fork runs use no secrets, a read-only token, and checkout without credential
persistence. GitHub can require a maintainer to approve a fork workflow run.

### Durable-work acceptance

The required `smoke` job combines Stability smoke with [Linux source
qualification](../.github/workflows/linux-source-qualification.yml) when
[the target branch's routing rules](../scripts/ci/durable-work-acceptance.mjs)
match the PR diff. The router compares GitHub's comparison commit with its
target-branch parent and verifies the PR head. During bootstrap it requires
Linux qualification for every PR whose base predates the policy. Both
execution jobs use read-only permissions and check out the exact PR head.

The separate [trusted policy workflow](../.github/workflows/durable-work-policy.yml)
uses the default branch and the GitHub API to classify all changed paths. It
checks the qualification job for the open PR's current head and publishes
`trusted durable-work acceptance`. The workflow reads run metadata only. It
does not check out PR code or use PR artifacts. Add that status to the main
ruleset after validating both an applicable run and an unrelated PR.

If the PR changes the workflow or its routing and report checks, run the
Linux workflow on `main` with its PR number and exact head SHA. The trusted
policy uses that default-branch run as evidence. To qualify a source candidate
outside a PR, leave both inputs empty and select the candidate ref.

The Linux lane requires a source build, a fresh disposable agent run, native
PostgreSQL 18 backup and restore into a fresh target, and named runner recovery
cases. A managed update builds a Git payload and restarts a real systemd user
service. The check verifies the running commit and a saved database record
after the update and after rollback to the original commit. The existing
simulated backup and restart cases also run in Stability smoke. The Linux job
summary retains both revisions and the executed case outcomes. The active-work
schema migration and browser acceptance remain tracked in
[#127](https://github.com/groktopus/proprio/issues/127).

### Standalone sandbox-provider dependencies

`.github/workflows/sandbox-providers.yml` checks same-repository PRs that touch
sandbox providers, the plugin SDK/shared inputs, or the qualification tools. Its
Linux `provider-dependencies (locked)` job installs the root workspace and Daytona's
standalone lockfile frozen, builds the plugin SDK, and typechecks, builds, and
tests Daytona. The `provider-dependencies (shared)` job installs the separate
shared-provider lockfile frozen and checks every provider that workspace owns,
including the Cloudflare bridge template. Individual check failures are retained
while the other providers run; any failure makes the job fail.

JSON reports must include an executed passing test; all-skipped
suites do not qualify. Cloud credential-dependent live tests remain opt-in.

The runner derives lockfile ownership from `scripts/typecheck-test-programs.mjs`.
It does not resolve or rewrite stale locks during verification. These checks
prove package compatibility and the executed tests, not live cloud acceptance.

### Droid Auto Review

`.github/workflows/droid-review.yml` invokes Factory Droid's automatic review
and security review for non-draft, same-repository pull requests when they are
opened, reopened, or marked ready for review. The job gives its GitHub token
read access to contents and write access to pull requests for review comments.

### Droid Tag

`.github/workflows/droid.yml` invokes Factory Droid when a pull request, issue,
review, or comment contains `@droid`. The job checks that both the original actor
and rerun actor are the maintainer before checkout or credential setup. Update
this check when repository ownership changes. Its token has contents read and
write permissions for issues and pull requests. Both workflows pin the Factory
action and checkout to commit SHAs and use the workflow token with OIDC disabled.

Both workflows use `openai/gpt-6.2-sol` through Nous Portal for code and security
reviews. The runner registers the model in Droid's user settings and reads
`NOUS_API_KEY` from GitHub Actions secrets. Review runs also require
`FACTORY_API_KEY` for the Factory action.

## Local verification

Install the pinned package manager and workspace dependencies using the setup
instructions in [DEVELOPING.md](DEVELOPING.md). The ordinary local verification
entry point is `pnpm verify`. It selects affected Vitest files conservatively
and may report that broader verification is needed. Follow the verification
instructions in `AGENTS.md` and `doc/DEVELOPING.md` for the relevant change.
Use `--base <ref>` to override the locally recorded default branch.

The repository contains test-selection, test-duration, CI profiling, sharding,
and incremental verification utilities. Their presence does not mean the
tracked workflows currently run a full source/test matrix. Changes that add
or restore broader CI must update this page from the workflow definitions and
identify the checks actually required on `main`.

## Release registry tests

Run `pnpm test:release-registry` for the package, registry, and release tooling
owned by this checkout. The suite uses test archives and does not require an
external workflow checkout. Proprio's source distribution has no configured
preview or cloud-migrator publisher. The standalone tests cover local packaging
and validation, plus the error returned by unconfigured distribution commands.

The suite also retains wiring assertions for workflows and deployment policy
stored outside this repository. To check them, set `PROPRIO_RELEASE_WORKFLOW_ROOT`
to the root of the owning checkout before running the same command. Without that
path, the test output lists those assertions as skipped. With a path, missing
workflow or policy inputs fail the relevant assertion.

Run `pnpm test:scale-ramp` for the separate capacity-test harness. Its hosted
target fixtures require the deployment's test-host policy.

## Security configuration status

Workflow YAML and repository security settings are separate controls.
Dependabot configuration is tracked in `.github/dependabot.yml`.

At the 2026-11-22 settings check, secret scanning, push protection, and
Dependabot security updates were enabled. CodeQL default setup was configured
for weekly remote analysis, with Actions, C/C++, Go, JavaScript/TypeScript,
Python, and Rust selected. Completed PR analyses confirmed that scanning ran.

The `main` ruleset required the `smoke` check and zero approvals. It did not
require Code Owner approval. `.github/CODEOWNERS` names `@magnus919` as the sole
repository-wide owner. Ownership does not add an approval requirement by itself.

Repository settings can change independently of this checkout. Verify them
before relying on this dated snapshot. Optional automated review follows
[CONTRIBUTING.md](../CONTRIBUTING.md); a service outage is not a passing review.
