#!/bin/zsh
# Read-only production smoke test. It must not enqueue jobs or mutate state.
set -euo pipefail

API_BASE="${TRADING_MAX_API_BASE:-http://127.0.0.1:8421}"
WEB_BASE="${TRADING_MAX_WEB_BASE:-http://127.0.0.1:3413}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

fetch_json() {
  curl --fail --silent --show-error --max-time 15 "$1"
}

health="$(fetch_json "$API_BASE/health")"
printf '%s' "$health" | /usr/bin/python3 -c '
import json, sys
payload = json.load(sys.stdin)
if payload.get("status") != "ok" or not payload.get("latestRunId"):
    raise SystemExit(f"health is not ready: {payload}")
'

ready="$(fetch_json "$API_BASE/ready")"
printf '%s' "$ready" | /usr/bin/python3 -c '
import json, sys
payload = json.load(sys.stdin)
if payload.get("status") != "ready":
    raise SystemExit(f"readiness failed: {payload}")
'

# These endpoints are intentionally GET-only. A deploy must prove that the
# browser-facing data contract still serves the last successful snapshot.
fetch_json "$API_BASE/v1/dashboard" >/dev/null
fetch_json "$API_BASE/v1/research/status" >/dev/null
snapshot="$(fetch_json "$API_BASE/v1/snapshots/latest")"
printf '%s' "$snapshot" | /usr/bin/python3 -c '
import json, sys
payload = json.load(sys.stdin)
if not payload.get("runId") or not payload.get("artifacts"):
    raise SystemExit(f"snapshot contract is incomplete: {payload}")
'
curl --fail --silent --show-error --max-time 15 "$WEB_BASE/" >/dev/null
printf '%s\n' "Trading Max read-only production smoke passed"
