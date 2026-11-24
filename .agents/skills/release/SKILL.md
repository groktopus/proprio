---
name: release
description: Qualify and publish a Proprio Linux source prerelease from an exact main revision.
---

# Release Proprio

Use the [source release runbook](../../../doc/RELEASING.md) and
[readiness checklist](../../../doc/RELEASE-CHECKLIST.md). Use the requested
`v0.0.x` source version and respect its milestone or rollout prerequisites.

1. Resolve the preceding published source tag and select the merged candidate
   on `main`. Use a clean checkout with frozen dependencies.
2. Dispatch Linux source qualification on `main` with both exact SHAs.
   Retain the passing run attempt and acceptance artifact.
3. Draft operator-facing notes for the exact range. Follow the documentation,
   support, and evidence requirements in the runbook. Review the notes and
   candidate checklist before publication.
4. Dry-run `scripts/create-github-release.sh` with the version, previous tag,
   and notes. Use the same arguments for the authorized live publication.
5. Verify the GitHub prerelease, tag SHA, and downloadable catalog. Record
   the published links, qualification, supported scope, and known gaps.

Handle a partial publication using the retry procedure in the runbook.
