"""Allowlisted calendar requests and publisher credits for a local workspace."""

from calendar import month_name
from dataclasses import dataclass
from datetime import date, timedelta
from urllib.parse import urlencode


@dataclass(frozen=True)
class CalendarSource:
    key: str
    market: str
    publisher: str
    zone: str
    url: str
    parser: str
    credit: str


def sources(today: date) -> list[CalendarSource]:
    end = today + timedelta(days=180)
    result = []

    def add(key, market, publisher, zone, url, parser=None, credit=None):
        result.append(
            CalendarSource(key, market, publisher, zone, url, parser or key, credit or publisher)
        )

    ny = "America/New_York"
    fed = "Federal Reserve Board"
    add(
        "bea",
        "US",
        "Bureau of Economic Analysis",
        ny,
        "https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics",
        "ical",
    )
    census = "https://www.census.gov/economic-indicators/calendar-listview"
    add("census", "US", "U.S. Census Bureau", ny, census + ".html")
    # The canonical page switches to next year before January. Read the linked
    # current-year archive only when the canonical table actually rolls over.
    add("fomc", "US", fed, ny, "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm")
    first = today.replace(day=1)
    following = (first + timedelta(days=32)).replace(day=1)
    for month in [first, following]:
        slug = f"{month.year}-{month_name[month.month].lower()}"
        add(
            "fedmonth-" + slug,
            "US",
            fed,
            ny,
            f"https://www.federalreserve.gov/newsevents/{slug}.htm",
            "fedmonth",
        )
    for rid in [10, 50, 192, 46]:
        query = urlencode(
            {"rid": rid, "vs": today.isoformat(), "ve": end.isoformat(), "view": "year"}
        )
        add(
            f"fred-{rid}",
            "US",
            "Bureau of Labor Statistics via FRED",
            "America/Chicago",
            "https://fred.stlouisfed.org/releases/calendar?" + query,
            "fred",
            "U.S. Bureau of Labor Statistics, via FRED, Federal Reserve Bank of St. Louis",
        )
    query = urlencode(
        {
            "sort": "release_date_asc",
            "fromDate": today.isoformat(),
            "toDate": end.isoformat(),
            "limit": 1000,
        }
    )
    for state in ["upcoming", "cancelled"]:
        add(
            "ons-" + state,
            "GB",
            "Office for National Statistics",
            "Europe/London",
            f"https://api.beta.ons.gov.uk/v1/search/releases?release-type=type-{state}&{query}",
            "ons",
            "Office for National Statistics. Contains public sector information licensed under the Open Government Licence v3.0.",
        )
    add(
        "boe",
        "GB",
        "Bank of England",
        "Europe/London",
        "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates",
        credit="Bank of England. Personal and internal non-commercial use.",
    )
    add(
        "eurostat",
        "EA",
        "Eurostat",
        "Europe/Luxembourg",
        "https://ec.europa.eu/eurostat/o/calendars/eventsIcal?theme=0&category=2",
        "ical",
        "European Commission, Eurostat, Euro indicators release calendar. Chinese labels by Trading Max. Eurostat is not responsible for the translation.",
    )
    for key, path in [("ecb", "mgcgc"), ("ecbstats", "statscal")]:
        add(
            key,
            "EA",
            "European Central Bank",
            "Europe/Berlin",
            f"https://www.ecb.europa.eu/press/calendars/{path}/html/index.en.html",
        )
    for key, series, agency in [
        ("cpi", "00200573", "Statistics Bureau of Japan"),
        ("labour", "00200531", "Statistics Bureau of Japan"),
        ("output", "00550300", "Ministry of Economy, Trade and Industry"),
    ]:
        add(
            "estat-" + key,
            "JP",
            agency,
            "Asia/Tokyo",
            f"https://www.e-stat.go.jp/release-calendar/statistics/{series}",
            "estat",
            f"{agency}, via e-Stat. Titles translated and abridged by Trading Max.",
        )
    add(
        "cao",
        "JP",
        "Cabinet Office, Japan",
        "Asia/Tokyo",
        "https://www.esri.cao.go.jp/en/sna/kouhyou/kouhyou_top.html",
    )
    add("boj", "JP", "Bank of Japan", "Asia/Tokyo", "https://www.boj.or.jp/en/mopo/mpmsche_minu/")
    add(
        "hk",
        "HK",
        "Census and Statistics Department",
        "Asia/Hong_Kong",
        "https://www.censtatd.gov.hk/data/en/press_release/press_release_index.json",
        credit="Census and Statistics Department, © Government of the Hong Kong SAR. Display labels adapted by Trading Max.",
    )
    add(
        "mods",
        "KR",
        "Ministry of Data and Statistics",
        "Asia/Seoul",
        "https://mods.go.kr/newsPln.es?mid=a10305000000&oa_mm=ALL",
        credit="Ministry of Data and Statistics, Republic of Korea. Display titles translated by Trading Max.",
    )
    add(
        "bok",
        "KR",
        "Bank of Korea",
        "Asia/Seoul",
        "https://www.bok.or.kr/eng/main/contents.do?menuNo=400020",
    )
    return result
