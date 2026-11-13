"""Daily index context. Requests only read published snapshots; the market monitor builds them."""

from __future__ import annotations

import logging
from collections import deque
from collections.abc import Callable, Iterator, Mapping, Sequence
from datetime import date, datetime, timedelta
from math import ceil, isclose
from pathlib import Path
from typing import cast
from zoneinfo import ZoneInfo

from pydantic import Field
from trading_max.infrastructure.alpaca_market_prices import (
    ALPACA_BATCH_SIZE,
    ALPACA_SIP,
    market_price_sources,
)
from trading_max.infrastructure.durable_files import atomic_bytes
from trading_max.infrastructure.sector_prices import (
    BATCH_SIZE,
    YAHOO_SOURCE,
    SparkRateLimited,
    SparkSeries,
)
from trading_max.infrastructure.sector_universe import (
    UNIVERSES,
    SectorUniverse,
    SectorUniverseProvider,
)
from trading_max.infrastructure.shared_market_prices import (
    MarketPriceBudgetExhausted,
    SharedMarketPrices,
)
from trading_max.reference.indices import INDEX_REGISTRY, IndexSpec

from .index_models import (
    IndexBreadthHistory,
    IndexBreadthPoint,
    IndexValuationReference,
    IndexValuationSnapshot,
    IndexVixContext,
)
from .models import ApiModel
from .sector_models import SectorMarketCode, SectorSessionWindow
from .sector_sessions import MARKETS, board_complete, exchange_sessions, sessions_between

LOGGER = logging.getLogger(__name__)
BREADTH_MARKETS: dict[SectorMarketCode, tuple[str, ...]] = {
    "us": ("sp-500", "nasdaq-100"),
    "uk": ("ftse-100",),
    "jp": ("msci-japan",),
}
BREADTH_SESSIONS = 252
MAX_LOOKBACK_SESSIONS = 210
MIN_BREADTH_COVERAGE = 0.8
VIX_SOURCE = "Cboe VIX via Yahoo Finance (^VIX)"
ATTEMPT_INTERVAL = timedelta(hours=1)


def _valuation_references() -> dict[str, IndexValuationReference]:
    refs = {
        key: IndexValuationReference(
            source=f"iShares {UNIVERSES[basket].fund_ticker}",
            source_url=UNIVERSES[basket].source_url,
            basis="etf",
        )
        for key, basket in {"sp-500": "us", "nasdaq-100": "ndx", "ftse-100": "uk"}.items()
    }
    for key, slug in {
        "msci-world": "msci-world-index",
        "msci-world-ex-usa": "msci-world-ex-usa-index",
        "msci-acwi": "msci-acwi-index",
        "msci-em": "msci-em-emerging-markets-index-2",
        "msci-em-imi": "msci-em-emerging-markets-imi-index",
        "msci-japan": "msci-japan-index",
    }.items():
        refs[key] = IndexValuationReference(
            source="MSCI",
            source_url=f"https://www.msci.com/indexes/index/{INDEX_REGISTRY[key].compiler_id}/{slug}",
            basis="index",
        )
    return refs


VALUATION_REFERENCES = _valuation_references()


class BreadthCloses(ApiModel):
    fetched_at: datetime
    isin: str = ""
    source: str = YAHOO_SOURCE
    values: dict[str, float]


class _BreadthInputs(ApiModel):
    schema_version: int = 1
    preferred_source: str = YAHOO_SOURCE
    closes: dict[str, BreadthCloses]


class _LocalValuation(ApiModel):
    as_of: date
    fetched_at: datetime
    pe: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    forward_pe: float | None = Field(default=None, gt=0, allow_inf_nan=False)


def _read[T: ApiModel](path: Path, model: type[T]) -> T | None:
    try:
        return model.model_validate_json(path.read_bytes())
    except (OSError, ValueError):
        return None


def _write(path: Path, data: ApiModel) -> None:
    atomic_bytes(path, data.model_dump_json().encode())


def _batches(symbols: list[str], size: int = BATCH_SIZE) -> Iterator[list[str]]:
    # Keep the provider's round-robin mix of large and small listings.
    count = -(-len(symbols) // size)
    for index in range(count):
        yield symbols[index::count]


def _completed(sessions: Sequence[SectorSessionWindow], now: datetime) -> list[str]:
    return [session.date for session in sessions if board_complete(session, now)]


def _dated(series: SparkSeries, zone: ZoneInfo, valid: set[str]) -> dict[str, float]:
    return {
        day: close
        for stamp, close in zip(series.timestamps, series.closes, strict=False)
        if close is not None
        and (day := datetime.fromtimestamp(stamp, zone).date().isoformat()) in valid
    }


def _compatible(older: Mapping[str, float], recent: Mapping[str, float]) -> bool:
    overlap = older.keys() & recent.keys()
    return bool(overlap) and all(isclose(older[d], recent[d], rel_tol=1e-5) for d in overlap)


def _breadth(
    universe: SectorUniverse,
    dates: list[str],
    inputs: Mapping[str, BreadthCloses],
    now: datetime,
) -> IndexBreadthHistory | None:
    members = {item.symbol for item in universe.constituents if item.weight > 0}
    available = [inputs[symbol] for symbol in members if symbol in inputs]
    if not available:
        return None
    start = max(0, len(dates) - BREADTH_SESSIONS)
    counts = {period: [[0, 0] for _ in dates[start:]] for period in (50, 200)}
    for series in available:
        for period, readings in counts.items():
            window: deque[tuple[int, float]] = deque()
            total = 0.0
            # A 50/200-day average uses the last 50/200 observed closes.
            # A few missed sessions do not invalidate 200 otherwise usable
            # prices, but stale or heavily interrupted lookbacks do.
            max_age = ceil(period * 1.05)
            for index, day in enumerate(dates):
                price = series.values.get(day)
                if price is None:
                    continue
                window.append((index, price))
                total += price
                if len(window) > period:
                    total -= window.popleft()[1]
                if index >= start and len(window) == period and index - window[0][0] < max_age:
                    slot = readings[index - start]
                    slot[0] += int(
                        price > total / period and not isclose(price, total / period, rel_tol=1e-12)
                    )
                    slot[1] += 1
    minimum = ceil(len(members) * MIN_BREADTH_COVERAGE)
    points = []
    for day, (above50, eligible50), (above200, eligible200) in zip(
        dates[start:], counts[50], counts[200], strict=True
    ):
        points.append(
            IndexBreadthPoint(
                date=day,
                above_50=above50 / eligible50 if eligible50 >= minimum else None,
                above_200=above200 / eligible200 if eligible200 >= minimum else None,
                eligible_50=eligible50,
                eligible_200=eligible200,
            )
        )
    first = next(
        (i for i, p in enumerate(points) if p.above_50 is not None or p.above_200 is not None), None
    )
    if first is None:
        return None
    return IndexBreadthHistory(
        fund=universe.fund_ticker,
        holdings_url=universe.source_url,
        holdings_as_of=date.fromisoformat(universe.as_of),
        holdings_fetched_at=datetime.fromisoformat(universe.fetched_at),
        prices_source=market_price_sources(item.source for item in available),
        prices_fetched_at=max(item.fetched_at for item in available),
        calculated_at=now,
        as_of=next(
            p.date for p in reversed(points) if p.above_50 is not None or p.above_200 is not None
        ),
        members=len(members),
        points=points[first:],
    )


def _vix(
    series: SparkSeries,
    dates: list[str],
    now: datetime,
) -> IndexVixContext | None:
    # Chart bars are labelled in Chicago. Exclude weekends, holidays and the
    # unfinished daily bar even if the provider returns a live mark in it.
    closes = _dated(series, ZoneInfo("America/Chicago"), set(dates))
    latest = closes.get(dates[-1])
    sample = sorted(day for day in closes if day < dates[-1])
    if latest is None or len(sample) < ceil((len(dates) - 1) * 0.95):
        return None
    values = sorted(closes[day] for day in sample)
    return IndexVixContext(
        source=VIX_SOURCE,
        as_of=dates[-1],
        fetched_at=series.fetched_at or now,
        sample_start=sample[0],
        sample_end=sample[-1],
        sample_size=len(values),
        close=latest,
        percentile=sum(value <= latest for value in values) / len(values),
        p10=values[ceil(0.10 * len(values)) - 1],
        p90=values[ceil(0.90 * len(values)) - 1],
    )


class IndexDepth:
    """Compute bounded public context after sector refreshes using the same price budget."""

    def __init__(
        self,
        root: Path,
        prices: SharedMarketPrices,
        universes: SectorUniverseProvider | None = None,
    ) -> None:
        self.root = root / "state" / "indices" / "depth-v1"
        self.valuation_root = root / "reference" / "index-valuations"
        self.prices = prices
        self.universes = universes or SectorUniverseProvider(root)
        self._attempts: dict[str, tuple[str, datetime, int]] = {}

    def breadth(self, spec: IndexSpec) -> IndexBreadthHistory | None:
        return _read(self.root / f"{spec.id}.json", IndexBreadthHistory)

    def vix(self) -> IndexVixContext | None:
        return _read(self.root / "vix-context.json", IndexVixContext)

    def valuation(
        self,
        spec: IndexSpec,
        now: datetime,
    ) -> tuple[IndexValuationSnapshot | None, IndexValuationReference | None]:
        ref = VALUATION_REFERENCES.get(spec.id)
        if ref is None:
            return None, None
        snapshot = _read(self.valuation_root / f"{spec.id}.json", _LocalValuation)
        if snapshot is None or (snapshot.pe is None and snapshot.forward_pe is None):
            return None, ref
        if snapshot.fetched_at.tzinfo is None or not (
            snapshot.as_of <= snapshot.fetched_at.date() and snapshot.fetched_at <= now
        ):
            return None, ref
        return IndexValuationSnapshot(**ref.model_dump(), **snapshot.model_dump()), ref

    @staticmethod
    def _market_dates(market: SectorMarketCode, now: datetime, *, days: int) -> list[str]:
        today = now.astimezone(ZoneInfo(MARKETS[market].timezone)).date()
        return _completed(sessions_between(market, today - timedelta(days=days), today), now)

    @staticmethod
    def _vix_dates(now: datetime, *, days: int) -> list[str]:
        today = now.astimezone(ZoneInfo("America/Chicago")).date()
        return _completed(exchange_sessions("XCBF", today - timedelta(days=days), today), now)

    def breadth_stale(self, spec: IndexSpec, history: IndexBreadthHistory, now: datetime) -> bool:
        dates = self._market_dates(cast(SectorMarketCode, spec.scope), now, days=14)
        return bool(dates and history.as_of.isoformat() < dates[-1])

    def vix_stale(self, vix: IndexVixContext, now: datetime) -> bool:
        dates = self._vix_dates(now, days=14)
        return bool(dates and vix.as_of.isoformat() < dates[-1])

    def _attempt(self, key: str, day: str, now: datetime) -> bool:
        last = self._attempts.get(key)
        tries = 0
        if last is not None and last[0] == day:
            if now - last[1] < ATTEMPT_INTERVAL or last[2] >= 3:
                return False
            tries = last[2]
        self._attempts[key] = (day, now, tries + 1)
        return True

    def refresh(
        self,
        market: SectorMarketCode,
        now: datetime,
        *,
        settled: Callable[[str], Mapping[str, BreadthCloses]],
        check_active: Callable[[], None],
    ) -> None:
        """Run only after the market monitor's ordinary quote work."""
        if market == "us":
            self._refresh_vix(now, check_active)
        try:
            self._refresh_breadth(market, now, settled, check_active)
        except (SparkRateLimited, MarketPriceBudgetExhausted):
            # The shared pause/budget takes precedence. The prior snapshot stays visible.
            return

    def _refresh_breadth(
        self,
        market: SectorMarketCode,
        now: datetime,
        settled: Callable[[str], Mapping[str, BreadthCloses]],
        check_active: Callable[[], None],
    ) -> None:
        ids = BREADTH_MARKETS[market]
        dates = self._market_dates(market, now, days=14)
        if not dates:
            return
        day = dates[-1]
        snapshots = [self.breadth(INDEX_REGISTRY[key]) for key in ids]
        path = self.root / f"{market}-closes.json"
        prefer_alpaca = (
            market == "us"
            and isinstance(self.prices, SharedMarketPrices)
            and self.prices.alpaca_source is not None
        )
        preferred_source = ALPACA_SIP if prefer_alpaca else YAHOO_SOURCE
        cache = _read(path, _BreadthInputs)
        same_provider = cache is None or cache.preferred_source == preferred_source
        if same_provider and all(
            snapshot and snapshot.as_of.isoformat() >= day for snapshot in snapshots
        ):
            return
        if not same_provider:
            self._attempts.pop(market, None)
        last_attempt = self._attempts.get(market)
        if not self._attempt(market, day, now):
            return
        try:
            dates = self._market_dates(market, now, days=740)[
                -(BREADTH_SESSIONS + MAX_LOOKBACK_SESSIONS - 1) :
            ]
            zone = ZoneInfo(MARKETS[market].timezone)
            valid = set(dates)
            baskets = {}
            for key in ids:
                check_active()
                try:
                    baskets[key] = self.universes.get(cast(str, INDEX_REGISTRY[key].basket))
                except Exception:
                    LOGGER.warning("Index breadth holdings unavailable for %s", key, exc_info=True)
            members: dict[str, str] = {}
            for basket in baskets.values():
                for item in basket.constituents:
                    if item.weight > 0:
                        members[item.symbol] = item.isin or members.get(item.symbol, "")
            old = cache.closes if cache and cache.schema_version == 1 else {}
            old = {
                symbol: old[symbol]
                for symbol, isin in members.items()
                if symbol in old and (not isin or old[symbol].isin == isin)
            }
            # When the preferred provider changes, replace a complete history
            # before adding any new closes; already published snapshots stay readable.
            forced = {
                symbol
                for symbol, item in old.items()
                if not same_provider and item.source != preferred_source
            }
            inputs = {
                symbol: values
                for symbol, values in old.items()
                if day in values.values and symbol not in forced
            }
            # Bootstrapping needs long history regardless of the one-month cache.
            reusable = settled(day)
            recent = {symbol: reusable[symbol] for symbol in members if symbol in reusable}
            missing = [
                symbol
                for symbol in old
                if symbol not in recent and symbol not in inputs and symbol not in forced
            ]
            check_active()
            session = exchange_sessions(
                MARKETS[market].calendar, date.fromisoformat(day), date.fromisoformat(day)
            )[-1]
            deferred = False
            batch_size = ALPACA_BATCH_SIZE if prefer_alpaca else BATCH_SIZE
            # Work in provider batches so a budget deferral can retain completed
            # reads and the next monitor slot can resume without starting over.
            for batch in _batches(missing, batch_size):
                check_active()
                try:
                    quotes = self.prices.daily(batch, not_before=session.close)
                except (SparkRateLimited, MarketPriceBudgetExhausted):
                    deferred = True
                    break
                for symbol, series in quotes.items():
                    recent[symbol] = BreadthCloses(
                        fetched_at=series.fetched_at or now,
                        values=_dated(series, zone, valid),
                        source=series.source,
                    )
            replaced = set(forced)
            for symbol, newer in recent.items():
                before = old.get(symbol)
                if before is None or symbol in inputs or day not in newer.values:
                    continue
                if before.source == newer.source and _compatible(before.values, newer.values):
                    inputs[symbol] = BreadthCloses(
                        fetched_at=newer.fetched_at,
                        isin=members[symbol],
                        values=before.values | newer.values,
                        source=newer.source,
                    )
                else:
                    # A split/correction revised the historical price basis, or
                    # the workspace was offline too long. Do not stitch the two.
                    replaced.add(symbol)
            backfill = [
                symbol
                for symbol in members
                if (symbol not in old or symbol in replaced) and symbol not in inputs
            ]
            if not deferred:
                for batch in _batches(backfill, batch_size):
                    check_active()
                    try:
                        histories = self.prices.breadth_history(batch)
                    except (SparkRateLimited, MarketPriceBudgetExhausted):
                        deferred = True
                        break
                    except RuntimeError:
                        LOGGER.warning(
                            "Index breadth history batch failed for %s", market, exc_info=True
                        )
                        continue
                    for symbol, series in histories.items():
                        if series.fetched_at and series.fetched_at < session.close:
                            continue
                        closes = _dated(series, zone, valid)
                        if closes:
                            inputs[symbol] = BreadthCloses(
                                fetched_at=series.fetched_at or now,
                                isin=members[symbol],
                                values=closes,
                                source=series.source,
                            )
            if deferred:
                if last_attempt is None:
                    self._attempts.pop(market, None)
                else:
                    self._attempts[market] = last_attempt
            # Retain older prices for a missing session; leave that session blank.
            closes = old | inputs
            closes = {
                symbol: BreadthCloses(
                    fetched_at=series.fetched_at,
                    isin=series.isin,
                    source=series.source,
                    values={d: p for d, p in series.values.items() if d in valid},
                )
                for symbol, series in closes.items()
            }
            if not closes or (deferred and not inputs):
                return
            check_active()
            _write(
                path,
                _BreadthInputs(
                    closes=closes,
                    preferred_source=cache.preferred_source
                    if deferred and cache is not None
                    else preferred_source,
                ),
            )
            for key, basket in baskets.items():
                if snapshot := _breadth(basket, dates, closes, now):
                    previous = self.breadth(INDEX_REGISTRY[key])
                    if (
                        previous is None
                        or snapshot.as_of > previous.as_of
                        or (snapshot.as_of == previous.as_of and not deferred)
                    ):
                        _write(self.root / f"{key}.json", snapshot)
        except (SparkRateLimited, MarketPriceBudgetExhausted):
            raise
        except Exception:
            LOGGER.warning("Index breadth refresh failed for %s", market, exc_info=True)

    def _refresh_vix(self, now: datetime, check_active: Callable[[], None]) -> None:
        dates = self._vix_dates(now, days=14)
        if not dates:
            return
        day = dates[-1]
        previous = self.vix()
        if (previous and previous.as_of.isoformat() >= day) or not self._attempt("vix", day, now):
            return
        try:
            check_active()
            current = date.fromisoformat(day)
            session = exchange_sessions("XCBF", current, current)[-1]
            series = self.prices.history("^VIX", not_before=session.close)
            if series is not None:
                # 5Y history includes the close under comparison; compare with
                # earlier sessions only and respect the provider's actual coverage.
                reference = self._vix_dates(now, days=365 * 5 + 2)
                if snapshot := _vix(series, reference, now):
                    check_active()
                    _write(self.root / "vix-context.json", snapshot)
        except (SparkRateLimited, MarketPriceBudgetExhausted):
            return
        except Exception:
            LOGGER.warning("VIX context refresh failed", exc_info=True)
