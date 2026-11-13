"""Batched Yahoo Finance prices for index-wide session snapshots.

The chart endpoint behind yf.download costs one request per symbol, so a
500-name index every ten minutes would mean thousands of requests an hour. The
spark endpoint returns the same five-minute closes with each previous close for
up to twenty symbols per request (Yahoo rejects more). Requests go through
yfinance's shared session, which owns Yahoo's cookie and crumb handshake.

Yahoo answers a batch with no known symbol at all with an error status, which
also makes yfinance renegotiate its session. Symbols are therefore dealt into
batches round-robin, so each batch carries some of the largest listings.
"""

from __future__ import annotations

import math
import threading
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Protocol

from yfinance.exceptions import YFRateLimitError

SPARK_URL = "https://query1.finance.yahoo.com/v8/finance/spark"
SPARK_DETAIL_URL = "https://query1.finance.yahoo.com/v7/finance/spark"
BATCH_SIZE = 20


class SparkResponse(Protocol):
    status_code: int

    def json(self) -> Any: ...


Getter = Callable[[str, dict[str, str], float], SparkResponse]


class SparkRateLimited(RuntimeError):
    """Yahoo asked for fewer requests; the batches not yet sent were skipped."""


@dataclass(frozen=True, slots=True)
class SparkSeries:
    """One symbol's provider points: epoch seconds and the price at each."""

    symbol: str
    timestamps: tuple[int, ...]
    closes: tuple[float | None, ...]
    previous_close: float | None = None
    name: str = ""
    timezone: str | None = None


def _yahoo_get(url: str, params: dict[str, str], timeout: float) -> SparkResponse:
    # Deferred: constructing the shared session performs Yahoo's handshake.
    from yfinance.data import YfData

    return YfData().get(url, params=params, timeout=timeout)


def _price(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) and number > 0 else None


def _points(timestamps: Any, closes: Any) -> tuple[tuple[int, ...], tuple[float | None, ...]]:
    if not isinstance(timestamps, list) or not isinstance(closes, list):
        return (), ()
    pairs = [
        (int(stamp), _price(close))
        for stamp, close in zip(timestamps, closes, strict=False)
        if isinstance(stamp, int | float) and not isinstance(stamp, bool)
    ]
    return tuple(stamp for stamp, _ in pairs), tuple(close for _, close in pairs)


def _error(payload: Mapping[str, Any]) -> str:
    error = (payload.get("spark") or {}).get("error") if "spark" in payload else None
    if isinstance(error, Mapping):
        return str(error.get("description") or error.get("code") or "unknown error")
    return str(error or "unexpected response")


def parse_compact(payload: Any) -> dict[str, SparkSeries]:
    """Parse the v8 response, one object per symbol keyed by the symbol."""

    if not isinstance(payload, Mapping):
        raise ValueError("spark response is not an object")
    if "spark" in payload:
        raise ValueError(f"spark request rejected: {_error(payload)}")
    series: dict[str, SparkSeries] = {}
    for symbol, row in payload.items():
        if not isinstance(row, Mapping):
            continue
        timestamps, closes = _points(row.get("timestamp"), row.get("close"))
        previous = _price(row.get("previousClose")) or _price(row.get("chartPreviousClose"))
        series[str(symbol).upper()] = SparkSeries(
            symbol=str(symbol).upper(),
            timestamps=timestamps,
            closes=closes,
            previous_close=previous,
        )
    return series


def parse_detail(payload: Any) -> dict[str, SparkSeries]:
    """Parse the v7 response, which also names each security."""

    if not isinstance(payload, Mapping) or not isinstance(payload.get("spark"), Mapping):
        raise ValueError("spark response is not an object")
    results = payload["spark"].get("result")
    if not isinstance(results, list):
        raise ValueError(f"spark request rejected: {_error(payload)}")
    series: dict[str, SparkSeries] = {}
    for item in results:
        responses = item.get("response") if isinstance(item, Mapping) else None
        if not isinstance(responses, list) or not responses:
            continue
        response = responses[0]
        if not isinstance(response, Mapping):
            continue
        meta = response.get("meta") if isinstance(response.get("meta"), Mapping) else {}
        quotes = (response.get("indicators") or {}).get("quote") or [{}]
        symbol = str(item.get("symbol") or meta.get("symbol") or "").upper()
        if not symbol:
            continue
        timestamps, closes = _points(
            response.get("timestamp"), quotes[0].get("close") if quotes else None
        )
        series[symbol] = SparkSeries(
            symbol=symbol,
            timestamps=timestamps,
            closes=closes,
            previous_close=_price(meta.get("chartPreviousClose")),
            name=str(meta.get("longName") or meta.get("shortName") or "").strip(),
        )
    return series


class YahooSparkPrices:
    """Session and daily prices for many symbols in twenty-symbol batches."""

    def __init__(
        self,
        *,
        get: Getter | None = None,
        workers: int = 4,
        timeout: float = 20.0,
    ) -> None:
        self._get = get or _yahoo_get
        self.workers = max(1, workers)
        self.timeout = timeout

    def intraday(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        """Five-minute prices of each symbol's latest session, with its previous close."""

        return self._fetch(SPARK_URL, symbols, {"range": "1d", "interval": "5m"}, parse_compact)

    def benchmark_intraday(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        return self._fetch(SPARK_URL, symbols, {"range": "5d", "interval": "5m"}, parse_compact)

    def daily(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        """About a month of daily closes, with each security's display name."""

        return self._fetch(
            SPARK_DETAIL_URL, symbols, {"range": "1mo", "interval": "1d"}, parse_detail
        )

    def _fetch(
        self,
        url: str,
        symbols: Iterable[str],
        params: Mapping[str, str],
        parse: Callable[[Any], dict[str, SparkSeries]],
    ) -> dict[str, SparkSeries]:
        unique = list(dict.fromkeys(symbol.strip().upper() for symbol in symbols if symbol))
        count = -(-len(unique) // BATCH_SIZE)
        batches: Sequence[list[str]] = [unique[index::count] for index in range(count)]
        if not batches:
            return {}
        throttled = threading.Event()

        def request(batch: list[str]) -> dict[str, SparkSeries]:
            if throttled.is_set():
                return {}
            try:
                response = self._get(url, {**params, "symbols": ",".join(batch)}, self.timeout)
            except YFRateLimitError as exc:
                throttled.set()
                raise SparkRateLimited("Yahoo Finance is rate-limiting price requests") from exc
            if response.status_code == 429:
                throttled.set()
                raise SparkRateLimited("Yahoo Finance is rate-limiting price requests")
            if response.status_code == 404:
                return {}  # none of these symbols has data
            if response.status_code != 200:
                raise RuntimeError(f"Yahoo Finance spark returned HTTP {response.status_code}")
            return parse(response.json())

        series: dict[str, SparkSeries] = {}
        failures: list[Exception] = []
        with ThreadPoolExecutor(max_workers=min(self.workers, len(batches))) as pool:
            for future in [pool.submit(request, batch) for batch in batches]:
                try:
                    series.update(future.result())
                except Exception as exc:
                    failures.append(exc)
        limited = next((exc for exc in failures if isinstance(exc, SparkRateLimited)), None)
        if limited is not None:
            raise limited
        if failures and not series:
            first = failures[0]
            raise RuntimeError(f"Yahoo Finance price request failed: {first}") from first
        return series


__all__ = [
    "BATCH_SIZE",
    "SPARK_DETAIL_URL",
    "SPARK_URL",
    "SparkRateLimited",
    "SparkSeries",
    "YahooSparkPrices",
    "parse_compact",
    "parse_detail",
]
