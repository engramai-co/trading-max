"""Official Indian cash-equity schedules for the verified calendar year."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from .sector_models import SectorSessionWindow

INDIAN_EXCHANGES = {"XNSE", "XBOM"}
INDIA_START = date(2026, 1, 1)
INDIA_END = date(2026, 12, 31)
INDIA_ZONE = ZoneInfo("Asia/Kolkata")

# NSE/CMTR/71775 and BSE 20251212-8, as amended by NSE/CMTR/72260
# and BSE 20260112-8 (January 15 municipal election).
_HOLIDAYS = {
    date.fromisoformat(f"2026-{day}")
    for day in (
        "01-15",
        "01-26",
        "03-03",
        "03-26",
        "03-31",
        "04-03",
        "04-14",
        "05-01",
        "05-28",
        "06-26",
        "09-14",
        "10-02",
        "10-20",
        "11-10",
        "11-24",
        "12-25",
    )
}
_REGULAR = (time(9, 15), time(15, 30))
_SPECIAL = {
    date(2026, 2, 1): _REGULAR,  # Union Budget: NSE/CMTR/72349 and BSE 20260116-33.
    date(2026, 11, 8): (time(14, 20), time(15, 30)),  # NSE/CMTR/76941 and BSE 20261019-9.
}
# The two exchanges announced the same 2026 cash-equity schedule. Keep their
# identities separate so a later venue-specific notice can override one.
_SCHEDULES = dict.fromkeys(INDIAN_EXCHANGES, (_HOLIDAYS, _SPECIAL))


def india_sessions(name: str, start: date, end: date) -> tuple[SectorSessionWindow, ...]:
    """Only emit verified days; never extend a calendar by guessing weekdays."""
    holidays, special = _SCHEDULES[name]
    day = max(start, INDIA_START)
    end = min(end, INDIA_END)
    windows = []
    while day <= end:
        hours = special.get(day)
        if hours is None and day.weekday() < 5 and day not in holidays:
            hours = _REGULAR
        if hours is not None:
            opened, closed = (
                datetime.combine(day, hour, INDIA_ZONE).astimezone(UTC) for hour in hours
            )
            windows.append(SectorSessionWindow(date=day.isoformat(), open=opened, close=closed))
        day += timedelta(days=1)
    return tuple(windows)
