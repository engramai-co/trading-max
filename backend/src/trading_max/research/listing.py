"""One listing identity for broker positions and research quotes.

A listing is a market and the symbol on it, written ``US:IAG`` or ``LSE:IAG``.
Trading 212 instrument codes name their market in a suffix (``IAG_US_EQ``,
``IAGl_EQ``), the same code the display ticker drops. Research symbols name
London with ``.L`` and leave US listings bare, so the exchange that quotes them
decides. A listing either side cannot place is unknown and matches nothing.
"""

from __future__ import annotations

from typing import NamedTuple

from trading_max.reference.venues import local_venue_symbol

from .venues import VenueClaim, VenueResolution, provider_claim, resolve_venue

US = "US"
LONDON = "LSE"


class ReceiptTerms(NamedTuple):
    mic: str
    ordinary_per_receipt: int
    source: str


# US broker bindings use a country-level ID. Receipt terms apply only on the
# reviewed venue, so disambiguate it before issuing that ID.
BP_LISTING_SOURCE = (
    "https://www.bp.com/investors/shareholder-and-dividend-information/share-listing-information"
)
REVIEWED_RECEIPTS = {
    "US:BP": ReceiptTerms("XNYS", 6, BP_LISTING_SOURCE),
    "US:SHEL": ReceiptTerms(
        "XNYS",
        2,
        "https://www.shell.com/investors/information-for-shareholders/shareholder-faqs.html",
    ),
    "US:TSM": ReceiptTerms(
        "XNYS", 5, "https://investor.tsmc.com/sites/ir/sec-filings/2025_20F%20Report.pdf"
    ),
    "US:BABA": ReceiptTerms(
        "XNYS",
        8,
        "https://www.sec.gov/Archives/edgar/data/1577552/000119312526231755/baba-20260331.htm",
    ),
    "US:NOK": ReceiptTerms(
        "XNYS", 1, "https://www.nokia.com/system/files/2026-03/nokia-form-20-f-2025.pdf"
    ),
    "US:ARM": ReceiptTerms("XNAS", 1, "https://investors.arm.com/node/8281/html"),
}
REVIEWED_ORDINARY_SOURCES = {
    "LSE:BP": BP_LISTING_SOURCE,
    "XCSE:NOVO-B.CO": "https://annualreport.novonordisk.com/2025/strategic-aspirations/financial-performance.html",
    "XSTO:VOLV-B.ST": "https://www.volvogroup.com/en/investors/the-volvo-share.html",
    "XSTO:VOLV-A.ST": "https://www.volvogroup.com/en/investors/the-volvo-share.html",
}
EQUAL_DISTRIBUTION_CLASSES = frozenset({"XCSE:NOVO-B.CO", "XSTO:VOLV-A.ST", "XSTO:VOLV-B.ST"})


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

    return resolved_quote_listing(symbol, resolve_venue(symbol, provider_claim(exchange)), exchange)


def resolved_quote_listing(
    symbol: str | None, venue: VenueResolution, exchange: str | None = None
) -> str | None:
    code = str(symbol or "").strip().upper()
    calendar = venue.calendar
    if code.endswith(".L") and len(code) > 2 and calendar == "XLON":
        listing = f"{LONDON}:{code.removesuffix('.L')}"
        if (
            listing in REVIEWED_ORDINARY_SOURCES
            and resolve_venue(None, provider_claim(exchange)).calendar != "XLON"
        ):
            return None
        return listing
    if code and "." not in code and calendar == "XNYS":
        listing = f"{US}:{code}"
        receipt = REVIEWED_RECEIPTS.get(listing)
        if (
            receipt
            and not venue.venues <= resolve_venue(None, VenueClaim("mic", receipt.mic)).venues
        ):
            return None
        return listing
    # KOSDAQ shares the Korean trading calendar but has its own listing MIC.
    mic = next(iter(venue.venues)) if len(venue.venues) == 1 else None
    if calendar and local_venue_symbol(code, mic or calendar) != code:
        return f"{calendar}:{code}"
    return None
