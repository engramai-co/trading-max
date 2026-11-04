"""Join each holding to its change since the London trading day's first observation."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from .values import JsonObject, nullable_number

DayChange = tuple[float, float | None]


def _moment(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def holding_day_changes(
    attribution: Any,
    accounts: Mapping[str, JsonObject],
) -> dict[tuple[str, str], DayChange]:
    """Map (account, ticker) to the day's GBP change and its share of the opening value.

    The day attribution (account/attribution/day.json) counts only when it measured
    the same broker observation that the holdings show. A missing, stale or
    unreconciled account leaves its positions without a day change instead of
    pairing current values with an older change. Positions opened during the day
    have no opening and stay absent; attributions written before the opening value
    existed give the GBP change without a percentage.
    """

    if not isinstance(attribution, Mapping):
        return {}
    measured = attribution.get("accounts")
    if not isinstance(measured, Mapping):
        return {}
    changes: dict[tuple[str, str], DayChange] = {}
    for code, account in accounts.items():
        entry = measured.get(code)
        if not isinstance(entry, Mapping):
            continue
        observed = _moment(account.get("fetched_at") or account.get("fetched_at_utc"))
        if observed is None or _moment(entry.get("as_of")) != observed:
            continue
        totals: dict[str, tuple[float, float | None]] = {}
        for row in entry.get("contributions") or []:
            if not isinstance(row, Mapping):
                continue
            ticker = str(row.get("ticker") or "")
            amount = nullable_number(row.get("contribution_gbp"))
            if not ticker or amount is None:
                continue
            opening = nullable_number(row.get("opening_value_gbp"))
            total, base = totals.get(ticker, (0.0, 0.0))
            totals[ticker] = (
                total + amount,
                None if base is None or opening is None else base + opening,
            )
        for ticker, (amount, opening) in totals.items():
            changes[(str(code), ticker)] = (
                round(amount, 2),
                amount / opening if opening else None,
            )
    return changes


__all__ = ["DayChange", "holding_day_changes"]
