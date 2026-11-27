# Linux self-hosted image publication

The first installable format is a Linux amd64 OCI image from the repository's
`production` target. The qualified layouts are the authenticated Compose
quickstart with embedded PostgreSQL and the full stack with PostgreSQL 17.
The default local harness CLIs are present. The optional remote provider pack,
Cloud target, other architectures, and live model-provider journeys have
separate qualification.

## Build, qualify, and promote

Use the workflow's two dispatch modes from `main`. First select `qualify` and
leave `release_tag` empty. That run builds, signs, and Compose-tests one
candidate digest. Record its source SHA, digest, Actions run ID, and run
attempt from the run summary and URL.

On a clean Linux amd64 host, anonymously pull that candidate by digest, verify
its provenance and SPDX SBOM, then exercise the advertised Compose topology
with persisted state and the previous known-good image for upgrade or rollback.
Keep those host results with the qualification record. Only after that evidence
is accepted, publish the matching source release `v0.0.x` at the exact
qualified source SHA.

Then dispatch `promote` from `main` with `release_tag=linux-0.0.x`, the exact
source SHA and candidate digest, plus the qualification run ID and attempt. The
promotion job requires that exact run to be a successful `workflow_dispatch`
from `main` for the same SHA and attempt; it also requires its Compose
qualification job to have succeeded and its retained build artifact to contain
the selected digest. It verifies the published source release and lightweight
or annotated tag, both attestations, and anonymous candidate access before
tagging the same digest. Promotion does not build or substitute an image. A
later `main` commit does not change the source SHA pinned by the qualification
run and release tag.

The build publishes one candidate digest. It records the source revision in an
OCI label and signs build provenance and the SPDX SBOM for the digest with
GitHub artifact attestations. A separate GitHub-hosted Linux runner verifies
both attestations, pulls the immutable digest, checks the installed CLIs,
and runs the Compose state smoke against both storage layouts. The candidate
artifact is retained for 90 days so promotion can verify the exact run attempt.

The first GHCR package may start private. After qualification, a package
administrator sets its visibility to public in Package settings. If the
candidate is not anonymously readable, promotion stops before assigning the
release tag. Reuse the same tested digest after changing visibility. If a
version tag already points to a different digest, investigate before starting
another promotion.

Record the source SHA, immutable image digest, qualification run ID and
attempt, promotion run, and result in the release record. Retain published
image manifests, signed attestations, and release records for the latest two
qualified versions and any digest still deployed. Candidate tags can be
removed after their disposition is recorded. Do not delete a manifest
referenced by a retained release or its attestation.

### Release checklist

Before promotion:

1. Require successful build and both Compose state-restore checks from one
   candidate qualification run. Record its exact source SHA, digest, run ID,
   and attempt.
2. On a clean Linux amd64 host, anonymously pull the candidate by digest,
   verify provenance and SPDX SBOM, and exercise the advertised authenticated
   Compose topology with persisted state.
3. Qualify an upgrade from the previous known-good image, or rehearse the
   documented rollback/restore procedure using its retained digest,
   configuration, and backup. Record which path passed and the resulting
   version/storage migration outcome.
4. If release notes advertise authenticated/public Compose installs, verify
   the fresh first-admin CLI invite flow from [#414](https://github.com/groktopus/proprio/issues/414)
   on this exact image. Keep that profile source-only or unsupported until its
   bootstrap check passes. Do not change private browser-claim behavior.
5. Publish the matching GitHub source release `v0.0.x` at the exact qualified
   source SHA, then run `promote` with the same source SHA, candidate digest,
   qualification run ID, and attempt.

After promotion, on a clean Linux amd64 host verify the public version tag and
include this pull-by-tag example, its immutable digest, compatible Compose
setup, required migration steps, previous known-good digest, qualification
run, and upgrade or rollback evidence in the GitHub release notes:

```bash
docker pull --platform linux/amd64 ghcr.io/groktopus/proprio:linux-0.0.x
docker pull --platform linux/amd64 ghcr.io/groktopus/proprio@sha256:<qualified-digest>
```

Leave the optional remote provider pack unadvertised until it passes separate
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
