#!/bin/zsh
#
# Atomic-ish deployment for a pre-provisioned Trading Max macOS host.
#
# The script records the currently deployed commit, moves the working tree to
# the requested revision, rebuilds both services, and only keeps the new
# revision if the health gate passes. Any failure rolls the tree back to the
# previous commit and restores the previous build.
#
# Only an exact commit already reachable from the protected origin/main branch
# can be deployed. This keeps the product-side deploy primitive independent
# from any particular CI provider while preventing branch names, pull-request
# refs, and unreviewed commits from reaching the host.
#
# Usage: deploy.sh <40-character-main-commit-sha>
set -euo pipefail

SERVICE_ROOT="${TRADING_MAX_SERVICE_ROOT:-$HOME/Services/trading-max}"
APP_ROOT="${TRADING_MAX_APP_ROOT:-$SERVICE_ROOT/app}"
WEB_ROOT="$APP_ROOT/apps/web"
STATE_ROOT="${TRADING_MAX_STATE_ROOT:-$HOME/Library/Application Support/Trading Max}"
DEPLOY_BRANCH="${TRADING_MAX_DEPLOY_BRANCH:-main}"
API_HEALTH="http://127.0.0.1:8421/health"
WEB_HEALTH="http://127.0.0.1:3413/"
HEALTH_ATTEMPTS=30
HEALTH_DELAY=2

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ $# -lt 1 ]]; then
  echo "usage: deploy.sh <40-character-main-commit-sha>" >&2
  exit 64
fi

TARGET_REF="$1"
if [[ ! "$TARGET_REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "deployment target must be a full lowercase 40-character commit SHA" >&2
  exit 64
fi

log() {
  printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$1"
}

install_launch_agents() {
  local launch_agent_dir="$HOME/Library/LaunchAgents"
  mkdir -p "$launch_agent_dir"
  for service in api web worker backup; do
    local label="com.engram.trading-max-${service}"
    local source="$APP_ROOT/deploy/macos/${label}.plist"
    local destination="$launch_agent_dir/${label}.plist"
    if [[ ! -f "$source" ]]; then
      log "missing LaunchAgent template: $source"
      return 1
    fi
    sed "s#__TRADING_MAX_HOME__#${HOME}#g" "$source" > "$destination"
    chmod 600 "$destination"
  done
}

cd "$APP_ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "tracked changes exist in the production checkout; refusing deployment"
  exit 66
fi

PREVIOUS_SHA="$(git rev-parse HEAD)"
log "current revision $PREVIOUS_SHA"

restart_services() {
  local uid
  uid="$(id -u)"
  install_launch_agents
  for service in api web worker; do
    local label="com.engram.trading-max-${service}"
    local installed_plist="$HOME/Library/LaunchAgents/${label}.plist"
    if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$uid/$label"
    else
      launchctl bootstrap "gui/$uid" "$installed_plist"
    fi
  done
  local backup_label="com.engram.trading-max-backup"
  local backup_plist="$HOME/Library/LaunchAgents/${backup_label}.plist"
  if ! launchctl print "gui/$uid/$backup_label" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$uid" "$backup_plist"
  fi
}

wait_for_health() {
  local url="$1"
  local label="$2"
  local attempt=1
  local code=""
  while (( attempt <= HEALTH_ATTEMPTS )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
    if [[ "$code" == "200" ]]; then
      log "$label healthy after ${attempt} attempt(s)"
      return 0
    fi
    sleep "$HEALTH_DELAY"
    (( attempt += 1 ))
  done
  log "$label failed health check (last status ${code:-none})"
  return 1
}

probe_backend_contracts() {
  local endpoint
  local code
  local health_payload
  health_payload="$(curl -s --max-time 10 "$API_HEALTH" || true)"
  log "backend health payload: ${health_payload:-none}"
  for endpoint in "/health" "/v1/dashboard" "/v1/research/status"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      "${API_HEALTH%/health}${endpoint}" || true)"
    log "backend probe ${endpoint}: ${code:-none}"
  done
}

validate_external_state() {
  PYTHONPATH="$APP_ROOT/backend/src:$APP_ROOT" \
    "$APP_ROOT/.venv/bin/python" - "$STATE_ROOT" <<'PY'
import sys
from pathlib import Path

from trading_max.infrastructure import SnapshotStore

root = Path(sys.argv[1])
snapshot = SnapshotStore(root).latest()
if snapshot is None:
    raise SystemExit("no valid immutable snapshot is available")
print(
    "external state validated: "
    f"{snapshot.manifest.run_id} ({len(snapshot.manifest.artifacts)} artifacts)"
)
PY
}

wait_for_worker() {
  local worker_plist="$APP_ROOT/deploy/macos/com.engram.trading-max-worker.plist"
  if [[ ! -f "$worker_plist" ]]; then
    log "worker plist not present in release"
    return 1
  fi
  local uid
  uid="$(id -u)"
  local attempt=1
  while (( attempt <= HEALTH_ATTEMPTS )); do
    if launchctl print "gui/$uid/com.engram.trading-max-worker" 2>/dev/null \
      | grep -q "state = running" \
      && "$APP_ROOT/.venv/bin/python" -c \
        'import trading_max; import services.api.trading_max_api.worker_main'; then
      log "worker healthy after ${attempt} attempt(s)"
      return 0
    fi
    sleep "$HEALTH_DELAY"
    (( attempt += 1 ))
  done
  log "worker failed health check"
  return 1
}

build_release() {
  log "syncing python dependencies"
  uv sync --all-packages --frozen

  log "installing web dependencies"
  (cd "$WEB_ROOT" && npm ci --no-audit --no-fund)

  log "building web bundle"
  (cd "$WEB_ROOT" && npm run build)
}

rollback() {
  log "rolling back to $PREVIOUS_SHA"
  cd "$APP_ROOT"
  git checkout --force --detach "$PREVIOUS_SHA"
  if build_release && restart_services \
    && wait_for_health "$API_HEALTH" "api" \
    && wait_for_health "$WEB_HEALTH" "web" \
    && wait_for_worker; then
    log "rollback restored a healthy deployment"
  else
    log "ROLLBACK FAILED - the host needs manual attention"
  fi
}

log "fetching protected origin/${DEPLOY_BRANCH}"
git fetch --prune origin \
  "+refs/heads/${DEPLOY_BRANCH}:refs/remotes/origin/${DEPLOY_BRANCH}"

if ! RESOLVED_REF="$(git rev-parse --verify --quiet "${TARGET_REF}^{commit}")"; then
  log "unknown revision '$TARGET_REF'; leaving $PREVIOUS_SHA deployed"
  exit 65
fi

MAIN_REF="origin/${DEPLOY_BRANCH}"
if ! git rev-parse --verify --quiet "${MAIN_REF}^{commit}" >/dev/null; then
  log "missing trusted branch ${MAIN_REF}; leaving $PREVIOUS_SHA deployed"
  exit 65
fi
if ! git merge-base --is-ancestor "$RESOLVED_REF" "$MAIN_REF"; then
  log "$RESOLVED_REF is not reachable from ${MAIN_REF}; refusing deployment"
  exit 65
fi
log "verified $RESOLVED_REF is reachable from ${MAIN_REF}"

if [[ "${TRADING_MAX_DEPLOY_VALIDATE_ONLY:-false}" == "true" ]]; then
  log "validation-only deployment contract passed"
  exit 0
fi

backup_script="${RUNNER_TEMP:-/tmp}/trading-max-backup-${RESOLVED_REF}.sh"
git show "$RESOLVED_REF:deploy/macos/backup.sh" > "$backup_script"
chmod 700 "$backup_script"
TRADING_MAX_SERVICE_ROOT="$SERVICE_ROOT" \
  TRADING_MAX_STATE_ROOT="$STATE_ROOT" \
  "$backup_script"

log "checking out $TARGET_REF ($RESOLVED_REF)"
if ! git checkout --force --detach "$RESOLVED_REF"; then
  log "checkout failed; leaving $PREVIOUS_SHA deployed"
  exit 1
fi
NEW_SHA="$(git rev-parse HEAD)"
log "target revision $NEW_SHA"

if ! build_release; then
  log "build failed"
  rollback
  exit 1
fi

log "normalizing host bootstrap and credential references"
"$APP_ROOT/.venv/bin/python" "$APP_ROOT/deploy/macos/configure-host.py" \
  --defer-credential-migration

log "applying external-state migrations"
"$APP_ROOT/deploy/macos/migrate.sh"

if ! validate_external_state; then
  log "external state validation failed"
  rollback
  exit 1
fi

log "restarting services"
restart_services

if ! wait_for_health "$API_HEALTH" "api"; then
  rollback
  exit 1
fi

if ! wait_for_health "$WEB_HEALTH" "web"; then
  probe_backend_contracts
  rollback
  exit 1
fi

if ! wait_for_worker; then
  rollback
  exit 1
fi

log "running read-only production smoke"
if ! "$APP_ROOT/deploy/macos/production-smoke.sh"; then
  log "production smoke failed"
  rollback
  exit 1
fi

log "deployment of $NEW_SHA succeeded"
