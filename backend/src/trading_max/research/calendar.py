"""Exchange sessions used by research, independent of account NAV sampling."""

from __future__ import annotations

from datetime import datetime, timedelta
from functools import lru_cache

import exchange_calendars as xcals
import pandas as pd
from exchange_calendars.errors import CalendarError
from pydantic import Field

from trading_max.domain import DomainModel

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

# Exchanges by the time zone the provider reports, for exchange names it does
# not give as a code above (for example NasdaqGS or XETRA).
ZONES = {
    "America/New_York": "XNYS",
    "America/Toronto": "XTSE",
    "Europe/London": "XLON",
    "Europe/Dublin": "XDUB",
    "Europe/Amsterdam": "XAMS",
    "Europe/Berlin": "XETR",
    "Europe/Brussels": "XBRU",
    "Europe/Madrid": "XMAD",
    "Europe/Rome": "XMIL",
    "Europe/Paris": "XPAR",
    "Europe/Zurich": "XSWX",
    "Asia/Hong_Kong": "XHKG",
    "Asia/Shanghai": "XSHG",
    "Asia/Seoul": "XKRX",
    "Asia/Taipei": "XTAI",
    "Asia/Tokyo": "XTKS",
    "Australia/Sydney": "XASX",
}
# A schedule covers the recent sessions a quote or broker price can belong to
# and the coming ones a page can stay open into.
SCHEDULE_BEFORE = timedelta(days=14)
SCHEDULE_AFTER = timedelta(days=10)


class ScheduledSession(DomainModel):
    """One regular session as the exchange schedules it, in UTC."""

    date: str
    open: str
    close: str


class SessionSchedule(DomainModel):
    """An exchange's sessions around the time a quote was served.

    Holidays are absent and early closes keep their earlier close, so a client
    can tell the latest completed session, the one before it and whether one is
    open at any moment in the window without a calendar of its own.
    """

    calendar: str
    sessions: list[ScheduledSession] = Field(default_factory=list)


def calendar_name(exchange: str | None) -> str | None:
    return EXCHANGES.get(str(exchange or "").upper())


def listing_calendar(symbol: str | None, exchange: str | None, timezone: str | None) -> str | None:
    """The calendar of the exchange that quotes a listing.

    The provider's exchange code decides, then its time zone, then a London
    ``.L`` symbol.
    """

    return (
        calendar_name(exchange)
        or ZONES.get(str(timezone or ""))
        or ("XLON" if str(symbol or "").strip().upper().endswith(".L") else None)
    )


@lru_cache(maxsize=64)
def market_calendar(name: str, first_year: int, last_year: int):
    return xcals.get_calendar(name, start=f"{first_year - 1}-01-01", end=f"{last_year + 1}-12-31")


def _utc(value: pd.Timestamp) -> str:
    return value.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def session_schedule(name: str | None, now: datetime) -> SessionSchedule | None:
    """Scheduled sessions from two weeks before `now` to ten days after it."""

    if not name:
        return None
    current = pd.Timestamp(now)
    current = current.tz_localize("UTC") if current.tzinfo is None else current.tz_convert("UTC")
    start = (current - SCHEDULE_BEFORE).tz_localize(None).normalize()
    end = (current + SCHEDULE_AFTER).tz_localize(None).normalize()
    try:
        frame = market_calendar(name, start.year, end.year).schedule.loc[start:end]
    except CalendarError:
        return None
    return SessionSchedule(
        calendar=name,
        sessions=[
            ScheduledSession(
                date=label.date().isoformat(), open=_utc(row["open"]), close=_utc(row["close"])
            )
            for label, row in frame.iterrows()
        ],
    )


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
