"""Dated company events around each notable decision: what was happening then.

Decision review measures what followed a buy or sell. This module adds the
events that a reader would want to see beside it: results and their surprise,
analyst rating changes, SEC filings and, for recent decisions, news headlines.
Events come from the price provider, are cached per listing outside Git and
are attached only to the decisions the review shows, to keep the payload small.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd

EventLoader = Callable[[str], list[dict[str, Any]]]

#: Events this many calendar days before a decision still explain it.
LEAD_DAYS = 7
#: Each shown decision carries at most this many events, most telling first.
MAX_EVENTS = 4
#: Decisions shown per side, direction and horizon in the review.
SHOWN_PER_LIST = 5
RECENT_DECISIONS = 12
FILING_FORMS = {"8-K", "10-K", "10-Q", "6-K", "20-F", "40-F"}
RATING_ACTIONS = {"up": "upgrade", "down": "downgrade", "init": "initiate"}
#: Most telling first: results, then rating changes, filings and news.
EVENT_ORDER = {"earnings": 0, "downgrade": 1, "upgrade": 1, "initiate": 2, "filing": 3, "news": 4}
#: Routine filings and headlines are frequent; a few say enough beside a decision.
KIND_LIMITS = {"filing": 1, "news": 2}


def _day(value: Any) -> str | None:
    with suppress(TypeError, ValueError):
        stamp = pd.Timestamp(value)
        if pd.isna(stamp):
            return None
        if stamp.tzinfo is not None:
            stamp = stamp.tz_convert("UTC")
        return stamp.date().isoformat()
    return None


def _number(value: Any) -> float | None:
    with suppress(TypeError, ValueError):
        number = float(value)
        return number if math.isfinite(number) else None
    return None


def _default_events(symbol: str) -> list[dict[str, Any]]:
    """Results, rating changes, filings and recent news from Yahoo Finance."""

    import yfinance as yf

    ticker = yf.Ticker(symbol)
    events: list[dict[str, Any]] = []
    with suppress(Exception):
        frame = ticker.get_earnings_dates(limit=40)
        for stamp, row in (frame if frame is not None else pd.DataFrame()).iterrows():
            reported = _number(row.get("Reported EPS"))
            day = _day(stamp)
            if reported is None or day is None:
                continue
            events.append(
                {
                    "date": day,
                    "kind": "earnings",
                    "estimate": _number(row.get("EPS Estimate")),
                    "reported": reported,
                    "surprise_pct": _number(row.get("Surprise(%)")),
                }
            )
    with suppress(Exception):
        frame = ticker.upgrades_downgrades
        for stamp, row in (frame if frame is not None else pd.DataFrame()).iterrows():
            kind = RATING_ACTIONS.get(str(row.get("Action") or "").lower())
            day = _day(stamp)
            if kind is None or day is None:
                continue
            events.append(
                {
                    "date": day,
                    "kind": kind,
                    "firm": str(row.get("Firm") or "") or None,
                    "from_grade": str(row.get("FromGrade") or "") or None,
                    "to_grade": str(row.get("ToGrade") or "") or None,
                }
            )
    with suppress(Exception):
        for filing in ticker.sec_filings or []:
            form = str(filing.get("type") or "").upper()
            day = _day(filing.get("date"))
            if form not in FILING_FORMS or day is None:
                continue
            events.append(
                {
                    "date": day,
                    "kind": "filing",
                    "form": form,
                    "title": str(filing.get("title") or "") or None,
                    "url": str(filing.get("edgarUrl") or "") or None,
                }
            )
    with suppress(Exception):
        for item in ticker.news or []:
            content = item.get("content") or {}
            day = _day(content.get("pubDate"))
            title = str(content.get("title") or "")
            if day is None or not title:
                continue
            url = (content.get("canonicalUrl") or {}).get("url")
            provider = (content.get("provider") or {}).get("displayName")
            events.append(
                {
                    "date": day,
                    "kind": "news",
                    "title": title[:200],
                    "source": str(provider or "") or None,
                    "url": str(url or "") or None,
                }
            )
    return events


class CachedSecurityEvents:
    """Company events cached per listing; past events rarely change."""

    def __init__(
        self,
        root: Path,
        *,
        fetch: EventLoader = _default_events,
        refresh_after: timedelta = timedelta(hours=24),
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.root = root
        self.fetch = fetch
        self.refresh_after = refresh_after
        self.now = now

    def _path(self, symbol: str) -> Path:
        return self.root / (hashlib.sha256(symbol.encode()).hexdigest()[:24] + ".json")

    def __call__(self, symbol: str) -> list[dict[str, Any]]:
        path = self._path(symbol)
        cached: dict[str, Any] = {}
        with suppress(FileNotFoundError, ValueError):
            cached = json.loads(path.read_text(encoding="utf-8"))
        fetched_at = cached.get("fetched_at")
        if fetched_at and self.now() - datetime.fromisoformat(fetched_at) < self.refresh_after:
            return list(cached.get("events") or [])
        try:
            events = self.fetch(symbol)
        except Exception:
            # A provider outage keeps the last known events instead of none.
            return list(cached.get("events") or [])
        if not events and cached.get("events"):
            events = list(cached["events"])
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"symbol": symbol, "fetched_at": self.now().isoformat(), "events": events}),
            encoding="utf-8",
        )
        temporary.replace(path)
        return events


def shown_decisions(decisions: Sequence[Mapping[str, Any]]) -> list[int]:
    """Indexes of the decisions the review lists: the largest effects and the latest."""

    chosen: set[int] = set(range(max(0, len(decisions) - RECENT_DECISIONS), len(decisions)))
    for field in ("effect_horizon_gbp", "effect_to_date_gbp"):
        for side in ("buy", "sell"):
            scored = [
                (index, float(row[field]))
                for index, row in enumerate(decisions)
                if row.get("side") == side and row.get(field) is not None
            ]
            for sign in (1.0, -1.0):
                ranked = sorted(
                    (item for item in scored if sign * item[1] > 0),
                    key=lambda item: -sign * item[1],
                )
                chosen.update(index for index, _ in ranked[:SHOWN_PER_LIST])
    return sorted(chosen)


def _window_end(row: Mapping[str, Any], closes: pd.Series, horizon_days: int) -> date:
    start = pd.Timestamp(row["date"])
    position = int(closes.index.searchsorted(start, side="right")) - 1
    end = position + horizon_days
    stamp = closes.index[min(end, len(closes) - 1)] if len(closes) else start
    return pd.Timestamp(stamp).date()


def attach_decision_events(
    review: dict[str, Any],
    closes_by_ticker: Mapping[str, tuple[str, pd.Series]],
    events: EventLoader,
) -> int:
    """Add an events list to each shown decision; return how many listings were read.

    closes_by_ticker maps a ticker to its resolved listing and GBP closes, which
    give the end of each decision's window (its horizon, or the latest close).
    """

    decisions = review.get("decisions") or []
    horizon_days = int(review.get("horizon_days") or 20)
    loaded: dict[str, list[dict[str, Any]]] = {}
    for index in shown_decisions(decisions):
        row = decisions[index]
        listing = closes_by_ticker.get(row["ticker"])
        if listing is None:
            continue
        symbol, closes = listing
        if symbol not in loaded:
            loaded[symbol] = events(symbol)
        start = date.fromisoformat(row["date"]) - timedelta(days=LEAD_DAYS)
        end = _window_end(row, closes, horizon_days)
        inside = [
            event
            for event in loaded[symbol]
            if start.isoformat() <= str(event.get("date")) <= end.isoformat()
        ]
        inside.sort(key=lambda event: (EVENT_ORDER.get(event.get("kind"), 9), event["date"]))
        kept: list[dict[str, Any]] = []
        counts: dict[str, int] = {}
        for event in inside:
            kind = str(event.get("kind"))
            if counts.get(kind, 0) >= KIND_LIMITS.get(kind, MAX_EVENTS):
                continue
            counts[kind] = counts.get(kind, 0) + 1
            kept.append(event)
        row["events"] = sorted(kept[:MAX_EVENTS], key=lambda event: event["date"])
    return len(loaded)


__all__ = [
    "CachedSecurityEvents",
    "attach_decision_events",
    "shown_decisions",
]
