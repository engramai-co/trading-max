#!/bin/zsh
#
# Nightly backup for the irreplaceable Trading Max state.
#
# The published snapshots, watchlist, job history and broker-derived reports
# cannot be rebuilt from the upstream APIs, so they are archived to a local
# destination that can be mirrored off-host. Secrets are deliberately excluded:
# they live in the login Keychain and a 0600 env file and must not be copied
# into a general-purpose archive.
#
# Usage: backup.sh [destination-directory]
set -euo pipefail

SERVICE_ROOT="${TRADING_MAX_SERVICE_ROOT:-$HOME/Services/trading-max}"
STATE_ROOT="${TRADING_MAX_STATE_ROOT:-$HOME/Library/Application Support/Trading Max}"
DEFAULT_DESTINATION="$HOME/Backups/Trading Max"
RETAIN_ARCHIVES="${TRADING_MAX_BACKUP_RETAIN:-14}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DESTINATION="${1:-${TRADING_MAX_BACKUP_DIR:-$DEFAULT_DESTINATION}}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$DESTINATION/trading_max-$STAMP.tar.gz"

log() {
  printf '[backup %s] %s\n' "$(date -u +%H:%M:%S)" "$1"
}

mkdir -p "$DESTINATION"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/trading_max-backup.XXXXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
STATE_STAGE="$STAGING/state"
mkdir -p "$STATE_STAGE"

if [[ -d "$STATE_ROOT" ]]; then
  log "copying external state from $STATE_ROOT"
  if [[ -f "$STATE_ROOT/trading_max.db" ]]; then
    # Python's online backup API produces a consistent copy while API and
    # worker processes are live. Do not fall back to copying a live SQLite
    # file: a raw copy can omit WAL pages and produce an unrecoverable backup.
    BACKUP_PYTHON="$SERVICE_ROOT/app/.venv/bin/python"
    if [[ ! -x "$BACKUP_PYTHON" ]]; then
      log "backup virtualenv is missing: $BACKUP_PYTHON"
      exit 66
    fi
    "$BACKUP_PYTHON" - "$STATE_ROOT/trading_max.db" "$STATE_STAGE/trading_max.db" <<'PY'
import sqlite3
import sys

source, destination = sys.argv[1:]
with sqlite3.connect(source) as source_db, sqlite3.connect(destination) as destination_db:
    source_db.backup(destination_db)
PY
    tar -C "$STATE_ROOT" \
      --exclude='trading_max.db' \
      --exclude='trading_max.db-*' \
      --exclude='secrets' \
      --exclude='*.env' \
      --exclude='*.log' \
      -cf - . | tar -C "$STATE_STAGE" -xf -
  else
    tar -C "$STATE_ROOT" \
      --exclude='secrets' \
      --exclude='*.env' \
      --exclude='*.log' \
      -cf - . | tar -C "$STATE_STAGE" -xf -
  fi
else
  log "external state root does not exist yet; creating a metadata-only backup"
fi

log "archiving runtime state to $ARCHIVE"
tar -czf "$ARCHIVE" -C "$STAGING" state

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
log "archive complete ($SIZE)"

log "verifying archive integrity"
tar -tzf "$ARCHIVE" > /dev/null
"$SERVICE_ROOT/app/.venv/bin/python" \
  "$SERVICE_ROOT/app/tools/verify_backup_archive.py" "$ARCHIVE"
log "archive verified"

log "pruning archives older than the newest $RETAIN_ARCHIVES"
ls -1t "$DESTINATION"/trading_max-*.tar.gz 2>/dev/null \
  | tail -n +$(( RETAIN_ARCHIVES + 1 )) \
  | while read -r stale; do
      log "removing $stale"
      rm -f "$stale"
    done

log "backup finished"
