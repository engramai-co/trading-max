"""Synthetic adapters for the internal demo, never used by production."""

from __future__ import annotations

import json
import math
from datetime import UTC, date, datetime, timedelta
from pathlib import Path


def demo_as_of(root: Path) -> date:
    marker = json.loads((root / "DESKTOP_SYNTHETIC_DATA.json").read_text(encoding="utf-8"))
    return date.fromisoformat(marker["as_of"])


class PreviewPrices:
    def __init__(self, as_of: date) -> None:
        self.end = datetime.combine(as_of, datetime.min.time(), tzinfo=UTC) + timedelta(hours=20)

    def get(self, ticker: str, interval: str, *, preview: bool = False):
        from services.api.trading_max_api.dashboard_models import ResearchPriceSeries

        if ticker.upper() != "BE" or interval not in {"15m", "60m", "1d", "1wk"}:
            raise ValueError("requested-interval-unavailable")
        stamps = []
        for i in range(211):
            day = self.end - timedelta(days=210 - i)
            if day.weekday() >= 5:
                continue
            if interval in {"15m", "60m"}:
                step = 15 if interval == "15m" else 60
                stamps.extend(
                    day.replace(hour=13, minute=30) + timedelta(minutes=n)
                    for n in range(0, 390, step)
                )
            else:
                stamps.append(day)
        if interval == "1wk":
            stamps = stamps[::5]
        points = []
        for i, stamp in enumerate(stamps):
            ratio = i / max(1, len(stamps) - 1)
            close = round(160 + 40 * ratio + 7 * math.sin(ratio * math.pi * 8), 2)
            points.append(
                {
                    "date": stamp.isoformat(),
                    "open": close - 0.5,
                    "high": close + 1.4,
                    "low": close - 1.2,
                    "close": close,
                    "volume": 125000 + i * 13,
                    "sma20": None,
                    "sma50": None,
                    "sma200": None,
                }
            )
        return ResearchPriceSeries(
            ticker="BE",
            as_of=stamps[-1].isoformat(),
            currency="USD",
            available_sessions=len({p["date"][:10] for p in points}),
            points=points,
            requested_interval=interval,
            actual_interval=interval,
            timezone="America/New_York",
            exchange_calendar="XNYS",
            fetched_at=self.end.isoformat(),
            coverage_reason="Synthetic demo prices",
        )


class PreviewSearch:
    def search(self, query: str, *, limit: int = 8):
        from services.api.trading_max_api.models import SecuritySearchResponse, SecuritySearchResult

        match = query.strip().lower() in {"be", "bloom", "bloom energy"}
        return SecuritySearchResponse(
            query=query,
            source="watchlist",
            results=[
                SecuritySearchResult(
                    ticker="BE",
                    name="Bloom Energy",
                    exchange="NYSE",
                    bloomberg_ticker="BE US Equity",
                    figi="BBG001BBH6X2",
                    already_watched=True,
                )
            ]
            if match
            else [],
        )
