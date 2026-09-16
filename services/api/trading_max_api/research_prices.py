"""Explicit security-chart interval requests backed only by real OHLC records."""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd
import yfinance as yf
from trading_max.research.calendar import calendar_name
from trading_max.research.facts import fingerprint
from trading_max.research.technical import price_series

from .dashboard_models import ResearchPriceSeries
from .valuation_assumptions import _atomic_write


class SecurityPriceHistory:
    def __init__(self, root: Path) -> None:
        self.root = root / "research-cache" / "security-prices"
        self.lock = threading.RLock()

    def get(self, ticker: str, interval: str) -> ResearchPriceSeries:
        if interval not in {"15m", "60m", "1d", "1wk"}:
            raise ValueError("unsupported-security-interval")
        path = self.root / (fingerprint([ticker, interval]) + ".json")
        with self.lock:
            if path.exists():
                saved = json.loads(path.read_text())
                age = (
                    datetime.now(UTC) - datetime.fromisoformat(saved["fetchedAt"])
                ).total_seconds()
                if age < (300 if interval != "1wk" else 3600):
                    return ResearchPriceSeries.model_validate(saved)
            proxy = yf.Ticker(ticker)
            frame = proxy.history(
                interval=interval,
                period={"15m": "60d", "60m": "1y", "1wk": "max", "1d": "10y"}[interval],
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
                "sma" + str(n): frame["Close"].rolling(n, min_periods=n).mean()
                for n in (20, 50, 200)
            }
            points = price_series(frame, averages, sessions=10_000)
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
                available_sessions=len(points),
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
