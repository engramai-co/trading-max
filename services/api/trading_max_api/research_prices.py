"""Explicit security-chart interval requests backed only by real OHLC records."""

from __future__ import annotations

import threading
from collections.abc import Callable
from contextlib import AbstractContextManager, nullcontext, suppress
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf
from trading_max.infrastructure.alpaca_http import AlpacaDataError
from trading_max.infrastructure.alpaca_market_prices import ALPACA_SIP, NY, AlpacaMarketPrices
from trading_max.infrastructure.singleflight import SingleFlightCache
from trading_max.research.calendar import calendar_name
from trading_max.research.facts import fingerprint
from trading_max.research.technical import price_series

from .dashboard_models import ResearchPriceSeries
from .valuation_assumptions import _atomic_write


class SecurityPriceHistory:
    def __init__(
        self,
        root: Path,
        *,
        alpaca: Callable[[], AlpacaMarketPrices | None] | None = None,
        yahoo_request: Callable[[], AbstractContextManager[None]] = nullcontext,
    ) -> None:
        self.root = root / "research-cache" / "security-prices"
        self.cache: SingleFlightCache[tuple[str, str], ResearchPriceSeries] = SingleFlightCache(96)
        self.provider_slots = threading.BoundedSemaphore(3)
        self._alpaca = alpaca
        self._yahoo_request = yahoo_request
        self._alpaca_cache: SingleFlightCache[
            tuple[AlpacaMarketPrices, str, str], ResearchPriceSeries | None
        ] = SingleFlightCache(48)

    def alpaca_etf(self, ticker: str, interval: str) -> ResearchPriceSeries | None:
        source = self._alpaca() if self._alpaca else None
        if source is None:
            return None

        def load():
            try:
                rows = source.etf_history(ticker, interval)
            except AlpacaDataError:
                return None
            if not rows:
                return None
            frame = pd.DataFrame.from_dict(rows, orient="index").rename(
                columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume"}
            )
            columns = ["Open", "High", "Low", "Close", "Volume"]
            frame = frame.reindex(columns=columns).apply(pd.to_numeric, errors="coerce")
            frame.index = pd.DatetimeIndex(frame.index).tz_convert(NY)
            frame = frame.sort_index()
            frame.attrs["intraday"] = interval.endswith("m")
            averages = {
                f"sma{n}": frame["Close"].rolling(n, min_periods=n).mean() for n in (20, 50, 200)
            }
            points = price_series(frame, averages, sessions=10_000)
            return ResearchPriceSeries(
                ticker=ticker,
                as_of=points[-1]["date"],
                currency="USD",
                available_sessions=len({p["date"][:10] for p in points}),
                points=points,
                requested_interval=interval,
                actual_interval=interval,
                timezone=NY.key,
                exchange_calendar="XNYS",
                source=ALPACA_SIP,
                fetched_at=datetime.now(UTC).isoformat(),
            )

        result = self._alpaca_cache.get_or_compute(
            (source, ticker, interval),
            load,
            valid=lambda value: (
                value is not None
                and value.fetched_at is not None
                and (datetime.now(UTC) - datetime.fromisoformat(value.fetched_at)).total_seconds()
                < 300
            ),
        )
        if result is not None and self._alpaca() is source:
            return result.model_copy(deep=True)
        return None

    def get(
        self, ticker: str, interval: str, *, preview: bool = False, market_etf: bool = False
    ) -> ResearchPriceSeries:
        if interval not in {"15m", "60m", "1d", "1wk"}:
            raise ValueError("unsupported-security-interval")
        ticker = ticker.upper()
        cache_interval = interval + ":preview" if preview else interval

        def fresh(value: ResearchPriceSeries) -> bool:
            if not value.fetched_at:
                return False
            age = (datetime.now(UTC) - datetime.fromisoformat(value.fetched_at)).total_seconds()
            return 0 <= age < (300 if interval != "1wk" else 3600)

        def load() -> ResearchPriceSeries:
            path = self.root / (fingerprint([ticker, cache_interval]) + ".json")
            with suppress(OSError, ValueError, KeyError):
                saved = ResearchPriceSeries.model_validate_json(path.read_text())
                if fresh(saved):
                    return saved
            with self.provider_slots, self._yahoo_request() if market_etf else nullcontext():
                return (
                    self._fetch(ticker, interval, path, preview=True)
                    if preview
                    else self._fetch(ticker, interval, path)
                )

        # Routes trim windows and attach trade markers; never let one response
        # mutate the shared complete history used by another consumer.
        return self.cache.get_or_compute((ticker, cache_interval), load, valid=fresh).model_copy(
            deep=True
        )

    def _fetch(
        self, ticker: str, interval: str, path: Path, *, preview: bool = False
    ) -> ResearchPriceSeries:
        proxy = yf.Ticker(ticker)
        frame = proxy.history(
            interval=interval,
            period="6mo"
            if preview
            else {"15m": "60d", "60m": "1y", "1wk": "max", "1d": "10y"}[interval],
            auto_adjust=True,
            prepost=False,
            actions=True,
            timeout=20,
        )
        if frame.empty:
            raise ValueError("requested-interval-unavailable")
        metadata = proxy.get_history_metadata() or {}
        code = str(metadata.get("currency") or "")
        if code in {"GBp", "GBX"}:
            frame[["Open", "High", "Low", "Close"]] *= 0.01
            if "Dividends" in frame:
                frame["Dividends"] *= 0.01
            code = "GBP"
        frame.attrs["intraday"] = interval.endswith("m")
        averages = {
            "sma" + str(n): frame["Close"].rolling(n, min_periods=n).mean() for n in (20, 50, 200)
        }
        points = price_series(frame, averages, sessions=10_000)
        if preview:
            for point in points:
                for key in (
                    "sma20",
                    "sma50",
                    "sma200",
                    "rsi14",
                    "macd",
                    "macdSignal",
                    "macdHistogram",
                ):
                    point[key] = None
        events = []
        for stamp, row in frame.iterrows():
            for field, kind in (("Dividends", "dividend"), ("Stock Splits", "split")):
                value = row.get(field)
                if pd.notna(value) and value != 0:
                    events.append(
                        {
                            "date": stamp.isoformat(),
                            "kind": kind,
                            "value": float(value),
                            "currency": code,
                        }
                    )
        result = ResearchPriceSeries(
            ticker=ticker,
            as_of=points[-1]["date"],
            currency=code,
            available_sessions=len({p["date"][:10] for p in points}),
            points=points,
            requested_interval=interval,
            actual_interval=interval,
            timezone=metadata.get("exchangeTimezoneName"),
            exchange_calendar=calendar_name(metadata.get("exchangeName")),
            fetched_at=datetime.now(UTC).isoformat(),
            events=events,
        )
        _atomic_write(path, result.model_dump(mode="json"))
        return result


def price_window(series: ResearchPriceSeries, window: str | None) -> ResearchPriceSeries:
    """Project genuine observations after indicators were calculated on full history."""
    if window != "3M" or not series.points:
        return series
    start = date.fromisoformat(series.points[-1].date[:10]) - timedelta(days=90)
    points = [p for p in series.points if p.date[:10] >= start.isoformat()]
    return series.model_copy(
        update={
            "points": points,
            "trade_markers": [m for m in series.trade_markers if m.date[:10] >= start.isoformat()],
            "coverage_start": points[0].date if points else None,
            "coverage_end": points[-1].date if points else None,
        }
    )
