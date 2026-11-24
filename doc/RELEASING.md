# Proprio source releases

Proprio publishes Linux source prereleases on GitHub. The source sequence uses
`v0.0.x` tags. The release provides GitHub source archives and a feature catalog.
Any supported installable artifact has its own qualification and provenance.

## Select and verify the candidate

The release maintainer selects an exact merged `main` commit and the preceding
published source tag. Fetch both before using a clean, detached checkout.
Install workspace dependencies with the frozen lockfile. Keep generated notes
outside the checkout.

Dispatch [Linux source qualification](https://github.com/groktopus/proprio/actions/workflows/linux-source-qualification.yml)
on `main`, with `test_head` set to the full candidate SHA and `base_sha` set
to the full preceding tag SHA. Record the run attempt and retain the
`durable-work-acceptance` artifact. The verifier requires a completed passing
run for those exact revisions. Publication requires that evidence even for a
docs-only diff.

Review the [release checklist](RELEASE-CHECKLIST.md) with the CI and Linux
deployment owners. Summarize user-facing changes since the preceding tag.
Include the candidate and predecessor SHAs, qualification run and artifact
links, verified Linux architecture and database topology, install guide, and
known gaps. If you describe an upgrade path, include its retained-record and
rollback results, recovery time and observed data loss. Distinguish the
coverage of a synthetic task from provider-backed runs.

## Preview and publish

Use a GitHub remote for `groktopus/proprio` and a maintainer login with
permission to create a tag and release:

```sh
./scripts/create-github-release.sh 0.0.3 --previous-tag v0.0.2 \
  --notes-file /tmp/proprio-v0.0.3.md --dry-run
```

The dry run checks the remote, candidate, previous tag, and retained Linux
evidence. It generates the catalog from the pristine candidate. Missing,
skipped, failed, expired, or mismatched evidence blocks the command.

When the checklist and release authorization are satisfied, run the same
command without `--dry-run`. The script verifies before creating the tag.
It checks the remote tag again before publishing the GitHub prerelease and
attaches `feature-catalog.json`. Confirm the published release, asset, and
tag SHA on GitHub and record their links with the qualification attempt.

If publication stops after the tag is created, retry from the same clean
candidate with the same notes and arguments. The script reuses the matching
remote tag and can finish a draft. Investigate a mismatched tag or an
unexpected existing release before retrying.

For a failed upgrade, follow the rehearsed restore or roll-forward path. A
managed payload rollback does not reverse database migrations. Preserve the
pre-upgrade database backup, keys, and old revision until state retention and
task execution are verified.
