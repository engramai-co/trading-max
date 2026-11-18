"""One listing identity for broker positions and research quotes.

A listing is a market and the symbol on it, written ``US:IAG`` or ``LSE:IAG``.
Trading 212 instrument codes name their market in a suffix (``IAG_US_EQ``,
``IAGl_EQ``), the same code the display ticker drops. Research symbols name
London with ``.L`` and leave US listings bare, so the exchange that quotes them
decides. A listing either side cannot place is unknown and matches nothing.
"""

from __future__ import annotations

from .calendar import listing_calendar

US = "US"
LONDON = "LSE"


def broker_listing(instrument: str | None) -> str | None:
    """The listing of a Trading 212 instrument code."""

    code = str(instrument or "").strip()
    for suffix, market in (("_US_EQ", US), ("l_EQ", LONDON)):
        symbol = code.removesuffix(suffix).upper() if code.endswith(suffix) else ""
        if symbol:
            return f"{market}:{symbol}"
    return None


def quote_listing(symbol: str | None, exchange: str | None, timezone: str | None) -> str | None:
    """The listing of a research quote: its symbol on the exchange quoting it."""

    code = str(symbol or "").strip().upper()
    calendar = listing_calendar(code, exchange, timezone)
    if code.endswith(".L") and len(code) > 2 and calendar == "XLON":
        return f"{LONDON}:{code.removesuffix('.L')}"
    if code and "." not in code and calendar == "XNYS":
        return f"{US}:{code}"
    # Retain the provider suffix and require the exchange to corroborate it.
    suffixes = {
        "XHKG": (".HK",),
        "XTKS": (".T",),
        "XKRX": (".KS", ".KQ"),
        "XPAR": (".PA",),
        "XAMS": (".AS",),
        "XBRU": (".BR",),
        "XETR": (".DE",),
        "XFRA": (".F", ".DE"),
        "XMIL": (".MI",),
        "XMAD": (".MC",),
        "XSWX": (".SW",),
        "XDUB": (".IR",),
    }
    if code.endswith(suffixes.get(calendar, ())):
        return f"{calendar}:{code}"
    return None
