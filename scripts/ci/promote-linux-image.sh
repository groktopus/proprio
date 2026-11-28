#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="$repo_root"
# shellcheck source=../release-lib.sh
. "$repo_root/scripts/release-lib.sh"

image=ghcr.io/groktopus/proprio
source_sha="${1:-}"
built_digest="${2:-}"
qualified_digest="${3:-}"
release_tag="${4:-}"
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ||
      ! "$built_digest" =~ ^sha256:[0-9a-f]{64}$ ||
      "$qualified_digest" != "$built_digest" ||
      ! "$release_tag" =~ ^linux-0\.0\.[1-9][0-9]*$ ]]; then
  echo "Promotion requires a source SHA, matching build and qualification digests, and a linux-0.0.x tag." >&2
  exit 1
fi

repo=groktopus/proprio
workflow="$repo/.github/workflows/linux-image-release.yml"
verify_args=(--repo "$repo" --signer-workflow "$workflow" --source-ref refs/heads/main --source-digest "$source_sha" --deny-self-hosted-runners)
reference="$image@$built_digest"

# A versioned image is only eligible for the matching published source release.
# Resolve annotated Git tags to their commit rather than trusting the release's
# target_commitish (which is not the tag's immutable target).
source_tag="v${release_tag#linux-}"
release_metadata="$(gh release view "$source_tag" --repo "$repo" --json tagName,isDraft --jq '.tagName + " " + (.isDraft | tostring)')"
read -r published_tag is_draft <<<"$release_metadata"
if [[ "$published_tag" != "$source_tag" || "$is_draft" != false ]]; then
  echo "Publish the matching GitHub source release $source_tag before promoting $release_tag." >&2
  exit 1
fi
source_remote="https://github.com/$repo.git"
tag_sha="$(remote_tag_commit "$source_remote" "$source_tag")" || {
  echo "Could not resolve the source tag $source_tag from $source_remote." >&2
  exit 1
}
if [[ "$tag_sha" != "$source_sha" ]]; then
  echo "Release source tag $source_tag resolves to $tag_sha, not dispatched source $source_sha." >&2
  exit 1
fi

gh attestation verify "oci://$reference" "${verify_args[@]}"
gh attestation verify "oci://$reference" "${verify_args[@]}" --predicate-type https://spdx.dev/Document

# Verify the exact candidate is publicly readable before creating a version tag.
anonymous="$(mktemp -d)"
trap 'rm -rf "$anonymous"' EXIT
inspect_args=(--format '{{ .Manifest.Digest }}')
public_digest="$(docker --config "$anonymous" buildx imagetools inspect "$reference" "${inspect_args[@]}")"
[[ "$public_digest" == "$built_digest" ]]

target="$image:$release_tag"
inspect_error="$anonymous/existing.err"
if current="$(docker buildx imagetools inspect "$target" "${inspect_args[@]}" 2>"$inspect_error")"; then
  if [[ "$current" != "$built_digest" ]]; then
    echo "Release tag $target is already bound to $current." >&2
    exit 1
  fi
elif grep -qiE '(manifest unknown|not found)' "$inspect_error"; then
  docker buildx imagetools create --prefer-index=false --tag "$target" "$reference"
else
  cat "$inspect_error" >&2
  exit 1
fi

[[ "$(docker --config "$anonymous" buildx imagetools inspect "$target" "${inspect_args[@]}")" == "$built_digest" ]]
printf 'Published %s at %s from %s.\n' "$target" "$built_digest" "$source_sha"
