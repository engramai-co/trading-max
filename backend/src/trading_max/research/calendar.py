"""Exchange sessions used by research, independent of account NAV sampling."""

from __future__ import annotations

from functools import lru_cache

import exchange_calendars as xcals
import pandas as pd

EXCHANGES = {
    "NMS": "XNYS",
    "NGM": "XNYS",
    "NCM": "XNYS",
    "NYQ": "XNYS",
    "ASE": "XNYS",
    "PCX": "XNYS",
    "NASDAQ": "XNYS",
    "NYSE": "XNYS",
    "LSE": "XLON",
    "LONDON": "XLON",
    "HKG": "XHKG",
    "JPX": "XTKS",
    "TOR": "XTSE",
    "ASX": "XASX",
    "GER": "XFRA",
    "PAR": "XPAR",
    "AMS": "XAMS",
}


def calendar_name(exchange: str | None) -> str | None:
    return EXCHANGES.get(str(exchange or "").upper())


@lru_cache(maxsize=64)
def market_calendar(name: str, first_year: int, last_year: int):
    return xcals.get_calendar(name, start=f"{first_year - 1}-01-01", end=f"{last_year + 1}-12-31")


def completed_daily_bars(frame: pd.DataFrame, *, now: pd.Timestamp) -> pd.DataFrame:
    """Keep daily indicators off a still-forming bar, including early-close sessions."""
    if frame.empty:
        return frame
    now = now.tz_localize("UTC") if now.tzinfo is None else now.tz_convert("UTC")
    local = now.tz_convert(frame.index.tz) if frame.index.tz else now
    today = pd.Timestamp(local.date())
    days = frame.index.tz_localize(None).normalize()
    complete = days < today
    name = calendar_name(frame.attrs.get("exchange"))
    if name:
        cal = market_calendar(name, today.year, today.year)
        if cal.is_session(today) and cal.session_close(today) <= now:
            complete |= days == today
    return frame.loc[complete].copy()


def completed_months(close: pd.Series, *, exchange: str | None, now: pd.Timestamp) -> pd.Series:
    """A completed return requires both true month-end closes, never just a resample label."""
    close = close.dropna()
    if close.empty:
        return pd.Series(dtype=float)
    timestamps = close.index.tz_localize(None).normalize()
    daily = pd.Series(close.to_numpy(), index=timestamps)
    monthly = daily.resample("ME").last()
    name = calendar_name(exchange)
    if not name:
        # Legacy data with unknown exchange: final observed month stays pending.
        cutoff = min(
            pd.Timestamp(now).tz_localize(None).to_period("M"), timestamps[-1].to_period("M")
        )
        return monthly[monthly.index.to_period("M") < cutoff].pct_change(fill_method=None).dropna()
    cal = market_calendar(name, timestamps[0].year, max(timestamps[-1].year, now.year))
    now = now.tz_localize("UTC") if now.tzinfo is None else now.tz_convert("UTC")
    for end in monthly.index:
        sessions = cal.sessions_in_range(end.replace(day=1), end)
        if (
            sessions.empty
            or sessions[-1] not in daily.index
            or cal.session_close(sessions[-1]) > now
        ):
            monthly.loc[end] = float("nan")
    return monthly.pct_change(fill_method=None).dropna()
