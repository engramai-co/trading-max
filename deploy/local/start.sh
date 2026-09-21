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
if [[ ! -f "$APP_ROOT/apps/web/.next/BUILD_ID" || ! -f "$APP_ROOT/apps/web/.next/standalone/server.js" ]]; then
  npm --prefix apps/web ci --no-audit --no-fund
  npm --prefix apps/web run build
fi
if [[ ! -f "$APP_ROOT/backend/src/trading_max/synthesis/_pi/node_modules/@earendil-works/pi-ai/package.json" ]]; then
  npm run llm:install
fi

mkdir -p "$STATE_ROOT/logs"
export TRADING_MAX_STATE_ROOT="$STATE_ROOT"
export HOSTNAME="127.0.0.1"
export PORT="3413"
# Separate process groups let shutdown reach component descendants as well as
# their immediate parents. This works with the Bash 3.2 shipped by macOS.
set -m
pids=()
names=(api worker web)
cleanup() {
  trap - EXIT
  trap '' TERM INT
  if [[ ${#pids[@]} -eq 0 ]]; then
    return
  fi
  for pid in "${pids[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

uv run python -m services.api.trading_max_api \
  >>"$STATE_ROOT/logs/api.log" 2>&1 &
pids+=("$!")
uv run python -m services.api.trading_max_api.worker_main \
  >>"$STATE_ROOT/logs/worker.log" 2>&1 &
pids+=("$!")
"$APP_ROOT/deploy/local/run-web.sh" >>"$STATE_ROOT/logs/web.log" 2>&1 &
pids+=("$!")

echo "Trading Max is starting at http://127.0.0.1:3413"
echo "logs: $STATE_ROOT/logs"
while true; do
  for index in "${!pids[@]}"; do
    if ! kill -0 "${pids[$index]}" 2>/dev/null; then
      if wait "${pids[$index]}"; then
        status=1
      else
        status=$?
      fi
      echo "Trading Max ${names[$index]} exited; stopping the other processes. See $STATE_ROOT/logs/${names[$index]}.log" >&2
      exit "$status"
    fi
  done
  sleep 1
done
