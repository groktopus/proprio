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

Record the source SHA, immutable image digest, version tag, Actions attempt,
and qualification result in the release record. Retain published image
manifests, signed attestations, and release records for the latest two
qualified versions and any digest still deployed. Candidate tags can be
removed after their disposition is recorded. Do not delete a manifest
referenced by a retained release or its attestation.

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
