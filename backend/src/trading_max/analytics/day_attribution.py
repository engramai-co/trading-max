"""Per-position contributions to the account change over the 1D and 5D windows.

The first observation of each London trading day becomes the baseline. Later
observations attribute each position's GBP change to the shares held through the
whole window. Shares bought or sold during the day, cash, FX on cash and timing
differences are deliberately left unattributed so that a consumer can show them as
the residual against the account's own period result.

The 5D window keeps the opening of each of the last five London trading days and
chains them: each segment from one opening to the next, and from the last opening
to now, attributes the shares held at both of its ends. Trades between days then
move into or out of the attribution at the next opening, and only trades within a
day stay unattributed.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from itertools import pairwise
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import Field

from trading_max.domain import DomainModel

LONDON = ZoneInfo("Europe/London")
CENT = Decimal("0.01")
WINDOW_DAYS = 5


class BaselinePosition(DomainModel):
    key: str
    ticker: str
    name: str
    quantity: Decimal
    value_gbp: Decimal


class AccountBaseline(DomainModel):
    captured_at: datetime
    positions: list[BaselinePosition] = Field(default_factory=list)


class DayBaseline(DomainModel):
    schema_version: int = 1
    day: date
    accounts: dict[str, AccountBaseline] = Field(default_factory=dict)


class PositionContribution(DomainModel):
    ticker: str
    name: str
    contribution_gbp: Decimal


class AccountDayAttribution(DomainModel):
    since: datetime
    as_of: datetime
    contributions: list[PositionContribution] = Field(default_factory=list)


class DayAttribution(DomainModel):
    schema_version: int = 1
    day: date
    accounts: dict[str, AccountDayAttribution] = Field(default_factory=dict)


class WindowBaselines(DomainModel):
    schema_version: int = 1
    days: list[DayBaseline] = Field(default_factory=list)


class WindowAttribution(DomainModel):
    schema_version: int = 1
    start_day: date
    day: date
    accounts: dict[str, AccountDayAttribution] = Field(default_factory=dict)


def trading_day(moment: datetime) -> date:
    """The London weekday a moment belongs to; weekends stay on Friday like the 1D chart."""

    day = moment.astimezone(LONDON).date()
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def window_days(day: date, count: int = WINDOW_DAYS) -> list[date]:
    """The last count London weekdays ending on day, oldest first, like the 5D chart."""

    days = [day]
    while len(days) < count:
        previous = days[-1] - timedelta(days=1)
        while previous.weekday() >= 5:
            previous -= timedelta(days=1)
        days.append(previous)
    return sorted(days)


def _timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _decimal(value: Any) -> Decimal | None:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return number if number.is_finite() else None


def _positions(account: Mapping[str, Any]) -> list[BaselinePosition] | None:
    """Reconciled position detail, or None when the observation has none."""

    rows = account.get("positions")
    if rows is None:
        return None
    positions = []
    for row in rows:
        quantity = _decimal(row.get("quantity"))
        value = _decimal(row.get("current_value_gbp"))
        ticker = str(row.get("ticker") or "")
        if quantity is None or value is None or not ticker:
            continue
        positions.append(
            BaselinePosition(
                key=str(row.get("broker_ticker") or ticker),
                ticker=ticker,
                name=str(row.get("name") or ticker),
                quantity=quantity,
                value_gbp=value,
            )
        )
    return positions


def _contributions(
    opening: list[BaselinePosition], current: list[BaselinePosition]
) -> list[PositionContribution]:
    now = {position.key: position for position in current}
    rows = []
    for start in opening:
        end = now.get(start.key)
        if end is None or start.quantity <= 0 or end.quantity <= 0:
            continue
        held = min(start.quantity, end.quantity)
        change = held * (end.value_gbp / end.quantity - start.value_gbp / start.quantity)
        rows.append(
            PositionContribution(
                ticker=end.ticker,
                name=end.name,
                contribution_gbp=change.quantize(CENT),
            )
        )
    rows.sort(key=lambda row: (-abs(row.contribution_gbp), row.ticker))
    return rows


def update_day_attribution(
    previous_baseline: Mapping[str, Any] | None,
    accounts: Mapping[str, Mapping[str, Any]],
) -> tuple[DayBaseline, DayAttribution]:
    """Carry or reset the day's baseline and attribute the change since it."""

    if not accounts:
        raise ValueError("day attribution needs at least one account observation")
    observed = {code: _timestamp(account["fetched_at"]) for code, account in accounts.items()}
    day = trading_day(max(observed.values()))
    baseline: DayBaseline | None = None
    if previous_baseline is not None:
        try:
            baseline = DayBaseline.model_validate(previous_baseline)
        except ValueError:
            baseline = None
    opening = dict(baseline.accounts) if baseline is not None and baseline.day == day else {}
    result: dict[str, AccountDayAttribution] = {}
    for code, account in accounts.items():
        current = _positions(account)
        if current is None:
            # Unreconciled position detail cannot open or extend the day.
            continue
        if code not in opening:
            opening[code] = AccountBaseline(captured_at=observed[code], positions=current)
        result[code] = AccountDayAttribution(
            since=opening[code].captured_at,
            as_of=observed[code],
            contributions=_contributions(opening[code].positions, current),
        )
    return DayBaseline(day=day, accounts=opening), DayAttribution(day=day, accounts=result)


def update_window_attribution(
    previous_window: Mapping[str, Any] | None,
    today: DayBaseline,
    accounts: Mapping[str, Mapping[str, Any]],
    *,
    history: Callable[[date], DayBaseline | None] | None = None,
) -> tuple[WindowBaselines, WindowAttribution]:
    """Chain the daily openings of the 5D window up to the current observation.

    The history callable may supply an opening the stored window lacks, for
    example from an earlier published snapshot when the window is first built.
    """

    days = window_days(today.day)
    stored: dict[date, DayBaseline] = {}
    if previous_window is not None:
        try:
            for baseline in WindowBaselines.model_validate(previous_window).days:
                if baseline.day in days:
                    stored[baseline.day] = baseline
        except ValueError:
            stored = {}
    stored[today.day] = today
    if history is not None:
        for day in days:
            if day not in stored:
                found = history(day)
                if found is not None and found.day == day:
                    stored[day] = found
    openings = [stored[day] for day in days if day in stored]
    result: dict[str, AccountDayAttribution] = {}
    for code, account in accounts.items():
        current = _positions(account)
        if current is None:
            continue
        chain = [
            (baseline.accounts[code].captured_at, baseline.accounts[code].positions)
            for baseline in openings
            if code in baseline.accounts
        ]
        if not chain:
            continue
        points = [*chain, (_timestamp(account["fetched_at"]), current)]
        totals: dict[str, PositionContribution] = {}
        for (_, start), (_, end) in pairwise(points):
            for row in _contributions(start, end):
                entry = totals.get(row.ticker)
                totals[row.ticker] = (
                    row
                    if entry is None
                    else PositionContribution(
                        ticker=row.ticker,
                        name=row.name,
                        contribution_gbp=entry.contribution_gbp + row.contribution_gbp,
                    )
                )
        rows = sorted(totals.values(), key=lambda row: (-abs(row.contribution_gbp), row.ticker))
        result[code] = AccountDayAttribution(
            since=chain[0][0], as_of=points[-1][0], contributions=rows
        )
    return (
        WindowBaselines(days=openings),
        WindowAttribution(start_day=days[0], day=today.day, accounts=result),
    )


def baseline_from_accounts(
    day: date, accounts: Mapping[str, Mapping[str, Any]]
) -> DayBaseline | None:
    """An opening built from earlier account observations, one per account."""

    opening: dict[str, AccountBaseline] = {}
    for code, account in accounts.items():
        positions = _positions(account)
        if positions is not None:
            opening[code] = AccountBaseline(
                captured_at=_timestamp(account["fetched_at"]), positions=positions
            )
    return DayBaseline(day=day, accounts=opening) if opening else None


__all__ = [
    "AccountDayAttribution",
    "DayAttribution",
    "DayBaseline",
    "PositionContribution",
    "WindowAttribution",
    "WindowBaselines",
    "baseline_from_accounts",
    "trading_day",
    "update_day_attribution",
    "update_window_attribution",
    "window_days",
]
