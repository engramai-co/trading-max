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

# Keep an older host configuration deployable after the filesystem fallback
# removal. The API remains loopback-only; the token is inherited from the API
# service's existing production credential when the web-specific alias is
# absent.
export PORTFOLIO_BACKEND_URL="${PORTFOLIO_BACKEND_URL:-http://127.0.0.1:8421}"
export PORTFOLIO_BACKEND_TOKEN="${PORTFOLIO_BACKEND_TOKEN:-${TRADING_MAX_API_TOKEN:-}}"

cd "$SERVICE_ROOT/app"
export HOSTNAME="127.0.0.1"
export PORT="3413"
exec /usr/bin/env node apps/web/.next/standalone/server.js
