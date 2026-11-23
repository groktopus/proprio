# CI workflows

This page describes workflows tracked in `.github/workflows/` at this revision.
It is not a specification for centrally managed workflows or past CI setups.

## Pull request workflows

### Stability smoke

`.github/workflows/stability-smoke.yml` runs for pull requests targeting `main`
when the pull request comes from a branch in this repository. It checks out the
exact pull-request head without persisting checkout credentials, installs the
workspace from the frozen pnpm lockfile, and runs:

- the `AGENTS.md` local-link check and its Node test suite;
- the CLI service-onboarding test;
- server cost-summary and database-backup tests, with named PostgreSQL assertions;
- Agent Chat supersession and Stop regressions across server and UI;
- the standalone release-registry test suite;
- native heartbeat replay cadence and settlement callback consumers;
- late live-settlement metadata regressions;
- strict cron parsing and routine and plugin schedule recovery;
- the server typecheck, Hermes adapter build, and server TypeScript build compilation.

Named PostgreSQL and selected regression cases must report a passing result.
A platform skip does not satisfy those assertions.

The workflow has read-only repository permissions and a 15-minute timeout. It
is a focused smoke lane. The server typecheck and selected builds do not replace
repo-wide typecheck, release packaging, the full test suite, or E2E acceptance.
Fork pull requests do not run the smoke job.

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
and security review for non-draft pull requests when they are opened, reopened,
or marked ready for review. Its external action needs write permissions to
publish reviews and comments. Review the workflow permissions and action version
before changing them; this workflow is not a substitute for test checks.

### Droid Tag

`.github/workflows/droid.yml` invokes Factory Droid when a pull request, issue,
review, or comment contains `@droid`. It uses write permissions to respond to
requests and comments. It is event-driven assistance, not a required CI lane.

## Local verification

Install the pinned package manager and workspace dependencies using the setup
instructions in [DEVELOPING.md](DEVELOPING.md). The ordinary local verification
entry point is `pnpm verify`. It selects affected Vitest files conservatively
and may report that broader verification is needed. Follow the verification
instructions in `AGENTS.md` and `doc/DEVELOPING.md` for the relevant change.
Use `--base <ref>` to override the locally recorded default branch.

The repository contains test-selection, test-duration, CI profiling, sharding,
and incremental verification utilities. Their presence does not mean the
three workflows above currently run a full source/test matrix. Changes that add
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
