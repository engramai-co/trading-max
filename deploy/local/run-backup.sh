#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_ROOT="${TRADING_MAX_STATE_ROOT:?TRADING_MAX_STATE_ROOT is required}"
BACKUP_ROOT="${TRADING_MAX_BACKUP_ROOT:?TRADING_MAX_BACKUP_ROOT is required}"

cd "$APP_ROOT"
exec "$APP_ROOT/.venv/bin/trading-max" backup \
  --state-root "$STATE_ROOT" \
  --destination "$BACKUP_ROOT" \
  --retain "${TRADING_MAX_BACKUP_RETAIN:-14}"
