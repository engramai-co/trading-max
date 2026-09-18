"""Opt-in historical US prices. Yahoo remains the baseline and fallback."""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path

import exchange_calendars as xcals
import httpx
import pandas as pd

from .intraday_reconstruction import IntradayPriceLoader, IntradayPrices

DATA_URL = "https://data.alpaca.markets"
NY = "America/New_York"


class AlpacaDataError(RuntimeError):
    """A deliberately non-secret provider error."""


class AlpacaHistoricalClient:
    def __init__(self, key: str, secret: str, *, transport=None, sleep=time.sleep) -> None:
        self._headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        self._transport = transport
        self._sleep = sleep
        self._last_request = 0.0

    def bars(self, symbol: str, start: pd.Timestamp, end: pd.Timestamp, feed: str) -> pd.Series:
        """Read all pages; raw prices already match historical nominal ledger units."""
        params = {
            "symbols": symbol,
            "timeframe": "1Min" if feed == "boats" else "5Min",
            "start": start.isoformat(),
            "end": end.isoformat(),
            "feed": feed,
            "adjustment": "raw",
            "limit": 10000,
            "sort": "asc",
        }
        rows: dict[pd.Timestamp, float] = {}
        tokens: set[str] = set()
        with httpx.Client(
            base_url=DATA_URL,
            headers=self._headers,
            timeout=20,
            follow_redirects=False,
            transport=self._transport,
        ) as client:
            for _ in range(250):
                for attempt in range(3):
                    self._sleep(max(0, 0.32 - (time.monotonic() - self._last_request)))
                    self._last_request = time.monotonic()
                    try:
                        response = client.get("/v2/stocks/bars", params=params)
                    except httpx.HTTPError:
                        raise AlpacaDataError("Alpaca market data unavailable") from None
                    if (response.status_code == 429 or response.status_code >= 500) and attempt < 2:
                        self._sleep(2**attempt)
                        continue
                    break
                if response.status_code != 200:
                    raise AlpacaDataError(f"Alpaca {feed} HTTP {response.status_code}")
                try:
                    payload = response.json()
                    for row in (payload.get("bars") or {}).get(symbol, []):
                        stamp = pd.Timestamp(row["t"])
                        value = float(row["c"])
                        if stamp.tzinfo is None or not math.isfinite(value) or value <= 0:
                            raise ValueError("invalid bar")
                        # A bar's close is available at its end, never its start.
                        available = stamp.tz_convert("UTC") + pd.Timedelta(
                            minutes=1 if feed == "boats" else 5
                        )
                        if start <= available <= end:
                            rows[available] = value
                    token = payload.get("next_page_token")
                    if not token:
                        return pd.Series(rows, dtype=float).sort_index()
                    if not isinstance(token, str) or token in tokens:
                        raise ValueError("repeated pagination token")
                    tokens.add(token)
                    params["page_token"] = token
                except (ValueError, TypeError, KeyError, AttributeError):
                    raise AlpacaDataError("Alpaca returned invalid market data") from None
        raise AlpacaDataError("Alpaca pagination limit exceeded")

    def test(self, now: pd.Timestamp | None = None) -> None:
        end = (now or pd.Timestamp.now(tz="UTC")) - pd.Timedelta(minutes=16)
        # Both feeds must be authorized, even if a holiday has no trades.
        for feed in ("sip", "boats"):
            self.bars("AAPL", end - pd.Timedelta(days=4), end, feed)


def us_sessions(start: pd.Timestamp, end: pd.Timestamp):
    """Trade-date calendar, including DST, holidays and overnight before half days."""
    calendar = xcals.get_calendar("XNYS")
    days = calendar.sessions_in_range(
        (start - pd.Timedelta(days=2)).date(), (end + pd.Timedelta(days=2)).date()
    )
    daytime, overnight = [], []
    for day in days:
        local = pd.Timestamp(day.date()).tz_localize(NY)
        pre = local + pd.Timedelta(hours=4)
        # After-hours ends at 17:00 ET on NYSE half days, otherwise 20:00.
        close = calendar.session_close(day).tz_convert(NY)
        post_hour = 17 if close.hour < 16 else 20
        daytime.append(
            (pre.tz_convert("UTC"), (local + pd.Timedelta(hours=post_hour)).tz_convert("UTC"))
        )
        # Use local calendar dates, not a 24-hour UTC subtraction across DST.
        prior = pd.Timestamp(day.date()) - pd.Timedelta(days=1)
        night_start = (prior + pd.Timedelta(hours=20)).tz_localize(NY).tz_convert("UTC")
        overnight.append((night_start, pre.tz_convert("UTC")))
    return tuple(daytime), tuple(overnight)


class AlpacaEnhancedPriceLoader:
    """Supplement YF with delayed SIP and BOATS; never invent overnight prices."""

    def __init__(
        self,
        root: Path,
        fallback: IntradayPriceLoader,
        client: AlpacaHistoricalClient,
        *,
        now: Callable[[], pd.Timestamp] = lambda: pd.Timestamp(datetime.now(UTC)),
    ) -> None:
        self.root, self.fallback, self.client, self.now = root, fallback, client, now
        self.memory: dict[tuple, IntradayPrices] = {}
        self.feeds: dict[tuple[str, str], dict] = {}
        self.failures: set[tuple[str, str]] = set()
        self.diagnostics: dict[str, dict] = {}

    def _feed(self, symbol: str, start: pd.Timestamp, end: pd.Timestamp, feed: str) -> pd.Series:
        key = (symbol, feed)
        path = self.root / (
            hashlib.sha256(f"{symbol}:{feed}:raw-v1".encode()).hexdigest()[:24] + ".json"
        )
        if key not in self.feeds:
            cached = {}
            with suppress(OSError, ValueError, TypeError):
                candidate = json.loads(path.read_text())
                if (
                    isinstance(candidate, dict)
                    and candidate.get("symbol") == symbol
                    and candidate.get("feed") == feed
                ):
                    cached = candidate
            self.feeds[key] = cached
        cached = self.feeds[key]
        try:
            old = pd.Series(
                {pd.Timestamp(t): float(v) for t, v in cached.get("bars", [])}, dtype=float
            ).sort_index()
            covered_start = pd.Timestamp(cached.get("start", end.isoformat()))
            covered_end = pd.Timestamp(cached.get("end", start.isoformat()))
            if covered_start.tzinfo is None or covered_end.tzinfo is None:
                raise ValueError("invalid cache timezone")
            if any(t.tzinfo is None or not math.isfinite(v) or v <= 0 for t, v in old.items()):
                raise ValueError("invalid cached prices")
        except (ValueError, TypeError, KeyError):
            cached = {}
            self.feeds[key] = cached
            old = pd.Series(dtype=float)
            covered_start, covered_end = end, start
        if key not in self.failures and (
            not cached or covered_start > start or covered_end < end.floor("10min")
        ):
            fetch_start = (
                start
                if not cached or covered_start > start
                else max(start, covered_end - pd.Timedelta(days=1))
            )
            try:
                fresh = self.client.bars(symbol, fetch_start, end, feed)
            except AlpacaDataError as exc:
                self.failures.add(key)
                self.diagnostics[f"{symbol}:{feed}"] = {"status": "fallback", "reason": str(exc)}
            else:
                # Replace the fetched overlap, including an explicitly empty response.
                old = pd.concat(
                    [old[old.index < fetch_start] if not old.empty else old, fresh]
                ).sort_index()
                old = old[~old.index.duplicated(keep="last")]
                old = old[old.index >= start] if not old.empty else old
                cached = {
                    "symbol": symbol,
                    "feed": feed,
                    "adjustment": "raw",
                    "start": start.isoformat(),
                    "end": end.isoformat(),
                    "bars": [[t.isoformat(), v] for t, v in old.items()],
                }
                self.feeds[key] = cached
                # A cache filesystem failure must not discard valid fetched prices.
                with suppress(OSError):
                    self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
                    temporary = path.with_suffix(".tmp")
                    temporary.write_text(json.dumps(cached, separators=(",", ":")))
                    temporary.chmod(0o600)
                    temporary.replace(path)
        if key not in self.failures:
            self.diagnostics[f"{symbol}:{feed}"] = {
                "status": "available" if not old.empty else "empty",
                "bars": len(old),
            }
        if old.empty:
            return old
        return old[(old.index >= start) & (old.index <= end)]

    def __call__(
        self, symbol: str, start: pd.Timestamp, end: pd.Timestamp, interval: str
    ) -> IntradayPrices:
        memo = (symbol, start.isoformat(), end.isoformat(), interval)
        if memo in self.memory:
            return self.memory[memo]
        try:
            baseline = self.fallback(symbol, start, end, interval)
        except Exception:
            baseline = IntradayPrices(pd.Series(dtype=float), "", 3600 if interval == "1h" else 300)
        # Unqualified US symbols only. FX and foreign venues retain their YF path.
        if not re.fullmatch(r"[A-Z]{1,6}(?:-[A-Z])?", symbol) or baseline.currency not in {
            "",
            "USD",
        }:
            return baseline
        cutoff = min(end, self.now() - pd.Timedelta(minutes=16))
        day, night = us_sessions(start, end)
        frames = [pd.DataFrame({"close": baseline.close, "cadence": baseline.cadence_seconds})]
        if cutoff > start:
            for feed, sessions, seconds in (("sip", day, 300), ("boats", night, 60)):
                series = self._feed(symbol.replace("-", "."), start, cutoff, feed)
                # Feed timestamps must agree with the calendar, not only the ticker.
                if not series.empty:
                    valid = pd.Series(False, index=series.index)
                    for a, b in sessions:
                        valid |= (series.index > a) & (series.index <= b)
                    series = series[valid]
                frames.append(pd.DataFrame({"close": series, "cadence": seconds}))
        merged = pd.concat(frames).sort_index(kind="stable")
        merged = merged[~merged.index.duplicated(keep="last")]
        result = IntradayPrices(
            merged["close"],
            "USD",
            baseline.cadence_seconds,
            tuple(sorted(set(baseline.sessions) | set(day) | set(night))),
            quote_cadence_seconds=merged["cadence"],
            # Sparse overnight trades get at most ten minutes, regardless of the
            # older YF hourly fallback's much longer normal-session allowance.
            freshness_windows=tuple((a, b, 600) for a, b in night),
        )
        self.memory[memo] = result
        return result
