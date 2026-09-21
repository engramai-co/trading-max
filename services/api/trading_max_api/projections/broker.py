"""Reconcile fresh broker totals with the last canonical positions."""

from __future__ import annotations

from datetime import UTC, datetime
from math import isfinite

from .values import JsonObject, nullable_number


def _observed_at(account: JsonObject) -> datetime | None:
    raw = account.get("fetched_at") or account.get("fetched_at_utc")
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def _verified_live_positions(account: JsonObject) -> list[JsonObject] | None:
    """Return live positions only when the payload still reconciles locally."""

    checks = account.get("checks")
    positions = account.get("positions")
    if (
        account.get("positions_status") != "verified"
        or not isinstance(checks, dict)
        or checks.get("positions_match_investments") is not True
        or not isinstance(positions, list)
    ):
        return None

    investments = nullable_number(account.get("investments_value_gbp"))
    if investments is None or not isfinite(investments):
        return None
    normalized: list[JsonObject] = []
    position_value = 0.0
    for raw_position in positions:
        if not isinstance(raw_position, dict):
            return None
        current_value = nullable_number(raw_position.get("current_value_gbp"))
        if current_value is None or not isfinite(current_value):
            return None
        position_value += current_value
        normalized.append(raw_position)

    tolerance = nullable_number(account.get("position_tolerance_gbp"))
    if tolerance is None or not isfinite(tolerance) or tolerance < 0:
        tolerance = max(0.02, abs(investments) * 0.0005)
    if abs(position_value - investments) > tolerance + 1e-9:
        return None
    return normalized


def overlay_live_broker_snapshot(
    canonical: JsonObject,
    live: JsonObject | None,
) -> JsonObject:
    """Overlay fresh broker totals and reconciliation-safe live positions."""

    if not isinstance(live, dict):
        return canonical
    canonical_accounts = canonical.get("accounts")
    live_accounts = live.get("accounts")
    if not isinstance(canonical_accounts, dict) or not isinstance(live_accounts, dict):
        return canonical

    merged_accounts = dict(canonical_accounts)
    overlaid = False
    for code in ("A", "B"):
        raw_canonical = canonical_accounts.get(code)
        raw_live = live_accounts.get(code)
        if not isinstance(raw_canonical, dict) or not isinstance(raw_live, dict):
            continue
        canonical_time = _observed_at(raw_canonical)
        live_time = _observed_at(raw_live)
        if live_time is None or (canonical_time is not None and live_time < canonical_time):
            continue

        account = dict(raw_canonical)
        for key in (
            "profile",
            "fetched_at",
            "source",
            "total_value_gbp",
            "cash_gbp",
            "investments_value_gbp",
            "position_value_gbp",
            "position_delta_gbp",
            "position_tolerance_gbp",
            "positions_status",
            "checks",
        ):
            if key in raw_live:
                account[key] = raw_live[key]
        live_positions = _verified_live_positions(raw_live)
        if live_positions is not None:
            account["positions"] = live_positions
            # When live positions are absent or fail reconciliation, deliberately
            # leave the previous canonical verified positions in place.
        merged_accounts[code] = account
        overlaid = True

    if not overlaid:
        return canonical
    merged = {**canonical, "accounts": merged_accounts}
    if live.get("generated_at_utc"):
        merged["generated_at_utc"] = live["generated_at_utc"]
    return merged
