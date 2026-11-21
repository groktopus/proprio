# Contributing to Proprio

The current focus is reliable Linux self-hosting. Reproducible bug reports, focused fixes, and tests are welcome. We are not trying to expand the feature surface during the bootstrap.

- Search existing reports first. Include the version or commit, environment, steps, and expected and actual behavior. Remove credentials, private prompts, and deployment details from logs.
- Keep each pull request focused. Explain the failure, show that the regression test fails without the fix, and say what you verified locally.
- For changes to task authority, runtime isolation, session recovery, data layout, or external services, discuss the design before implementation. Say how to roll it back without losing work.
- Attribute any patch imported from upstream and verify it independently on Proprio. A green result in a different repository is not evidence here.

See [the stability triage plan](STABILITY.md) for initial priorities and [SECURITY.md](SECURITY.md) for private reporting.
