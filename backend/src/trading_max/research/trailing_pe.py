"""Replay SEC diluted EPS at the first exchange close after EDGAR acceptance."""

from __future__ import annotations

import math
from bisect import bisect_right
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import fmean, pstdev
from typing import Literal, Self
from zoneinfo import ZoneInfo

from pydantic import Field, model_validator

from trading_max.domain import DomainModel

from .calendar import market_calendar

MINIMUM_SAMPLE = 60
# Don't carry a denominator indefinitely when a listing stops reporting.
MAX_PERIOD_AGE = timedelta(days=180)
# Above 400x the earnings yield is under 0.25%. Over ten years of this series
# for 16 large US listings, steady earners stayed below 100x and growth phases
# peaked at 250-370x, while EPS within cents of zero produced 700-5,400x and
# swamped the distribution. The cap keeps the growth phases and withholds
# those; the web copy repeats this number.
MEANINGFUL_PE_CAP = 400.0
# Below 1x the earnings yield is over 100%: a year's earnings would exceed the
# company's market value. Short of a one-off gain that large, it means EPS at
# the wrong scale, such as a quarter filed in thousands and never corrected.
# Exactly 1x and exactly 400x are kept.
MEANINGFUL_PE_FLOOR = 1.0
# Within one EPS reading the multiple moves only with the close, so a fivefold
# move where a new reading starts is a break in the earnings data, not a
# change in valuation.
SEGMENT_JUMP = 5.0
# A filing that restates every earlier period it repeats by one power of ten of
# at least two orders of magnitude either used the wrong scale for per-share
# values (upwards) or corrects an earlier filing that did (downwards).
SCALE_ERROR_POWER = 2
NEW_YORK = ZoneInfo("America/New_York")
DAY = timedelta(days=1)

Method = Literal["annual", "fourQuarters", "derivedFourthQuarter"]
NotMeaningful = Literal["aboveCap", "belowFloor", "segmentJump"]


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
    # Why a positive multiple is withheld; its close and EPS remain.
    not_meaningful: NotMeaningful | None = Field(
        default=None, exclude_if=lambda value: value is None
    )


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

    @model_validator(mode="after")
    def _screen(self) -> Self:
        """Derive every multiple and the distribution from the closes and EPS.

        A stored series and a new one are screened alike: a multiple above
        the cap or below the floor, or a reading that opens with a fivefold
        jump from the previous close's multiple, is withheld as not meaningful
        and left out of the distribution.
        """
        # Each close with positive EPS: its reading and multiple, if it has a price.
        readings: list[tuple[int, float | None] | None] = []
        for point in self.points:
            index = point.earnings_index
            eps = (
                self.earnings[index].eps
                if index is not None and 0 <= index < len(self.earnings)
                else None
            )
            if index is None or eps is None or eps <= 0:
                readings.append(None)
                continue
            value = point.close / eps if point.close is not None and point.close > 0 else None
            readings.append((index, value if value is not None and math.isfinite(value) else None))
        jumped: set[int] = set()
        last: tuple[int, float] | None = None
        for reading in readings:
            if reading is None:
                # Earnings crossing zero are not a jump: the line already breaks there.
                last = None
            elif reading[1] is not None:
                index, value = reading[0], reading[1]
                if (
                    last
                    and index != last[0]
                    and max(value / last[1], last[1] / value) > SEGMENT_JUMP
                ):
                    jumped.add(index)
                last = (index, value)
        for point, reading in zip(self.points, readings, strict=True):
            value = reading[1] if reading else None
            reason: NotMeaningful | None = None
            if value is not None and value > MEANINGFUL_PE_CAP:
                reason = "aboveCap"
            elif value is not None and value < MEANINGFUL_PE_FLOOR:
                reason = "belowFloor"
            elif value is not None and point.earnings_index in jumped:
                reason = "segmentJump"
            point.not_meaningful = reason
            point.pe = None if reason else value
        self.distribution = pe_distribution(
            [point.pe for point in self.points if point.pe is not None],
            self.points[-1].pe if self.points else None,
        )
        return self


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


def _power_of_ten(before: float, after: float) -> int | None:
    """The power of ten that turns one value into the other, if either is a rescaling of the other."""
    if not before or not after or (before > 0) != (after > 0):
        return None
    power = math.log10(after / before)
    # Per-share values are filed to the cent, so allow for that rounding.
    return round(power) if abs(power - round(power)) <= 0.05 else None


@dataclass
class _ImpliedQuarter:
    """A fourth quarter implied from annual EPS and Q1–Q3 as filed at the annual's vintage."""

    period: Period
    annual: float
    # None once a scale correction reaches one of them in a value other than
    # the one used here: the scale Q4 was implied at is then unknown.
    quarters: dict[Period, float] | None

    @property
    def eps(self) -> float | None:
        if self.quarters is None:
            return None
        return round(math.fsum([self.annual, *(-value for value in self.quarters.values())]), 12)


class _EarningsReplay:
    def __init__(self) -> None:
        self.quarters: Facts = {}
        self.annuals: Facts = {}
        self.derived: Facts = {}
        self.derived_years: dict[Period, _ImpliedQuarter] = {}
        # Every period's latest accepted value, to check new filings against.
        self.recorded: Facts = {}
        self.period_end: date | None = None
        self.is_annual = False

    def _rescaling(
        self, facts: list[tuple[Period, float | None]]
    ) -> tuple[int, dict[Period, float]] | None:
        """The one power of ten by which a filing restates the recorded periods it repeats.

        Returns the power with those periods' recorded values, or None unless
        every comparison agrees. A value unavailable on either side is no
        evidence, and zero against zero fits any scale. Zero against a nonzero
        value, a change of sign or a factor other than a power of ten rules a
        rescaling out; an unchanged value counts as the power zero.
        """
        powers: set[int | None] = set()
        repeated: dict[Period, float] = {}
        for period, value in facts:
            before = self.recorded.get(period)
            if before is None or value is None or before == value == 0:
                continue
            powers.add(_power_of_ten(before, value))
            repeated[period] = before
        power = powers.pop() if len(powers) == 1 else None
        return None if power is None else (power, repeated)

    def apply(self, filings: list[EpsFiling], split_factor: float) -> None:
        changes: dict[Period, set[float | None]] = defaultdict(set)
        # Recorded values that a filing has shown were tagged at the wrong
        # scale, with the factor that corrects each.
        misscaled: dict[Period, tuple[float, int]] = {}
        for filing in filings:
            if self.period_end is None or filing.report_end > self.period_end:
                self.period_end = filing.report_end
                self.is_annual = filing.annual
            elif filing.report_end == self.period_end:
                self.is_annual |= filing.annual
            facts = [
                ((fact.start, fact.end), None if fact.value is None else fact.value / split_factor)
                for fact in filing.observations
            ]
            power, repeated = self._rescaling(facts) or (0, {})
            if power >= SCALE_ERROR_POWER:
                # Per-share values tagged in thousands, say. The filing is
                # ignored, but its period still becomes the latest one:
                # unknown, not carried over.
                continue
            if power <= -SCALE_ERROR_POWER:
                misscaled |= {period: (before, 10**-power) for period, before in repeated.items()}
            for period, value in facts:
                changes[period].add(value)

        updated_annuals = set()
        for period, values in changes.items():
            value = next(iter(values)) if len(values) == 1 else None
            if _quarter(*period):
                self.quarters[period] = value
            elif _year(*period):
                self.annuals[period] = value
                updated_annuals.add(period)
            self.recorded[period] = value

        # An implied Q4 keeps Q1–Q3 as filed at its annual's vintage, so a later
        # restatement of one of them doesn't rewrite Q4 to offset it. A quarter
        # since shown to be tagged at the wrong scale is corrected there when
        # the correction rescales the very value Q4 was implied from. If that
        # quarter was restated in between, its scale at the vintage is unknown,
        # and so is Q4 until a new vintage of the annual implies it again below.
        for year, implied in self.derived_years.items():
            if year in updated_annuals or implied.quarters is None:
                continue
            reached = implied.quarters.keys() & misscaled.keys()
            if not reached:
                continue
            if all(implied.quarters[period] == misscaled[period][0] for period in reached):
                implied.quarters |= {
                    period: implied.quarters[period] / misscaled[period][1] for period in reached
                }
            else:
                implied.quarters = None
            self.derived[implied.period] = implied.eps

        # If a prerequisite was missing at the annual filing, a newly
        # disclosed comparative can complete the calculation prospectively.
        for period in sorted(updated_annuals | (self.annuals.keys() - self.derived_years.keys())):
            # A new vintage of the annual implies Q4 from the current quarters.
            previous = self.derived_years.pop(period, None)
            if previous:
                self.derived.pop(previous.period, None)
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
                implied = _ImpliedQuarter((start, period[1]), annual, dict(chain))
                self.derived[implied.period] = implied.eps
                self.derived_years[period] = implied

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
            # Screening the multiples derives the distribution.
            distribution=None,
        )
        if points
        else None
    )
