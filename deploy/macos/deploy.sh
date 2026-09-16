#!/bin/zsh
# Upgrade an already-provisioned host from an exact protected-main commit.
set -euo pipefail
SERVICE_ROOT="${TRADING_MAX_SERVICE_ROOT:-$HOME/Services/trading-max}"
APP_ROOT="${TRADING_MAX_APP_ROOT:-$SERVICE_ROOT/app}"
STATE_ROOT="${TRADING_MAX_STATE_ROOT:-$HOME/Library/Application Support/Trading Max}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "deployment target must be a full lowercase 40-character commit SHA" >&2
  exit 64
fi
TARGET_REF="$1"
log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$1"; }
cd "$APP_ROOT"
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "tracked changes exist in the production checkout; refusing deployment"
  exit 66
fi
PREVIOUS_SHA="$(git rev-parse HEAD)"
log "fetching protected origin/main"
git fetch --prune origin \
  "+refs/heads/main:refs/remotes/origin/main"

if ! RESOLVED_REF="$(git rev-parse --verify --quiet "${TARGET_REF}^{commit}")"; then
  log "unknown revision '$TARGET_REF'; leaving $PREVIOUS_SHA deployed"
  exit 65
fi

MAIN_REF="origin/main"
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

# Execute the controller from the verified target, including on the first
# upgrade from an older host. Its temporary source outlives app-pointer changes.
CONTROLLER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/trading-max-deploy.XXXXXXXX")"
trap 'rm -rf "$CONTROLLER_DIR"' EXIT
git show "$RESOLVED_REF:deploy/macos/release-manager.py" > "$CONTROLLER_DIR/release-manager.py"
chmod 600 "$CONTROLLER_DIR/release-manager.py"
TRADING_MAX_SERVICE_ROOT="$SERVICE_ROOT" \
  TRADING_MAX_APP_ROOT="$APP_ROOT" \
  TRADING_MAX_STATE_ROOT="$STATE_ROOT" \
  "$APP_ROOT/.venv/bin/python" "$CONTROLLER_DIR/release-manager.py" "$RESOLVED_REF"
