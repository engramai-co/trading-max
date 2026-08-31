#!/bin/zsh
set -euo pipefail

SERVICE_ROOT="${TRADING_MAX_SERVICE_ROOT:-$HOME/Services/trading-max}"
STATE_ROOT="${TRADING_MAX_STATE_ROOT:-$HOME/Library/Application Support/Trading Max}"
ENV_FILE="$STATE_ROOT/secrets/trading_max.env"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# LaunchAgents inherit a 256 descriptor limit, which starves the market-data
# downloads that open many concurrent TLS sockets and SQLite caches.
ulimit -n 8192 2>/dev/null || true

cd "$SERVICE_ROOT/app"
export PYTHONPATH="$SERVICE_ROOT/app/backend/src:$SERVICE_ROOT/app${PYTHONPATH:+:$PYTHONPATH}"
# STATE_ROOT is the single production state boundary. Ignore a stale
# TRADING_MAX_DATA_ROOT alias left by a pre-platform host configuration.
export TRADING_MAX_DATA_ROOT="$STATE_ROOT"
exec "$SERVICE_ROOT/app/.venv/bin/python" -m services.api.trading_max_api
