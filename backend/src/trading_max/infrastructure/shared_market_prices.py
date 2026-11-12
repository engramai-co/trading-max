"""Share price requests across sectors, indices and overlapping baskets."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable, Mapping
from urllib.parse import quote

from yfinance.exceptions import YFRateLimitError

from .sector_prices import SparkRateLimited, SparkSeries, YahooSparkPrices, _points, _yahoo_get

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
RATE_LIMIT_SECONDS = 30 * 60


class SharedMarketPrices:
    """Deduplicate concurrent work, cache by listing and pause on a provider 429."""

    def __init__(self, source: YahooSparkPrices | None = None) -> None:
        self.source = source or YahooSparkPrices()
        self._lock = threading.Lock()
        self._paused_until = 0.0
        self._cache: dict[tuple[str, str], tuple[float, SparkSeries | None]] = {}

    def _read(
        self,
        kind: str,
        symbols: Iterable[str],
        ttl: int,
        load: Callable[[list[str]], Mapping[str, SparkSeries]],
    ) -> dict[str, SparkSeries]:
        unique = list(dict.fromkeys(symbols))
        with self._lock:
            now = time.monotonic()
            wanted = [
                symbol for symbol in unique if self._cache.get((kind, symbol), (0, None))[0] <= now
            ]
            if wanted:
                if now < self._paused_until:
                    raise SparkRateLimited("Yahoo Finance price requests are paused")
                try:
                    result = load(wanted)
                except (SparkRateLimited, YFRateLimitError) as exc:
                    self._paused_until = time.monotonic() + RATE_LIMIT_SECONDS
                    raise SparkRateLimited("Yahoo Finance is rate-limiting price requests") from exc
                for symbol in wanted:
                    self._cache[kind, symbol] = (
                        time.monotonic() + (ttl if symbol in result else min(ttl, 60)),
                        result.get(symbol),
                    )
                if len(self._cache) > 4096:
                    self._cache = {
                        key: value for key, value in self._cache.items() if value[0] > now
                    }
            return {
                symbol: item
                for symbol in unique
                if (item := self._cache[kind, symbol][1]) is not None
            }

    def intraday(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        return self._read("intraday", symbols, 240, self.source.intraday)

    def daily(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        return self._read("daily", symbols, 240, self.source.daily)

    def history(self, symbol: str) -> SparkSeries | None:
        def load(_: list[str]) -> dict[str, SparkSeries]:
            response = _yahoo_get(
                CHART_URL + quote(symbol, safe=""), {"range": "5y", "interval": "1d"}, 12
            )
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
            quotes = row.get("indicators", {}).get("quote") or [{}]
            timestamps, closes = _points(row.get("timestamp"), quotes[0].get("close"))
            return {symbol: SparkSeries(symbol, timestamps, closes)} if timestamps else {}

        return self._read("5y-daily", [symbol], 30 * 60, load).get(symbol)
