"""Day changes from the day and 5D attributions.

Each holding joins its account's change since that account's first observation of
the London trading day, and an attribution keeps only the accounts measured
within its own trading days.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from trading_max.analytics.day_attribution import trading_day

from .values import JsonObject, nullable_number


@dataclass(frozen=True)
class DayChange:
    """A holding's change since the day's first observation and the trading day it covers."""

    gbp: float
    share: float | None
    date: str


@dataclass(frozen=True)
class _Contribution:
    ticker: str
    instrument: str | None
    amount: float
    opening: float | None


def _moment(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


def _measured_within(entry: Mapping[str, Any], first: str, last: str) -> bool:
    """Whether an account opened and was last observed, in that order, within the
    trading days first to last (ISO dates)."""

    since = _moment(entry.get("since"))
    as_of = _moment(entry.get("as_of"))
    if since is None or as_of is None or since > as_of:
        return False
    return first <= trading_day(since).isoformat() and trading_day(as_of).isoformat() <= last


def within_trading_days(attribution: Any) -> Any:
    """A day or 5D attribution with only the accounts measured within its own
    trading days: the day itself, or start_day to day for the 5D window.

    Attributions written before openings were kept per account can measure an
    account from an earlier trading day's observation, for example Friday's under
    Monday. Such an account is left out, so a consumer shows nothing for it rather
    than the gap between the days as the later day's change.
    """

    if not isinstance(attribution, Mapping):
        return attribution
    accounts = attribution.get("accounts")
    if not isinstance(accounts, Mapping):
        return attribution
    last = str(attribution.get("day") or "")
    first = str(attribution.get("start_day") or last)
    return {
        **attribution,
        "accounts": {
            code: entry
            for code, entry in accounts.items()
            if isinstance(entry, Mapping) and _measured_within(entry, first, last)
        },
    }


def _contributions(entry: Mapping[str, Any]) -> list[_Contribution]:
    rows = []
    for row in entry.get("contributions") or []:
        if not isinstance(row, Mapping):
            continue
        ticker = str(row.get("ticker") or "")
        amount = nullable_number(row.get("contribution_gbp"))
        if not ticker or amount is None:
            continue
        rows.append(
            _Contribution(
                ticker=ticker,
                instrument=str(row.get("instrument") or "") or None,
                amount=amount,
                opening=nullable_number(row.get("opening_value_gbp")),
            )
        )
    return rows


def _match(
    position: Mapping[str, Any],
    by_instrument: Mapping[str, list[_Contribution]],
    by_ticker: Mapping[str, list[_Contribution]],
    held: Counter[str],
) -> _Contribution | None:
    ticker = str(position.get("ticker") or "")
    broker = str(position.get("broker_ticker") or "") or None
    exact = by_instrument.get(broker or ticker, [])
    if exact:
        return exact[0] if len(exact) == 1 else None
    # Older artifacts carry no instrument and some snapshots no broker listing:
    # the display ticker joins only when one position and one contribution share
    # it, and never across two known, different listings.
    candidates = by_ticker.get(ticker, [])
    if len(candidates) != 1 or held[ticker] != 1:
        return None
    candidate = candidates[0]
    if candidate.instrument and broker and candidate.instrument != broker:
        return None
    return candidate


def holding_day_changes(
    attribution: Any,
    accounts: Mapping[str, JsonObject],
) -> dict[str, list[DayChange | None]]:
    """Each account's positions, in order, with their change in GBP and as a share
    of the opening value of the shares held all day.

    The day attribution (account/attribution/day.json) counts for an account only
    when it measured the very broker observation that the holdings show, from an
    opening on the same trading day as that observation and the attribution. A
    missing, stale or unreconciled account, one still on an earlier trading day,
    or one opened on an earlier day leaves its positions without a change.
    Positions join on the broker instrument, so listings that share a display
    ticker keep their own change. Positions opened during the day have none;
    attributions written before the opening value existed give pounds only.
    """

    if not isinstance(attribution, Mapping):
        return {}
    measured = within_trading_days(attribution).get("accounts")
    if not isinstance(measured, Mapping):
        return {}
    day = str(attribution.get("day") or "")
    result: dict[str, list[DayChange | None]] = {}
    for code, account in accounts.items():
        entry = measured.get(code)
        observed = _moment(account.get("fetched_at") or account.get("fetched_at_utc"))
        if (
            not isinstance(entry, Mapping)
            or observed is None
            or _moment(entry.get("as_of")) != observed
        ):
            continue
        rows = _contributions(entry)
        by_instrument: defaultdict[str, list[_Contribution]] = defaultdict(list)
        by_ticker: defaultdict[str, list[_Contribution]] = defaultdict(list)
        for row in rows:
            if row.instrument:
                by_instrument[row.instrument].append(row)
            by_ticker[row.ticker].append(row)
        positions = list(account.get("positions") or [])
        held = Counter(
            str(position.get("ticker") or "")
            for position in positions
            if isinstance(position, Mapping)
        )
        changes: list[DayChange | None] = []
        for position in positions:
            row = (
                _match(position, by_instrument, by_ticker, held)
                if isinstance(position, Mapping)
                else None
            )
            changes.append(
                None
                if row is None
                else DayChange(
                    gbp=round(row.amount, 2),
                    share=row.amount / row.opening if row.opening else None,
                    date=day,
                )
            )
        result[str(code)] = changes
    return result


__all__ = ["DayChange", "holding_day_changes", "within_trading_days"]
