"""Explicit security-chart interval requests backed only by real OHLC records."""

from __future__ import annotations

import threading
from contextlib import suppress
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf
from trading_max.infrastructure.singleflight import SingleFlightCache
from trading_max.research.calendar import calendar_name
from trading_max.research.facts import fingerprint
from trading_max.research.technical import price_series

from .dashboard_models import ResearchPriceSeries
from .valuation_assumptions import _atomic_write


class SecurityPriceHistory:
    def __init__(self, root: Path) -> None:
        self.root = root / "research-cache" / "security-prices"
        self.cache: SingleFlightCache[tuple[str, str], ResearchPriceSeries] = SingleFlightCache(96)
        self.provider_slots = threading.BoundedSemaphore(3)

    def get(self, ticker: str, interval: str, *, preview: bool = False) -> ResearchPriceSeries:
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
            with self.provider_slots:
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
