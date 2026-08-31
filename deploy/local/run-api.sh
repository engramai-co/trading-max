#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_ROOT="${TRADING_MAX_STATE_ROOT:?TRADING_MAX_STATE_ROOT is required}"
ENV_FILE="$STATE_ROOT/secrets/trading_max.env"

cd "$APP_ROOT"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
exec "$APP_ROOT/.venv/bin/python" -m services.api.trading_max_api
