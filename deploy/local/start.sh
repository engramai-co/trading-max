#!/usr/bin/env bash
# Start the supported three-process local workstation shape.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$(uname -s)" == "Darwin" ]]; then
  DEFAULT_STATE_ROOT="$HOME/Library/Application Support/Trading Max"
else
  DEFAULT_STATE_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/trading-max"
fi
STATE_ROOT="${TRADING_MAX_STATE_ROOT:-$DEFAULT_STATE_ROOT}"
ENV_FILE="$STATE_ROOT/secrets/trading_max.env"

cd "$APP_ROOT"
if [[ ! -f "$ENV_FILE" ]]; then
  uv run --package trading-max-backend trading-max setup --state-root "$STATE_ROOT"
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ "${TRADING_MAX_DEPLOYMENT_MODE:-local_workstation}" != "local_workstation" ]]; then
  echo "deploy/local/start.sh only supports local_workstation mode" >&2
  exit 64
fi
if [[ ! -f "$APP_ROOT/apps/web/.next/BUILD_ID" ]]; then
  npm --prefix apps/web ci --no-audit --no-fund
  npm --prefix apps/web run build
fi

mkdir -p "$STATE_ROOT/logs"
export HOSTNAME="127.0.0.1"
export PORT="3413"
pids=()
cleanup() {
  trap - TERM INT EXIT
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

uv run python -m services.api.trading_max_api \
  >>"$STATE_ROOT/logs/api.log" 2>&1 &
pids+=("$!")
uv run python -m services.api.trading_max_api.worker_main \
  >>"$STATE_ROOT/logs/worker.log" 2>&1 &
pids+=("$!")
(cd apps/web && npm run start) >>"$STATE_ROOT/logs/web.log" 2>&1 &
pids+=("$!")

echo "Trading Max is running at http://127.0.0.1:3413"
echo "logs: $STATE_ROOT/logs"
wait
