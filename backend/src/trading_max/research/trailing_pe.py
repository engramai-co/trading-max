"""Replay SEC diluted EPS at the first exchange close after EDGAR acceptance."""

from __future__ import annotations

import math
from bisect import bisect_right
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import fmean, pstdev
from typing import Literal
from zoneinfo import ZoneInfo

from trading_max.domain import DomainModel

from .calendar import market_calendar

MINIMUM_SAMPLE = 60
# Don't carry a denominator indefinitely when a listing stops reporting.
MAX_PERIOD_AGE = timedelta(days=180)
NEW_YORK = ZoneInfo("America/New_York")
DAY = timedelta(days=1)

Method = Literal["annual", "fourQuarters", "derivedFourthQuarter"]


class TrailingPeEarnings(DomainModel):
    effective_date: date
    period_end: date
    eps: float
    method: Method


class TrailingPePoint(DomainModel):
    date: date
    close: float | None
    pe: float | None
    earnings_index: int | None


class TrailingPeDistribution(DomainModel):
    samples: int
    lower_quartile: float
    median: float
    upper_quartile: float
    mean: float
    standard_deviation: float
    latest_percentile: float | None


class TrailingPeHistory(DomainModel):
    currency: Literal["USD"] = "USD"
    points: list[TrailingPePoint]
    earnings: list[TrailingPeEarnings]
    distribution: TrailingPeDistribution | None


@dataclass(frozen=True)
class DilutedEps:
    start: date
    end: date
    value: float | None


@dataclass(frozen=True)
class EpsFiling:
    accepted_at: datetime
    report_end: date
    annual: bool
    observations: tuple[DilutedEps, ...]


@dataclass(frozen=True)
class DailyClose:
    date: date
    close: float | None
    split: float


def _length(start: date, end: date) -> int:
    return (end - start).days + 1


def _quarter(start: date, end: date) -> bool:
    return 70 <= _length(start, end) <= 112


def _year(start: date, end: date) -> bool:
    return 350 <= _length(start, end) <= 380


Period = tuple[date, date]
Facts = dict[Period, float | None]


def _quarter_chain(quarters: Facts, end: date, count: int) -> list[tuple[Period, float]] | None:
    """Follow exact fiscal boundaries, rejecting competing contexts."""
    chain = []
    for _ in range(count):
        ending = [(period, value) for period, value in quarters.items() if period[1] == end]
        if len(ending) != 1 or ending[0][1] is None:
            return None
        period, value = ending[0]
        chain.append((period, value))
        end = period[0] - DAY
    return chain


class _EarningsReplay:
    def __init__(self) -> None:
        self.quarters: Facts = {}
        self.annuals: Facts = {}
        self.derived: Facts = {}
        self.derived_years: dict[Period, Period] = {}
        self.period_end: date | None = None
        self.is_annual = False

    def apply(self, filings: list[EpsFiling], split_factor: float) -> None:
        changes: dict[Period, set[float | None]] = defaultdict(set)
        for filing in filings:
            if self.period_end is None or filing.report_end > self.period_end:
                self.period_end = filing.report_end
                self.is_annual = filing.annual
            elif filing.report_end == self.period_end:
                self.is_annual |= filing.annual
            for fact in filing.observations:
                changes[fact.start, fact.end].add(
                    None if fact.value is None else fact.value / split_factor
                )

        updated_annuals = set()
        for period, values in changes.items():
            value = next(iter(values)) if len(values) == 1 else None
            if _quarter(*period):
                self.quarters[period] = value
            elif _year(*period):
                self.annuals[period] = value
                updated_annuals.add(period)

        # If a prerequisite was missing at the annual filing, a newly
        # disclosed comparative can complete the calculation prospectively.
        for period in sorted(updated_annuals | (self.annuals.keys() - self.derived_years.keys())):
            # Freeze the implied Q4 at the annual observation's vintage. A
            # later correction to Q1–Q3 alone must not rewrite Q4 to offset it.
            previous = self.derived_years.pop(period, None)
            if previous:
                self.derived.pop(previous, None)
            annual = self.annuals[period]
            if annual is None:
                continue
            candidates = []
            for end in {end for _, end in self.quarters}:
                start = end + DAY
                if not _quarter(start, period[1]):
                    continue
                chain = _quarter_chain(self.quarters, end, 3)
                if chain and chain[-1][0][0] == period[0]:
                    candidates.append((start, chain))
            if len(candidates) == 1:
                start, chain = candidates[0]
                fourth = (start, period[1])
                self.derived[fourth] = math.fsum([annual, *(-v for _, v in chain)])
                self.derived_years[period] = fourth

    def reading(self) -> tuple[date, float, Method] | None:
        end = self.period_end
        if end is None:
            return None
        if self.is_annual:
            # Use actual diluted EPS for the full fiscal year when available;
            # weighted average diluted shares can differ across quarters.
            annuals = [value for period, value in self.annuals.items() if period[1] == end]
            if annuals:
                return (
                    (end, annuals[0], "annual")
                    if len(annuals) == 1 and annuals[0] is not None
                    else None
                )
        # A reported fourth quarter is stronger than an inferred one, including
        # when the reported value itself is ambiguous.
        reported_ends = {finish for _, finish in self.quarters}
        quarters = self.quarters | {
            period: value
            for period, value in self.derived.items()
            if period[1] not in reported_ends
        }
        chain = _quarter_chain(quarters, end, 4)
        if not chain or not _year(chain[-1][0][0], end):
            return None
        inferred = any(period not in self.quarters for period, _ in chain)
        eps = round(math.fsum(value for _, value in chain), 12)
        return end, eps, "derivedFourthQuarter" if inferred else "fourQuarters"


def pe_distribution(
    samples: Sequence[float], latest: float | None, *, minimum: int = MINIMUM_SAMPLE
) -> TrailingPeDistribution | None:
    if len(samples) < minimum:
        return None
    values = sorted(samples)

    def quantile(q: float) -> float:
        rank = (len(values) - 1) * q
        i = int(rank)
        return values[i] + (values[i + 1] - values[i]) * (rank - i)

    return TrailingPeDistribution(
        samples=len(values),
        lower_quartile=quantile(0.25),
        median=quantile(0.5),
        upper_quartile=quantile(0.75),
        mean=fmean(values),
        standard_deviation=pstdev(values),
        latest_percentile=bisect_right(values, latest) / len(values)
        if latest is not None
        else None,
    )


def trailing_pe_history(
    filings: list[EpsFiling], prices: list[DailyClose], *, now: datetime
) -> TrailingPeHistory | None:
    if not filings or not prices:
        return None
    prices_by_day = {bar.date: bar for bar in prices}
    first_day, today = min(prices_by_day), now.astimezone(NEW_YORK).date()
    calendar = market_calendar("XNYS", first_day.year, today.year)
    sessions = calendar.schedule.loc[first_day.isoformat() : today.isoformat(), "close"]
    completed = sessions[sessions <= now]
    days = [session.date() for session in completed.index]
    closes = list(completed)
    split_days = sorted(bar.date for bar in prices if bar.split > 0 and bar.split != 1)
    factors = [1.0] * (len(split_days) + 1)
    for i in range(len(split_days) - 1, -1, -1):
        factors[i] = factors[i + 1] * prices_by_day[split_days[i]].split
    if not all(math.isfinite(factor) and factor > 0 for factor in factors):
        return None

    changes: dict[int, dict[datetime, list[EpsFiling]]] = defaultdict(lambda: defaultdict(list))
    for filing in filings:
        filed_day = filing.accepted_at.astimezone(NEW_YORK).date()
        # Earlier vintages might predate splits outside Yahoo's covered window.
        if filed_day >= first_day and filing.report_end <= filed_day:
            changes[bisect_right(closes, filing.accepted_at)][filing.accepted_at].append(filing)

    replay = _EarningsReplay()
    earnings: list[TrailingPeEarnings] = []
    points: list[TrailingPePoint] = []
    previous = None
    for index, day in enumerate(days):
        for accepted_at, batch in sorted(changes.get(index, {}).items()):
            filed_day = accepted_at.astimezone(NEW_YORK).date()
            # SEC values in filings on or after a split are assumed to already
            # reflect it. Later splits only rebase both legs, never the ratio.
            replay.apply(batch, factors[bisect_right(split_days, filed_day)])
        reading = replay.reading() if index in changes else previous
        if reading and day - reading[0] > MAX_PERIOD_AGE:
            reading = None
        if reading and reading != previous:
            end, eps, method = reading
            earnings.append(
                TrailingPeEarnings(effective_date=day, period_end=end, eps=eps, method=method)
            )
        previous = reading
        if not earnings:
            continue
        bar = prices_by_day.get(day)
        close = bar.close if bar and bar.close is not None and bar.close > 0 else None
        pe = close / reading[1] if close is not None and reading and reading[1] > 0 else None
        points.append(
            TrailingPePoint(
                date=day,
                close=close,
                pe=pe if pe is not None and math.isfinite(pe) else None,
                earnings_index=len(earnings) - 1 if reading else None,
            )
        )
    return (
        TrailingPeHistory(
            points=points,
            earnings=earnings,
            distribution=pe_distribution([p.pe for p in points if p.pe is not None], points[-1].pe),
        )
        if points
        else None
    )
