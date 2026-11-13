"""Share price requests across sectors, indices and overlapping baskets."""

from __future__ import annotations

import threading
import time
from calendar import monthrange
from collections import deque
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import quote

from yfinance.exceptions import YFRateLimitError

from .alpaca_http import AlpacaDataError
from .alpaca_market_prices import ALPACA_BATCH_SIZE, AlpacaMarketPrices, is_alpaca_listing
from .sector_prices import (
    BATCH_SIZE,
    SparkRateLimited,
    SparkSeries,
    YahooSparkPrices,
    _points,
    _price,
    _yahoo_get,
)

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
RATE_LIMIT_SECONDS = 30 * 60
# Reserve capacity for the opening and official closing reads. Limits apply
# across all market surfaces, including chart calls and failed requests.
REQUEST_BUDGET = ((60, 64, 96), (86400, 3200, 4000))
_priority = ContextVar("market_price_priority", default=False)


class MarketPriceBudgetExhausted(RuntimeError):
    """The shared market budget will make room as older requests age out."""


@contextmanager
def market_price_priority(enabled: bool) -> Iterator[None]:
    token = _priority.set(enabled)
    try:
        yield
    finally:
        _priority.reset(token)


@dataclass
class MarketPriceFallback:
    deferred: bool = False


_fallback: ContextVar[MarketPriceFallback | None] = ContextVar(
    "market_price_fallback", default=None
)


@contextmanager
def market_price_fallback() -> Iterator[MarketPriceFallback]:
    """Allow read-only views to use cached data when fresh requests are blocked."""
    state = MarketPriceFallback()
    token = _fallback.set(state)
    try:
        yield state
    finally:
        _fallback.reset(token)


class SharedMarketPrices:
    """Deduplicate concurrent work, cache by listing and pause on a provider 429."""

    def __init__(
        self,
        source: YahooSparkPrices | None = None,
        *,
        alpaca: Callable[[], AlpacaMarketPrices | None] | None = None,
    ) -> None:
        self.source = source or YahooSparkPrices()
        self._alpaca = alpaca
        self._alpaca_lock = threading.Lock()
        self._alpaca_source: AlpacaMarketPrices | None = None
        self._alpaca_cache: dict[tuple[str, str], tuple[float, SparkSeries | None]] = {}
        self._lock = threading.Lock()
        self._paused_until = 0.0
        self._requests: dict[int, deque[float]] = {
            window: deque() for window, _, _ in REQUEST_BUDGET
        }
        self._cache: dict[tuple[str, str], tuple[float, SparkSeries | None]] = {}

    @property
    def alpaca_source(self) -> AlpacaMarketPrices | None:
        return self._alpaca() if self._alpaca is not None else None

    @property
    def rate_limited(self) -> bool:
        return time.monotonic() < self._paused_until

    def _reserve(self, now: float, cost: int) -> None:
        for window, ordinary, total in REQUEST_BUDGET:
            used = self._requests[window]
            while used and used[0] <= now - window:
                used.popleft()
            if len(used) + cost > (total if _priority.get() else ordinary):
                raise MarketPriceBudgetExhausted("Shared market price request budget reached")
        for used in self._requests.values():
            used.extend([now] * cost)

    @contextmanager
    def yahoo_request(self) -> Iterator[None]:
        """Charge a direct market chart request against the same Yahoo budget."""
        with self._lock:
            now = time.monotonic()
            if now < self._paused_until:
                raise SparkRateLimited("Yahoo Finance price requests are paused")
            self._reserve(now, 1)
        try:
            yield
        except (SparkRateLimited, YFRateLimitError):
            with self._lock:
                self._paused_until = time.monotonic() + RATE_LIMIT_SECONDS
            raise SparkRateLimited("Yahoo Finance is rate-limiting price requests") from None

    def _alpaca_read(
        self,
        kind: str,
        symbols: list[str],
        ttl: int,
        load: Callable[[AlpacaMarketPrices, list[str]], Mapping[str, SparkSeries]],
        not_before: datetime | None,
    ) -> dict[str, SparkSeries]:
        if self._alpaca is None or not symbols:
            return {}
        with self._alpaca_lock:
            source = self.alpaca_source
            if source is not self._alpaca_source:
                self._alpaca_cache.clear()
                self._alpaca_source = source
            if source is None:
                return {}
            now = time.monotonic()
            missing = []
            result = {}
            for symbol in symbols:
                expires, item = self._alpaca_cache.get((kind, symbol), (0, None))
                if expires <= now or (
                    item is not None
                    and not_before is not None
                    and (item.fetched_at is None or item.fetched_at < not_before)
                ):
                    missing.append(symbol)
                elif item is not None:
                    result[symbol] = item
            for start in range(0, len(missing), ALPACA_BATCH_SIZE):
                batch = missing[start : start + ALPACA_BATCH_SIZE]
                fetched = datetime.now(UTC)
                try:
                    rows = load(source, batch)
                except AlpacaDataError:
                    # No waiting for Alpaca's budget and no replay of a failed
                    # page. Yahoo receives the remaining symbols.
                    for symbol in missing[start:]:
                        self._alpaca_cache[kind, symbol] = (time.monotonic() + 15, None)
                    break
                for symbol in batch:
                    item = rows.get(symbol)
                    if item is not None:
                        item = result[symbol] = replace(item, fetched_at=fetched)
                    self._alpaca_cache[kind, symbol] = (
                        time.monotonic() + (ttl if item is not None else min(ttl, 60)),
                        item,
                    )
            if len(self._alpaca_cache) > 4096:
                self._alpaca_cache = {
                    key: item for key, item in self._alpaca_cache.items() if item[0] > now
                }
            # Settings can change while the HTTP calls are in flight.
            return result if self._alpaca() is source else {}

    def _read(
        self,
        kind: str,
        symbols: Iterable[str],
        ttl: int,
        load: Callable[[list[str]], Mapping[str, SparkSeries]],
        *,
        not_before: datetime | None = None,
        alpaca_load: Callable[[AlpacaMarketPrices, list[str]], Mapping[str, SparkSeries]]
        | None = None,
    ) -> dict[str, SparkSeries]:
        unique = list(dict.fromkeys(symbol.strip().upper() for symbol in symbols if symbol.strip()))
        alpaca = (
            self._alpaca_read(
                kind, [s for s in unique if is_alpaca_listing(s)], ttl, alpaca_load, not_before
            )
            if alpaca_load is not None
            else {}
        )
        missing = [symbol for symbol in unique if symbol not in alpaca]
        if not missing:
            return alpaca
        if not alpaca or _fallback.get() is not None:
            return alpaca | self._read_yahoo(kind, missing, ttl, load, not_before=not_before)
        # Keep successful Alpaca names even if the Yahoo fallback is paused.
        with market_price_fallback():
            return alpaca | self._read_yahoo(kind, missing, ttl, load, not_before=not_before)

    def _read_yahoo(
        self,
        kind: str,
        symbols: Iterable[str],
        ttl: int,
        load: Callable[[list[str]], Mapping[str, SparkSeries]],
        *,
        not_before: datetime | None = None,
    ) -> dict[str, SparkSeries]:
        unique = list(dict.fromkeys(symbol.strip().upper() for symbol in symbols if symbol.strip()))
        with self._lock:
            now = time.monotonic()

            def expired(symbol: str) -> bool:
                expires, item = self._cache.get((kind, symbol), (0, None))
                return expires <= now or (
                    item is not None
                    and not_before is not None
                    and (item.fetched_at is None or item.fetched_at < not_before)
                )

            wanted = [symbol for symbol in unique if expired(symbol)]
            if wanted:
                try:
                    if now < self._paused_until:
                        raise SparkRateLimited("Yahoo Finance price requests are paused")
                    self._reserve(now, -(-len(wanted) // BATCH_SIZE))
                    try:
                        fetched_at = datetime.now(UTC)
                        result = load(wanted)
                    except (SparkRateLimited, YFRateLimitError) as exc:
                        self._paused_until = time.monotonic() + RATE_LIMIT_SECONDS
                        raise SparkRateLimited(
                            "Yahoo Finance is rate-limiting price requests"
                        ) from exc
                except (SparkRateLimited, MarketPriceBudgetExhausted):
                    fallback = _fallback.get()
                    if fallback is None:
                        raise
                    fallback.deferred = True
                    return {
                        symbol: replace(item, stale=True) if expired(symbol) else item
                        for symbol in unique
                        if (item := self._cache.get((kind, symbol), (0, None))[1]) is not None
                    }
                for symbol in wanted:
                    self._cache[kind, symbol] = (
                        time.monotonic() + (ttl if symbol in result else min(ttl, 60)),
                        replace(result[symbol], fetched_at=fetched_at)
                        if symbol in result
                        else None,
                    )
                if len(self._cache) > 4096:
                    self._cache = {
                        key: value
                        for key, value in self._cache.items()
                        if value[0] > now
                        or (value[1] is not None and value[0] > now - RATE_LIMIT_SECONDS)
                    }
            return {
                symbol: item
                for symbol in unique
                if (item := self._cache.get((kind, symbol), (0, None))[1]) is not None
            }

    def intraday(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        return self._read(
            "intraday", symbols, 240, self.source.intraday, alpaca_load=AlpacaMarketPrices.intraday
        )

    def daily(
        self, symbols: Iterable[str], *, not_before: datetime | None = None
    ) -> dict[str, SparkSeries]:
        return self._read(
            "daily",
            symbols,
            240,
            self.source.daily,
            not_before=not_before,
            alpaca_load=AlpacaMarketPrices.daily,
        )

    def breadth_history(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        return self._read(
            "breadth-2y",
            symbols,
            240,
            self.source.breadth_history,
            alpaca_load=AlpacaMarketPrices.breadth_history,
        )

    def benchmark_intraday_batch(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        """Read five-minute marks across the prior close in a batched spark request."""
        return self._read("benchmark-batch-5m", symbols, 240, self.source.benchmark_intraday)

    def benchmark_intraday(self, symbol: str, *, extended: bool = False) -> SparkSeries | None:
        """Keep enough five-minute history to identify carried official benchmark closes."""
        window = "1mo" if extended else "5d"
        return self._chart(
            f"benchmark-{window}-5m", symbol, {"range": window, "interval": "5m"}, 240
        )

    def history(self, symbol: str, *, not_before: datetime | None = None) -> SparkSeries | None:
        return self._chart(
            "5y-daily", symbol, {"range": "5y", "interval": "1d"}, 30 * 60, not_before=not_before
        )

    def history_bars(
        self, symbol: str, window: Literal["1W", "1M", "1Y", "MAX"], now: datetime
    ) -> SparkSeries | None:
        if window == "1W":
            start, interval, ttl = int((now - timedelta(days=7)).timestamp()), "30m", 5 * 60
        elif window == "1M":
            year, month = (now.year, now.month - 1) if now.month > 1 else (now.year - 1, 12)
            prior_month = now.replace(
                year=year, month=month, day=min(now.day, monthrange(year, month)[1])
            )
            start, interval, ttl = int(prior_month.timestamp()), "60m", 20 * 60
        elif window == "1Y":
            # Extra days cover a leap year and the NY date boundary.
            start, interval, ttl = int((now - timedelta(days=370)).timestamp()), "60m", 4 * 3600
        else:
            # Yahoo's range=max can silently coarsen even an explicit 1wk request.
            start, interval, ttl = 0, "1wk", 4 * 3600
        return self._chart(
            window,
            symbol,
            {"period1": str(start), "period2": str(int(now.timestamp())), "interval": interval},
            ttl,
        )

    def _chart(
        self,
        kind: str,
        symbol: str,
        params: dict[str, str],
        ttl: int,
        *,
        not_before: datetime | None = None,
    ) -> SparkSeries | None:
        symbol = symbol.strip().upper()

        def load(_: list[str]) -> dict[str, SparkSeries]:
            response = _yahoo_get(CHART_URL + quote(symbol, safe=""), params, 12)
            if response.status_code == 429:
                raise SparkRateLimited("Yahoo Finance is rate-limiting price requests")
            if response.status_code == 404:
                return {}
            if response.status_code != 200:
                raise RuntimeError(f"Yahoo chart returned HTTP {response.status_code}")
            rows = response.json().get("chart", {}).get("result") or []
            if not rows:
                return {}
            row = rows[0]
            meta = row.get("meta") or {}
            interval = params["interval"]
            granularity = meta.get("dataGranularity", interval)
            if granularity != interval and (interval, granularity) != ("60m", "1h"):
                return {}
            quotes = row.get("indicators", {}).get("quote") or [{}]
            timestamps, closes = _points(row.get("timestamp"), quotes[0].get("close"))
            return (
                {
                    symbol: SparkSeries(
                        symbol,
                        timestamps,
                        closes,
                        # chartPreviousClose refers to the beginning of the whole range.
                        previous_close=_price(meta.get("previousClose")),
                        timezone=meta.get("exchangeTimezoneName"),
                    )
                }
                if timestamps
                else {}
            )

        def alpaca_load(source: AlpacaMarketPrices, _: list[str]) -> dict[str, SparkSeries]:
            item = source.chart(symbol, kind, params)
            return {symbol: item} if item is not None else {}

        return self._read(
            kind, [symbol], ttl, load, not_before=not_before, alpaca_load=alpaca_load
        ).get(symbol)
