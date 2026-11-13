"""Batched IEX marks and completed SIP closes for US market views."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import httpx

from .alpaca_http import AlpacaDataError, AlpacaHTTP
from .sector_prices import YAHOO_SOURCE, SparkSeries, _price

ALPACA_BATCH_SIZE = 100
ALPACA_INTRADAY = "Alpaca (IEX real-time / SIP)"
ALPACA_SIP = "Alpaca (SIP)"
SIP_DELAY = timedelta(minutes=16)
NY = ZoneInfo("America/New_York")


def market_price_sources(sources: Iterable[str]) -> str:
    used = set(sources)
    if ALPACA_INTRADAY in used:
        used.discard(ALPACA_SIP)
    return " + ".join(sorted(used)) or YAHOO_SOURCE


def is_alpaca_listing(symbol: str) -> bool:
    # Yahoo's share-class separator is '-', unlike an exchange suffix such as
    # .L or .TO. This also excludes currencies, futures, indices and crypto pairs.
    return re.fullmatch(r"[A-Z]{1,6}(?:-[A-Z])?", symbol) is not None


def _mapped(symbols: Iterable[str]) -> dict[str, str]:
    return {symbol.replace("-", "."): symbol for symbol in symbols}


def _stamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo is not None else None
    except ValueError:
        return None


def _point(row: object, field: str = "c") -> tuple[datetime, float] | None:
    if (
        isinstance(row, dict)
        and (stamp := _stamp(row.get("t")))
        and (value := _price(row.get(field))) is not None
    ):
        return stamp, value
    return None


def _series(
    symbol: str,
    points: dict[datetime, float],
    source: str,
    previous_close: float | None = None,
) -> SparkSeries:
    ordered = sorted(points.items())
    return SparkSeries(
        symbol,
        tuple(int(stamp.timestamp()) for stamp, _ in ordered),
        tuple(value for _, value in ordered),
        previous_close=previous_close,
        timezone=NY.key,
        source=source,
    )


class AlpacaMarketPrices:
    def __init__(
        self, http: AlpacaHTTP, *, now: Callable[[], datetime] = lambda: datetime.now(UTC)
    ):
        self._http, self._now = http, now

    def _bar_rows(
        self,
        client: httpx.Client,
        mapped: dict[str, str],
        start: datetime,
        end: datetime,
        timeframe: str,
        feed: str,
        *,
        adjustment: str = "split",
    ) -> dict[str, dict[datetime, dict]]:
        params = {
            "symbols": ",".join(mapped),
            "start": start.isoformat(),
            "end": end.isoformat(),
            "timeframe": timeframe,
            "feed": feed,
            "adjustment": adjustment,
            "limit": 10000,
            "sort": "asc",
        }
        result: dict[str, dict[datetime, dict]] = {}
        seen = set()
        # A 100-name batch of two-year daily data fits in about six pages.
        # Bound unexpected pagination and discard the incomplete batch on error.
        for _ in range(12):
            payload = self._http.get(client, "/v2/stocks/bars", params)
            bars = payload.get("bars") or {}
            if not isinstance(bars, dict):
                raise AlpacaDataError("Alpaca returned invalid market data")
            for provider, rows in bars.items():
                if provider not in mapped or not isinstance(rows, list):
                    continue
                points = result.setdefault(mapped[provider], {})
                for row in rows:
                    if (point := _point(row)) and start <= point[0] <= end:
                        points[point[0]] = row
            token = payload.get("next_page_token")
            if token is None:
                return result
            if not isinstance(token, str) or not token or token in seen:
                raise AlpacaDataError("Alpaca returned invalid market data")
            seen.add(token)
            params["page_token"] = token
        raise AlpacaDataError("Alpaca pagination limit exceeded")

    def _bars(
        self,
        client: httpx.Client,
        mapped: dict[str, str],
        start: datetime,
        end: datetime,
        timeframe: str,
        feed: str,
    ) -> dict[str, dict[datetime, float]]:
        return {
            symbol: {stamp: float(row["c"]) for stamp, row in rows.items()}
            for symbol, rows in self._bar_rows(client, mapped, start, end, timeframe, feed).items()
        }

    def etf_history(self, symbol: str, interval: str) -> dict[datetime, dict]:
        """Complete regular-session SIP OHLCV bars for the ETF price chart."""
        now = self._now()
        cutoff = now - SIP_DELAY
        timeframe, minutes, days = {
            "15m": ("15Min", 15, 60),
            "60m": ("1Hour", 60, 366),
            "1d": ("1Day", 0, 366 * 10),
            "1wk": ("1Week", 0, 366 * 12),
        }[interval]
        start = max(now - timedelta(days=days), datetime(2016, 1, 1, tzinfo=NY))
        with self._http.client(timeout=5) as client:
            rows = self._bar_rows(
                client,
                _mapped([symbol]),
                start,
                cutoff,
                timeframe,
                "sip",
                adjustment="split,dividend",
            )
        points = rows.get(symbol, {})
        if not points:
            return {}
        if interval == "1wk":
            day = now.astimezone(NY).date()
            current_week = day - timedelta(days=day.weekday())
            return {
                stamp: row
                for stamp, row in points.items()
                if stamp.astimezone(NY).date() < current_week
            }
        sessions = self._sessions(now, days)
        return {
            stamp: row
            for stamp, row in points.items()
            if (window := sessions.get(stamp.astimezone(NY).date()))
            and (
                window[0] <= stamp < window[1]
                and min(stamp + timedelta(minutes=minutes), window[1]) <= cutoff
                if minutes
                else window[1] <= cutoff
            )
        }

    @staticmethod
    def _sessions(now: datetime, days: int) -> dict[date, tuple[datetime, datetime]]:
        day = now.astimezone(NY).date()
        calendar = xcals.get_calendar("XNYS")
        start = max(day - timedelta(days=days), calendar.first_session.date())
        end = min(day, calendar.last_session.date())
        return (
            {
                s.date(): (calendar.session_open(s), calendar.session_close(s))
                for s in calendar.sessions_in_range(start, end)
            }
            if start <= end
            else {}
        )

    @staticmethod
    def _completed(
        points: dict[datetime, float],
        sessions: dict[date, tuple[datetime, datetime]],
        cutoff: datetime,
    ) -> dict[datetime, float]:
        # A daily SIP bar is stamped at local midnight, including when the
        # session is in progress. Its timestamp alone does not make it final.
        return {
            stamp: value
            for stamp, value in points.items()
            if (window := sessions.get(stamp.astimezone(NY).date())) and window[1] <= cutoff
        }

    def intraday(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        now = self._now()
        sessions = self._sessions(now, 14)
        opened = [day for day, (start, _) in sessions.items() if start <= now]
        if len(opened) < 2:
            return {}
        prior, day = opened[-2:]
        start, end = sessions[day]
        mapped = _mapped(symbols)
        cutoff = now - SIP_DELAY
        with self._http.client(timeout=5) as client:
            reference = self._bars(
                client,
                mapped,
                datetime.combine(prior, datetime.min.time(), NY),
                cutoff,
                "1Day",
                "sip",
            )
            bars = self._bars(client, mapped, start, min(now, end), "5Min", "iex")
            snapshots = self._http.get(
                client, "/v2/stocks/snapshots", {"symbols": ",".join(mapped), "feed": "iex"}
            )

        result = {}
        for provider, symbol in mapped.items():
            completed = self._completed(reference.get(symbol, {}), sessions, cutoff)
            by_date = {stamp.astimezone(NY).date(): value for stamp, value in completed.items()}
            base = by_date.get(prior)
            if base is None:
                continue
            points = {
                stamp: close
                for stamp, close in bars.get(symbol, {}).items()
                if start <= stamp < end
            }
            snapshot = snapshots.get(provider)
            if (
                isinstance(snapshot, dict)
                and (trade := _point(snapshot.get("latestTrade"), "p"))
                and start <= trade[0] < end
                and trade[0] <= now
            ):
                points[trade[0]] = trade[1]
            official = by_date.get(day)
            if official is not None:
                points[end] = official
            if points:
                result[symbol] = _series(symbol, points, ALPACA_INTRADAY, base)
                if official is not None:
                    result[symbol] = replace(
                        result[symbol], session_end=int(end.timestamp()), full_day_price=official
                    )
        return result

    def daily(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        return self._daily(symbols, 32)

    def breadth_history(self, symbols: Iterable[str]) -> dict[str, SparkSeries]:
        return self._daily(symbols, 740)

    def _daily(self, symbols: Iterable[str], days: int) -> dict[str, SparkSeries]:
        now = self._now()
        cutoff = now - SIP_DELAY
        start = datetime.combine(
            now.astimezone(NY).date() - timedelta(days=days), datetime.min.time(), NY
        )
        sessions = self._sessions(now, days)
        with self._http.client(timeout=5) as client:
            rows = self._bars(client, _mapped(symbols), start, cutoff, "1Day", "sip")
        return {
            symbol: _series(symbol, completed, ALPACA_SIP)
            for symbol, points in rows.items()
            if (completed := self._completed(points, sessions, cutoff))
        }

    def chart(self, symbol: str, kind: str, params: dict[str, str]) -> SparkSeries | None:
        now = self._now()
        if kind == "5y-daily":
            return self._daily([symbol], 5 * 366).get(symbol)
        cutoff = now - SIP_DELAY
        if "period1" in params:
            start = datetime.fromtimestamp(int(params["period1"]), UTC)
        else:
            start = now - timedelta(days=31 if params["range"] == "1mo" else 7)
        timeframe = {"5m": "5Min", "30m": "30Min", "60m": "1Hour", "1wk": "1Week"}[
            params["interval"]
        ]
        with self._http.client(timeout=5) as client:
            bars = self._bars(client, _mapped([symbol]), start, cutoff, timeframe, "sip")
        points = bars.get(symbol, {})
        if timeframe in {"5Min", "30Min", "1Hour"}:
            minutes = {"5Min": 5, "30Min": 30, "1Hour": 60}[timeframe]
            sessions = self._sessions(now, (now - start).days + 3)
            points = {
                stamp: close
                for stamp, close in points.items()
                if (window := sessions.get(stamp.astimezone(NY).date()))
                and window[0] <= stamp < window[1]
                and min(stamp + timedelta(minutes=minutes), window[1]) <= cutoff
            }
        if points and timeframe == "1Week":
            current_week = now.astimezone(NY).date() - timedelta(days=now.astimezone(NY).weekday())
            points = {
                stamp: close for stamp, close in points.items() if stamp.date() < current_week
            }
        return _series(symbol, points, ALPACA_SIP) if points else None
