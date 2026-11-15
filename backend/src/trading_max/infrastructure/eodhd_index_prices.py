"""Authenticated daily index observations with a persistent free-plan budget."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from http.client import HTTPException, HTTPSConnection
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from .durable_files import atomic_bytes
from .sector_prices import SparkSeries, _price

EODHD_DAILY_LIMIT = 20
EODHD_SOURCE = "EODHD"
_CODES = frozenset({"TOPX.INDX", "HSTECH.INDX", "CSI300.INDX", "KOSPI200.INDX"})


class EodhdError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _request(symbol: str, key: str) -> list[dict]:
    query = urlencode({"api_token": key, "fmt": "json", "period": "d"})
    try:
        # The hostname is fixed and redirects are never followed. Avoid HTTP
        # client request logging: the provider requires the key in the query.
        with closing(HTTPSConnection("eodhd.com", timeout=12)) as connection:
            connection.request(
                "GET",
                f"/api/eod/{symbol}?{query}",
                headers={"Accept": "application/json", "User-Agent": "Trading Max"},
            )
            response = connection.getresponse()
            if response.status == 429:
                raise EodhdError("provider_rate_limited")
            if response.status in {401, 403}:
                raise EodhdError("provider_auth_failed")
            if response.status != 200:
                raise EodhdError("provider_unavailable")
            payload = json.loads(response.read(2_000_001))
    except (OSError, HTTPException, ValueError):
        raise EodhdError("provider_unavailable") from None
    if not isinstance(payload, list):
        raise EodhdError("provider_unavailable")
    return payload


def _observations(payload: list[dict], *, end: date) -> dict[date, float]:
    rows = {}
    for row in payload:
        if not isinstance(row, dict):
            continue
        try:
            day = date.fromisoformat(row.get("date", ""))
        except (TypeError, ValueError):
            continue
        # Use the published close, not the adjusted-close column.
        if day <= end and (close := _price(row.get("close"))) is not None:
            if day in rows and rows[day] != close:
                raise EodhdError("provider_unavailable")
            rows[day] = close
    if len(rows) < 2:
        raise EodhdError("provider_unavailable")
    return rows


class EodhdIndexPrices:
    def __init__(
        self,
        root: Path,
        getter: Callable[[str, str], list[dict]] = _request,
    ) -> None:
        self.root = root / "state" / "indices" / "eodhd-v1"
        self.getter = getter
        self._lock = threading.RLock()

    def _consume(self, now: datetime) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.root / "budget.sqlite3", isolation_level=None)) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS daily_requests "
                "(day TEXT PRIMARY KEY, calls INTEGER NOT NULL)"
            )
            db.execute("BEGIN IMMEDIATE")
            day = now.astimezone(UTC).date().isoformat()
            db.execute("DELETE FROM daily_requests WHERE day < ?", (day,))
            cursor = db.execute(
                "INSERT INTO daily_requests(day, calls) VALUES (?, 1) "
                "ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls < ?",
                (day, EODHD_DAILY_LIMIT),
            )
            db.execute("COMMIT")
            if cursor.rowcount == 0:
                raise EodhdError("provider_rate_limited")

    def test(self, key: str, now: datetime) -> None:
        self._consume(now)
        _observations(self.getter("TOPX.INDX", key), end=now.date())

    def history(
        self,
        symbol: str,
        key: str,
        now: datetime,
        zone: ZoneInfo,
        *,
        end: date,
    ) -> SparkSeries | None:
        if symbol not in _CODES:
            raise ValueError("invalid-eodhd-index")
        suffix = sha256(key.encode()).hexdigest()[:16]
        path = self.root / f"{symbol}-{suffix}.json"
        with self._lock:
            saved = None
            stamp = None
            try:
                raw = json.loads(path.read_bytes())
                saved = _observations(raw["rows"], end=end)
                stamp = datetime.fromisoformat(raw["fetchedAt"])
                if stamp.tzinfo is None or stamp > now:
                    saved = stamp = None
            except (OSError, ValueError, KeyError, EodhdError):
                pass
            if saved is None or stamp is None or now - stamp >= timedelta(hours=6):
                try:
                    self._consume(now)
                    raw = self.getter(symbol, key)
                    # Keep only the dates and unadjusted levels used by this
                    # integration, including a current bar the caller may omit.
                    stored = _observations(raw, end=now.astimezone(zone).date())
                    atomic_bytes(
                        path,
                        json.dumps(
                            {
                                "fetchedAt": now.isoformat(),
                                "rows": [
                                    {"date": day.isoformat(), "close": close}
                                    for day, close in sorted(stored.items())
                                ],
                            }
                        ).encode(),
                    )
                    saved = {day: level for day, level in stored.items() if day <= end}
                    stamp = now
                except (OSError, sqlite3.Error, EodhdError):
                    if saved is None or stamp is None:
                        return None
            return SparkSeries(
                symbol,
                tuple(
                    int(datetime.combine(day, datetime.min.time(), zone).timestamp())
                    for day in sorted(saved)
                ),
                tuple(saved[day] for day in sorted(saved)),
                timezone=zone.key,
                fetched_at=stamp,
                stale=now - stamp >= timedelta(hours=6),
                source=EODHD_SOURCE,
                granularity="1d",
            )
