# Linux self-hosted image publication

The first installable format is a Linux amd64 OCI image from the repository's
`production` target. The qualified layouts are the authenticated Compose
quickstart with embedded PostgreSQL and the full stack with PostgreSQL 17.
The default local harness CLIs are present. The optional remote provider pack,
Cloud target, other architectures, and live model-provider journeys have
separate qualification.

## Build, qualify, and promote

Dispatch **Linux image release** from `main` after checking the selected SHA.
Set `release_tag` to `linux-0.0.x` for an approved publication. Leaving it
blank builds and qualifies a candidate without assigning a public version tag.
For a versioned promotion, publish the matching GitHub source release at
`v0.0.x` first. The promotion guard resolves that tag (including annotated
tags) and requires its commit to equal the workflow's exact source SHA. A
missing release or source mismatch stops before registry operations.

The build publishes one candidate digest. It records the source revision in
an OCI label and signs build provenance and the SPDX SBOM for the digest with
GitHub artifact attestations. A separate GitHub-hosted Linux runner verifies
both attestations, pulls the immutable digest, checks the installed CLIs,
and runs the Compose state smoke against both storage layouts. Promotion
checks that the build and smoke outputs match, verifies the signatures again,
and tags the exact registry manifest without a rebuild.

The first GHCR package may start private. After qualification, a package
administrator sets its visibility to public in Package settings. The
promotion guard checks that the candidate digest is readable anonymously
before assigning the release tag. If visibility blocks promotion, rerun
only the failed promotion job after changing it. Reusing the same tested
digest avoids generating a new candidate. If a version tag already points
to a different digest, investigate before starting another promotion.

Record the source SHA, immutable image digest, Actions attempt, and
qualification result in the release record. Include the version tag when
promotion assigns one. A release can identify a publicly accessible
qualified image by its immutable digest. Retain published image
manifests, signed attestations, and release records for the latest two
qualified versions and any digest still deployed. Candidate tags can be
removed after their disposition is recorded. Do not delete a manifest
referenced by a retained release or its attestation.

### Release checklist

Before promoting a versioned image:

1. Confirm the GitHub release tag `v0.0.x` points to the exact selected source
   SHA and the release notes identify whether the image is source-only local
   self-hosting or includes another separately qualified profile.
2. Require successful build, signature, SBOM, amd64 digest, and both Compose
   state-restore checks from the same workflow attempt. Promote only the
   workflow's qualified digest; do not rebuild or substitute an earlier
   candidate.
3. On a clean Linux amd64 host, anonymously pull the version tag and confirm
   it resolves to the recorded digest. Verify provenance and SPDX SBOM, then
   exercise the advertised authenticated Compose topology with persisted
   state.
4. Qualify an upgrade from the previous known-good image, or rehearse the
   documented rollback/restore procedure using its retained digest,
   configuration, and backup. Record which path passed and the resulting
   version/storage migration outcome.
5. Add the immutable digest, version tag, compatible Compose setup, required
   migration steps, previous known-good digest, qualification run, and
   upgrade or rollback evidence to the GitHub release notes. Leave the
   optional remote provider pack unadvertised until it passes separate
   qualification.

## Verify and install

Set `IMAGE_DIGEST` and `SOURCE_SHA` from the published release record. These
commands need Docker and a current GitHub CLI with attestation support.

```bash
image="ghcr.io/groktopus/proprio@$IMAGE_DIGEST"
verify=(--repo groktopus/proprio \
  --signer-workflow groktopus/proprio/.github/workflows/linux-image-release.yml \
  --source-ref refs/heads/main --source-digest "$SOURCE_SHA" --deny-self-hosted-runners)
gh attestation verify "oci://$image" "${verify[@]}"
gh attestation verify "oci://$image" "${verify[@]}" --predicate-type https://spdx.dev/Document
docker pull --platform linux/amd64 "$image"
```

### First qualified public digest

Use source revision `4e3525fd8381bc813f1fd9e54b8753e6bd6cd49e` and image
`ghcr.io/groktopus/proprio@sha256:e480ac4cb84299a23d81880e13ce620d524b03f1eba99ba7daa469ed073d66d9`.
This is the signed OCI index. Its Linux amd64 child manifest is
`sha256:a96fa61d6914cf86fc71875e951431a03fc9bb4faa315a044bdce81318cc5a6c`.
Use the index for attestation verification. Docker selects the amd64 child
when pulling with `--platform linux/amd64`. Attempt 1 of the
[image qualification run](https://github.com/groktopus/proprio/actions/runs/45350841926)
tested that child from the signed index.
The runner verified both signatures and the source revision label before
checking the five installed harness versions and both Compose layouts.
The [retained build record and SPDX SBOM](https://github.com/groktopus/proprio/actions/runs/45350841926/artifacts/14900667594)
identify the same digest.

An independent reference install pulled the manifest anonymously on Linux
x86-64, verified its build provenance and SPDX SBOM with GitHub CLI 2.105.0,
and ran the same state drill with Docker Engine 29.9.2 and Compose 5.6.1.
Between 08:07:58 and 08:10:15 UTC on November 24, 2026, both layouts
preserved their company, successful synthetic agent run, and single receipt
through recreation and fresh restore. The embedded archive was a stopped
PostgreSQL 18.1 cluster. Both standalone PostgreSQL servers and the dump and
restore clients reported 17.12.

This run made the digest available through the public candidate tag
`candidate-45350841926-1`. The optional version-tag job was skipped.
Retain the candidate tag, index, child manifest, and attestations until a
retained release tag points to the same index.

The qualified image recovery procedure restores its backups into a fresh
project using the same digest. The preceding
[`v0.0.2` source prerelease](https://github.com/groktopus/proprio/releases/tag/v0.0.2)
has a separate [managed source recovery record](https://github.com/groktopus/proprio/actions/runs/45340716133).
Use a backup taken on that source revision and its original configuration,
signing keys, and storage settings for a source recovery.

### Start Compose

Follow the [Compose setup](DOCKER.md#docker-compose) from the recorded
source checkout. Add a Compose override setting the app service's `image`
to the full digest reference. The quickstart service is `proprio`. The
full-stack app service is `server`. Include the override after the base
Compose file and run `up --no-build -d --wait` instead of `up --build`.

Keep the known-good digest and its matching Compose configuration and
state backup. To recover after a failed release, verify the previously
recorded digest and use it in the override. If schema compatibility is
unclear, restore the backup into an empty project before directing traffic
to that image. Follow the [restore instructions](DOCKER.md#back-up-and-restore-compose-data).
