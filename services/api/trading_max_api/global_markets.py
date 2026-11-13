"""Deterministic attribution of a global move to public index observations."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from math import fsum, isclose
from typing import Literal, get_args
from zoneinfo import ZoneInfo

from trading_max.infrastructure.acwi_weights import AcwiWeights
from trading_max.infrastructure.sector_prices import SparkSeries
from trading_max.infrastructure.shared_market_prices import SharedMarketPrices
from trading_max.reference.indices import INDEX_REGISTRY

from .index_models import (
    GlobalContributionRow,
    GlobalMapMarket,
    GlobalMarketContribution,
    GlobalMarketMove,
    GlobalRowMarket,
)
from .sector_models import SectorSessionWindow
from .sector_sessions import exchange_sessions

MAIN_INDEX: dict[GlobalMapMarket, str] = {
    "us": "sp-500",
    "ca": "sp-tsx",
    "uk": "ftse-100",
    "eu": "stoxx-europe-600",
    "ch": "smi",
    "jp": "nikkei-225",
    "au": "asx-200",
    "hk": "hang-seng",
    "kr": "kospi",
    "tw": "taiex",
    "in": "nifty-50",
}
EUROPE = frozenset(
    [
        "Austria",
        "Belgium",
        "Denmark",
        "Finland",
        "France",
        "Germany",
        "Ireland",
        "Italy",
        "Netherlands",
        "Norway",
        "Portugal",
        "Spain",
        "Sweden",
    ]
)
# MSCI market classification: Hong Kong is developed; Korea and Taiwan are emerging.
EMERGING = frozenset(
    {
        "Brazil",
        "Chile",
        "China",
        "Colombia",
        "Czech Republic",
        "Egypt",
        "Greece",
        "Hungary",
        "India",
        "Indonesia",
        "Korea (South)",
        "South Korea",
        "Kuwait",
        "Malaysia",
        "Mexico",
        "Peru",
        "Philippines",
        "Poland",
        "Qatar",
        "Saudi Arabia",
        "South Africa",
        "Taiwan",
        "Thailand",
        "Turkey",
        "United Arab Emirates",
    }
)
LOCATIONS: dict[GlobalRowMarket, frozenset[str]] = {
    "us": frozenset({"United States"}),
    "ca": frozenset({"Canada"}),
    "uk": frozenset({"United Kingdom"}),
    "eu": EUROPE,
    "ch": frozenset({"Switzerland"}),
    "jp": frozenset({"Japan"}),
    "au": frozenset({"Australia"}),
    "hk": frozenset({"Hong Kong"}),
    "em": EMERGING,
}


LOGGER = logging.getLogger(__name__)
MSCI_ZONE = ZoneInfo("America/New_York")
ACWI = "^892400-USD-STRD"
EM = "^891800-USD-STRD"
CALENDARS = {
    "us": ("XNYS", "America/New_York"),
    "ca": ("XTSE", "America/Toronto"),
    "uk": ("XLON", "Europe/London"),
    # Regular core-European cash sessions and Mumbai exchange holidays.
    "eu": ("XPAR", "Europe/Paris"),
    "ch": ("XSWX", "Europe/Zurich"),
    "jp": ("XTKS", "Asia/Tokyo"),
    "au": ("XASX", "Australia/Sydney"),
    "hk": ("XHKG", "Asia/Hong_Kong"),
    "kr": ("XKRX", "Asia/Seoul"),
    "tw": ("XTAI", "Asia/Taipei"),
    "in": ("XBOM", "Asia/Kolkata"),
}
Point = tuple[datetime, float]


@dataclass(frozen=True, slots=True)
class Reference:
    date: date
    phase: Literal["live", "completed"]
    start: datetime
    end: datetime
    as_of: datetime
    level: float | None
    move: float | None


def _points(series: SparkSeries | None, now: datetime) -> list[Point]:
    if series is None:
        return []
    return sorted(
        (at, value)
        for stamp, value in zip(series.timestamps, series.closes, strict=False)
        if value is not None and value > 0 and (at := datetime.fromtimestamp(stamp, UTC)) <= now
    )


def _matching(left: float, right: float) -> bool:
    return isclose(left, right, rel_tol=0, abs_tol=0.0005)


def benchmark_closes(
    intraday: SparkSeries | None, daily: SparkSeries | None, now: datetime
) -> dict[date, Point]:
    """Timestamp completed marks from the feed, not the daily bar's midnight label.

    Yahoo carries the official close forward in its intraday stream. Historical
    daily candles corroborate those values. The latest daily candle can already
    contain the next indication, so use either the rolled previous-close field
    or the repeated final mark. The first point in that run is the publication
    timestamp; no fixed clock or time-zone offset is used.
    """
    days: dict[date, list[Point]] = {}
    for point in _points(intraday, now):
        day = point[0].astimezone(MSCI_ZONE).date()
        if day.weekday() < 5:
            days.setdefault(day, []).append(point)
    daily_values = {at.astimezone(MSCI_ZONE).date(): value for at, value in _points(daily, now)}
    closes: dict[date, Point] = {}
    last_day = max(days, default=None)
    previous = intraday.previous_close if intraday else None
    for day, points in days.items():
        known = daily_values.get(day) if day != last_day else None
        older = [value for stamp, value in daily_values.items() if stamp < day]
        rolled = (
            previous
            if day == last_day
            and older
            and previous is not None
            and not _matching(older[-1], previous)
            else None
        )
        candidates: list[tuple[bool, Point]] = []
        run: list[Point] = []
        for point in points:
            if run and (
                not _matching(run[-1][1], point[1]) or point[0] - run[-1][0] > timedelta(minutes=30)
            ):
                _close_candidate(run, candidates, known, rolled)
                run = []
            run.append(point)
        _close_candidate(run, candidates, known, rolled)
        if candidates:
            carried = [point for carry, point in candidates if carry]
            closes[day] = carried[-1] if carried else candidates[-1][1]
    return closes


def _close_candidate(
    run: list[Point],
    candidates: list[tuple[bool, Point]],
    known: float | None,
    previous: float | None,
) -> None:
    if not run:
        return
    at, value = run[0]
    # Two identical consecutive five-minute prices alone are ordinary trading.
    # A dated historical close is authoritative; otherwise require the feed's
    # closing carry pattern (15-minute marks) or a rolled previous-close value.
    settled = (
        sum(
            timedelta(minutes=14) <= right[0] - left[0] <= timedelta(minutes=16)
            for left, right in pairwise(run)
        )
        >= 2
    )
    confirmed = (known is not None and _matching(value, known)) or (
        previous is not None and _matching(value, previous)
    )
    if confirmed or (known is None and settled):
        candidates.append((settled, (at, value)))


def market_windows(
    market: GlobalMapMarket, start: datetime, now: datetime
) -> tuple[SectorSessionWindow, ...] | None:
    calendar, zone = CALENDARS[market]
    local = ZoneInfo(zone)
    try:
        return exchange_sessions(
            calendar,
            start.astimezone(local).date(),
            now.astimezone(local).date(),
            buffer_years=0 if calendar == "XBOM" else 1,
        )
    except ValueError:
        # The installed Mumbai holiday table may end before the observed year.
        return None


def reference_day(
    closes: Mapping[date, Point],
    acwi: SparkSeries | None,
    sessions: Mapping[GlobalMapMarket, tuple[SectorSessionWindow, ...] | None],
    now: datetime,
) -> Reference | None:
    if not closes:
        return None
    ordered = sorted(closes)
    latest = ordered[-1]
    boundary, level = closes[latest]
    opened = [
        session
        for windows in sessions.values()
        for session in windows or ()
        if boundary < session.open <= now
    ]
    if not opened:
        if len(ordered) < 2:
            return None
        start, base = closes[ordered[-2]]
        return Reference(latest, "completed", start, boundary, boundary, level, level / base - 1)
    first = min(opened, key=lambda session: session.open)
    date_label = date.fromisoformat(first.date)
    last = _live_value(acwi, first.open, now)
    return Reference(
        date_label,
        "live",
        boundary,
        now,
        last[0] if last else boundary,
        last[1] if last else None,
        last[1] / level - 1 if last else None,
    )


def _live_value(series: SparkSeries | None, start: datetime, now: datetime) -> Point | None:
    points = _points(series, now)
    if points and points[-1][0] >= max(start, now - timedelta(minutes=45)):
        return points[-1]
    return None


def _market_move(
    market: GlobalMapMarket,
    reference: Reference,
    windows: tuple[SectorSessionWindow, ...] | None,
    daily: SparkSeries | None,
    intraday: SparkSeries | None,
) -> GlobalMarketMove:
    if windows is None:
        return GlobalMarketMove(market=market, move=None, not_open=False)
    window = next(
        (window for window in reversed(windows) if reference.start < window.open <= reference.end),
        None,
    )
    if window is None:
        return GlobalMarketMove(market=market, move=0, not_open=True)
    zone = ZoneInfo(CALENDARS[market][1])
    closes = {
        at.astimezone(zone).date().isoformat(): value for at, value in _points(daily, reference.end)
    }
    prior = next((item for item in reversed(windows) if item.date < window.date), None)
    base = closes.get(prior.date) if prior else None
    expected = min(reference.end, window.close)
    if (
        window.break_start
        and window.break_end
        and window.break_start <= expected < window.break_end
    ):
        expected = window.break_start
    complete = reference.end >= window.close
    level = closes.get(window.date) if complete else None
    points = _points(intraday, reference.end)
    observations = [
        point for point in points if window.open <= point[0] <= window.close + timedelta(minutes=15)
    ]
    if observations:
        stamp, value = observations[-1]
        if level is None and stamp >= expected - timedelta(minutes=5 if complete else 35):
            level = value
        if (
            base is None
            and intraday is not None
            and points[-1][0].astimezone(zone).date().isoformat() == window.date
        ):
            base = intraday.previous_close
    return GlobalMarketMove(
        market=market, move=level / base - 1 if level and base else None, not_open=False
    )


def read_global_contribution(
    prices: SharedMarketPrices, weights: AcwiWeights | None, weights_stale: bool, now: datetime
) -> GlobalMarketContribution:
    # Use the same shared Yahoo price cache as the index cards. Read the
    # requested main listings in batches so opening Global does not fan out to
    # every other index in the eleven tabs.
    symbols = {
        market: INDEX_REGISTRY[identifier].symbol for market, identifier in MAIN_INDEX.items()
    }
    requested = [symbol for symbol in symbols.values() if symbol]
    daily, local = {}, {}
    acwi = em = None
    try:
        acwi = prices.benchmark_intraday(ACWI)
    except Exception:
        LOGGER.debug("Global ACWI observations failed", exc_info=True)
    try:
        em = prices.benchmark_intraday(EM)
    except Exception:
        LOGGER.debug("Global EM observations failed", exc_info=True)
    try:
        daily = prices.daily([ACWI, EM, *requested])
    except Exception:
        LOGGER.debug("Global daily prices failed", exc_info=True)
    try:
        local = prices.intraday(requested)
    except Exception:
        LOGGER.debug("Global market observations failed", exc_info=True)
    close_dates = benchmark_closes(acwi, daily.get(ACWI), now)
    earliest = min((item[0] for item in close_dates.values()), default=now)
    windows = {
        market: market_windows(market, earliest - timedelta(days=14), now) for market in MAIN_INDEX
    }
    reference = reference_day(close_dates, acwi, windows, now)
    market_moves = {}
    em_move = None
    if reference:
        for market, symbol in symbols.items():
            market_moves[market] = _market_move(
                market, reference, windows[market], daily.get(symbol or ""), local.get(symbol or "")
            )
        em_closes = benchmark_closes(em, daily.get(EM), now)
        lower_date = reference.start.astimezone(MSCI_ZONE).date()
        baseline = em_closes.get(lower_date)
        if reference.phase == "completed":
            observation = em_closes.get(reference.date)
        else:
            first_open = min(
                session.open
                for sessions in windows.values()
                for session in sessions or ()
                if reference.start < session.open <= reference.end
            )
            observation = _live_value(em, first_open, now)
        if baseline and observation:
            em_move = observation[1] / baseline[1] - 1
    return estimate_contribution(reference, weights, weights_stale, market_moves, em_move)


def estimate_contribution(
    reference: Reference | None,
    weights: AcwiWeights | None,
    weights_stale: bool,
    market_moves: Mapping[GlobalMapMarket, GlobalMarketMove],
    em_move: float | None,
) -> GlobalMarketContribution:
    total = reference.move if reference else None
    markets = [
        market_moves.get(market) or GlobalMarketMove(market=market, move=None, not_open=False)
        for market in MAIN_INDEX
    ]
    rows: list[GlobalContributionRow] = []
    residual = None
    state = "unavailable"
    if total is not None and weights is not None:
        partial = any(item.move is None for item in markets)
        for market in get_args(GlobalRowMarket):
            share = fsum(
                weight
                for location, weight in weights.locations.items()
                if location in LOCATIONS[market]
            )
            reading = market_moves.get(market)
            move = em_move if market == "em" else reading.move if reading else None
            if not share:
                continue
            if move is None:
                partial = True
                continue
            rows.append(
                GlobalContributionRow(
                    market=market,
                    index_id="msci-em" if market == "em" else MAIN_INDEX[market],
                    weight=share,
                    move=move,
                    contribution=share * move,
                    not_open=reading.not_open if reading else False,
                )
            )
        rows.sort(key=lambda row: (-abs(row.contribution), row.market))
        residual = total - fsum(row.contribution for row in rows)
        state = "partial" if partial else "ready"
    return GlobalMarketContribution(
        acwi_move=total,
        acwi_level=reference.level if reference else None,
        phase=reference.phase if reference else None,
        reference_date=reference.date if reference else None,
        as_of=reference.as_of if reference else None,
        weights_as_of=weights.as_of if weights else None,
        weights_stale=weights_stale,
        markets=markets,
        rows=rows,
        residual=residual,
        state=state,
    )
