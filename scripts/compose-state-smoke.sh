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
company_name="Compose state smoke"
receipt_path=/proprio/smoke/receipt
receipt_value=retained
cookie="$fixture_dir/cookies"
cleanup_projects=()
built_image=""

compose() {
  local instance="$1"
  shift
  docker compose --project-name "$project-$instance" --env-file "$fixture_dir/$instance.env" \
    -f "$repo/docker/$compose_file" "${override[@]}" "$@"
}

remove_instance() {
  if [[ "$profile" == embedded ]]; then
    compose "$1" stop "$service" || return 1
    compose "$1" run --rm --no-deps -T --user 0 --entrypoint sh "$service" \
      -ec 'find /proprio -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +' || return 1
  fi
  compose "$1" down --volumes --remove-orphans
}

cleanup() {
  local result=$?
  for instance in "${cleanup_projects[@]}"; do
    if (( result != 0 )); then
      diagnostics="${diagnostics:-$(mktemp -d)}"
      compose "$instance" logs --no-color > "$diagnostics/$instance.log" 2>&1 || true
    fi
    remove_instance "$instance" >/dev/null 2>&1 || result=1
  done
  [[ -z "$built_image" ]] || docker image rm "$built_image" >/dev/null 2>&1 || result=1
  rm -rf "$fixture_dir"
  if [[ -n "${diagnostics:-}" ]]; then
    printf 'Private Compose smoke diagnostics are in %s\n' "$diagnostics" >&2
  fi
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
    jq -e --arg id "$company_id" --arg name "$company_name" \
      'any(.[]; .id == $id and .name == $name)' >/dev/null
}

run_status() {
  curl --max-time 5 --fail --silent --show-error --cookie "$cookie" "$url/api/heartbeat-runs/$run_id" |
    jq -er --arg id "$run_id" 'select(.id == $id) | .status'
}

run_synthetic_agent() {
  local agent_id deadline status=pending
  local program='const fs = require("node:fs"); const path = process.argv[1]; fs.mkdirSync(require("node:path").dirname(path), { recursive: true }); fs.appendFileSync(path, process.argv[2] + "\n");'
  agent_id="$(jq -n --arg path "$receipt_path" --arg value "$receipt_value" --arg program "$program" '{
    name: "Synthetic agent", role: "ceo", adapterType: "process",
    adapterConfig: {command: "node", args: ["-e", $program, $path, $value]}
  }' | post "companies/$company_id/agents" | jq -er '.id')"
  run_id="$(printf '{"source":"on_demand","reason":"Compose state smoke"}' |
    post "agents/$agent_id/wakeup" | jq -er '.id')"
  deadline=$(( SECONDS + 45 ))
  while (( SECONDS < deadline )); do
    status="$(run_status)"
    case "$status" in
      succeeded) return 0 ;;
      failed|cancelled|timed_out|interrupted) break ;;
    esac
    sleep 1
  done
  printf 'Synthetic run %s ended the wait in status %s\n' "$run_id" "$status" >&2
  return 1
}

ready() {
  local instance="$1" attempt output
  for attempt in 1 2 3; do
    if compose "$instance" up -d --wait --wait-timeout 180 --no-build > "$fixture_dir/up.log" 2>&1; then
      curl --fail --silent --show-error "$url/api/health" | jq -e '.status == "ok"' >/dev/null
      return
    fi
    output="$(< "$fixture_dir/up.log")"
    printf '%s\n' "$output" >&2
    if [[ "$attempt" == 3 || ( "$output" != *"port is already allocated"* && "$output" != *"address already in use"* ) ]]; then
      return 1
    fi
    prepare_instance "$instance"
  done
}

assert_receipt() {
  [[ "$(run_status)" == succeeded ]]
  compose "$1" exec -T "$service" sh -ec 'printf "%s\n" "$1" | cmp - "$2"' sh "$receipt_value" "$receipt_path"
}

db_version() {
  if [[ "$profile" == embedded ]]; then
    compose "$1" exec -T "$service" sh -ec '
      cluster_version="$(find /proprio -name PG_VERSION -type f -print -quit)"
      postgres="$(find /app -path "*/bin/postgres" -type f -print -quit)"
      test -n "$cluster_version" && test -n "$postgres"
      printf "Cluster format %s\n" "$(cat "$cluster_version")"
      "$postgres" --version'
  else
    compose "$1" exec -T db sh -ec 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "show server_version"'
  fi
}

if [[ -z "$image" ]]; then
  image="$project:smoke"
  docker build --target production -t "$image" "$repo"
  built_image="$image"
fi

for profile in embedded external; do
  service=proprio
  compose_file=docker-compose.quickstart.yml
  if [[ "$profile" == external ]]; then
    service=server
    compose_file=docker-compose.yml
  fi
  jq -n --arg service "$service" --arg image "$image" '{services:{($service):{image:$image}}}' > "$fixture_dir/override.json"
  override=(-f "$fixture_dir/override.json")

  source="$profile-source"
  target="$profile-restored"
  prepare_instance "$source"
  cleanup_projects+=("$source")
  ready "$source"
  rm -f "$cookie"
  jq -n --arg email "$admin_email" --arg password "$admin_password" \
    '{name:"Compose smoke", $email, $password}' | post auth/sign-up/email >/dev/null
  printf '{}' | post bootstrap/claim | jq -e '.claimed' >/dev/null
  company_id="$(jq -n --arg name "$company_name" '{$name}' | post companies | jq -er '.id')"
  invite_url="$(printf '{"allowedJoinTypes":"human"}' | post "companies/$company_id/invites" |
    jq -er --arg url "$url" '.inviteUrl | select(startswith($url + "/invite/"))')"
  curl --fail --silent --show-error "$url/api/invites/${invite_url##*/}" |
    jq -e --arg company "$company_id" '.companyId == $company' >/dev/null
  run_synthetic_agent
  assert_record
  assert_receipt "$source"

  # Recreate the app on the same mount before backing it up.
  compose "$source" up -d --wait --wait-timeout 180 --no-build --force-recreate --no-deps "$service"
  assert_record
  assert_receipt "$source"
  printf '%s source PostgreSQL version:\n' "$profile"
  db_version "$source"

  compose "$source" stop "$service"
  compose "$source" run --rm --no-deps -T --entrypoint tar "$service" -C /proprio -czf - . > "$fixture_dir/data.tar.gz"
  if [[ "$profile" == external ]]; then
    compose "$source" exec -T db pg_dump --version
    compose "$source" exec -T db sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$fixture_dir/postgres.dump"
  fi

  prepare_instance "$target"
  cleanup_projects+=("$target")
  if [[ "$profile" == external ]]; then
    compose "$target" up -d --wait --wait-timeout 180 db
    compose "$target" exec -T db sh -ec 'for attempt in $(seq 1 30); do pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" && exit 0; sleep 1; done; exit 1'
    compose "$target" exec -T db pg_restore --version
    compose "$target" exec -T db sh -ec 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$fixture_dir/postgres.dump"
  else
    printf 'Embedded PostgreSQL backup is a physical copy of the stopped cluster.\n'
  fi
  compose "$target" run --rm --no-deps -T --entrypoint sh "$service" \
    -ec 'test -z "$(ls -A /proprio)" && exec tar --numeric-owner -C /proprio -xzf -' \
    < "$fixture_dir/data.tar.gz"
  ready "$target"
  rm -f "$cookie"
  jq -n --arg email "$admin_email" --arg password "$admin_password" \
    '{$email, $password}' | post auth/sign-in/email >/dev/null
  assert_record
  assert_receipt "$target"
  printf '%s restored PostgreSQL version:\n' "$profile"
  db_version "$target"
  printf '%s profile retained its company, succeeded run %s, and one receipt through recreation and fresh restore.\n' "$profile" "$run_id"
  for instance in "${cleanup_projects[@]}"; do
    remove_instance "$instance"
  done
  cleanup_projects=()
done
