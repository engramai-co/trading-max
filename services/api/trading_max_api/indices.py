"""Market index reads reuse public quotes and immutable account snapshots."""

from __future__ import annotations

import json
import logging
import statistics
import threading
from bisect import bisect_right
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from typing import cast, get_args
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd
from pydantic import ValidationError
from trading_max.analytics.accounts import AccountPositionMetrics
from trading_max.analytics.sector_board import FLAT_BAND, member_session, settle
from trading_max.domain.etf import evidenced_benchmark_id
from trading_max.infrastructure.acwi_weights import AcwiWeightsProvider
from trading_max.infrastructure.alpaca_market_prices import (
    ALPACA_INTRADAY,
    ALPACA_SIP,
    is_alpaca_listing,
    market_price_sources,
)
from trading_max.infrastructure.durable_files import atomic_bytes
from trading_max.infrastructure.sector_prices import SparkSeries
from trading_max.infrastructure.sector_universe import SectorUniverseProvider
from trading_max.infrastructure.shared_market_prices import SharedMarketPrices
from trading_max.infrastructure.world_sector_weights import WorldSectorWeightsProvider
from trading_max.reference.indices import INDEX_REGISTRY, IndexRange, IndexScope, IndexSpec

from .artifacts import ArtifactStore
from .etf_snapshot import read_etf_portfolio
from .global_markets import GlobalReference, read_global_contribution, read_global_reference
from .global_sector_models import GlobalSectorBoard
from .global_sectors import read_global_sectors, with_portfolio_exposure
from .index_depth import BREADTH_MARKETS, IndexDepth
from .index_models import (
    GlobalMarketContribution,
    IndexBasket,
    IndexContext,
    IndexContribution,
    IndexFundHolding,
    IndexHistory,
    IndexIdentity,
    IndexMarket,
    IndexPoint,
    IndexQuote,
)
from .sector_models import SectorBreadth, SectorMarketCode, SectorSessionWindow
from .sector_monitor import SectorBoardStore
from .sector_sessions import (
    MARKETS,
    board_complete,
    calendar_known,
    exchange_sessions,
    latest_session,
    prior_session_dates,
    provider_previous_close,
    provider_session_close,
)

LOGGER = logging.getLogger(__name__)
DAILY_WINDOWS = {
    "3M": pd.DateOffset(months=3),
    "6M": pd.DateOffset(months=6),
    "1Y": pd.DateOffset(years=1),
    "3Y": pd.DateOffset(years=3),
    "5Y": pd.DateOffset(years=5),
}
INTRADAY_MINUTES = {"1D": 5, "1W": 30, "1M": 60}
MSCI_ZONE = ZoneInfo("America/New_York")
BROKER_KEY = "account/broker_snapshot_metrics.json"


def index_identity(spec: IndexSpec, source: str = "Yahoo Finance") -> IndexIdentity:
    return IndexIdentity(
        id=spec.id,
        scope=spec.scope,
        name=spec.name,
        name_zh=spec.name_zh,
        compiler=spec.compiler,
        compiler_id=spec.compiler_id,
        symbol=spec.symbol,
        currency=spec.currency,
        calendar=spec.calendar,
        basis=spec.basis,
        kind=spec.kind,
        history_years=spec.history_years,
        ranges=list(spec.ranges),
        rights=spec.rights,
        aliases=list(spec.aliases),
        source=source if spec.symbol else None,
    )


def active_indices(scope: IndexScope | None = None) -> Iterable[IndexSpec]:
    return (spec for spec in INDEX_REGISTRY.values() if scope is None or spec.scope == scope)


# Composite calendars do not imply a local session.
_CLOCKS = {
    **{item.calendar: (item.calendar, item.timezone) for item in MARKETS.values()},
    "XNAS": ("XNYS", "America/New_York"),
    "XCBF": ("XCBF", "America/Chicago"),
    "XETR": ("XETR", "Europe/Berlin"),
    "XPAR": ("XPAR", "Europe/Paris"),
    "XSHG": ("XSHG", "Asia/Shanghai"),
    "XTAI": ("XTAI", "Asia/Taipei"),
    "XTSE": ("XTSE", "America/Toronto"),
    "XASX": ("XASX", "Australia/Sydney"),
    "XSWX": ("XSWX", "Europe/Zurich"),
    "XNSE": ("XNSE", "Asia/Kolkata"),
    "XBOM": ("XBOM", "Asia/Kolkata"),
    "STOXX-Europe": (None, "Europe/Paris"),
}


def _index_clock(
    spec: IndexSpec, now: datetime
) -> tuple[ZoneInfo, SectorSessionWindow | None, str | None]:
    calendar, timezone = _CLOCKS.get(spec.calendar, (None, "UTC"))
    zone = ZoneInfo(timezone)
    if not calendar or not calendar_known(calendar, timezone, now):
        return zone, None, None
    day = now.astimezone(zone).date()
    started = [
        window
        for window in exchange_sessions(calendar, day - timedelta(days=14), day)
        if window.open <= now
    ]
    return zone, started[-1] if started else None, started[-2].date if len(started) > 1 else None


def _points(series: SparkSeries | None) -> list[IndexPoint]:
    return [IndexPoint(at=at, value=value) for at, value in _rows(series) if value is not None]


def _dated(series: SparkSeries | None, zone: ZoneInfo) -> dict[str, float]:
    return {point.at.astimezone(zone).date().isoformat(): point.value for point in _points(series)}


def _provider_zone(series: SparkSeries | None, fallback: ZoneInfo) -> ZoneInfo:
    try:
        return ZoneInfo(series.timezone) if series and series.timezone else fallback
    except (ValueError, ZoneInfoNotFoundError):
        return fallback


def _rows(series: SparkSeries | None) -> list[tuple[datetime, float | None]]:
    if series is None:
        return []
    return [
        (datetime.fromtimestamp(stamp, UTC), value)
        for stamp, value in sorted(
            dict(zip(series.timestamps, series.closes, strict=False)).items()
        )
    ]


def _midnight(day: date) -> datetime:
    return datetime.combine(day, datetime.min.time(), UTC)


def _weekly_rows(
    series: SparkSeries | None, zone: ZoneInfo, now: datetime
) -> list[tuple[datetime, float | None]]:
    # Yahoo labels weekly bars by their first local day (not always Monday)
    # and can append a current quote. Use only completed periods, dated at
    # their final calendar day, so FX lookup never uses an unfinished candle.
    zone = _provider_zone(series, zone)
    today = now.astimezone(zone).date()
    rows = []
    for stamp, value in _rows(series):
        start = stamp.astimezone(zone)
        end = start.date() + timedelta(days=6)
        if start.time() == datetime.min.time() and end < today:
            rows.append((_midnight(end), value))
    return rows


def _hourly_closes(series: SparkSeries | None) -> list[tuple[datetime, float | None]]:
    # The 17:00 New York bar matched 248 of 251 published MSCI World
    # closes within 0.05% in a one-year comparison, including both DST shifts.
    rows = []
    for stamp, value in _rows(series):
        local = stamp.astimezone(MSCI_ZONE)
        if local.weekday() < 5 and (local.hour, local.minute, local.second) == (17, 0, 0):
            rows.append((_midnight(local.date()), value))
    return rows


def _risk(
    points: list[IndexPoint], gaps: set[datetime], *, periods_per_year: int = 252
) -> tuple[float | None, float | None]:
    if len(points) < 2:
        return None, None
    peak = points[0].value
    trough = 0.0
    for point in points:
        peak = max(peak, point.value)
        trough = min(trough, point.value / peak - 1)
    adjacent: dict[datetime, IndexPoint | None] = dict.fromkeys(gaps)
    adjacent.update({point.at: point for point in points})
    returns = [
        current.value / prior.value - 1
        for a, b in pairwise(sorted(adjacent))
        if (prior := adjacent[a]) is not None and (current := adjacent[b]) is not None
    ]
    return trough, statistics.stdev(returns) * (periods_per_year**0.5) if len(
        returns
    ) >= 2 else None


def _convert(
    points: list[IndexPoint], rates: list[IndexPoint], *, prior_period: bool, tolerance: timedelta
) -> list[IndexPoint]:
    # A daily/weekly FX candle dated the same day can end after the index candle.
    stamps = [point.at for point in rates]
    converted = []
    for point in points:
        limit = point.at - timedelta(days=1) if prior_period else point.at
        index = bisect_right(stamps, limit) - 1
        if index >= 0 and point.at - rates[index].at <= tolerance:
            converted.append(point.model_copy(update={"value": point.value * rates[index].value}))
    return converted


def _short_risk(
    points: list[IndexPoint], gaps: set[datetime], zone: ZoneInfo, now: datetime
) -> tuple[float | None, float | None]:
    # Drawdown uses the plotted bars. Annualised volatility uses one last
    # observation per finished weekday rather than annualising intraday ticks.
    today = now.astimezone(zone).date()
    daily: dict[datetime, IndexPoint] = {}
    for point in points:
        day = point.at.astimezone(zone).date()
        if day < today and day.weekday() < 5:
            daily[_midnight(day)] = point.model_copy(update={"at": _midnight(day)})
    daily_gaps = {
        _midnight(day)
        for stamp in gaps
        if (day := stamp.astimezone(zone).date()) < today and day.weekday() < 5
    }
    complete = [point for stamp, point in daily.items() if stamp not in daily_gaps]
    return _risk(points, gaps)[0], _risk(complete, daily_gaps)[1]


class IndexService:
    def __init__(
        self,
        root: Path,
        store: ArtifactStore,
        boards: SectorBoardStore,
        prices: SharedMarketPrices,
        *,
        now: Callable[[], datetime] | None = None,
        universes: SectorUniverseProvider | None = None,
        depth: IndexDepth | None = None,
    ) -> None:
        self.store = store
        self.boards = boards
        self.prices = prices
        self.universes = universes or SectorUniverseProvider(root)
        self.depth = depth or IndexDepth(root, prices, self.universes)
        self.acwi_weights = AcwiWeightsProvider(root)
        self.world_sector_weights = WorldSectorWeightsProvider(root)
        self._global_clock_lock = threading.Lock()
        self._global_clock: tuple[datetime, GlobalReference] | None = None
        self._global_sectors_lock = threading.Lock()
        self._global_sectors: tuple[datetime, GlobalSectorBoard] | None = None
        self._contribution_lock = threading.Lock()
        self._contribution: tuple[datetime, GlobalMarketContribution] | None = None
        self.root = root / "state" / "indices"
        self.now = now or (lambda: datetime.now(UTC))
        self._lock = threading.RLock()
        self._market_locks = {scope: threading.Lock() for scope in get_args(IndexScope)}
        self._quote_source = None
        self._markets: dict[str, tuple[datetime, IndexMarket]] = {}
        self._baselines: dict[str, tuple[str, bool, SparkSeries]] = {}
        self._ndx_lock = threading.Lock()
        self._ndx_cache: tuple[datetime, IndexBasket | None] | None = None
        self._ndx_late_attempts: tuple[str, int] | None = None
        self._ndx_closes: tuple[str, bool, dict[str, SparkSeries]] | None = None
        self._histories: dict[tuple[str, str, bool], tuple[datetime, IndexHistory]] = {}

    def _global_reference(self) -> tuple[datetime, GlobalReference]:
        with self._global_clock_lock:
            now = self.now()
            cached = self._global_clock
            if cached and timedelta(0) <= now - cached[0] < timedelta(minutes=4):
                return cached
            self._global_clock = (now, read_global_reference(self.prices, now))
            return self._global_clock

    def global_contribution(self) -> GlobalMarketContribution:
        with self._contribution_lock:
            now, reference = self._global_reference()
            cached = self._contribution
            if cached and now == cached[0]:
                return cached[1]
            weights, stale = self.acwi_weights.get(now)
            answer = read_global_contribution(self.prices, weights, stale, now, reference)
            path = self.root / "global-contribution.json"
            # Keep the last usable estimate across a process restart, including
            # normal partial market coverage. Keep its original reference time.
            if answer.prices_stale and not answer.rows:
                try:
                    saved = GlobalMarketContribution.model_validate_json(path.read_bytes())
                    if (
                        saved.as_of is not None
                        and timedelta(0) <= now - saved.as_of <= timedelta(days=4)
                        and (
                            answer.reference_date is None
                            or answer.reference_date == saved.reference_date
                        )
                    ):
                        answer = saved.model_copy(update={"prices_stale": True})
                except (OSError, ValueError):
                    LOGGER.debug("Global contribution cache is unavailable", exc_info=True)
            elif answer.rows and not answer.prices_stale:
                try:
                    atomic_bytes(path, answer.model_dump_json(by_alias=True).encode())
                except OSError:
                    LOGGER.debug("Global contribution cache could not be written", exc_info=True)
            self._contribution = (now, answer)
            return answer

    def global_sectors(self) -> GlobalSectorBoard:
        with self._global_sectors_lock:
            now, reference = self._global_reference()
            cached = self._global_sectors
            if cached and now == cached[0]:
                public = cached[1]
            else:
                weights, stale = self.world_sector_weights.get(now)
                public = read_global_sectors(self.prices, weights, stale, now, reference)
                self._global_sectors = (now, public)
        return with_portfolio_exposure(public, self.store)

    def market(self, scope: IndexScope) -> IndexMarket:
        with self._market_locks[scope]:
            return self._market(scope)

    def _sync_market_source(self) -> None:
        source = self.prices.alpaca_source if isinstance(self.prices, SharedMarketPrices) else None
        if source is not self._quote_source:
            self._markets.clear()
            self._histories.clear()
            self._baselines.clear()
            self._ndx_closes = None
            self._ndx_cache = None
            self._quote_source = source

    def _market(self, scope: IndexScope) -> IndexMarket:
        now = self.now()
        specs = list(active_indices(scope))
        clocks = {spec.id: _index_clock(spec, now) for spec in specs if spec.symbol}
        self._sync_market_source()
        cached = self._markets.get(scope)
        # Session-aware scopes slow down after the closing grace period.
        # Unscheduled series are demand-driven and cannot claim a live session.
        polling = any(
            window and now <= window.close + timedelta(hours=1) for _, window, _ in clocks.values()
        )
        calendar_status = {
            spec.id: calendar_known(
                spec.calendar, _CLOCKS.get(spec.calendar, (None, "UTC"))[1], now
            )
            for spec in specs
        }
        if (
            cached
            and now - cached[0] < timedelta(minutes=10 if polling else 30)
            and all(
                quote.calendar_known == calendar_status[quote.index.id]
                for quote in cached[1].quotes
            )
        ):
            return cached[1]
        path = self.root / f"{scope}.json"
        try:
            raw = json.loads(path.read_bytes())
            # Old quote snapshots predate the range catalog. Keep their quotes
            # available offline, with the existing exact-identity check below.
            if isinstance(raw, dict) and isinstance(raw.get("quotes"), list):
                for item in raw["quotes"]:
                    identity = item.get("index") if isinstance(item, dict) else None
                    if isinstance(identity, dict) and isinstance(identity.get("id"), str):
                        spec = INDEX_REGISTRY.get(identity["id"])
                        if spec:
                            identity.setdefault("ranges", list(spec.ranges))
            previous = IndexMarket.model_validate(raw)
        except (OSError, ValueError):
            previous = None
        saved = {quote.index.id: quote for quote in previous.quotes} if previous else {}
        fetch = []
        for spec in specs:
            if not spec.symbol:
                continue
            _, window, _ = clocks[spec.id]
            old = saved.get(spec.id)
            if (
                window
                and old
                and not is_alpaca_listing(spec.symbol)
                and old.index == index_identity(spec)
                and old.session_date == window.date
                and old.state == "closed"
                and old.change is not None
            ):
                continue
            fetch.append(spec)

        daily, intraday = {}, {}
        try:
            if fetch:
                intraday = self.prices.intraday(spec.symbol for spec in fetch if spec.symbol)
        except Exception:
            LOGGER.debug("Index intraday read failed", exc_info=True)
        needed = []
        for spec in fetch:
            _, window, _ = clocks[spec.id]
            if window is None:
                continue
            cached_baseline = self._baselines.get(spec.id)
            if cached_baseline and cached_baseline[:2] == (
                window.date,
                board_complete(window, now),
            ):
                daily[spec.id] = cached_baseline[2]
            else:
                needed.append(spec)
        try:
            if needed:
                rows = self.prices.daily(spec.symbol for spec in needed if spec.symbol)
                for spec in needed:
                    item = rows.get(spec.symbol or "")
                    if item is None:
                        continue
                    daily[spec.id] = item
                    zone, window, prior = clocks[spec.id]
                    if window and prior:
                        completed = board_complete(window, now)
                        closes = _dated(item, zone)
                        if prior in closes and (not completed or window.date in closes):
                            self._baselines[spec.id] = (window.date, completed, item)
        except Exception:
            LOGGER.debug("Index daily close read failed", exc_info=True)

        result = IndexMarket(scope=scope, quotes=[])
        fetched_ids = {spec.id for spec in fetch}
        for spec in specs:
            known = calendar_status[spec.id]
            quote = IndexQuote(index=index_identity(spec), calendar_known=known)
            old = saved.get(spec.id)
            if spec.id in fetched_ids:
                zone, window, prior = clocks[spec.id]
                item = intraday.get(spec.symbol or "")
                points = [point for point in _points(item) if point.at <= now]
                daily_item = daily.get(spec.id)
                from_alpaca = item is not None and item.source == ALPACA_INTRADAY
                if (
                    item
                    and daily_item
                    and daily_item.source != (ALPACA_SIP if from_alpaca else item.source)
                ):
                    daily_item = None
                closes = _dated(daily_item, zone)
                state = "observed"
                day = None
                if window:
                    day = window.date
                    points = [
                        p
                        for p in points
                        if window.open <= p.at <= window.close + timedelta(minutes=15)
                    ]
                    completed = board_complete(window, now)
                    official = None
                    if completed:
                        session_close = provider_session_close(item, window, now)
                        official = (
                            (session_close if spec.scope == "cn" else None)
                            or closes.get(window.date)
                            or session_close
                        )
                    if official is not None:
                        points = [p for p in points if p.at < window.close] + [
                            IndexPoint(at=window.close, value=official)
                        ]
                    expected = min(now, window.close)
                    if (
                        window.break_start
                        and window.break_end
                        and window.break_start <= now < window.break_end
                    ):
                        expected = window.break_start
                    state = (
                        "closed"
                        if official is not None
                        else "stale"
                        if completed
                        or (points and expected - points[-1].at > timedelta(minutes=35))
                        else "live"
                    )
                elif points:
                    day = points[-1].at.astimezone(zone).date().isoformat()
                    points = [p for p in points if p.at.astimezone(zone).date().isoformat() == day]
                    # A composite does not have a verified prior session here.
                    # Its feed must provide the reference; never subtract an
                    # arbitrary older daily bar from the latest print.
                base = (
                    item.previous_close
                    if from_alpaca
                    else closes.get(prior)
                    if prior
                    else (item.previous_close if item and not window else None)
                )
                if points:
                    if base is None and spec.scope == "cn" and window:
                        base = provider_previous_close(item, window)
                    last = points[-1]
                    change = None
                    if base:
                        change = (
                            last.value - base
                            if spec.kind == "volatility"
                            else last.value / base - 1
                        )
                    quote = IndexQuote(
                        index=index_identity(spec, (item or daily_item).source)
                        if item or daily_item
                        else quote.index,
                        calendar_known=known,
                        session_date=day,
                        level=last.value,
                        change=change,
                        as_of=last.at,
                        points=points,
                        state=state,
                    )
                if (
                    old
                    and old.index == quote.index
                    and old.as_of
                    and (
                        quote.as_of is None or (quote.state != "closed" and quote.as_of < old.as_of)
                    )
                ):
                    quote = old.model_copy(update={"state": "stale", "calendar_known": known})
                if quote.state in {"unavailable", "stale"} or (window and quote.change is None):
                    result.refresh_failed = True
            elif spec.symbol and old:
                quote = old
            result.quotes.append(quote)
        if fetch and any(quote.as_of for quote in result.quotes):
            try:
                atomic_bytes(path, result.model_dump_json(by_alias=True).encode())
            except OSError:
                LOGGER.debug("Index quote cache could not be written", exc_info=True)
        self._markets[scope] = (now, result)
        return result

    def history(self, spec: IndexSpec, period: IndexRange, gbp: bool) -> IndexHistory:
        key = (spec.id, period, gbp)
        with self._lock:
            self._sync_market_source()
            now = self.now()
            cached = self._histories.get(key)
            if cached and now - cached[0] < timedelta(minutes=4):
                return cached[1]
            currency = "GBP" if gbp and spec.currency else spec.currency
            result = IndexHistory(index=index_identity(spec), range=period, currency=currency)
            try:
                result = self._history(spec, period, gbp, result, now)
            except Exception:
                LOGGER.debug("Index history read failed", exc_info=True)
            if not result.points and cached and cached[1].points:
                result = cached[1].model_copy(update={"state": "stale"})
            self._histories[key] = (now, result)
            return result

    def _history(
        self,
        spec: IndexSpec,
        period: IndexRange,
        gbp: bool,
        result: IndexHistory,
        now: datetime,
    ) -> IndexHistory:
        if spec.symbol is None or period not in spec.ranges:
            return result
        zone, window, _ = _index_clock(spec, now)
        day = now.astimezone(zone).date()
        gaps: set[datetime] = set()
        quote = None
        is_intraday = period in INTRADAY_MINUTES
        series = None
        if period == "1D":
            quote = next((q for q in self.market(spec.scope).quotes if q.index.id == spec.id), None)
            points = quote.points if quote else []
            if quote:
                result.index = quote.index
        else:
            if period == "1W" or period == "1M":
                series = self.prices.history_bars(spec.symbol, period, now)
                cut = (
                    now - timedelta(days=7)
                    if period == "1W"
                    else (pd.Timestamp(now) - pd.DateOffset(months=1)).to_pydatetime()
                )
                rows = [
                    (at, value)
                    for at, value in _rows(series)
                    if cut <= at <= now
                    and (
                        value is not None or window is not None or at.astimezone(zone).weekday() < 5
                    )
                ]
                zone = _provider_zone(series, zone)
            elif period == "MAX":
                series = self.prices.history_bars(spec.symbol, period, now)
                rows = _weekly_rows(series, zone, now)
            else:
                last_complete = (
                    date.fromisoformat(window.date)
                    if window and board_complete(window, now)
                    else date.fromisoformat(window.date) - timedelta(days=1)
                    if window
                    else day - timedelta(days=1)
                )
                cut_day = (
                    pd.Timestamp(window.date if window else day) - DAILY_WINDOWS[period]
                ).date()
                if spec.hourly_close:
                    last_complete = now.astimezone(MSCI_ZONE).date() - timedelta(days=1)
                    series = self.prices.history_bars(spec.symbol, "1Y", now)
                    rows = _hourly_closes(series)
                    result.hourly_close = True
                else:
                    series = self.prices.history(spec.symbol)
                    rows = [
                        (_midnight(at.astimezone(zone).date()), value)
                        for at, value in _rows(series)
                        if value is not None or window or at.astimezone(zone).weekday() < 5
                    ]
                rows = [(at, value) for at, value in rows if cut_day <= at.date() <= last_complete]
                if window and (
                    first := next((at for at, value in rows if value is not None), None)
                ):
                    observed = {at.date().isoformat() for at, value in rows if value is not None}
                    calendar = _CLOCKS[spec.calendar][0]
                    gaps.update(
                        _midnight(date.fromisoformat(session.date))
                        for session in exchange_sessions(calendar, first.date(), last_complete)
                        if session.date not in observed
                    )
            # A provider may emit a live row beside a dated row. A null must
            # never override a price for the same date.
            values: dict[datetime, float] = {}
            for at, value in rows:
                if value is not None:
                    values[at] = value
            points = [IndexPoint(at=at, value=value) for at, value in sorted(values.items())]
            if not window or is_intraday or period == "MAX":
                gaps.update(at for at, value in rows if value is None and at not in values)
        if series is not None:
            result.index = index_identity(spec, series.source)
        if gbp and spec.currency not in {None, "GBP"} and points:
            fx = f"{spec.currency}GBP=X"
            if period == "1D":
                rates = _points(self.prices.intraday([fx]).get(fx))
            elif period == "1W" or period == "1M":
                rates = _points(self.prices.history_bars(fx, period, now))
            elif period == "MAX":
                series = self.prices.history_bars(fx, period, now)
                rates = [
                    IndexPoint(at=at, value=value)
                    for at, value in _weekly_rows(series, ZoneInfo("Europe/London"), now)
                    if value is not None
                ]
            else:
                series = self.prices.history(fx)
                fx_zone = _provider_zone(series, ZoneInfo("UTC"))
                rates = [
                    IndexPoint(at=_midnight(date.fromisoformat(day)), value=value)
                    for day, value in _dated(series, fx_zone).items()
                ]
            tolerance = (
                timedelta(days=7 if period == "MAX" else 5)
                if not is_intraday
                else timedelta(minutes=30 if period == "1D" else INTRADAY_MINUTES[period])
            )
            original = {point.at for point in points}
            points = _convert(points, rates, prior_period=not is_intraday, tolerance=tolerance)
            gaps.update(original - {point.at for point in points})
        if points:
            result.points = points
            result.as_of = points[-1].at
            result.gaps = sorted(gaps)
            result.state = (
                "stale"
                if quote and quote.state == "stale"
                else ("partial" if gaps else "available")
            )
            if period in {"1W", "1M"}:
                result.max_drawdown, result.volatility = _short_risk(points, gaps, zone, now)
            elif not is_intraday:
                result.max_drawdown, result.volatility = _risk(
                    points, gaps, periods_per_year=52 if period == "MAX" else 252
                )
        return result

    def context(self, spec: IndexSpec) -> IndexContext:
        funds, as_of = self._funds(spec)
        try:
            if spec.basket == "ndx":
                self._sync_market_source()
                with self._ndx_lock:
                    now = self.now()
                    window = latest_session("us", now)
                    cached = self._ndx_cache
                    previous = cached[1] if cached else None
                    late = bool(window and now >= window.close + timedelta(hours=1))
                    same_session = previous and window and previous.session_date == window.date
                    settled = same_session and (
                        (late and previous.as_of is not None)
                        or (
                            board_complete(window, now)
                            and previous.as_of == window.close
                            and previous.coverage >= 0.98
                        )
                    )
                    attempts = self._ndx_late_attempts
                    late_attempts = (
                        attempts[1] if attempts and window and attempts[0] == window.date else 0
                    )
                    interval = timedelta(minutes=60 if late else 15)
                    if (
                        window
                        and not settled
                        and late_attempts < 3
                        and (not cached or now - cached[0] >= interval)
                    ):
                        if late:
                            self._ndx_late_attempts = (window.date, late_attempts + 1)
                        try:
                            cached = (now, self._basket(spec))
                        except Exception:
                            LOGGER.debug("Nasdaq 100 basket refresh failed", exc_info=True)
                            cached = (now, previous)
                        self._ndx_cache = cached
                    basket = cached[1] if cached else None
            else:
                basket = self._basket(spec)
        except Exception:
            LOGGER.debug("Index basket read failed", exc_info=True)
            basket = None
        now = self.now()
        breadth = (
            self.depth.breadth(spec) if spec.id in BREADTH_MARKETS.get(spec.scope, ()) else None
        )
        vix = self.depth.vix() if spec.scope == "us" else None
        valuation, valuation_reference = self.depth.valuation(spec, now)
        return IndexContext(
            basket=basket,
            funds=funds,
            portfolio_as_of=as_of,
            exposure_gbp=round(sum(item.value_gbp for item in funds), 2) if funds else None,
            breadth_history=breadth,
            breadth_stale=breadth is not None and self.depth.breadth_stale(spec, breadth, now),
            vix=vix,
            vix_stale=vix is not None and self.depth.vix_stale(vix, now),
            valuation=valuation,
            valuation_reference=valuation_reference,
        )

    def _funds(self, spec: IndexSpec) -> tuple[list[IndexFundHolding], str | None]:
        manifest = self.store.latest_manifest()
        if manifest is None:
            return [], None
        portfolio = read_etf_portfolio(self.store, manifest.run_id)
        selected = {
            fund.isin: fund
            for fund in portfolio.funds
            if fund.isin
            and evidenced_benchmark_id(fund.index_name, fund.evidence) == spec.benchmark
        }
        if not selected:
            return [], portfolio.broker_as_of
        try:
            broker = self.store.read_json(manifest.run_id, BROKER_KEY)
        except FileNotFoundError:
            return [], portfolio.broker_as_of
        accounts = broker.get("accounts", {})
        by_isin: dict[str, list[tuple[float, float | None]]] = {}
        for account in accounts.values():
            for row in account.get("positions", []):
                if not isinstance(row, dict) or row.get("isin") not in selected:
                    continue
                try:
                    position = AccountPositionMetrics.model_validate(row)
                except ValidationError:
                    continue
                if position.current_value_gbp > 0:
                    by_isin.setdefault(position.isin, []).append(
                        (float(position.current_value_gbp), float(position.quantity))
                    )
        return [
            IndexFundHolding(
                isin=isin,
                ticker=selected[isin].tickers[0],
                name=selected[isin].name,
                value_gbp=round(sum(value for value, _ in lines), 2),
                shares=sum(shares for _, shares in lines if shares is not None)
                if all(shares is not None for _, shares in lines)
                else None,
            )
            for isin, lines in sorted(by_isin.items())
            if selected[isin].tickers
        ], portfolio.broker_as_of

    def _basket(self, spec: IndexSpec) -> IndexBasket | None:
        basket_id = spec.basket or spec.proxy_basket
        if basket_id is None:
            return None
        now = self.now()
        scope = cast(SectorMarketCode, spec.scope)
        window = latest_session(scope, now)
        if window is None:
            return None
        groups: dict[str, tuple[str, list[IndexContribution]]] = {}
        proxy_universe = None
        if spec.basket == "ndx":
            self._sync_market_source()
            # CNDX overlaps with CSPX. Both use the same per-listing price cache.
            # Only request dated baselines again if they were missing or to settle.
            universe = self.universes.get("ndx")
            symbols = [item.symbol for item in universe.constituents]
            quotes = self.prices.intraday(symbols)
            prior = prior_session_dates(scope, window.date, 1)
            zone = ZoneInfo(MARKETS[scope].timezone)
            completed = board_complete(window, now)
            closes_cache = self._ndx_closes
            dated = (
                dict(closes_cache[2])
                if closes_cache and closes_cache[:2] == (window.date, completed)
                else {}
            )
            needed = [symbol for symbol in symbols if symbol not in dated]
            if needed:
                pulled = self.prices.daily(needed)
                dated.update(pulled)
                self._ndx_closes = (
                    window.date,
                    completed,
                    {
                        symbol: item
                        for symbol, item in dated.items()
                        if prior
                        and prior[0] in (closes := _dated(item, zone))
                        and (not completed or window.date in closes)
                    },
                )
            fund, holdings_date, session_date = universe.fund_ticker, universe.as_of, window.date
            source_url = universe.source_url
            holdings_fetched_at = datetime.fromisoformat(universe.fetched_at)
            fetched_at = max(
                (item.fetched_at for item in quotes.values() if item.fetched_at is not None),
                default=None,
            )
            as_of = None
            sources = set()
            for member in universe.constituents:
                item = quotes.get(member.symbol)
                daily_item = dated.get(member.symbol)
                from_alpaca = item is not None and item.source == ALPACA_INTRADAY
                if (
                    item
                    and daily_item
                    and daily_item.source != (ALPACA_SIP if from_alpaca else item.source)
                ):
                    daily_item = None
                closes = _dated(daily_item, zone)
                base = (
                    item.previous_close if from_alpaca else closes.get(prior[0]) if prior else None
                )
                session = (
                    member_session(
                        item.timestamps,
                        item.closes,
                        base,
                        session_open=window.open,
                        session_close=window.close,
                    )
                    if item
                    else None
                )
                if completed:
                    session = settle(
                        session,
                        closes.get(window.date) or provider_session_close(item, window, now),
                        base,
                        session_close=window.close,
                    )
                if session is not None:
                    if item or daily_item:
                        sources.add((item or daily_item).source)
                    as_of = max(as_of or session.observed_at, session.observed_at)
                groups.setdefault(member.sector_code, (member.sector_name, []))[1].append(
                    IndexContribution(
                        key=member.symbol,
                        name=member.name,
                        weight=member.weight,
                        contribution=member.weight * session.change if session else None,
                    )
                )
            prices_source = market_price_sources(sources)
        else:
            board = self.boards.load(basket_id)
            if board is None:
                return None
            grouping = next((g for g in board.groupings if g.kind == "gics"), None)
            if grouping is None:
                return None
            fund, holdings_date, session_date = (
                board.source.fund_ticker,
                board.source.as_of,
                board.session_date,
            )
            as_of = board.as_of
            source_url = board.source.url
            prices_source = board.source.prices
            fetched_at = board.fetched_at
            holdings_fetched_at = board.source.holdings_fetched_at
            proxy_universe = board.source.universe if spec.proxy_basket else None
            for group in grouping.groups:
                groups[group.key] = (
                    group.name,
                    [
                        IndexContribution(
                            key=item.symbol,
                            name=item.name,
                            weight=item.weight,
                            contribution=item.weight * item.change
                            if item.change is not None and spec.basket in {"us", "uk"}
                            else None,
                        )
                        for item in group.members
                    ],
                )
        members = [member for _, group in groups.values() for member in group]
        priced = [m for m in members if m.contribution is not None and m.weight > 0]
        coverage = sum(m.weight for m in priced)
        estimate = sum(m.contribution or 0 for m in priced) if priced else None
        breadth = SectorBreadth()
        for member in priced:
            move = (member.contribution or 0) / member.weight
            if move > FLAT_BAND + 1e-9:
                breadth.up += 1
            elif move < -FLAT_BAND - 1e-9:
                breadth.down += 1
            else:
                breadth.flat += 1
        residual = None
        # Compare only contemporaneous reads of the same session; missing
        # constituent weights stay missing in the contribution arithmetic.
        if estimate is not None and spec.kind == "index" and spec.basis == "price" and as_of:
            quote = next((q for q in self.market(scope).quotes if q.index.id == spec.id), None)
            if (
                quote
                and quote.state != "stale"
                and quote.session_date == session_date
                and quote.change is not None
                and quote.as_of
                and abs(quote.as_of - as_of) <= timedelta(minutes=5)
            ):
                residual = quote.change - estimate
        return IndexBasket(
            fund=fund,
            holdings_date=holdings_date,
            session_date=session_date,
            as_of=as_of,
            coverage=coverage,
            breadth=breadth,
            leaders=sorted(
                (m for m in priced if (m.contribution or 0) > 0),
                key=lambda m: -(m.contribution or 0),
            )[:5],
            laggards=sorted(
                (m for m in priced if (m.contribution or 0) < 0), key=lambda m: m.contribution or 0
            )[:5],
            top_holdings=sorted(members, key=lambda m: -m.weight)[:10],
            sectors=[
                IndexContribution(
                    key=key,
                    name=name,
                    weight=sum(m.weight for m in group),
                    contribution=sum(m.contribution or 0 for m in group)
                    if any(m.contribution is not None for m in group)
                    else None,
                )
                for key, (name, group) in groups.items()
            ],
            estimated_move=estimate,
            residual=residual,
            proxy_universe=proxy_universe,
            source_url=source_url,
            prices_source=prices_source,
            fetched_at=fetched_at,
            holdings_fetched_at=holdings_fetched_at,
        )
