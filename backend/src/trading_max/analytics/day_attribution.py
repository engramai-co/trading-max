"""Per-position contributions to the account change since the trading day opened.

The first observation of each London trading day becomes the baseline. Later
observations attribute each position's GBP change to the shares held through the
whole window. Shares bought or sold during the day, cash, FX on cash and timing
differences are deliberately left unattributed so that a consumer can show them as
the residual against the account's own period result.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import Field

from trading_max.domain import DomainModel

LONDON = ZoneInfo("Europe/London")
CENT = Decimal("0.01")


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


def trading_day(moment: datetime) -> date:
    """The London weekday a moment belongs to; weekends stay on Friday like the 1D chart."""

    day = moment.astimezone(LONDON).date()
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


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


__all__ = [
    "AccountDayAttribution",
    "DayAttribution",
    "DayBaseline",
    "PositionContribution",
    "trading_day",
    "update_day_attribution",
]
