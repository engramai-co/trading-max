"""Join dated listing evidence to published daily price sessions."""

from datetime import datetime

from trading_max.research.closing_auctions import headline_session
from trading_max.research.held_funds import observed_product
from trading_max.research.news import NEWS_KEY, NEWS_STATUS_KEY
from trading_max.research.venues import row_claims

from .events import headline_stories, listed_dividends, listed_headlines
from .tools import EARNINGS, FINANCIALS, FUNDAMENTALS, _mapped, _rows


def listing_moment_events(
    args, series, exchange_calendar, calendar, metrics, evidence, pinned, news_rows
):
    keys = []
    issues = []
    events = []
    ticker = pinned.ticker
    if calendar:
        keys.append(EARNINGS)
    if metrics:
        keys.append(FUNDAMENTALS)
    if not calendar:
        issues.append("security_calendar_unavailable")

    news, rejected = pinned.event_row(news_rows[NEWS_KEY])
    if rejected:
        issues.append("listing_calendar_unavailable")
    status = news_rows[NEWS_STATUS_KEY]
    venue = pinned.venue()
    if venue.conflict:
        return [], keys, ["listing_calendar_unavailable"]
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

    product = observed_product(
        series.published_bar_asset_type if series else None,
        metrics.get("quoteType"),
        fund=bool(series and series.published_fund_row),
    )
    segments = {
        str(v).strip().lower()
        for v in (series.published_bar_segment if series else None, metrics.get("marketSegment"))
        if v
    }
    segment = next(iter(segments)) if len(segments) == 1 else None
    exchange = venue.calendar if series else exchange_calendar
    stories, news_keys, news_issues = _published_stories(ticker, evidence, news, status, pinned)
    headlines, timing_issues = _timed_headlines(args, stories, exchange, product, segment)
    return [*events, *headlines], [*keys, *news_keys], [*issues, *news_issues, *timing_issues]


def moment_stories(read, pinned, financials=None):
    def feed(key):
        return _mapped(_mapped((read.read(key) or {}).get("securities")).get(pinned.ticker))

    news, status = feed(NEWS_KEY), feed(NEWS_STATUS_KEY)
    pinned = pinned.with_event_claims(financials, news, status)
    if pinned.venue().conflict:
        return [], [], ["listing_calendar_unavailable"]
    financials, _ = pinned.event_row(financials)
    evidence = _mapped(_mapped(financials.get("financials")).get("evidence"))
    news, _ = pinned.event_row(news)
    return _published_stories(pinned.ticker, evidence, news, status, pinned)


def _published_stories(ticker, evidence, news, status, pinned):
    keys = [key for key, row in ((NEWS_KEY, news), (NEWS_STATUS_KEY, status)) if row]
    issues = []
    status = {**news, **status}
    if not isinstance(news.get("items"), list) or not status.get("as_of"):
        issues.append("security_news_unavailable")
    if status.get("error"):
        issues.append("security_news_refresh_failed")
    raw_rows = [*_rows(news.get("items")), *_rows(evidence.get("news"))]
    if evidence.get("news"):
        keys.append(FINANCIALS)
    rows = []
    for raw in raw_rows:
        for row in listed_headlines(ticker, [raw]):
            if row:
                row["calendar"] = pinned.venue(*row_claims(ticker, raw)).calendar
                rows.append(row)
    return headline_stories(rows, raw_rows), keys, issues


def headline_events(read, args, exchange):
    stories, keys, issues = moment_stories(read, read.deps.selected_listing(args.ticker))
    events, timing_issues = _timed_headlines(args, stories, exchange)
    return events, keys, [*issues, *timing_issues]


def _timed_headlines(args, stories, exchange, asset_type=None, segment=None):
    events, issues = [], []
    for row in stories:
        published = row["date"]
        day, timing = (
            headline_session(
                row.get("calendar") or exchange,
                datetime.fromisoformat(row["instant"]),
                asset_type,
                segment=segment,
            )
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
    return events, issues
