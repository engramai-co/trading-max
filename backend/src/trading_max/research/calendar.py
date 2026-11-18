"""Exchange sessions used by research, independent of account NAV sampling."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from functools import lru_cache

import exchange_calendars as xcals
import pandas as pd
from exchange_calendars.common_holidays import ascension_day, corpus_christi, whit_monday
from exchange_calendars.errors import CalendarError
from exchange_calendars.exchange_calendar import HolidayCalendar
from exchange_calendars.exchange_calendar_xfra import XFRAExchangeCalendar
from pandas.tseries.holiday import Holiday
from pydantic import Field

from trading_max.domain import DomainModel

YAHOO_SUFFIX_BY_MIC = {
    "XLON": ".L",
    "XAMS": ".AS",
    "XETR": ".DE",
    "XFRA": ".F",
    "XBRU": ".BR",
    "XMAD": ".MC",
    "XSTO": ".ST",
    "XHKG": ".HK",
    "XTKS": ".T",
    "XASX": ".AX",
    "XTSE": ".TO",
    "XPAR": ".PA",
    "XMIL": ".MI",
    "XSWX": ".SW",
    "XDUB": ".IR",
    "XKRX": ".KS",
    "XTAI": ".TW",
    "XCSE": ".CO",
    "XHEL": ".HE",
    "XLIS": ".LS",
    "XOSL": ".OL",
    "XWBO": ".VI",
    "XNYS": "",
    "XNAS": "",
    "ARCX": "",
}
YAHOO_MIC_BY_SUFFIX = {suffix: mic for mic, suffix in YAHOO_SUFFIX_BY_MIC.items() if suffix}

# Yahoo codes, MICs and the verified OpenFIGI exchange codes used by watchlists.
# https://www.openfigi.com/about/exchange-codes
_VENUES = {
    "XNYS": "XNYS NYQ NYSE UN",
    "XNAS": "XNAS NMS NGM NCM NGS NASDAQ NASDAQGS NASDAQGM NASDAQCM UW UQ UR",
    "XASE": "XASE ASE AMEX NYSEAMERICAN NYSEMKT UA",
    "ARCX": "ARCX PCX NYSEARCA ARCA UP",
    "BATS": "BATS BTS BZX CBOEBZX UF",
    "BATY": "BATY",
    "OTCM": "OTCM OTC PNK OQB OQX UV",
    "XLON": "XLON LSE LON LONDON LONDONSTOCKEXCHANGE LN LI IOB",
    "XFRA": "XFRA FRANKFURTSTOCKEXCHANGE FRA FRANKFURT GF",
    "XETR": "XETR GER XETRA ETR DEUTSCHEBOERSEXETRA GY",
    "XAMS": "XAMS AMSTERDAM AMS EURONEXTAMSTERDAM NA",
    "XBRU": "XBRU BRUSSELS NYSEEURONEXT-EURONEXTBRUSSELS BRU EURONEXTBRUSSELS BB",
    "XMAD": "XMAD MADRID MCE BOLSADEMADRID SQ",
    "XSTO": "XSTO NASDAQOMXNORDIC STO STOCKHOLM SS",
    "XHKG": "XHKG HONGKONG HKG HKEX HKSE HK",
    "XTKS": "XTKS TOKYO JPX TYO TOKYOSTOCKEXCHANGE JT",
    "XASX": "XASX AUSTRALIANSECURITIESEXCHANGE ASX ASX-ALLMARKETS AT",
    "XTSE": "XTSE TORONTO TOR TSX TORONTOSTOCKEXCHANGE CT",
    "XPAR": "XPAR PARIS NYSEEURONEXT-EURONEXTPARIS PAR EURONEXTPARIS FP",
    "XMIL": "XMIL MILAN MIL BORSAITALIANA IM",
    "XSWX": "XSWX SWISS SWISSEXCHANGE EBS SWX SIXSWISSEXCHANGE SE",
    "XDUB": "XDUB IRISH IRISHSTOCKEXCHANGE-ALLMARKET DUBLIN ISE ID",
    "XKRX": "XKRX KSE KSC KOSPI KP",
    "XKOS": "XKOS KOE KOSDAQ KQ",
    "XTAI": "XTAI TAIWAN TAIWANSTOCKEXCHANGE TAI TWSE",
    "XCSE": "XCSE COPENHAGEN OMXNORDICEXCHANGECOPENHAGENA/S CPH DC",
    "XHEL": "XHEL HELSINKI NASDAQOMXHELSINKILTD. HEL FH",
    "XLIS": "XLIS LISBON NYSEEURONEXT-EURONEXTLISBON LIS PL",
    "XOSL": "XOSL OSLO OSLOBORSASA OSL NO",
    "XWBO": "XWBO VIENNA WIENERBOERSEAG VIE AV",
    "ROCO": "ROCO TWO TPEX GRETAISECURITIESMARKET",
    "XNSE": "XNSE NSI NSE NATIONALSTOCKEXCHANGEOFINDIA IS",
    "XBOM": "XBOM BSE BSELTD BOMBAYSTOCKEXCHANGE BO BOM IB",
    "XSES": "XSES SES SGX SP",
    "XSHG": "XSHG SHH",
    "XSHE": "XSHE SHZ",
    "XJSE": "XJSE JNB SJ",
    "BVMF": "BVMF SAO",
    "XMEX": "XMEX MEX",
    "XCNQ": "XCNQ CNQ",
    "NEOE": "NEOE NEO",
    "XOSE": "XOSE OSA",
}
EXCHANGES = {code: mic for mic, codes in _VENUES.items() for code in codes.split()}
# Some OpenFIGI codes identify a composite. They rule out a foreign listing
# without identifying a single venue or providing a trading calendar.
_COMPOSITES = {
    "US": "XNYS XNAS XASE ARCX BATS BATY OTCM",
    "CBOE": "BATS BATY",
    "GR": "XFRA XETR",
    "JP": "XTKS XOSE",
    "KS": "XKRX XKOS",
    "KRX": "XKRX XKOS",
    "TT": "XTAI ROCO",
    "IN": "XNSE XBOM",
    "CN": "XTSE XCNQ NEOE",
    "AU": "XASX",
    "SM": "XMAD",
    "SW": "XSWX",
    "CH": "XSHG XSHE",
    "BZ": "BVMF",
    "MM": "XMEX",
}
_VENUE_SETS = {code: frozenset([mic]) for code, mic in EXCHANGES.items()}
_VENUE_SETS.update({code: frozenset(mics.split()) for code, mics in _COMPOSITES.items()})
_CALENDARS = {mic: mic for mic in YAHOO_SUFFIX_BY_MIC}
_CALENDARS.update(dict.fromkeys(("XNYS", "XNAS", "XASE", "ARCX", "BATS"), "XNYS"))

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
    open at any moment in the window without a calendar of its own. ``until``
    is when the first session after the listed ones opens: up to then the list
    is complete, and from then on it no longer says which session is current.
    """

    calendar: str
    sessions: list[ScheduledSession] = Field(default_factory=list)
    until: str | None = None


def calendar_name(exchange: str | None) -> str | None:
    return _CALENDARS.get(EXCHANGES.get("".join(str(exchange or "").upper().split())))


def listing_venues(symbol: str | None, exchange: str | None) -> frozenset[str]:
    """Known venues for an exact listing or market composite, independent of schedules."""
    code = "".join(str(exchange or "").upper().split())
    if code:
        return _VENUE_SETS.get(code, frozenset())
    _, dot, suffix = str(symbol or "").strip().upper().rpartition(".")
    mic = YAHOO_MIC_BY_SUFFIX.get(dot + suffix)
    return frozenset([mic]) if mic else frozenset()


def listing_calendar(symbol: str | None, exchange: str | None, timezone: str | None) -> str | None:
    """Resolve an observed venue or a qualified listing. Time zones span exchanges."""
    if str(exchange or "").strip():
        return calendar_name(exchange)
    _, dot, suffix = str(symbol or "").strip().upper().rpartition(".")
    return YAHOO_MIC_BY_SUFFIX.get(dot + suffix)


class _FrankfurtEquitiesCalendar(XFRAExchangeCalendar):
    """Frankfurt floor-market shares and funds follow their own extended session."""

    open_times = ((None, time(8)),)
    close_times = ((None, time(20)), (pd.Timestamp("2021-11-29"), time(22)))

    @property
    def special_closes(self):
        traded_holidays = HolidayCalendar(
            [
                ascension_day(start_date="2021-11-29"),
                whit_monday(start_date="2021-11-29"),
                corpus_christi(start_date="2021-11-29"),
                Holiday(
                    "German Unity Day",
                    month=10,
                    day=3,
                    start_date="2021-11-29",
                    days_of_week=(0, 1, 2, 3, 4),
                ),
            ]
        )
        return [*super().special_closes, (time(20), traded_holidays)]


@lru_cache(maxsize=64)
def market_calendar(name: str, first_year: int, last_year: int, *, buffer_years: int = 1):
    start = f"{first_year - buffer_years}-01-01"
    end = f"{last_year + buffer_years}-12-31"
    if name == "XFRA":
        return _FrankfurtEquitiesCalendar(start=start, end=end)
    return xcals.get_calendar(name, start=start, end=end)


@lru_cache(maxsize=256)
def listing_closure_date(name: str, since: datetime, observed: datetime) -> date | None:
    """The exchange-local date when the measured window covers no scheduled trading.

    The observation's exchange-local day must itself be sessionless, so a zero
    from the first broker poll before the open stays a zero. Check for any
    earlier session in the measured window as well: a London Friday baseline
    can carry that Friday's trading into a weekend observation.
    """
    # A UTC year boundary can also cross the exchange's local year boundary.
    try:
        cal = market_calendar(name, since.year, observed.year, buffer_years=0)
        first = since.astimezone(cal.tz).date()
        last = observed.astimezone(cal.tz).date()
        if first.year != since.year or last.year != observed.year:
            cal = market_calendar(name, first.year, last.year, buffer_years=0)
    except (CalendarError, ValueError):
        return None

    sessions = cal.schedule.loc[first.isoformat() : last.isoformat()]
    if not sessions.empty and sessions.index[-1].date() == last:
        return None
    overlaps = ((sessions["close"] >= since) & (sessions["open"] <= observed)).any()
    return None if overlaps else last


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
        schedule = market_calendar(name, start.year, end.year).schedule
    except CalendarError:
        return None
    following = schedule.loc[end + pd.Timedelta(days=1) :]
    return SessionSchedule(
        calendar=name,
        sessions=[
            ScheduledSession(
                date=label.date().isoformat(), open=_utc(row["open"]), close=_utc(row["close"])
            )
            for label, row in schedule.loc[start:end].iterrows()
        ],
        until=_utc(following["open"].iloc[0]) if not following.empty else None,
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
