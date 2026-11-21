# Stability cleanup sprint

We are not copying an upstream backlog into Proprio. Upstream reports and patches are leads, not accepted work or proof that a bug exists here.

1. **Triage by symptom and affected path.** Combine reports with the same proven cause. Keep links to distinct reproductions and versions. Don’t group two symptoms just because they share an error label.
2. **Verify against Proprio's pinned baseline.** Record the environment, expected and actual behavior, and a failing regression test where feasible. If it cannot be verified, label it unconfirmed instead of treating it as a release blocker.
3. **Check fixes before importing them.** Inspect the diff and its dependencies. Prefer the smallest change that fixes the baseline reproducer; preserve notices and contributor attribution. Require an independent regression check and a rollback path for changes to durable state.
4. **Protect data and surface failures.** Prioritize lost or stranded work, misleading terminal status, inaccessible diagnostics, resource exhaustion, and restart or resume failures. Handle sensitive reports through coordinated disclosure, not public exploit detail.
5. **Defer feature requests by default.** Exceptions should materially simplify operations or make an existing supported path reliable.

Initial acceptance priority: clean Linux installation and restart, an end-to-end agent job, clear disk-full and provider failure reporting, correct stop and resume behavior, and preservation of work after a failed or interrupted run.
