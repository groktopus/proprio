# Contributing to Proprio

The current focus is reliable Linux self-hosting. Reproducible bug reports, focused fixes, and tests are welcome. We are not trying to expand the feature surface during the bootstrap.

- Search existing reports first. Include the version or commit, environment, steps, and expected and actual behavior. Remove credentials, private prompts, and deployment details from logs.
- Keep each pull request focused. Explain the failure, show that the regression test fails without the fix, and say what you verified locally.
- For changes to task authority, runtime isolation, session recovery, data layout, or external services, discuss the design before implementation. Say how to roll it back without losing work.
- Attribute any patch imported from upstream and verify it independently on Proprio. A green result in a different repository is not evidence here.

Use the [product vision](VISION.md) to evaluate proposal scope.
See [the stability triage plan](STABILITY.md) for initial priorities and [SECURITY.md](SECURITY.md) for private reporting.

## Reviewing and merging

The required smoke check runs on the exact PR head, including PRs from forks.
It uses a GitHub-hosted runner with a read-only token and no repository secrets.
GitHub may require workflow approval for a first-time external contributor.

A repository maintainer may self-review a pull request. If GitHub does not allow the author to submit an approval, record the review in a pull request comment. Name the exact head commit, the behavior reviewed, the checks run, and any remaining risks. Do not describe a self-review as independent.

Merge only when the recorded review covers the current head, the applicable CI checks have passed on that head, and the change has focused verification evidence. Repeat the affected checks and review after a material change. A self-review does not override a failed check, required platform rules, or the design discussion required above. Merge does not authorize a release or deployment.

Automated review, including Greptile, is optional. No provider installation,
check-run, or score is required. Address actionable findings from available
reviewers. An optional reviewer job that fails solely because its service is
unavailable is missing review evidence, not a code-check failure or approval.
Record that failure and the current-head maintainer review in the PR. Required
platform rules and applicable CI typecheck, build, and test gates still apply.
