#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

dry_run=false
version=""
notes_file_override=""
previous_tag=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/create-github-release.sh <version> [--dry-run] [--notes-file PATH] [--previous-tag TAG]

Examples:
  ./scripts/create-github-release.sh 2026.318.0
  ./scripts/create-github-release.sh 2026.318.0 --dry-run
  ./scripts/create-github-release.sh 2026.318.0 --notes-file /tmp/stable-notes.md
  ./scripts/create-github-release.sh 0.0.3 --previous-tag v0.0.2 --notes-file /tmp/v0.0.3.md --dry-run

Notes:
  - For 0.0.x source prereleases, check out the qualified main revision.
    Pass the previous source release tag. This script verifies before tagging.
  - For other versions, run this after pushing the tag.
  - Resolves the git remote automatically.
  - In GitHub Actions, origin is used explicitly.
  - The legacy path also accepts 0.0.x-alpha.N, 0.0.x-beta.N, and 0.0.x-rc.N.
  - If the release already exists, this script updates its title and notes.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --previous-tag)
      shift
      [ "$#" -gt 0 ] || release_fail "--previous-tag requires a tag."
      previous_tag="$1"
      ;;
    --notes-file)
      shift
      if [ $# -eq 0 ]; then
        echo "Error: --notes-file requires a path." >&2
        exit 1
      fi
      notes_file_override="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$version" ]; then
        echo "Error: only one version may be provided." >&2
        exit 1
      fi
      version="$1"
      ;;
  esac
  shift
done

if [ -z "$version" ]; then
  usage
  exit 1
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
  [[ ! "$version" =~ ^0\.0\.[0-9]+-(alpha|beta|rc)\.[0-9]+$ ]]; then
  echo "Error: use 0.0.x for a source prerelease or a supported legacy version." >&2
  exit 1
fi

tag="v$version"
source_prerelease=false
if [[ "$version" =~ ^0\.0\.[1-9][0-9]*$ ]]; then
  source_prerelease=true
  if [[ ! "$previous_tag" =~ ^v0\.0\.[1-9][0-9]*$ || "$previous_tag" == "$tag" ]]; then
    release_fail "A source prerelease requires --previous-tag v0.0.x with a different published tag."
  fi
elif [ -n "$previous_tag" ]; then
  release_fail "--previous-tag is only used for 0.0.x source prereleases."
fi
notes_file="$REPO_ROOT/releases/${tag}.md"
if [ -n "$notes_file_override" ]; then
  notes_file="$notes_file_override"
fi
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -z "${PUBLISH_REMOTE:-}" ] && git_remote_exists origin; then
  PUBLISH_REMOTE=origin
fi
PUBLISH_REMOTE="$(resolve_release_remote)"
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI is required to create GitHub releases." >&2
  exit 1
fi

GITHUB_REPO="$(github_repo_from_remote "$PUBLISH_REMOTE" || true)"
if [ -z "$GITHUB_REPO" ]; then
  echo "Error: could not determine GitHub repository from remote $PUBLISH_REMOTE." >&2
  exit 1
fi

if [ ! -f "$notes_file" ]; then
  echo "Error: release notes file not found at $notes_file." >&2
  exit 1
fi

head_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
tag_commit="$head_commit"
if [ "$source_prerelease" = false ]; then
  tag_commit="$(git -C "$REPO_ROOT" rev-parse --verify "refs/tags/$tag^{commit}")" ||
    release_fail "Local git tag $tag does not exist."
elif git_local_tag_exists "$tag"; then
  tag_commit="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$tag^{commit}")"
fi
if [ "$head_commit" != "$tag_commit" ]; then
  release_fail "HEAD ($head_commit) does not match tag $tag ($tag_commit)."
fi
untracked_mode=no
[ "$source_prerelease" = false ] || untracked_mode=normal
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files="$untracked_mode")" ]; then
  release_fail "The release checkout must be clean before generating the feature catalog."
fi

catalog_dir="$(mktemp -d)"
trap 'rm -rf "$catalog_dir"' EXIT

remote_tag_commit() {
  local tag_ref="refs/tags/$1"
  local refs
  refs="$(git -C "$REPO_ROOT" ls-remote --exit-code --tags "$PUBLISH_REMOTE" "$tag_ref" "$tag_ref^{}")" || return "$?"
  awk -v tag_ref="$tag_ref" -v peeled_ref="$tag_ref^{}" \
    '$2 == peeled_ref { peeled = $1 } $2 == tag_ref { ref = $1 } END { print (peeled != "" ? peeled : ref) }' \
    <<<"$refs"
}

if [ "$source_prerelease" = true ]; then
  canonical_remote() {
    case "$1" in
      https://github.com/groktopus/proprio|https://github.com/groktopus/proprio.git|git@github.com:groktopus/proprio.git|ssh://git@github.com/groktopus/proprio.git) return 0 ;;
      *) return 1 ;;
    esac
  }
  canonical_remote "$(git -C "$REPO_ROOT" remote get-url --all "$PUBLISH_REMOTE")" &&
    canonical_remote "$(git -C "$REPO_ROOT" remote get-url --push --all "$PUBLISH_REMOTE")" ||
    release_fail "Source prereleases require canonical groktopus/proprio fetch and push destinations."
  source_notes="$catalog_dir/release-notes.md"
  cp -- "$notes_file" "$source_notes" || release_fail "Cannot copy the source release notes."
  grep -q '[^[:space:]]' "$source_notes" || release_fail "Source release notes must contain operator guidance."
  main_ref="$(git -C "$REPO_ROOT" ls-remote --exit-code "$PUBLISH_REMOTE" refs/heads/main)"
  main_sha="${main_ref%%$'\t'*}"
  if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$head_commit" "$main_sha"; then
    release_fail "The candidate is not on current main. Fetch main and use a merged revision."
  fi
  base_sha="$(remote_tag_commit "$previous_tag")" || release_fail "Cannot resolve previous source tag $previous_tag."
  if [ "$base_sha" = "$head_commit" ] || ! git -C "$REPO_ROOT" merge-base --is-ancestor "$base_sha" "$head_commit"; then
    release_fail "The previous source tag must be an ancestor of the candidate. Fetch the release tags."
  fi
  inventory="$(gh api --paginate "/repos/$GITHUB_REPO/releases?per_page=100" \
    --jq '.[] | {tag_name,draft,prerelease,assets:[.assets[].name]}')"
  release_state="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [target, expectedPrevious] = process.argv.slice(1);
    const releases = readFileSync(0, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const number = (tag) => BigInt(tag.slice(5));
    const previous = releases.filter(release => release.prerelease && !release.draft &&
       /^v0\.0\.[1-9][0-9]*$/.test(release.tag_name) && number(release.tag_name) < number(target))
       .reduce((latest, release) => !latest || number(release.tag_name) > number(latest) ? release.tag_name : latest, null);
    if (previous !== expectedPrevious) throw new Error(`Expected previous published source tag ${previous ?? "none"}, got ${expectedPrevious}`);
    const current = releases.find(release => release.tag_name === target);
    if (!current) console.log("create");
    else if (current.assets.some(name => name !== "feature-catalog.json")) throw new Error("The existing release has an unverified asset.");
    else if (current.draft) console.log("finish draft");
    else if (current.prerelease && current.assets.length === 1) console.log("leave published release unchanged");
    else throw new Error("The existing release must be inspected before publication.");
  ' "$tag" "$previous_tag" <<<"$inventory")"
  existing_source_tag=""
  if existing_source_tag="$(remote_tag_commit "$tag")"; then
    [ "$existing_source_tag" = "$tag_commit" ] ||
      release_fail "Remote tag $tag points to $existing_source_tag, expected $tag_commit."
  elif [ "$?" -ne 2 ]; then
    release_fail "Cannot check remote tag $tag."
  fi
  qualification="$(cd "$REPO_ROOT" &&
    node scripts/ci/durable-work-release-evidence.mjs "$tag_commit" "$base_sha" --require-linux --markdown)" ||
    release_fail "Source release is blocked until the exact candidate passes Linux qualification."
fi

catalog_file="$catalog_dir/feature-catalog.json"
node "$REPO_ROOT/cli/node_modules/tsx/dist/cli.mjs" \
  "$REPO_ROOT/scripts/generate-feature-catalog.ts" \
  --version "$version" \
  --out "$catalog_file"

if [ "$source_prerelease" = true ]; then
  if [ "$dry_run" = true ]; then
    printf '[dry-run] Verified %s at %s from %s (%s). Would %s.\n%s\n' \
      "$tag" "$tag_commit" "$previous_tag" "$base_sha" "$release_state" "$qualification"
    exit 0
  fi

  tag_ref="refs/tags/$tag"
  if [ -z "$existing_source_tag" ]; then
    [ "$release_state" = "create" ] || release_fail "The existing release has no matching remote tag."
    git -C "$REPO_ROOT" push "$PUBLISH_REMOTE" "$tag_commit:$tag_ref"
  fi
  published_sha="$(remote_tag_commit "$tag")"
  [ "$published_sha" = "$tag_commit" ] || release_fail "Remote tag $tag changed before publication."

  case "$release_state" in
    create)
      gh release create "$tag" "$catalog_file" -R "$GITHUB_REPO" --verify-tag --prerelease --title "Proprio $tag" --notes-file "$source_notes"
      ;;
    "finish draft")
      gh release upload "$tag" "$catalog_file" -R "$GITHUB_REPO" --clobber
      safe_draft="$(gh release view "$tag" -R "$GITHUB_REPO" --json isDraft,assets \
        --jq '.isDraft and ([.assets[].name] == ["feature-catalog.json"])')"
      [ "$safe_draft" = true ] || release_fail "The draft contains an unverified asset or changed during upload."
      gh release edit "$tag" -R "$GITHUB_REPO" --draft=false --prerelease --title "Proprio $tag" --notes-file "$source_notes"
      ;;
    "leave published release unchanged")
      printf 'Source prerelease %s is already published at %s.\n' "$tag" "$tag_commit"
      ;;
  esac
  exit 0
fi

if [ "$dry_run" = true ]; then
  echo "[dry-run] gh release create $tag -R $GITHUB_REPO --title $tag --notes-file $notes_file"
  echo "[dry-run] gh release upload $tag -R $GITHUB_REPO --clobber $catalog_file"
  exit 0
fi

if ! published_sha="$(remote_tag_commit "$tag")"; then
  release_fail "Remote tag $tag was not found on $PUBLISH_REMOTE. Push the release commit and tag first."
fi
if [ "$published_sha" != "$tag_commit" ]; then
  echo "Error: remote tag $tag points to $published_sha, but local tag $tag points to $tag_commit." >&2
  exit 1
fi

release_exists=false
if gh release view "$tag" -R "$GITHUB_REPO" >/dev/null 2>&1; then
  release_exists=true
fi

# The source release is the supported Core distribution path. Require retained
# exact-source durable-work evidence immediately before create/edit or asset
# upload, independently of package publication and its verification flags.
stable_tag=""
while IFS= read -r candidate; do
  if [ "$candidate" != "$tag" ] && [[ "$candidate" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    stable_tag="$candidate"
    break
  fi
done < <(git -C "$REPO_ROOT" tag --list 'v*' --sort=-version:refname)
if [ -z "$stable_tag" ]; then
  echo "Error: source publication needs a previous stable release tag for durable-work comparison." >&2
  exit 1
fi
previous_release_sha="$(git -C "$REPO_ROOT" rev-parse "${stable_tag}^{commit}")"
if ! (cd "$REPO_ROOT" && node scripts/ci/durable-work-release-evidence.mjs "$tag_commit" "$previous_release_sha"); then
  echo "Error: source release is blocked until the exact candidate passes Linux durable-work qualification." >&2
  exit 1
fi

if [ "$release_exists" = true ]; then
  gh release edit "$tag" -R "$GITHUB_REPO" --title "$tag" --notes-file "$notes_file"
  echo "Updated GitHub Release $tag"
else
  gh release create "$tag" -R "$GITHUB_REPO" --title "$tag" --notes-file "$notes_file"
  echo "Created GitHub Release $tag"
fi

gh release upload "$tag" -R "$GITHUB_REPO" --clobber "$catalog_file"
echo "Uploaded feature-catalog.json to GitHub Release $tag"
