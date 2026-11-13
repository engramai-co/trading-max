"""Forward P/E from vintages already captured by the research worker."""

from collections.abc import Iterable
from datetime import date
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime

from trading_max.domain import DomainModel

from .estimate_history import EstimateObservation
from .facts import number
from .trailing_pe import TrailingPeDistribution, pe_distribution

MINIMUM_FORWARD_SAMPLE = 30

type ForwardPeSource = Literal["yahoo-consensus", "yahoo-forward-pe"]


class ForwardPePoint(DomainModel):
    date: date
    observed_at: AwareDatetime
    price: float | None
    price_as_of: AwareDatetime | None
    eps: float | None
    pe: float | None
    source: ForwardPeSource | None
    recovered: bool


class ForwardPeHistory(DomainModel):
    currency: str
    points: list[ForwardPePoint]
    distribution: TrailingPeDistribution | None


def _weighted_eps(row: EstimateObservation, day: date) -> float | None:
    annual = {}
    for item in row.consensus:
        if item.period in {"0y", "+1y"}:
            if item.period in annual:
                return None
            annual[item.period] = item
    if annual.keys() != {"0y", "+1y"}:
        return None
    fy1, fy2 = (annual[slot] for slot in ("0y", "+1y"))
    if (
        fy1.currency != row.currency
        or fy2.currency != row.currency
        or not fy1.period_end
        or not fy2.period_end
    ):
        return None
    a, b = number(fy1.mean_eps), number(fy2.mean_eps)
    if a is None or b is None:
        return None
    fiscal_year = (fy2.period_end - fy1.period_end).days
    remaining = (fy1.period_end - day).days
    # Exclude stale 0y periods and non-adjacent fiscal years, including
    # transition stub years. Allow ordinary 52/53-week fiscal calendars.
    if not 350 <= fiscal_year <= 380 or not 0 <= remaining <= fiscal_year:
        return None
    weight = remaining / fiscal_year
    return number(a * weight + b * (1 - weight))


def _reading(row: EstimateObservation, day: date) -> ForwardPePoint:
    price = number(row.price)
    if price is None or price <= 0 or (row.price_as_of and row.price_as_of > row.observed_at):
        price = None
    eps = _weighted_eps(row, day)
    pe = None
    source: ForwardPeSource | None = None
    if eps is not None:
        source = "yahoo-consensus"
        if eps > 0 and price is not None:
            pe = number(price / eps)
    else:
        # This is Yahoo's reported ratio. Its forward horizon can differ
        # from our NTM estimate, and the raw forwardEps has no documented unit.
        vendor = number(row.forward_pe)
        if vendor is not None and vendor > 0:
            pe, eps, source = vendor, number(row.forward_eps), "yahoo-forward-pe"
    return ForwardPePoint(
        date=day,
        observed_at=row.observed_at,
        price=price,
        price_as_of=row.price_as_of if price is not None else None,
        eps=eps,
        pe=pe if pe is not None and pe > 0 else None,
        source=source,
        recovered=row.recovered,
    )


def forward_pe_history(
    rows: Iterable[EstimateObservation], *, currency: str, timezone: ZoneInfo
) -> ForwardPeHistory | None:
    """Use the last captured vintage per exchange-local date; never carry it forward."""
    by_day = {}
    for row in rows:
        if row.currency != currency:
            continue
        day = row.observed_at.astimezone(timezone).date()
        by_day[day] = _reading(row, day)
    points = list(by_day.values())
    if not points:
        return None
    latest = points[-1]
    # Vendor and derived readings need not use the same horizon. Compare the
    # latest observation only to historical readings on its own basis.
    samples = [
        point.pe for point in points if point.source == latest.source and point.pe is not None
    ]
    return ForwardPeHistory(
        currency=currency,
        points=points,
        distribution=pe_distribution(samples, latest.pe, minimum=MINIMUM_FORWARD_SAMPLE),
    )
