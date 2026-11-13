"""Exchange sessions and refresh timing for the sector boards.

Each market's regular sessions come from its exchange calendar. A board is
refreshed while its session trades and once more after the close, when the
official closing prices have settled; a midday break pauses the refreshes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

import pandas as pd
from trading_max.research.calendar import market_calendar

from .india_sessions import INDIA_END, INDIA_START, INDIAN_EXCHANGES, india_sessions
from .sector_models import SectorMarketCode, SectorSessionWindow


@dataclass(frozen=True, slots=True)
class MarketCalendar:
    calendar: str
    timezone: str
    refresh_minutes: int = 10
    quote_weight: float = 1.0
    listing_calendars: tuple[tuple[str, str], ...] = ()


MARKETS: dict[SectorMarketCode, MarketCalendar] = {
    "us": MarketCalendar("XNYS", "America/New_York", refresh_minutes=20),
    "uk": MarketCalendar("XLON", "Europe/London"),
    "hk": MarketCalendar("XHKG", "Asia/Hong_Kong"),
    "kr": MarketCalendar("XKRX", "Asia/Seoul"),
    "jp": MarketCalendar("XTKS", "Asia/Tokyo"),
    "eu": MarketCalendar("XETR", "Europe/London", refresh_minutes=30, quote_weight=0.95),
    "tw": MarketCalendar("XTAI", "Asia/Taipei", listing_calendars=((".TWO", "ROCO"),)),
    "in": MarketCalendar(
        "XNSE",
        "Asia/Kolkata",
        refresh_minutes=20,
        quote_weight=0.95,
        listing_calendars=((".BO", "XBOM"),),
    ),
    "ca": MarketCalendar("XTSE", "America/Toronto"),
    "au": MarketCalendar("XASX", "Australia/Sydney"),
}

# Closing auctions finish within minutes; a board fetched this long after the
# close carries official closing prices and is complete.
COMPLETE_AFTER = timedelta(minutes=30)
# The first slot after a midday break begins still captures the morning's last prints.
BREAK_TAIL = timedelta(minutes=10)
# A session whose prices never arrive is retried until this long after its close.
GIVE_UP_AFTER = timedelta(hours=3)
# A market without any board fills it from its latest session this many times
# after that window, then waits for the next session.
BACKFILL_ATTEMPTS = 3


def _utc(value: object) -> datetime | None:
    if value is None or pd.isna(value):
        return None
    stamp = pd.Timestamp(value)
    stamp = stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")
    return stamp.to_pydatetime()


@lru_cache(maxsize=256)
def sessions_between(
    market: SectorMarketCode, start: date, end: date
) -> tuple[SectorSessionWindow, ...]:
    """Regular sessions whose dates fall from `start` to `end`, in UTC."""

    return exchange_sessions(MARKETS[market].calendar, start, end)


def calendar_known(name: str, timezone: str, now: datetime) -> bool:
    if name not in INDIAN_EXCHANGES:
        return True
    return INDIA_START <= now.astimezone(ZoneInfo(timezone)).date() <= INDIA_END


# TWSE's published 2027 schedule adds these closures to the library.
# TPEx's 2026 cash-equity calendar matches TWSE's 2026 schedule. The
# separate venue identity permits its own future or extraordinary notices.
_TWSE_CLOSURES = {date(2027, 2, 2), date(2027, 2, 3), date(2027, 4, 6), date(2027, 12, 24)}


@lru_cache(maxsize=256)
def exchange_sessions(
    name: str, start: date, end: date, *, buffer_years: int = 1
) -> tuple[SectorSessionWindow, ...]:
    if name in INDIAN_EXCHANGES:
        return india_sessions(name, start, end)
    # exchange_calendars has no standalone Taipei Exchange calendar.
    name = "XTAI" if name == "ROCO" else name
    calendar = market_calendar(name, start.year, end.year, buffer_years=buffer_years)
    schedule = calendar.schedule.loc[pd.Timestamp(start) : pd.Timestamp(end)]
    windows = []
    for label, row in schedule.iterrows():
        day = pd.Timestamp(label).date()
        if name == "XTAI" and day in _TWSE_CLOSURES:
            continue
        opened, closed = _utc(row["open"]), _utc(row["close"])
        if opened is None or closed is None:
            continue
        windows.append(
            SectorSessionWindow(
                date=day.isoformat(),
                open=opened,
                close=closed,
                break_start=_utc(row.get("break_start")),
                break_end=_utc(row.get("break_end")),
            )
        )
    return tuple(windows)


def latest_session(market: SectorMarketCode, now: datetime) -> SectorSessionWindow | None:
    """The latest session that has opened by `now`."""

    calendar = MARKETS[market]
    if not calendar_known(calendar.calendar, calendar.timezone, now):
        return None
    started = [
        session
        for session in sessions_between(
            market, (now - timedelta(days=14)).date(), (now + timedelta(days=1)).date()
        )
        if session.open <= now
    ]
    return started[-1] if started else None


def next_session(market: SectorMarketCode, now: datetime) -> SectorSessionWindow | None:
    """The first session that opens after `now`."""

    calendar = MARKETS[market]
    if not calendar_known(calendar.calendar, calendar.timezone, now):
        return None
    return next(
        (
            session
            for session in sessions_between(
                market, (now - timedelta(days=1)).date(), (now + timedelta(days=14)).date()
            )
            if session.open > now
        ),
        None,
    )


def prior_session_dates(market: SectorMarketCode, session_date: str, count: int) -> list[str]:
    """The `count` session dates before `session_date`, oldest first."""

    if count <= 0:
        return []
    day = date.fromisoformat(session_date)
    sessions = sessions_between(
        market, day - timedelta(days=count * 3 + 14), day - timedelta(days=1)
    )
    return [session.date for session in sessions][-count:]


def in_break(session: SectorSessionWindow, now: datetime) -> bool:
    """Inside a midday break, after the slot that captures the morning's close."""

    return (
        session.break_start is not None
        and session.break_end is not None
        and session.break_start + BREAK_TAIL <= now < session.break_end
    )


def board_complete(session: SectorSessionWindow, fetched_at: datetime) -> bool:
    return fetched_at >= session.close + COMPLETE_AFTER


def is_due(
    session: SectorSessionWindow,
    board_session: str | None,
    board_complete: bool,
    now: datetime,
    *,
    backfill_attempts: int = 0,
) -> bool:
    """Whether a market's board needs a refresh at `now`.

    A board is refreshed until it holds the current session's closing prices,
    never during a midday break, and at most until a few hours after the
    close: a session whose prices never arrive keeps the last board rather
    than polling all night. Later still, a market without the latest session's
    closing board (none at all, an older session's, or this session's unsettled
    one, as after a restart) is filled from that session, but only
    ``BACKFILL_ATTEMPTS`` times.
    """

    if in_break(session, now):
        return False
    if board_session is not None and (
        board_session > session.date or (board_session == session.date and board_complete)
    ):
        return False
    if now <= session.close + COMPLETE_AFTER + GIVE_UP_AFTER:
        return True
    return backfill_attempts < BACKFILL_ATTEMPTS


__all__ = [
    "BACKFILL_ATTEMPTS",
    "BREAK_TAIL",
    "COMPLETE_AFTER",
    "GIVE_UP_AFTER",
    "MARKETS",
    "MarketCalendar",
    "board_complete",
    "in_break",
    "is_due",
    "latest_session",
    "next_session",
    "prior_session_dates",
    "sessions_between",
]
