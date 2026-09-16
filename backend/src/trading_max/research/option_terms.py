"""Explicit terms for the limited set of public contracts we can model.

OCC standard equity terms: https://www.optionseducation.org/optionsoverview/options-basics
Unconfirmed adjusted deliverables and index settlement conventions are excluded.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Any

import exchange_calendars as xcals
import pandas as pd
import yfinance as yf


@lru_cache(maxsize=512)
def expiry_instant(expiry: date, *, extended: bool = False) -> datetime | None:
    calendar = xcals.get_calendar(
        "XNYS", start=f"{expiry.year - 1}-01-01", end=f"{expiry.year + 1}-12-31"
    )
    stamp = pd.Timestamp(expiry)
    if not calendar.is_session(stamp):
        return None
    close = calendar.session_close(stamp).to_pydatetime()
    return close + timedelta(minutes=15) if extended else close


def contract_terms(
    symbol: str, size: str, underlying: str, asset_type: str, exchange: str, expiry: date
) -> dict[str, Any]:
    match = re.fullmatch(r"([A-Z.]+)(\d{6})([CP])(\d{8})", symbol)
    normal = bool(
        match
        and match.group(1) == underlying.upper()
        and match.group(2) == expiry.strftime("%y%m%d")
        and size == "REGULAR"
        and exchange in {"NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BATS"}
        and asset_type in {"EQUITY", "ETF"}
    )
    # These liquid ETF classes trade until 16:15; do not generalize that to
    # every fund or any cash-settled index contract.
    supported = normal and (asset_type == "EQUITY" or underlying in {"SPY", "QQQ", "IWM"})
    instant = expiry_instant(expiry, extended=asset_type == "ETF") if supported else None
    return {
        "multiplier": 100.0 if normal else None,
        "exercise_style": "American" if normal else None,
        "settlement": "physical" if normal else None,
        "expiry_instant": instant.isoformat() if instant else None,
        "terms_state": "available" if instant else "unsupported",
        "terms_source": "OCC standard equity terms + provider REGULAR contract size"
        if normal
        else None,
    }


@lru_cache(maxsize=8)
def treasury_rate(as_of_day: str) -> dict[str, Any]:
    """A dated three-month Treasury discount-yield proxy, never a timeless constant."""
    cutoff = date.fromisoformat(as_of_day)
    try:
        frame = yf.Ticker("^IRX").history(
            start=(cutoff - timedelta(days=10)).isoformat(),
            end=(cutoff + timedelta(days=1)).isoformat(),
            auto_adjust=False,
        )
        values = frame["Close"].dropna()
        stamp, raw = values.index[-1], float(values.iloc[-1])
        if not math.isfinite(raw) or raw < 0 or raw > 30:
            raise ValueError("invalid Treasury observation")
        # Convert the 13-week bank-discount quote to an annual continuous rate.
        maturity = 91
        discount = raw / 100
        rate = -math.log(1 - discount * maturity / 360) * 365 / maturity
        return {
            "value": rate,
            "asOf": stamp.date().isoformat(),
            "source": "Yahoo Finance ^IRX",
            "method": "13-week bank-discount yield converted to continuous annual rate; flat term proxy",
        }
    except Exception:
        return {
            "value": None,
            "asOf": None,
            "source": "Yahoo Finance ^IRX",
            "method": "unavailable",
        }


def chain_availability(
    captured_at: str, expiries: list[dict[str, Any]], now: datetime | None = None
) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    try:
        capture = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
        capture = capture.replace(tzinfo=UTC) if capture.tzinfo is None else capture
        recent = 0 <= (now - capture).total_seconds() <= 86400
    except ValueError:
        recent = False
    active = []
    for row in expiries:
        value = row.get("expiryInstant")
        try:
            if value and datetime.fromisoformat(value.replace("Z", "+00:00")) > now:
                active.append(row["expiry"])
        except (ValueError, TypeError):
            continue
    return {
        "evaluatedAt": now.isoformat(),
        "state": "current" if recent and active else "historical",
        "currentExpiries": sorted(active) if recent else [],
    }
