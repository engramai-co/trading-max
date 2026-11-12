"""Describe changes in a reconciled account, using only observed daily marks."""

from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from itertools import groupby
from typing import Literal

import pandas as pd
from pydantic import Field

from trading_max.analytics.decision_prices import _rate_due
from trading_max.analytics.historical_nav import (
    CASH_RECONCILIATION_RELATIVE_TOLERANCE,
    CASH_RECONCILIATION_TOLERANCE_GBP,
    LedgerEvent,
    _nominal_close,
)
from trading_max.domain import DomainModel
from trading_max.research.calendar import listing_calendar, market_calendar

SESSION_MOVE_SHARE = 0.05
CASH_SHARE = 0.10
CASH_MIN_SESSIONS = 10
WEIGHT_DRIFT_SHARE = 0.03
WEIGHT_DRIFT_DAYS = 30
EVIDENCE_DAYS = 90
RECENT_FILL_LIMIT = 8
CASH_CALENDAR = "XLON"
_ZERO = 1e-7
_DAY = pd.Timedelta(days=1)
_TICK = pd.Timedelta(nanoseconds=1)


class ReviewRules(DomainModel):
    session_move_share: float
    cash_share: float
    cash_min_sessions: int
    weight_drift_share: float
    weight_drift_days: int
    evidence_days: int
    recent_fill_limit: int

    @classmethod
    def current(cls) -> ReviewRules:
        return cls(
            session_move_share=SESSION_MOVE_SHARE,
            cash_share=CASH_SHARE,
            cash_min_sessions=CASH_MIN_SESSIONS,
            weight_drift_share=WEIGHT_DRIFT_SHARE,
            weight_drift_days=WEIGHT_DRIFT_DAYS,
            evidence_days=EVIDENCE_DAYS,
            recent_fill_limit=RECENT_FILL_LIMIT,
        )


class HoldingMove(DomainModel):
    date: date
    ticker: str
    quote_currency: str
    change: float


class CashSpan(DomainModel):
    start: date
    end: date
    sessions: int
    peak_share: float
    average_share: float


class WeightDrift(DomainModel):
    start: date
    end: date
    ticker: str
    before: float
    after: float


class AllocationShares(DomainModel):
    largest_holding: float
    cash: float
    usd_exposure: float


class FillEffect(DomainModel):
    filled_at: datetime
    ticker: str
    side: Literal["buy", "sell"]
    quantity: float
    before: AllocationShares
    after: AllocationShares


class AccountReviewEvidence(DomainModel):
    as_of: datetime | None = None
    coverage: Literal["complete", "partial"]
    holding_moves: list[HoldingMove] = Field(default_factory=list)
    cash_spans: list[CashSpan] = Field(default_factory=list)
    weight_drifts: list[WeightDrift] = Field(default_factory=list)
    fill_effects: list[FillEffect] = Field(default_factory=list)


class InvestmentReviewEvidence(DomainModel):
    rules: ReviewRules
    accounts: dict[Literal["A", "B"], AccountReviewEvidence]


@dataclass(frozen=True)
class ReviewListing:
    ticker: str
    quote_currency: str
    symbol: str
    listing_currency: str
    frame: pd.DataFrame


def _positive(value: object) -> float | None:
    if value is None or pd.isna(value):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _column(frame: pd.DataFrame, name: str) -> pd.Series:
    series = pd.to_numeric(frame.get(name, pd.Series(dtype=float)), errors="coerce")
    series.index = pd.DatetimeIndex(series.index).tz_localize(None).normalize()
    return series[~series.index.duplicated(keep=False)].sort_index()


class _ListingMarks:
    def __init__(self, listing: ReviewListing, start: pd.Timestamp, end: pd.Timestamp):
        self.listing = listing
        calendar = listing_calendar(listing.symbol, listing.frame.attrs.get("exchange"), None)
        equivalent = listing.quote_currency == listing.listing_currency or {
            listing.quote_currency,
            listing.listing_currency,
        } == {"GBP", "GBX"}
        self.schedule = (
            market_calendar(calendar, start.year, end.year).schedule.loc[start:end]
            if calendar and equivalent
            else pd.DataFrame(columns=["open", "close"])
        )
        self.tz = str(market_calendar(calendar, start.year, end.year).tz) if calendar else "UTC"
        self.adjusted = _column(listing.frame, "Close")
        self.splits = _column(listing.frame, "Stock Splits")
        self.nominal = _nominal_close(
            pd.DataFrame({"Close": self.adjusted, "Stock Splits": self.splits})
        )
        self.closes = list(self.schedule["close"])

    def price(self, at: pd.Timestamp) -> float | None:
        index = bisect_right(self.closes, at) - 1
        if index < 0:
            return None
        day = self.schedule.index[index]
        close = _positive(self.nominal.get(day))
        if close is None:
            return None
        # Before the next close, a known split has already changed units when
        # the listing opened. The preceding close is still the cached mark.
        if index + 1 < len(self.schedule):
            next_session = self.schedule.iloc[index + 1]
            if next_session["open"] <= at:
                close /= _positive(self.splits.get(next_session.name)) or 1.0
        return close


class _FxMarks:
    def __init__(self, frames: Mapping[str, pd.DataFrame], start: pd.Timestamp, end: pd.Timestamp):
        days = pd.date_range(start, end)
        due = days[_rate_due(days)]
        self.days = list(due)
        self.available_at = list(due.tz_localize("UTC") + _DAY - _TICK)
        self.rates = {code: _column(frame, "Close") for code, frame in frames.items()}

    def pounds(self, value: float, currency: str, at: pd.Timestamp) -> float | None:
        if abs(value) < _ZERO:
            return 0.0
        if currency == "GBP":
            return value
        if currency == "GBX":
            return value / 100
        index = bisect_right(self.available_at, at) - 1
        rates = self.rates.get(currency)
        rate = _positive(rates.get(self.days[index])) if index >= 0 and rates is not None else None
        return value / rate if rate is not None else None


@dataclass(frozen=True)
class _State:
    holdings: dict[str, float]
    cash: dict[str, float]


class _Replay:
    """A compact index of the NAV ledger's timestamped quantity and cash events."""

    def __init__(self, events: Sequence[LedgerEvent], start: pd.Timestamp, end: pd.Timestamp):
        self.times: list[pd.Timestamp] = []
        self.states: list[_State] = [_State({}, {})]
        self.fills: list[tuple[LedgerEvent, bool]] = []
        self.trade_times: dict[str, list[pd.Timestamp]] = defaultdict(list)
        holdings: dict[str, float] = defaultdict(float)
        cash: dict[str, float] = defaultdict(float)
        for at, group in groupby(events, key=lambda event: event.timestamp):
            if at > end:
                break
            batch = list(group)
            if at >= start and not self.times:
                self.states[0] = _State(dict(holdings), dict(cash))
            for event in batch:
                if event.identity is not None and event.quantity:
                    holdings[event.identity] += event.quantity
                cash[event.currency] += event.cash
                if event.fill_side and at >= start:
                    # The export carries no sequence for events at identical
                    # timestamps. A nontrivial tie cannot give a unique split.
                    self.fills.append((event, sum(bool(e.quantity or e.cash) for e in batch) == 1))
                    if event.identity:
                        self.trade_times[event.identity].append(at)
            if at >= start:
                self.times.append(at)
                self.states.append(_State(dict(holdings), dict(cash)))
        self.terminal = _State(dict(holdings), dict(cash))
        if not self.times:
            self.states[0] = self.terminal

    def at(self, at: pd.Timestamp, *, before: bool = False) -> _State:
        index = (bisect_left if before else bisect_right)(self.times, at)
        return self.states[index]


def _cash(state: _State, fx: _FxMarks, at: pd.Timestamp) -> float | None:
    values = [fx.pounds(value, code, at) for code, value in state.cash.items()]
    return (
        None if any(value is None for value in values) else sum(v for v in values if v is not None)
    )


@dataclass(frozen=True)
class _Allocation:
    shares: AllocationShares
    weights: dict[str, float]


def _allocation(
    state: _State, markets: Mapping[str, _ListingMarks], fx: _FxMarks, at: pd.Timestamp
) -> _Allocation | None:
    cash = _cash(state, fx, at)
    if cash is None:
        return None
    values = {}
    for identity, shares in state.holdings.items():
        if abs(shares) < _ZERO:
            continue
        market = markets.get(identity)
        price = market.price(at) if market is not None else None
        if shares < 0 or market is None or price is None:
            return None
        gbp = fx.pounds(shares * price, market.listing.listing_currency, at)
        if gbp is None:
            return None
        values[identity] = gbp
    total = cash + sum(values.values())
    if total <= _ZERO:
        return None
    weights = {identity: value / total for identity, value in values.items()}
    return _Allocation(
        AllocationShares(
            largest_holding=max(weights.values(), default=0.0),
            cash=cash / total,
            usd_exposure=sum(
                weight
                for identity, weight in weights.items()
                if markets[identity].listing.quote_currency == "USD"
            ),
        ),
        weights,
    )


def _cash_spans(
    days: list[tuple[pd.Timestamp, _Allocation | None]],
) -> list[CashSpan]:
    spans = []
    for qualifies, group in groupby(
        days, key=lambda row: row[1] is not None and row[1].shares.cash >= CASH_SHARE - 1e-12
    ):
        if qualifies:
            rows = list(group)
            if len(rows) >= CASH_MIN_SESSIONS:
                values = [
                    allocation.shares.cash for _, allocation in rows if allocation is not None
                ]
                spans.append(
                    CashSpan(
                        start=rows[0][0].date(),
                        end=rows[-1][0].date(),
                        sessions=len(rows),
                        peak_share=max(values),
                        average_share=sum(values) / len(values),
                    )
                )
    return spans[::-1]


def _drifts(
    days: list[tuple[pd.Timestamp, _Allocation | None]],
    trade_times: Mapping[str, list[pd.Timestamp]],
    markets: Mapping[str, _ListingMarks],
) -> list[WeightDrift]:
    rows = []
    trades = {
        identity: {stamp.date() for stamp in times} for identity, times in trade_times.items()
    }
    for identity, market in markets.items():
        seen: list[tuple[pd.Timestamp, float]] = []
        best: WeightDrift | None = None
        best_change = 0.0
        trading_days = sorted(trades.get(identity, ()))
        for day, allocation in days:
            if seen:
                first_trade = bisect_left(trading_days, seen[-1][0].date())
                if first_trade < len(trading_days) and trading_days[first_trade] <= day.date():
                    seen.clear()
            weight = allocation.weights.get(identity) if allocation is not None else None
            if weight is None or day.date() in trading_days:
                seen.clear()
                continue
            seen = [
                (start, before) for start, before in seen if (day - start).days <= WEIGHT_DRIFT_DAYS
            ]
            for start, before in seen:
                change = abs(weight - before)
                if change >= WEIGHT_DRIFT_SHARE - 1e-12 and change >= best_change:
                    best = WeightDrift(
                        start=start.date(),
                        end=day.date(),
                        ticker=market.listing.ticker,
                        before=before,
                        after=weight,
                    )
                    best_change = change
            seen.append((day, weight))
        if best is not None:
            rows.append(best)
    return sorted(rows, key=lambda row: (row.end, row.ticker), reverse=True)


def build_review_evidence(
    events: Sequence[LedgerEvent],
    listings: Mapping[str, ReviewListing],
    fx_frames: Mapping[str, pd.DataFrame],
    *,
    as_of: pd.Timestamp,
    terminal_holdings: Mapping[str, float],
    terminal_cash_gbp: float,
    terminal_value_gbp: float,
) -> AccountReviewEvidence:
    """Evaluate recent history and the latest individual fills for one account."""

    end = as_of.tz_convert("UTC").tz_localize(None).normalize()
    start = end - pd.Timedelta(days=EVIDENCE_DAYS - 1)
    # A cash streak can start before the observation window. Include the ledger
    # history for cash so qualifying spans keep their actual start and average.
    history_start = (
        min(start, events[0].timestamp.tz_convert("UTC").tz_localize(None).normalize())
        if events
        else start
    )
    mark_start = history_start - pd.Timedelta(days=14)
    replay = _Replay(events, mark_start.tz_localize("UTC"), as_of)
    result = AccountReviewEvidence(as_of=as_of.to_pydatetime(), coverage="complete")
    if (
        not events
        or any(event.timestamp > as_of for event in events)
        or any(
            not math.isclose(
                replay.terminal.holdings.get(key, 0), terminal_holdings.get(key, 0), abs_tol=1e-6
            )
            for key in replay.terminal.holdings.keys() | terminal_holdings.keys()
        )
    ):
        result.coverage = "partial"
        return result

    markets = {
        identity: _ListingMarks(listing, mark_start, end) for identity, listing in listings.items()
    }
    states_in_window = [
        replay.at(start.tz_localize("UTC")),
        *replay.states[bisect_left(replay.times, start.tz_localize("UTC")) + 1 :],
    ]
    held_in_window = {
        key for state in states_in_window for key, qty in state.holdings.items() if qty > _ZERO
    }
    if any(key not in markets or markets[key].schedule.empty for key in held_in_window):
        result.coverage = "partial"

    for identity, market in markets.items():
        trades = {
            stamp.tz_convert(market.tz).date() for stamp in replay.trade_times.get(identity, ())
        }
        previous = None
        for day, closed in market.schedule["close"].items():
            if closed > as_of:
                break
            if (
                day >= start
                and previous is not None
                and day.date() not in trades
                and (
                    replay.at(previous[1]).holdings.get(identity, 0.0) > _ZERO
                    and replay.at(closed).holdings.get(identity, 0.0) > _ZERO
                )
            ):
                before, after = (
                    _positive(market.adjusted.get(previous[0])),
                    _positive(market.adjusted.get(day)),
                )
                if before is None or after is None:
                    result.coverage = "partial"
                elif abs(change := after / before - 1) >= SESSION_MOVE_SHARE - 1e-12:
                    result.holding_moves.append(
                        HoldingMove(
                            date=day.date(),
                            ticker=market.listing.ticker,
                            quote_currency=market.listing.quote_currency,
                            change=change,
                        )
                    )
            previous = (day, closed)
    result.holding_moves.sort(key=lambda row: (row.date, abs(row.change), row.ticker), reverse=True)

    fx = _FxMarks(fx_frames, mark_start, end)
    cash_at_snapshot = _cash(replay.terminal, fx, as_of)
    tolerance = max(
        CASH_RECONCILIATION_TOLERANCE_GBP,
        terminal_value_gbp * CASH_RECONCILIATION_RELATIVE_TOLERANCE,
    )
    if cash_at_snapshot is None or not math.isclose(
        terminal_cash_gbp, cash_at_snapshot, rel_tol=0, abs_tol=tolerance
    ):
        result.coverage = "partial"
        return result

    # Account trading days use the London calendar. We sample after the UTC
    # day ends so completed US closes and that day's final FX can both enter.
    session_days = market_calendar(CASH_CALENDAR, history_start.year, end.year).sessions
    daily = []
    for day in session_days[(session_days >= history_start) & (session_days <= end)]:
        cutoff = day.tz_localize("UTC") + _DAY - _TICK
        if cutoff > as_of:
            break
        state = replay.at(cutoff)
        valuation = _allocation(state, markets, fx, cutoff)
        if (
            day >= start
            and valuation is None
            and (
                any(abs(qty) >= _ZERO for qty in state.holdings.values())
                or any(abs(amount) >= _ZERO for amount in state.cash.values())
            )
        ):
            result.coverage = "partial"
        daily.append((day, valuation))
    result.cash_spans = [row for row in _cash_spans(daily) if row.end >= start.date()]
    result.weight_drifts = _drifts(
        [row for row in daily if row[0] >= start], replay.trade_times, markets
    )

    fills = [row for row in replay.fills if row[0].timestamp >= start.tz_localize("UTC")]
    for event, ordered in reversed(fills[-RECENT_FILL_LIMIT:]):
        at = event.timestamp
        before = _allocation(replay.at(at, before=True), markets, fx, at) if ordered else None
        after = _allocation(replay.at(at), markets, fx, at) if ordered else None
        if (
            before is None
            or after is None
            or not event.fill_ticker
            or not event.fill_side
            or not event.identity
            or abs(event.quantity) < _ZERO
        ):
            result.coverage = "partial"
            continue
        result.fill_effects.append(
            FillEffect(
                filled_at=at.to_pydatetime(),
                ticker=event.fill_ticker,
                side=event.fill_side,
                quantity=abs(event.quantity),
                before=before.shares,
                after=after.shares,
            )
        )
    return result
