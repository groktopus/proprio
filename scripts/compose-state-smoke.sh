#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $# -gt 1 || "${1:-}" == --help ]]; then
  echo "Usage: $0 [prebuilt-image]"
  exit "$(( $# > 1 ))"
fi
image="${1:-}"
unset BETTER_AUTH_SECRET PROPRIO_TOOL_ACTION_SIGNING_SECRET PROPRIO_POSTGRES_PASSWORD
unset PROPRIO_PORT PROPRIO_BIND_IP PROPRIO_PUBLIC_URL PROPRIO_ALLOWED_HOSTNAMES PROPRIO_DATA_DIR
unset OPENAI_API_KEY ANTHROPIC_API_KEY

umask 077
fixture_dir="$(mktemp -d)"
project="proprio-state-$(openssl rand -hex 5)"
session_secret="$(openssl rand -hex 32)"
tool_secret="$(openssl rand -hex 32)"
db_password="$(openssl rand -hex 32)"
admin_password="$(openssl rand -hex 24)"
admin_email="compose-state@example.test"
cookie="$fixture_dir/cookies"
cleanup_projects=()

compose() {
  local instance="$1"
  shift
  docker compose --project-name "$project-$instance" --env-file "$fixture_dir/$instance.env" \
    -f "$repo/docker/$compose_file" "${override[@]}" "$@"
}

cleanup() {
  local result=$?
  for instance in "${cleanup_projects[@]}"; do
    if (( result != 0 )); then
      # Keep credential-bearing logs out of shared CI output.
      printf 'Compose smoke failed for %s-%s. Review the failing command above.\n' "$project" "$instance" >&2
    fi
    compose "$instance" down --volumes --remove-orphans >/dev/null 2>&1 || result=1
  done
  rm -rf "$fixture_dir"
  exit "$result"
}
trap cleanup EXIT

prepare_instance() {
  local instance="$1" port
  port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  url="http://localhost:$port"
  cat > "$fixture_dir/$instance.env" <<ENV
BETTER_AUTH_SECRET=$session_secret
PROPRIO_TOOL_ACTION_SIGNING_SECRET=$tool_secret
PROPRIO_POSTGRES_PASSWORD=$db_password
PROPRIO_PORT=$port
PROPRIO_DATA_DIR=$fixture_dir/$instance-state
ENV
  cleanup_projects+=("$instance")
}

post() {
  local route="$1"
  local response="$fixture_dir/response.json"
  if ! curl --fail-with-body --silent --show-error --cookie "$cookie" --cookie-jar "$cookie" \
      -H "Origin: $url" -H 'Content-Type: application/json' --data-binary @- \
      -o "$response" "$url/api/$route"; then
    printf 'Board request failed at /api/%s\n' "$route" >&2
    jq -c '{code, error, message}' "$response" >&2 || true
    return 1
  fi
  cat "$response"
}

assert_record() {
  curl --fail --silent --show-error --cookie "$cookie" "$url/api/companies" |
    jq -e --arg id "$company_id" 'any(.[]; .id == $id and .name == "Compose state smoke")' >/dev/null
}

ready() {
  compose "$1" up -d --wait --wait-timeout 180 "${build_flag[@]}" "${@:2}"
  curl --fail --silent --show-error "$url/api/health" | jq -e '.status == "ok"' >/dev/null
}

for profile in embedded external; do
  service=proprio
  compose_file=docker-compose.quickstart.yml
  if [[ "$profile" == external ]]; then
    service=server
    compose_file=docker-compose.yml
  fi
  override=()
  build_flag=(--build)
  if [[ -n "$image" ]]; then
    jq -n --arg service "$service" --arg image "$image" '{services:{($service):{image:$image}}}' > "$fixture_dir/override.json"
    override=(-f "$fixture_dir/override.json")
    build_flag=(--no-build)
  fi

  source="$profile-source"
  target="$profile-restored"
  prepare_instance "$source"
  ready "$source"
  rm -f "$cookie"
  jq -n --arg email "$admin_email" --arg password "$admin_password" \
    '{name:"Compose smoke", $email, $password}' | post auth/sign-up/email >/dev/null
  printf '{}' | post bootstrap/claim | jq -e '.claimed' >/dev/null
  company_id="$(printf '{"name":"Compose state smoke"}' | post companies | jq -er '.id')"
  compose "$source" exec -T "$service" sh -c 'mkdir -p /proprio/smoke && printf retained > /proprio/smoke/receipt'
  assert_record

  # Recreate the app on the same mount before backing it up.
  compose "$source" up -d --wait --wait-timeout 180 --no-build --force-recreate --no-deps "$service"
  assert_record
  compose "$source" exec -T "$service" grep -qx retained /proprio/smoke/receipt

  compose "$source" stop "$service"
  compose "$source" run --rm --no-deps -T --entrypoint tar "$service" -C /proprio -czf - . > "$fixture_dir/data.tar.gz"
  if [[ "$profile" == external ]]; then
    compose "$source" exec -T db pg_dump -U proprio -d proprio -Fc > "$fixture_dir/postgres.dump"
  fi
  compose "$source" down --volumes
  cleanup_projects=()

  prepare_instance "$target"
  if [[ "$profile" == external ]]; then
    compose "$target" up -d --wait --wait-timeout 180 db
    compose "$target" exec -T db pg_restore --exit-on-error --no-owner -U proprio -d proprio < "$fixture_dir/postgres.dump"
  fi
  compose "$target" run --rm --no-deps -T --entrypoint sh "$service" \
    -ec 'test -z "$(ls -A /proprio)" && exec tar --numeric-owner -C /proprio -xzf -' \
    < "$fixture_dir/data.tar.gz"
  ready "$target"
  rm -f "$cookie"
  jq -n --arg email "$admin_email" --arg password "$admin_password" \
    '{$email, $password}' | post auth/sign-in/email >/dev/null
  assert_record
  compose "$target" exec -T "$service" grep -qx retained /proprio/smoke/receipt
  printf '%s profile retained its board record and data file through recreation and fresh restore.\n' "$profile"
  compose "$target" down --volumes
  cleanup_projects=()
done
