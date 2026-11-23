#!/usr/bin/env bash
# End-to-end proof that `proprio update` works ACROSS VERSIONS, including
# database migrations, against a real managed install with a live service.
#
# Journey (real GitHub, real embedded Postgres, real systemd/launchd service):
#   install --ref BASE (payload with N migrations) -> onboard + service active
#   -> point the tracked ref at NEXT (payload with N+1 migrations; NEXT adds a
#      probe migration creating table `e2e_update_probe`)
#   -> update --check (exit 10) -> update --yes
#   -> assert: pre-update DB backup written, payload flipped, service healthy,
#      probe migration applied to the real database (visible in a pg dump),
#      the database cluster was reused (no re-initialization)
#   -> update --rollback -> old payload must still boot against the migrated DB
#
# The tracked-ref edit in install.json simulates the real user state "installed
# from this ref a while ago, the ref has since gained migrations" without having
# to mutate refs on GitHub while the test runs.
#
# Env knobs:
#   E2E_REPO                  GitHub repo (default: groktopus/proprio)
#   E2E_UPDATE_BASE_REF       ref to install first (required; e.g. test/e2e-update-base)
#   E2E_UPDATE_NEXT_REF       ref to update to (required; BASE + one probe migration)
#   E2E_BOOTSTRAP_CLI         path to an already-built bootstrap CLI entry point
#                             (dist/index.js); when unset, builds one from BASE
#   E2E_BOOTSTRAP_NODE_LOADER optional Node loader for a workspace source entry point
#   E2E_SERVICE_TIMEOUT_SECS  service active/health wait (default 300)
#   E2E_UPDATE_REQUIRE_PROBE  0 for an exact-commit lifecycle check without a probe migration
#   E2E_UPDATE_REQUIRE_ACTIVE_RUN  1 to keep issue work active across update and require durable recovery
#   E2E_UPDATE_BROWSER_READBACK  1 to reload the same recovered task in Chromium
#   E2E_UPDATE_BROWSER_REPORT  optional output path for the browser readback report
#   E2E_UPDATE_USE_BOOTSTRAP_CLI  1 to run update commands with the exact tested CLI source
#   E2E_UPDATE_NEXT_REPO      GitHub repository containing NEXT (default: E2E_REPO)
#   E2E_UPDATE_STEP_SUMMARY   optional path to GitHub Actions step summary
set -uo pipefail

E2E_REPO="${E2E_REPO:-groktopus/proprio}"
BASE_REF="${E2E_UPDATE_BASE_REF:?E2E_UPDATE_BASE_REF is required}"
NEXT_REF="${E2E_UPDATE_NEXT_REF:?E2E_UPDATE_NEXT_REF is required}"
E2E_SERVICE_TIMEOUT_SECS="${E2E_SERVICE_TIMEOUT_SECS:-300}"
probe="${E2E_UPDATE_REQUIRE_PROBE:-1}"
active_run_required="${E2E_UPDATE_REQUIRE_ACTIVE_RUN:-0}"
browser_readback="${E2E_UPDATE_BROWSER_READBACK:-0}"
use_bootstrap_cli="${E2E_UPDATE_USE_BOOTSTRAP_CLI:-0}"
NEXT_REPO="${E2E_UPDATE_NEXT_REPO:-$E2E_REPO}"
if [[ "$probe" != 0 && "$probe" != 1 ]]; then
  echo "E2E_UPDATE_REQUIRE_PROBE must be 0 or 1" >&2
  exit 2
fi
if [[ "$active_run_required" != 0 && "$active_run_required" != 1 ]]; then
  echo "E2E_UPDATE_REQUIRE_ACTIVE_RUN must be 0 or 1" >&2
  exit 2
fi
if [[ "$browser_readback" != 0 && "$browser_readback" != 1 ]]; then
  echo "E2E_UPDATE_BROWSER_READBACK must be 0 or 1" >&2
  exit 2
fi
if [[ "$active_run_required" = 1 && "$probe" != 0 ]]; then
  echo "The active-run fixture requires E2E_UPDATE_REQUIRE_PROBE=0" >&2
  exit 2
fi
if [[ "$browser_readback" = 1 && "$probe" != 0 ]]; then
  echo "The browser readback fixture requires E2E_UPDATE_REQUIRE_PROBE=0" >&2
  exit 2
fi
if [[ "$browser_readback" = 1 && -z "${E2E_UPDATE_BROWSER_REPORT:-}" ]]; then
  echo "E2E_UPDATE_BROWSER_READBACK=1 requires E2E_UPDATE_BROWSER_REPORT" >&2
  exit 2
fi
if [[ "$use_bootstrap_cli" != 0 && "$use_bootstrap_cli" != 1 ]]; then
  echo "E2E_UPDATE_USE_BOOTSTRAP_CLI must be 0 or 1" >&2
  exit 2
fi
if [[ "$use_bootstrap_cli" = 1 && ( -z "${E2E_BOOTSTRAP_CLI:-}" || -z "${E2E_BOOTSTRAP_NODE_LOADER:-}" ) ]]; then
  echo "E2E_UPDATE_USE_BOOTSTRAP_CLI=1 requires E2E_BOOTSTRAP_CLI and E2E_BOOTSTRAP_NODE_LOADER" >&2
  exit 2
fi
if [[ "$probe" = 0 && ( ! "$BASE_REF" =~ ^[0-9a-f]{40}$ || ! "$NEXT_REF" =~ ^[0-9a-f]{40}$ || "$BASE_REF" = "$NEXT_REF" ) ]]; then
  echo "The lifecycle check requires two distinct, full commit SHAs" >&2
  exit 2
fi

# Clean environment, then isolate ALL Proprio state (managed store, config,
# embedded Postgres, backups) under a dedicated home for this test.
for var in $(env | grep -o '^PROPRIO_[A-Z_]*' || true); do unset "$var"; done
unset NODE_ENV npm_config_prefix 2>/dev/null || true
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export CI="${CI:-1}"
export PROPRIO_HOME="$HOME/.proprio-e2e-update"

SHIM="$HOME/.local/bin/proprio"
STORE="$PROPRIO_HOME/cli"
BACKUP_DIR="$PROPRIO_HOME/instances/default/data/backups"
RESULTS=()
FAILED=0
LIFECYCLE_COMPLETED=0
MIGRATION_OUTCOME="not_applicable"
MIGRATION_RECOVERY_MS=""
MIGRATION_DATA_LOSS=""

note()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
pass()  { RESULTS+=("PASS  $1"); printf '\033[1;32mPASS\033[0m %s\n' "$1"; }
fail_() { RESULTS+=("FAIL  $1"); printf '\033[1;31mFAIL\033[0m %s\n' "$1"; FAILED=1; }

shim() { "$SHIM" "$@"; }
update_cli() {
  if [ "$use_bootstrap_cli" = 1 ]; then
    local executable="$STORE/current/node_modules/proprio/dist/index.js"
    E2E_MANAGED_EXECUTABLE="$executable" \
      node --import "$E2E_BOOTSTRAP_NODE_LOADER" "$PWD/scripts/ci/managed-update-command.mjs" "$@"
  else
    shim "$@"
  fi
}
current_target() { readlink "$STORE/current" 2>/dev/null || echo "<missing>"; }
backup_count() { ls "$BACKUP_DIR" 2>/dev/null | grep -c -E '\.sql(\.gz)?$'; }
newest_backup() { ls -t "$BACKUP_DIR"/*.sql* 2>/dev/null | head -1; }
dump_text() { case "$1" in *.gz) gunzip -c "$1" ;; *) cat "$1" ;; esac; }
first_run_count() { shim service logs -n 2000 2>/dev/null | grep -c "first-run embedded PostgreSQL" || true; }

wait_active() {
  local expected_commit="${1:-}"
  local deadline=$(( $(date +%s) + E2E_SERVICE_TIMEOUT_SECS )) status_json=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status_json="$(shim service status --json 2>/dev/null || true)"
    if [ -n "$expected_commit" ]; then
      if jq -e --arg sha "$expected_commit" '.active and .health.ok and .health.commit == $sha' \
          <<<"$status_json" >/dev/null 2>&1; then return 0; fi
    elif echo "$status_json" | grep -q '"active"[[:space:]]*:[[:space:]]*true'; then
      return 0
    fi
    sleep 5
  done
  echo "last status: ${status_json:-<none>}"
  shim service logs -n 80 || true
  return 1
}

cleanup() {
  shim service stop >/dev/null 2>&1 || true
  shim service uninstall >/dev/null 2>&1 || true
  shim uninstall >/dev/null 2>&1 || true
}
record_summary() {
  if [ -n "${E2E_UPDATE_STEP_SUMMARY:-}" ]; then
    {
      printf '\nManaged service qualification for `%s` → `%s`.\n\n' "$BASE_REF" "$NEXT_REF"
      printf -- '- %s\n' "${RESULTS[@]}"
    } >> "$E2E_UPDATE_STEP_SUMMARY"
  fi
  if [ -n "${E2E_UPDATE_RESULT_FILE:-}" ]; then
    mkdir -p "$(dirname "$E2E_UPDATE_RESULT_FILE")"
    local complete_outcome="failed"
    [ "$LIFECYCLE_COMPLETED" = 1 ] && complete_outcome="passed"
    local migration_elapsed="null" migration_loss="null"
    [ -n "$MIGRATION_RECOVERY_MS" ] && migration_elapsed="$MIGRATION_RECOVERY_MS"
    [ -n "$MIGRATION_DATA_LOSS" ] && migration_loss="$MIGRATION_DATA_LOSS"
    jq -n \
      --arg sourceSha "$NEXT_REF" \
      --arg baseSha "$BASE_REF" \
      --arg managedOutcome "$complete_outcome" \
      --arg migrationOutcome "$MIGRATION_OUTCOME" \
      --argjson recoveryMs "$migration_elapsed" \
      --argjson dataLoss "$migration_loss" \
      '{sourceSha:$sourceSha,baseSha:$baseSha,cases:{"managed-update-rollback":{outcome:$managedOutcome},"migration-active-run-recovery":{outcome:$migrationOutcome,previousReleaseSha:$baseSha,schemaCandidateSha:$sourceSha,elapsedRecoveryMs:$recoveryMs,observedDataLoss:$dataLoss}}}' \
      > "$E2E_UPDATE_RESULT_FILE"
  fi
}

note "0. Preflight"
uname -a
node --version && npm --version
command -v corepack >/dev/null || npm install -g corepack
[ -e "$SHIM" ] && { echo "shim already exists at $SHIM — refusing to run"; exit 2; }
[ -d "$PROPRIO_HOME" ] && { echo "$PROPRIO_HOME already exists — refusing to run"; exit 2; }
if [ "$(uname -s)" = "Linux" ] && [ ! -S "/run/user/$(id -u)/bus" ]; then
  echo "no systemd user bus at /run/user/$(id -u)/bus — this test needs a real service"; exit 2
fi
echo "repo=$E2E_REPO base=$BASE_REF next=$NEXT_REPO@$NEXT_REF proprio_home=$PROPRIO_HOME"
trap 'record_summary; cleanup' EXIT
base_commit=""
next_commit=""
tracked_ref="$NEXT_REF"
if [ "$probe" = 0 ]; then
  command -v jq >/dev/null || exit 2
  base_commit="$BASE_REF"
  next_commit="$NEXT_REF"
  # A bare SHA pins installation. GitHub resolves SHA^0 to the exact same
  # immutable commit while the CLI follows its tracked-ref update path.
  tracked_ref="${NEXT_REF}^0"
fi

if [ -n "${E2E_BOOTSTRAP_CLI:-}" ] && [ -f "$E2E_BOOTSTRAP_CLI" ]; then
  BOOTSTRAP_CLI="$E2E_BOOTSTRAP_CLI"
  note "1. Bootstrap CLI reused: $BOOTSTRAP_CLI"
else
  note "1. Bootstrap: build the CLI from the GitHub tarball of $BASE_REF"
  BOOT="$HOME/e2e-upd-bootstrap"
  mkdir -p "$BOOT"
  curl --fail --silent --show-error --location \
      "https://codeload.github.com/$E2E_REPO/tar.gz/$BASE_REF" \
    | tar -xz --strip-components=1 -C "$BOOT" || { fail_ "1a bootstrap tarball"; exit 1; }
  ( cd "$BOOT" \
      && corepack pnpm install --frozen-lockfile > "$HOME/e2e-upd-bootstrap-install.log" 2>&1 \
      && PROPRIO_README_ASSET_REF="$BASE_REF" bash scripts/build-npm.sh --skip-checks --skip-typecheck > "$HOME/e2e-upd-bootstrap-build.log" 2>&1 ) \
    || { tail -40 "$HOME"/e2e-upd-bootstrap-*.log; fail_ "1b bootstrap build"; exit 1; }
  TARBALL="$(cd "$BOOT/cli" && npm pack --silent 2>/dev/null | tail -1)"
  mkdir -p "$HOME/e2e-upd-bootstrap-cli"
  ( cd "$HOME/e2e-upd-bootstrap-cli" && npm install --no-fund --no-audit "$BOOT/cli/$TARBALL" > "$HOME/e2e-upd-bootstrap-npm.log" 2>&1 ) \
    || { tail -40 "$HOME/e2e-upd-bootstrap-npm.log"; fail_ "1c bootstrap npm install"; exit 1; }
  BOOTSTRAP_CLI="$HOME/e2e-upd-bootstrap-cli/node_modules/proprio/dist/index.js"
fi
bootstrap() {
  local -a node_args=()
  if [ -n "${E2E_BOOTSTRAP_NODE_LOADER:-}" ]; then
    node_args+=(--import "$E2E_BOOTSTRAP_NODE_LOADER")
  fi
  node "${node_args[@]}" "$BOOTSTRAP_CLI" "$@"
}
if [ "$use_bootstrap_cli" = 1 ] && [ -z "${E2E_BOOTSTRAP_CLI:-}" ]; then
  echo "E2E_UPDATE_USE_BOOTSTRAP_CLI=1 requires E2E_BOOTSTRAP_CLI" >&2
  exit 2
fi


bootstrap --version >/dev/null || { fail_ "1d bootstrap CLI smoke"; exit 1; }
pass "1 bootstrap CLI ready"

note "2. install --ref $BASE_REF (the 'old version' the user installed a while ago)"
if bootstrap install --repo "$E2E_REPO" --ref "$BASE_REF" --yes; then
  pass "2a install base ref exits 0"
else
  fail_ "2a install base ref exits 0"; exit 1
fi
BASE_TARGET="$(current_target)"
case "$BASE_TARGET" in
  *"installs/git/"*) pass "2b current -> git payload ($(basename "$BASE_TARGET"))" ;;
  *) fail_ "2b current -> git payload (got: $BASE_TARGET)"; exit 1 ;;
esac

note "3. onboard + service start on the old version (initializes the database)"
if shim onboard --yes --install-service; then
  pass "3a onboard --yes --install-service exits 0"
else
  fail_ "3a onboard --yes --install-service exits 0"; exit 1
fi
if wait_active "$base_commit"; then
  pass "3b service active on base version"
else
  fail_ "3b service active on base version"; exit 1
fi
FIRST_RUN_BEFORE="$(first_run_count)"
PG_VERSION_FILE="$(find "$PROPRIO_HOME" -name PG_VERSION 2>/dev/null | head -1)"
PG_INODE_BEFORE="$([ -n "$PG_VERSION_FILE" ] && ls -i "$PG_VERSION_FILE" | awk '{print $1}')"
[ -n "$PG_VERSION_FILE" ] && pass "3c embedded Postgres cluster initialized" || fail_ "3c embedded Postgres cluster found"

if [ "$probe" = 1 ]; then
  note "4. baseline dump: probe table must NOT exist on the old schema"
  if shim db-backup >/dev/null 2>&1; then
    pass "4a db-backup on base version exits 0"
  else
    fail_ "4a db-backup on base version exits 0"
  fi
  BASELINE_DUMP="$(newest_backup)"
  if [ -n "$BASELINE_DUMP" ] && ! dump_text "$BASELINE_DUMP" | grep -q "e2e_update_probe"; then
    pass "4b baseline schema has no e2e_update_probe table"
  else
    fail_ "4b baseline schema has no e2e_update_probe table (dump: ${BASELINE_DUMP:-<none>})"
  fi
else
  note "4. Save one record through the running service"
  base_version="$(shim service status --json | jq -er '.health.serverVersion')" || exit 1
  port="$(jq -er '.server.port' "$PROPRIO_HOME/instances/default/config.json")" || exit 1
  origin="http://127.0.0.1:$port"
  fixture_name="Managed update acceptance fixture"
  company_json="$(curl --fail --silent --show-error --max-time 5 "$origin/api/companies" \
    -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data '{"name":"Managed update acceptance fixture"}')" || exit 1
  company_id="$(jq -er '.id' <<<"$company_json")" || exit 1
  company_issue_prefix="$(jq -er '.issuePrefix' <<<"$company_json")" || exit 1
  verify_record() {
    curl --fail --silent --show-error --max-time 5 "$origin/api/companies/$company_id" \
      | jq -e --arg id "$company_id" --arg name "$fixture_name" '.id == $id and .name == $name' >/dev/null
  }
  verify_record && pass "4a record is saved by the base service" || { fail_ "4a base record"; exit 1; }

  ACTIVE_EFFECT="$PROPRIO_HOME/migration-effect.txt"
  ACTIVE_SCRIPT="$PROPRIO_HOME/migration-active-agent.mjs"
  ACTIVE_TITLE="Retain active work during schema upgrade"
  ACTIVE_OUTPUT="Recovered task output: qualification effect completed exactly once."
  ACTIVE_MODE="complete"
  [ "$active_run_required" = 1 ] && ACTIVE_MODE="hold"
  cat > "$ACTIVE_SCRIPT" <<'NODE'
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const marker = process.argv[2];
const issueId = process.argv[3];
const origin = process.argv[4];
const output = process.argv[5];
const mode = process.argv[6];
const checkpoint = join(process.cwd(), "qualification-checkpoint.txt");
mkdirSync(process.cwd(), { recursive: true });
if (!existsSync(checkpoint)) writeFileSync(checkpoint, `checkpoint for ${issueId}\n`, { flag: "wx" });
let created = false;
try {
  const fd = openSync(marker, "wx");
  writeFileSync(fd, "effect\n");
  closeSync(fd);
  created = true;
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
if (created) process.stdout.write("qualification checkpoint saved; effect count 1\n");
if (created && mode === "hold") {
  setTimeout(() => process.exit(0), 600_000);
} else {
  const commentsUrl = `${origin}/api/issues/${issueId}/comments`;
  const headers = { Origin: origin, "Content-Type": "application/json" };
  const existing = await fetch(commentsUrl, { headers });
  if (!existing.ok) throw new Error(`Could not read task comments: ${existing.status}`);
  const comments = await existing.json();
  if (!comments.some(comment => comment.body === output)) {
    const saved = await fetch(commentsUrl, { method: "POST", headers, body: JSON.stringify({ body: output }) });
    if (!saved.ok) throw new Error(`Could not save recovered task output: ${saved.status} ${await saved.text()}`);
  }
  process.stdout.write("qualification output delivered from the retained workspace checkpoint\n");
}
NODE
  ACTIVE_ISSUE_RESPONSE="$(curl --silent --show-error --max-time 10 --write-out $'\n%{http_code}' "$origin/api/companies/$company_id/issues" \
    -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg title "$ACTIVE_TITLE" '{title:$title,description:"Qualification fixture for a supported schema upgrade.",status:"todo"}')")" \
    || { fail_ "4c recovered task creation request failed"; exit 1; }
  ACTIVE_ISSUE_STATUS="${ACTIVE_ISSUE_RESPONSE##*$'\n'}"
  ACTIVE_ISSUE_BODY="${ACTIVE_ISSUE_RESPONSE%$'\n'*}"
  if [[ ! "$ACTIVE_ISSUE_STATUS" =~ ^2[0-9][0-9]$ ]]; then
    SAFE_ISSUE_ERROR="$(jq -cn --arg status "$ACTIVE_ISSUE_STATUS" --arg body "$ACTIVE_ISSUE_BODY" '
      ($body | try fromjson catch {}) as $response |
      {status: (try ($status | tonumber) catch 0),
       error: (if ($response.error | type) == "string" then $response.error[0:200] else null end),
       details: (if ($response.details | type) == "array" then
         [$response.details[:5][] | {code: (.code // null), path: (.path // null), message: (if (.message | type) == "string" then .message[0:200] else null end)}]
         else [] end)}')"
    fail_ "4c recovered task creation returned HTTP $SAFE_ISSUE_ERROR"
    exit 1
  fi
  ACTIVE_ISSUE_JSON="$ACTIVE_ISSUE_BODY"
  ACTIVE_ISSUE_ID="$(jq -er '.id' <<<"$ACTIVE_ISSUE_JSON")" || exit 1
  ACTIVE_ISSUE_IDENTIFIER="$(jq -er '.identifier' <<<"$ACTIVE_ISSUE_JSON")" || exit 1
  ACTIVE_ISSUE_PREFIX="$company_issue_prefix"
  ACTIVE_AGENT_JSON="$(curl --fail --silent --show-error --max-time 10 "$origin/api/companies/$company_id/agents" \
    -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg command "$(command -v node)" --arg script "$ACTIVE_SCRIPT" --arg effect "$ACTIVE_EFFECT" --arg issue "$ACTIVE_ISSUE_ID" --arg origin "$origin" --arg output "$ACTIVE_OUTPUT" --arg mode "$ACTIVE_MODE" '{name:"Schema upgrade worker",role:"engineer",adapterType:"process",adapterConfig:{command:$command,args:[$script,$effect,$issue,$origin,$output,$mode],graceSec:1},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true}}}')")" \
    || { fail_ "4d recovery worker creation"; exit 1; }
  ACTIVE_AGENT_ID="$(jq -er '.id' <<<"$ACTIVE_AGENT_JSON")" || exit 1
  curl --fail --silent --show-error --max-time 10 --request PATCH "$origin/api/issues/$ACTIVE_ISSUE_ID" \
    -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg agent "$ACTIVE_AGENT_ID" '{assigneeAgentId:$agent}')" >/dev/null \
    || { fail_ "4e recovery worker assignment"; exit 1; }
  active_deadline=$(( $(date +%s) + 90 ))
  ACTIVE_RUN_BEFORE=""
  ACTIVE_RUN_ID=""
  while [ "$(date +%s)" -lt "$active_deadline" ]; do
    ACTIVE_RUNS_BEFORE="$(curl --fail --silent --show-error --max-time 5 "$origin/api/issues/$ACTIVE_ISSUE_ID/runs" 2>/dev/null || true)"
    ACTIVE_RUN_ID="$(jq -er '[.[] | select(.status == "running" or .status == "succeeded")][0].id // empty' <<<"$ACTIVE_RUNS_BEFORE" 2>/dev/null || true)"
    if [ -n "$ACTIVE_RUN_ID" ]; then
      ACTIVE_RUN_BEFORE="$(curl --fail --silent --show-error --max-time 5 "$origin/api/heartbeat-runs/$ACTIVE_RUN_ID" 2>/dev/null || true)"
      if [ -f "$ACTIVE_EFFECT" ] && { [ "$active_run_required" = 0 ] && jq -e '.status == "succeeded"' <<<"$ACTIVE_RUN_BEFORE" >/dev/null 2>&1 || [ "$active_run_required" = 1 ] && jq -e '.status == "running"' <<<"$ACTIVE_RUN_BEFORE" >/dev/null 2>&1; }; then break; fi
    fi
    sleep 1
  done
  [ -n "$ACTIVE_RUN_ID" ] || { fail_ "4f recovered task assignment starts a durable run"; exit 1; }
  ACTIVE_WORKSPACE_ID="$(jq -er '.executionWorkspaceId // .execution.executionWorkspaceId' <<<"$ACTIVE_RUN_BEFORE")" \
    || { fail_ "4g task run has a persistent workspace"; exit 1; }
  ACTIVE_WORKSPACE_BEFORE="$(curl --fail --silent --show-error --max-time 5 "$origin/api/execution-workspaces/$ACTIVE_WORKSPACE_ID")" \
    || { fail_ "4g task workspace is readable"; exit 1; }
  ACTIVE_WORKSPACE_CWD="$(jq -er '.cwd' <<<"$ACTIVE_WORKSPACE_BEFORE")" || { fail_ "4g workspace path exists"; exit 1; }
  ACTIVE_CHECKPOINT="$ACTIVE_WORKSPACE_CWD/qualification-checkpoint.txt"
  [ -f "$ACTIVE_CHECKPOINT" ] && [ "$(cat "$ACTIVE_CHECKPOINT")" = "checkpoint for $ACTIVE_ISSUE_ID" ] \
    && [ -f "$ACTIVE_EFFECT" ] && [ "$(cat "$ACTIVE_EFFECT")" = "effect" ] \
    && pass "4g task run saved one effect and a workspace checkpoint" \
    || { fail_ "4g task run checkpoint and effect"; exit 1; }
  if [ "$active_run_required" = 1 ]; then
    RECOVERY_STARTED_MS="$(( $(date +%s%3N) ))"
    pass "4h schema-upgrade run is active before candidate migration ($ACTIVE_RUN_ID)"
  fi
fi
BACKUPS_BEFORE="$(backup_count)"

note "5. simulate time passing: tracked ref now points at $NEXT_REF"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.ref = process.argv[2];
  m.repo = process.argv[3];
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
' "$STORE/install.json" "$tracked_ref" "$NEXT_REPO" && pass "5a tracked ref updated in install.json" || fail_ "5a tracked ref update"

CHECK_JSON="$(update_cli update --check --json)"; CHECK_EXIT=$?
printf '%s\n' "$CHECK_JSON"
if [ "$use_bootstrap_cli" = 1 ] && ! jq -e '.mode == "managed"' <<<"$CHECK_JSON" >/dev/null; then
  fail_ "5b exact candidate updater recognizes the installed managed executable"
  exit 1
fi
if [ "$CHECK_EXIT" -ne 10 ]; then
  fail_ "5b update --check sees the new commit (got exit $CHECK_EXIT)"
  exit 1
fi
if [ "$probe" = 0 ] && ! jq -e --arg sha "$next_commit" '.targetSha == $sha' <<<"$CHECK_JSON" >/dev/null; then
  fail_ "5b tracked reference did not resolve to the tested commit"
  exit 1
fi
pass "5b update --check sees the new commit (exit 10)"

note "6. update --yes (backup -> build new payload -> flip -> restart service)"
if update_cli update --yes > "$HOME/e2e-upd-update.log" 2>&1; then
  pass "6a update --yes exits 0"
else
  tail -40 "$HOME/e2e-upd-update.log"; fail_ "6a update --yes exits 0"; exit 1
fi
tail -5 "$HOME/e2e-upd-update.log"
BACKUPS_AFTER="$(backup_count)"
if [ "$BACKUPS_AFTER" -gt "$BACKUPS_BEFORE" ]; then
  pass "6b pre-update database backup was written ($BACKUPS_BEFORE -> $BACKUPS_AFTER)"
else
  fail_ "6b pre-update database backup was written ($BACKUPS_BEFORE -> $BACKUPS_AFTER)"
fi
NEXT_TARGET="$(current_target)"
if [ "$NEXT_TARGET" != "$BASE_TARGET" ] && [ "${NEXT_TARGET#*installs/git/}" != "$NEXT_TARGET" ]; then
  pass "6c payload flipped to new git payload ($(basename "$NEXT_TARGET"))"
else
  fail_ "6c payload flipped (before: $BASE_TARGET after: $NEXT_TARGET)"
fi

note "7. service healthy on the new version, with the migration applied"
if wait_active "$next_commit"; then
  pass "7a service active after update"
else
  fail_ "7a service active after update"; exit 1
fi
if [ "$probe" = 1 ]; then
  if shim service logs -n 2000 2>/dev/null | grep -q "e2e_update_probe"; then
    pass "7b service logs mention applying the probe migration"
  else
    fail_ "7b service logs mention applying the probe migration"
  fi
  if shim db-backup >/dev/null 2>&1; then
    pass "7c db-backup on new version exits 0"
  else
    fail_ "7c db-backup on new version exits 0"
  fi
  POST_DUMP="$(newest_backup)"
  if [ -n "$POST_DUMP" ] && dump_text "$POST_DUMP" | grep -q "e2e_update_probe"; then
    pass "7d probe migration table exists in the real database after update"
  else
    fail_ "7d probe migration table exists in the real database (dump: ${POST_DUMP:-<none>})"
  fi

else
  installed_commit="$(jq -er '.sha' "$STORE/install.json")" || exit 1
  [ "$installed_commit" = "$next_commit" ] && pass "7b install manifest matches the running candidate" \
    || { fail_ "7b candidate manifest"; exit 1; }
  verify_record && pass "7c candidate reads the saved base record" || { fail_ "7c candidate record continuity"; exit 1; }
  recovery_deadline=$(( $(date +%s) + 180 ))
  ACTIVE_RUNS_AFTER=""
  ACTIVE_LIVE_AFTER=""
  ACTIVE_COMMENTS_AFTER=""
  recovered=0
  while [ "$(date +%s)" -lt "$recovery_deadline" ]; do
    ACTIVE_RUNS_AFTER="$(curl --fail --silent --show-error --max-time 5 "$origin/api/issues/$ACTIVE_ISSUE_ID/runs" 2>/dev/null || true)"
    ACTIVE_LIVE_AFTER="$(curl --fail --silent --show-error --max-time 5 "$origin/api/issues/$ACTIVE_ISSUE_ID/live-runs" 2>/dev/null || true)"
    ACTIVE_COMMENTS_AFTER="$(curl --fail --silent --show-error --max-time 5 "$origin/api/issues/$ACTIVE_ISSUE_ID/comments" 2>/dev/null || true)"
    if jq -e 'length == 0' <<<"$ACTIVE_LIVE_AFTER" >/dev/null 2>&1 \
      && jq -e 'length > 0 and all(.[]; .status == "succeeded" or .status == "failed" or .status == "cancelled" or .status == "timed_out" or .status == "interrupted") and ([.[] | select(.status == "succeeded")] | length == 1)' <<<"$ACTIVE_RUNS_AFTER" >/dev/null 2>&1 \
      && jq -e --arg body "$ACTIVE_OUTPUT" '[.[] | select(.body == $body)] | length == 1' <<<"$ACTIVE_COMMENTS_AFTER" >/dev/null 2>&1; then
      recovered=1
      break
    fi
    sleep 1
  done
  [ "$recovered" = 1 ] || { fail_ "7d recovered task reaches one successful outcome and one visible output before timeout"; exit 1; }
  ACTIVE_ISSUE_AFTER="$(curl --fail --silent --show-error --max-time 5 "$origin/api/issues/$ACTIVE_ISSUE_ID")" \
    || { fail_ "7d recovered task read after update"; exit 1; }
  ACTIVE_WORKSPACE_AFTER="$(curl --fail --silent --show-error --max-time 5 "$origin/api/execution-workspaces/$ACTIVE_WORKSPACE_ID")" \
    || { fail_ "7d execution workspace read after update"; exit 1; }
  ACTIVE_ORIGINAL_RUN_AFTER="$(curl --fail --silent --show-error --max-time 5 "$origin/api/heartbeat-runs/$ACTIVE_RUN_ID")" \
    || { fail_ "7d original run identity remains readable"; exit 1; }
  jq -e --arg id "$ACTIVE_ISSUE_ID" --arg workspace "$ACTIVE_WORKSPACE_ID" '.id == $id and .executionWorkspaceId == $workspace' <<<"$ACTIVE_ISSUE_AFTER" >/dev/null \
    || { fail_ "7d task retains its execution workspace"; exit 1; }
  jq -e --arg id "$ACTIVE_WORKSPACE_ID" --arg cwd "$ACTIVE_WORKSPACE_CWD" '.id == $id and .cwd == $cwd' <<<"$ACTIVE_WORKSPACE_AFTER" >/dev/null \
    || { fail_ "7d execution workspace identity and path are retained"; exit 1; }
  jq -e --arg id "$ACTIVE_RUN_ID" '.id == $id and (.status == "succeeded" or .status == "interrupted")' <<<"$ACTIVE_ORIGINAL_RUN_AFTER" >/dev/null \
    || { fail_ "7d original run reached an allowed terminal recovery state"; exit 1; }
  [ -f "$ACTIVE_CHECKPOINT" ] && [ "$(cat "$ACTIVE_CHECKPOINT")" = "checkpoint for $ACTIVE_ISSUE_ID" ] \
    || { fail_ "7e workspace checkpoint survives update"; exit 1; }
  [ -f "$ACTIVE_EFFECT" ] && [ "$(cat "$ACTIVE_EFFECT")" = "effect" ] \
    || { fail_ "7e durable effect count remains exactly one"; exit 1; }
  if [ "$browser_readback" = 1 ]; then
    E2E_UPDATE_BROWSER_REPORT="$E2E_UPDATE_BROWSER_REPORT" node scripts/ci/browser-task-readback.mjs \
      "$origin" "$ACTIVE_ISSUE_PREFIX" "$ACTIVE_ISSUE_IDENTIFIER" "$ACTIVE_TITLE" "$ACTIVE_OUTPUT" \
      || { fail_ "7f browser reload reads the recovered task output"; exit 1; }
    pass "7f browser reload reads the recovered task output"
  fi
  if [ "$active_run_required" = 1 ]; then
    MIGRATION_RECOVERY_MS="$(( $(date +%s%3N) - RECOVERY_STARTED_MS ))"
    MIGRATION_OUTCOME="passed"
    MIGRATION_DATA_LOSS=0
    pass "7g active task recovered through migration with original run and workspace retained (${MIGRATION_RECOVERY_MS}ms; data loss 0)"
  fi
fi

note "8. data continuity: same database cluster, not re-initialized"
FIRST_RUN_AFTER="$(first_run_count)"
if [ "$FIRST_RUN_AFTER" = "$FIRST_RUN_BEFORE" ]; then
  pass "8a no new first-run database initialization after update ($FIRST_RUN_BEFORE -> $FIRST_RUN_AFTER)"
else
  fail_ "8a no new first-run database initialization ($FIRST_RUN_BEFORE -> $FIRST_RUN_AFTER)"
fi
PG_INODE_AFTER="$([ -n "$PG_VERSION_FILE" ] && ls -i "$PG_VERSION_FILE" 2>/dev/null | awk '{print $1}')"
if [ -n "$PG_INODE_BEFORE" ] && [ "$PG_INODE_AFTER" = "$PG_INODE_BEFORE" ]; then
  pass "8b embedded Postgres cluster reused (same PG_VERSION inode)"
else
  fail_ "8b embedded Postgres cluster reused (inode $PG_INODE_BEFORE -> ${PG_INODE_AFTER:-<gone>})"
fi

note "9. rollback: old payload must still boot against the migrated database"
if update_cli update --rollback; then
  pass "9a update --rollback exits 0"
else
  fail_ "9a update --rollback exits 0"
fi
case "$(current_target)" in
  "$BASE_TARGET") pass "9b rollback restored the base payload" ;;
  *) fail_ "9b rollback restored the base payload (got: $(current_target))" ;;
esac
if wait_active "$base_commit"; then
  pass "9c rolled-back service is active against the retained database"
else
  fail_ "9c rolled-back service is active against the retained database"
fi
if [ "$probe" = 0 ]; then
  rollback_version="$(shim service status --json | jq -er '.health.serverVersion')" || exit 1
  [ "$rollback_version" = "$base_version" ] && pass "9d rollback reports the original version and commit" \
    || fail_ "9d rollback version or commit"
  verify_record && pass "9e original service reads the same saved record after rollback"     || fail_ "9e rollback record continuity"
fi

note "10. cleanup"
shim service stop >/dev/null 2>&1 || true
if shim service uninstall && shim uninstall; then
  pass "10a service uninstall + uninstall exit 0"
else
  fail_ "10a service uninstall + uninstall exit 0"
fi
note "RESULTS ($E2E_REPO $BASE_REF -> $NEXT_REF on $(uname -sm))"
printf '%s\n' "${RESULTS[@]}"
if [ "$FAILED" = "1" ]; then echo; echo "OVERALL: FAIL"; exit 1; fi
LIFECYCLE_COMPLETED=1
trap - EXIT
record_summary
echo; echo "OVERALL: PASS"
