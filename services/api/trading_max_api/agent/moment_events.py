"""Join dated listing evidence to published daily price sessions."""

from datetime import datetime

from trading_max.research.calendar import listing_calendar
from trading_max.research.closing_auctions import headline_session
from trading_max.research.news import NEWS_KEY, NEWS_STATUS_KEY

from .events import headline_stories, listed_dividends, listed_headlines
from .tools import EARNINGS, FINANCIALS, FUNDAMENTALS, _mapped, _Read, _rows


def listing_moment_events(
    read: _Read, args, exchange_calendar, calendar, metrics, evidence, *, series=None
):
    keys = []
    issues = []
    events = []
    ticker = args.ticker
    if calendar:
        keys.append(EARNINGS)
    if metrics:
        keys.append(FUNDAMENTALS)
    if not calendar:
        issues.append("security_calendar_unavailable")
    dividend_status = _mapped(_mapped(evidence.get("status")).get("dividends")).get("state")
    if not isinstance(evidence.get("dividends"), list) or dividend_status in {"failed", "missing"}:
        issues.append("dividends_unavailable")
        history = {}
    else:
        keys.append(FINANCIALS)
        history = evidence
    ex_dates = set()
    for row in listed_dividends(ticker, calendar, metrics, history):
        if row and args.start <= row["date"] <= args.end:
            # The calendar and per-share history can describe the same ex-date.
            if row["kind"] == "ex_dividend":
                ex_dates.add(row["date"])
            if row["kind"] == "dividend" and row["date"] in ex_dates:
                continue
            events.append(
                {"date": row["date"], "kind": row["kind"], "reference": row["source_url"]}
            )

    # The pinned chart itself can be the only record of a fund distribution.
    # A payment date is distinct from an ex-date, even if both fall on one day.
    distribution_days = {e["date"] for e in events if e["kind"] in {"dividend", "ex_dividend"}}
    if series is not None and (series.published_bar_ticker or series.ticker) == ticker:
        for bar in series.events:
            day = bar["date"][:10]
            if (
                bar["kind"] == "dividend"
                and args.start <= day <= args.end
                and day not in distribution_days
            ):
                events.append(
                    {"date": day, "kind": "dividend", "reference": f"price_bar:{ticker}:{day}"}
                )
                distribution_days.add(day)

    exchange = exchange_calendar
    if not (series and (series.published_bar_exchange or series.quote_exchange)) and metrics.get(
        "fullExchangeName"
    ):
        exchange = listing_calendar(
            ticker, metrics.get("fullExchangeName"), metrics.get("exchangeTimezoneName")
        )
    asset_type = series.published_bar_asset_type if series else None
    if not asset_type or asset_type.upper() == "UNKNOWN":
        asset_type = metrics.get("quoteType")
    headlines, news_keys, news_issues = headline_events(read, args, exchange, evidence, asset_type)
    return [*events, *headlines], [*keys, *news_keys], [*issues, *news_issues]


def moment_stories(read, ticker, evidence):
    keys, issues = [], []

    def feed(key):
        return _mapped(_mapped((read.read(key) or {}).get("securities")).get(ticker))

    news = feed(NEWS_KEY)
    status = feed(NEWS_STATUS_KEY)
    if news:
        keys.append(NEWS_KEY)
    if status:
        keys.append(NEWS_STATUS_KEY)
    status = {**news, **status}
    if not isinstance(news.get("items"), list) or not status.get("as_of"):
        issues.append("security_news_unavailable")
    if status.get("error"):
        issues.append("security_news_refresh_failed")
    raw_rows = [*_rows(news.get("items")), *_rows(evidence.get("news"))]
    if evidence.get("news"):
        keys.append(FINANCIALS)
    rows = [row for row in listed_headlines(ticker, raw_rows) if row]
    return headline_stories(rows, raw_rows), keys, issues


def headline_events(read, args, exchange, evidence, asset_type=None):
    stories, keys, issues = moment_stories(read, args.ticker, evidence)
    events = []
    for row in stories:
        published = row["date"]
        day, timing = (
            headline_session(exchange, datetime.fromisoformat(row["instant"]), asset_type)
            if row["instant"]
            else (published, None)
        )
        if day is None:
            issues.append("listing_calendar_unavailable")
        elif args.start <= day <= args.end:
            event = {"date": day, "kind": "news", "reference": row["reference"], "role": "lead"}
            if timing:
                event["timing"] = timing
            if day != published:
                event["publication_date"] = published
            events.append(event)
    return events, keys, issues
