#!/bin/zsh
# Apply the checked-in SQLite migrations to an external Trading Max state root.
# This is deliberately explicit: deployment can call it only after the
# release has been built and the operator has approved the cutover.
set -euo pipefail

SERVICE_ROOT="${TRADING_MAX_SERVICE_ROOT:-$HOME/Services/trading-max}"
APP_ROOT="$SERVICE_ROOT/app"
STATE_ROOT="${TRADING_MAX_STATE_ROOT:-$HOME/Library/Application Support/Trading Max}"
PYTHON="$APP_ROOT/.venv/bin/python"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TRADING_MAX_APP_ROOT="$APP_ROOT"
export TRADING_MAX_STATE_ROOT="$STATE_ROOT"
export PYTHONPATH="$APP_ROOT/backend/src:$APP_ROOT${PYTHONPATH:+:$PYTHONPATH}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Trading Max virtualenv is missing: $PYTHON" >&2
  exit 66
fi

"$PYTHON" -c '
import os
from pathlib import Path

from trading_max.infrastructure import SqliteDatabase

app_root = Path(os.environ["TRADING_MAX_APP_ROOT"])
state_root = Path(os.environ["TRADING_MAX_STATE_ROOT"])
database = SqliteDatabase(
    state_root / "trading_max.db",
    migrations_dir=app_root / "backend" / "migrations",
)
try:
    with database.read() as connection:
        rows = connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()
    print("trading_max migrations applied: " + ", ".join(row["version"] for row in rows))
finally:
    database.close()
'
