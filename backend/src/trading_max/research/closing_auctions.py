"""Scheduled closing-price determinations for continuous-trading equities and ETFs."""

from dataclasses import dataclass
from datetime import date, datetime, time

from exchange_calendars.errors import CalendarError

from .calendar import market_calendar

# Offsets in seconds from the calendar's scheduled close. The endpoints are
# inclusive. A single instant represents a deterministic close. Extended
# trading at an already determined closing price is outside the auction.
Window = tuple[int, int]
FIXED = (0, 0)
FIVE_MINUTE_CALL = (300, 330)


@dataclass(frozen=True)
class ClosingRule:
    equity: Window
    etf: Window | None = None  # Same as equities unless the venue specifies otherwise.


# Only documented session types are eligible. A calendar can end at the start
# of the closing auction, its uncross, or the end of trading-at-last.
# Keys below are the calendar's local close, including shortened sessions.
_FIXED_CLOSE = ClosingRule(FIXED)
# https://www.nyse.com/markets/hours-calendars
# https://www.nyse.com/trade/auctions
# https://m.nasdaqtrader.com/content/productsservices/trading/crosses/openclose_faqs.pdf
# https://www.cboe.com/document/tech-spec/document/technical-specifications/cboe-titanium-u.s.-equitiesoptions-multicast-pitch-specification
# https://www.tsx.com/en/trading/calendars-and-trading-hours/trading-hours
_NORTH_AMERICAN_HOURS = {time(16): _FIXED_CLOSE, time(13): _FIXED_CLOSE}

# Euronext Instructions 4-01/4-03, the trading-group rows and notes on
# random uncrossing. The library's 14:05 (13:05 Lisbon) includes trading-at-last.
# https://www.euronext.com/en/regulation/euronext-regulated-markets
# https://www.euronext.com/en/trading/trading-hours-holidays
_FIVE_MINUTE_AUCTION = ClosingRule(FIVE_MINUTE_CALL)
_EUR_HALF = ClosingRule((-300, -270))
_EUR_HOURS = {time(17, 30): _FIVE_MINUTE_AUCTION, time(14, 5): _EUR_HALF}

_NORDIC = ClosingRule((-30, 0), (-300, -300))
# Nasdaq Nordic Market Model 3.1 and 3.2. ETFs end continuous trading five
# minutes before the share auction. The uncross randomises *before* its end.
# https://www.nasdaq.com/docs/2026/06/17/Nasdaq_Nordic_Market_Model_2026_03_Clean.pdf

_RULES = {
    "XNYS": _NORTH_AMERICAN_HOURS,
    "XTSE": _NORTH_AMERICAN_HOURS,
    "XAMS": _EUR_HOURS,
    "XBRU": _EUR_HOURS,
    "XPAR": _EUR_HOURS,
    "XMIL": {time(17, 30): _FIVE_MINUTE_AUCTION},
    "XLIS": {time(16, 30): _FIVE_MINUTE_AUCTION, time(13, 5): _EUR_HALF},
    "XDUB": {
        time(16, 28): ClosingRule((120, 150), (420, 450)),
        time(12, 28): ClosingRule((120, 150), (1920, 1950)),
    },
    # On the pre-Easter half day, the ETF book closes without a closing auction.
    # https://www.euronext.com/media/14571/download
    "XOSL": {time(16, 20): _FIVE_MINUTE_AUCTION, time(13): ClosingRule(FIVE_MINUTE_CALL, FIXED)},
    "XCSE": {time(17): _NORDIC},
    "XHEL": {time(18, 30): _NORDIC},
    "XSTO": {time(17, 30): _NORDIC, time(13): _NORDIC},
    # https://docs.londonstockexchange.com/sites/default/files/documents/service-and-technical-description-icsd-settlement.pdf
    "XLON": {time(16, 30): _FIVE_MINUTE_AUCTION, time(12, 30): _FIVE_MINUTE_AUCTION},
    # https://cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours
    # https://www.cashmarket.deutsche-boerse.com/cash-en/Stay-Informed/circulars-newsletters/deutsche-boerse-circulars/Final-trading-session-2026-5668166
    "XFRA": {time(22): _FIXED_CLOSE, time(20): _FIXED_CLOSE, time(14): _FIXED_CLOSE},
    # https://www.cashmarket.deutsche-boerse.com/cash-en/trading/Xetra/continuous-trading-with-auctions/auctionschedule
    # https://www.cashmarket.deutsche-boerse.com/resource/blob/1431340/a23cc3ff15d46a3b649bd23f1618b928/data/091_18e.pdf
    "XETR": {time(17, 30): _FIVE_MINUTE_AUCTION, time(14): _FIVE_MINUTE_AUCTION},
    # https://www.hkex.com.hk/Global/Exchange/FAQ/Securities-Market/Trading/CAS?sc_lang=en
    # https://www.hkex.com.hk/News/Market-Communications/2019/1910082news?sc_lang=en
    "XHKG": {time(16): ClosingRule((480, 600)), time(12): ClosingRule((480, 600))},
    # https://www.wienerborse.at/uploads/u/cms/files/trading/xetra-t7-detailed-specifications-market-models.pdf
    # https://www.wienerborse.at/en/news/vienna-stock-exchange-news/last-trading-day-12302026/
    "XWBO": {
        time(17, 30): ClosingRule(FIVE_MINUTE_CALL, (120, 150)),
        time(14, 15): ClosingRule(FIVE_MINUTE_CALL, (120, 150)),
    },
    # https://www.bolsasymercados.es/dam/descargas/exchange/renta-variable/equities-rigths-market-model-en.pdf
    # https://www.bolsasymercados.es/en/bme-exchange/trading/etfs.html
    # https://www.bolsasymercados.es/dam/descargas/regulacion/renta-variable/sociedad-de-bolsas/instrucciones-operativas/2026/2026-148-io-horarios-24-y-31.pdf
    "XMAD": {
        time(17, 30): ClosingRule(FIVE_MINUTE_CALL, (300, 300)),
        time(14): ClosingRule((0, 30), FIXED),
    },
    # https://www.six-group.com/en/products-services/the-swiss-stock-exchange/trading/trading-provisions/trading-hours.html
    # https://www.six-group.com/dam/download/the-swiss-stock-exchange/trading/trading-provisions/regulation/trading-guides/product-guide-equities.pdf
    "XSWX": {time(17, 30): ClosingRule((0, 120), (300, 420))},
    # https://www.jpx.co.jp/english/equities/trading/domestic/04.html
    "XTKS": {time(15): _FIXED_CLOSE, time(15, 30): _FIXED_CLOSE},
    # https://www.twse.com.tw/en/products/system/trading.html
    "XTAI": {time(13, 30): _FIXED_CLOSE},
    # https://global.krx.co.kr/contents/GLB/06/0602/0602010202/GLB0602010202T1.jsp
    # https://global.krx.co.kr/contents/GLB/06/0602/0602010204/GLB0602010204T9.jsp
    "XKRX": {time(15, 30): ClosingRule((0, 30)), time(16, 30): ClosingRule((0, 30))},
    # https://www.asx.com.au/content/dam/asx/rules-guidance-notes-waivers/asx-operating-rules/rules/asx_or_appendices.pdf
    # https://asxonline.com/content/asxonline/public/notices/2025/november/1402.25.11.html
    "XASX": {time(16): ClosingRule((600, 630)), time(14, 10): ClosingRule((0, 30))},
}


# Earlier Frankfurt hours are represented in the shared session calendar.
# These venues changed the applicable auction or its eligible securities.
# https://www.wienerborse.at/en/news/vienna-stock-exchange-news/atx-extension-of-the-closing-auction-from-2-may-no-trading-on-1-may-2019/
# https://www.asx.com.au/content/dam/asx/markets/trade-our-cash-market/equity-markets-working-groups/asx-trade-service-release-15-post-implementation-report.pdf
_VERIFIED_FROM = {"XHKG": date(2019, 10, 8), "XASX": date(2025, 6, 23), "XWBO": date(2019, 5, 2)}


# https://www.wienerborse.at/en/trading/trading-information/trading-hours/
# https://www.wienerborse.at/uploads/u/cms/files/trading/xetra-t7-detailed-specifications-market-models.pdf
def _vienna_windows(rule, product, segment, close_time):
    segment = " ".join(str(segment or "").lower().split())
    if segment in {"global market", "gmc1", "gmc2", "gmc3"}:
        return [rule.etf] if product != "ETF" else []
    if segment in {
        "atx",
        "ctp",
        "ctd",
        "dipc",
        "dimc",
        "prime market",
        "standard market continuous",
        "direct market continuous",
        "direct market plus continuous",
    }:
        return [rule.equity] if product != "ETF" else []
    if segment in {"etf", "etf2"} or (
        product == "ETF" and segment == "continuous trading with auctions"
    ):
        return [rule.etf] if product != "EQUITY" else []
    continuous = [rule.etf] if product == "ETF" else [rule.equity, rule.etf]
    if segment == "continuous trading with auctions":
        return continuous
    # Full-day auction-only segments uncross at 13:30:00–13:30:30.
    # No shortened auction-only schedule is registered.
    if close_time != time(17, 30):
        return []
    auction = (-14_400, -14_370)
    if segment in {
        "auction",
        "auction only",
        "standard market auction",
        "direct market auction",
        "direct market plus auction",
        "foao",
        "aod",
        "aof",
        "aonc",
        "dipa",
        "dima",
        "diqi",
    }:
        return [auction]
    return [*continuous, auction]


def headline_session(
    name: str | None, stamp: datetime, asset_type: str | None, *, segment: str | None = None
) -> tuple[str | None, str | None]:
    """Assign a timed lead to its listing's session and disclose a random closing window."""
    if name not in _RULES:
        return None, None
    try:
        exchange = market_calendar(name, stamp.year, stamp.year)
        day = stamp.astimezone(exchange.tz).date()
        session = exchange.date_to_session(day.isoformat(), direction="next")
        if day < _VERIFIED_FROM.get(name, date.min):
            return None, None
        close = exchange.session_close(session)
        rule = _RULES[name].get(close.tz_convert(exchange.tz).time())
        if rule is None:
            return None, None
        product = str(asset_type or "").strip().upper()
        if product in {"ETF", "EQUITY"}:
            windows = [rule.etf or rule.equity] if product == "ETF" else [rule.equity]
        elif not product or product in {"UNKNOWN", "FUND"}:
            windows = [rule.equity, rule.etf or rule.equity]
        else:
            return None, None
        if name == "XWBO":
            windows = _vienna_windows(rule, product, segment, close.tz_convert(exchange.tz).time())
            if not windows:
                return None, None
        if session.date() != day:
            return session.date().isoformat(), None
        seconds = (stamp - close).total_seconds()
        if all(seconds > latest for _, latest in windows):
            return exchange.next_session(session).date().isoformat(), None
        if any(seconds > latest for _, latest in windows):
            # With no instrument type, the verified cutoffs imply different sessions.
            return None, None
        random_end = any(first < last and first <= seconds <= last for first, last in windows)
        return day.isoformat(), "closing_auction_window" if random_end else None
    except (CalendarError, OverflowError, ValueError):
        return None, None
