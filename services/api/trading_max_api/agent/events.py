"""Read dated evidence from a single publication with account-scoped trades."""

from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from itertools import chain
from typing import Annotated
from urllib.parse import quote

from exchange_calendars.errors import CalendarError
from pydantic import AfterValidator, StringConstraints, model_validator
from trading_max.research.calendar import market_calendar
from trading_max.research.calendars.events import window_bounds
from trading_max.research.calendars.refresh import MACRO_KEY
from trading_max.research.listing import LONDON, broker_listing
from trading_max.research.news import NEWS_KEY, NEWS_STATUS_KEY, web_url

from ..research_listing import PinnedListing
from .tools import (
    ANALYST,
    CFD_LEDGER,
    CODE_SCOPE,
    EARNINGS,
    FINANCIALS,
    FUNDAMENTALS,
    TECHNICAL,
    Context,
    Json,
    Paged,
    Scoped,
    Ticker,
    _number,
    _position_rows,
    _Read,
    _rows,
    _short_id,
)

MARKERS = "account/trade_markers.json"
FUND_PRICES = "research/fund_prices.json"
YAHOO = "Yahoo Finance"


def _day(value):
    return date.fromisoformat(value).isoformat()


Day = Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$"), AfterValidator(_day)]


class EventArgs(Scoped, Paged):
    start: Day
    end: Day
    ticker: Ticker | None = None

    @model_validator(mode="after")
    def window(self):
        days = (date.fromisoformat(self.end) - date.fromisoformat(self.start)).days
        if self.start <= date.min.isoformat() or self.end >= date.max.isoformat():
            raise ValueError("Dates are outside the supported calendar range.")
        if not 0 <= days <= 365:
            raise ValueError("Choose an ordered window of at most 366 calendar days.")
        return self


def _stamp(raw):
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        try:
            return datetime.fromtimestamp(raw, UTC).isoformat()
        except (ValueError, OverflowError, OSError):
            return None
    if isinstance(raw, str):
        try:
            return (
                datetime.fromisoformat(raw).isoformat()
                if len(raw) > 10
                else date.fromisoformat(raw).isoformat()
            )
        except ValueError:
            return None
    return None


def _entry(kind, title, zh, raw, *, ticker=None, publisher=YAHOO, url=None, end=None, **extra):
    stamp = _stamp(raw)
    if not stamp or not isinstance(title, str) or not title:
        return None
    instant = datetime.fromisoformat(stamp) if len(stamp) > 10 else None
    return dict(
        kind=kind,
        title_en=title[:320],
        title_zh=zh[:320],
        date=stamp[:10],
        end_date=end,
        instant=instant.isoformat() if instant and instant.utcoffset() is not None else None,
        ticker=ticker,
        publisher=publisher,
        source_url=web_url(url),
        **extra,
    )


def _indexed(payload):
    payload = payload or {}
    return {
        str(r.get("ticker", "")).upper(): r
        for r in _rows(payload.get("rows", payload.get("fundamentals")))
    }


def _security_entry(ticker, kind, title, zh, raw, **kw):
    url = "https://finance.yahoo.com/quote/" + quote(ticker, safe="") + "/"
    return _entry(kind, title, zh, raw, ticker=ticker, url=kw.pop("url", url), **kw)


def listed_dividends(ticker, cal, metrics, evidence):
    for key, metric, kind, en, zh in [
        ("Ex-Dividend Date", "exDividendDate", "ex_dividend", "Ex-dividend date", "除息日"),
        ("Dividend Date", "dividendDate", "dividend_pay", "Dividend payment date", "派息日"),
    ]:
        stamp = _stamp(cal.get(key)) or _stamp(metrics.get(metric))
        if stamp:
            yield _security_entry(ticker, kind, en, zh, stamp[:10])
    for r in _rows(evidence.get("dividends")):
        yield _security_entry(
            ticker,
            "dividend",
            "Dividend",
            "股息",
            r.get("date"),
            amount=_number(r.get("amount")),
            currency=r.get("currency"),
            unit="per_share",
            basis=r.get("basis"),
        )


def listed_headlines(ticker, rows):
    for row in rows:
        url_value = web_url(row.get("url"))
        if not url_value or not (row.get("publisher") or row.get("source")):
            continue
        yield _security_entry(
            ticker,
            "news",
            row.get("title"),
            row.get("title") or "",
            row.get("instant") or row.get("publishedAt") or row.get("date"),
            url=url_value,
            publisher=row.get("publisher") or row.get("source"),
            provider_id=row.get("id") if row.get("id") != url_value else None,
            role="lead",
        )


def _public(ticker, data, upcoming):
    def add(kind, title, zh, raw, **kw):
        return _security_entry(ticker, kind, title, zh, raw, **kw)

    analyst = data[ANALYST].get(ticker, {}).get("analyst", {})
    recorded = set()
    for e in _rows(analyst.get("earningsEvents")):
        recorded.add(e.get("date"))
        if upcoming and e.get("status") == "reported":
            continue
        currency = e.get("currency") or e.get("epsCurrency")
        yield add(
            "earnings",
            "Earnings",
            "业绩公布",
            e.get("instant") or e.get("date"),
            status=e.get("status"),
            estimated_eps=_number(e.get("estimatedEps")) if currency else None,
            actual_eps=_number(e.get("actualEps")) if currency else None,
            currency_missing=e.get("epsCurrencyMissing")
            or (
                not currency
                and any(_number(e.get(k)) is not None for k in ("estimatedEps", "actualEps"))
            ),
            fiscal_period=e.get("fiscalPeriod"),
            source_as_of=e.get("asOf") or analyst.get("asOf"),
            # A company's filing currency can differ from the EPS series for a listing.
            currency=currency,
            unit="per_share",
        )
    cal = data[EARNINGS].get(ticker, {}).get("calendar", {})
    days = sorted(
        {v[:10] for v in (cal.get("Earnings Date") or []) if isinstance(v, str) and _stamp(v)}
    )
    if days and not any(days[0] <= d <= days[-1] for d in recorded if d):
        yield add(
            "earnings",
            "Estimated earnings date",
            "预计业绩公布",
            days[0],
            end=days[-1] if len(days) > 1 else None,
            status="provider-estimate",
        )
    fundamental = data[FUNDAMENTALS].get(ticker, {})
    metrics = fundamental.get("metrics") or fundamental.get("info") or {}
    evidence = data.get(FINANCIALS, {}).get(ticker, {}).get("financials", {}).get("evidence", {})
    yield from listed_dividends(ticker, cal, metrics, {} if upcoming else evidence)
    if upcoming:
        return
    for r in _rows(analyst.get("upgradesDowngrades")):
        firm = r.get("Firm") or r.get("firm")
        if not firm:
            continue
        stamp = _stamp(r.get("epochGradeDate")) or _stamp(
            r.get("GradeDate") or r.get("gradeDate") or r.get("index")
        )
        if stamp and len(stamp) > 10 and datetime.fromisoformat(stamp).utcoffset() is None:
            # yfinance's GradeDate index is derived from UTC epoch seconds.
            stamp = datetime.fromisoformat(stamp).replace(tzinfo=UTC).isoformat()
        yield add(
            "rating_change",
            "Analyst rating update",
            "分析师评级变动",
            stamp,
            firm=firm,
            action=r.get("Action") or r.get("action"),
            from_grade=r.get("FromGrade") or r.get("fromGrade"),
            to_grade=r.get("ToGrade") or r.get("toGrade"),
        )
    for r in _rows(evidence.get("filings")):
        yield add(
            "filing",
            r.get("title") or r.get("form") or "Filing",
            "监管披露",
            r.get("date"),
            url=r.get("url"),
            publisher="SEC",
            form=r.get("form"),
            reference=r.get("accession") or r.get("id"),
        )
    yield from listed_headlines(ticker, _headline_rows(data, ticker))


def _headline_rows(data, ticker):
    headlines = data[NEWS_KEY].get(ticker, {}).get("items", [])
    evidence = data[FINANCIALS].get(ticker, {}).get("financials", {}).get("evidence", {})
    return chain(headlines, _rows(evidence.get("news")))


def _article_references(raw_rows):
    """Give each article one reference across all scopes in this publication."""
    by_url = {}
    aliases = defaultdict(set)
    for row in raw_rows:
        url, article_id = row.get("url"), row.get("id")
        if not url or not article_id or article_id == url:
            continue
        other = by_url.setdefault(url, article_id)
        if article_id != other:
            aliases[article_id].add(other)
            aliases[other].add(article_id)

    # One canonical URL may appear under several IDs, each with its own syndicated links.
    canonical = {}
    for article_id in aliases:
        if article_id in canonical:
            continue
        group = set()
        pending = [article_id]
        while pending:
            item = pending.pop()
            if item not in group:
                group.add(item)
                pending.extend(aliases[item] - group)
        canonical.update(dict.fromkeys(group, min(group)))
    return {url: canonical.get(article_id, article_id) for url, article_id in by_url.items()}


def headline_stories(articles, raw_rows):
    references = _article_references(raw_rows) if articles else {}
    headlines = {}
    for row in articles:
        identity = references.get(row["source_url"], row["source_url"])
        story = headlines.get(identity)
        if story is None:
            story = headlines[identity] = {**row, "reference": identity, "tickers": []}
        elif row["instant"] and not story["instant"]:
            # The published instant determines which local day contains this article.
            story.update(row)
        if row["ticker"] not in story["tickers"]:
            story["tickers"].append(row["ticker"])
    return list(headlines.values())


def _market_days(names, start, end, issues):
    for name in sorted(names):
        try:
            cal = market_calendar(name, start.year, end.year)
        except (CalendarError, ValueError, OverflowError):
            issues.append("exchange_calendar_unavailable")
            continue
        early = {v.date() for v in cal.early_closes}
        day = start
        while day <= end:
            if day in early:
                yield _entry(
                    "half_day",
                    f"{name} early close",
                    f"{name} 提早收市",
                    cal.session_close(day.isoformat()).isoformat(),
                    publisher="exchange_calendars",
                    market=name,
                    timezone=str(cal.tz),
                )
            elif cal.weekmask[day.weekday()] == "1" and not cal.is_session(day.isoformat()):
                yield _entry(
                    "holiday",
                    f"{name} market holiday",
                    f"{name} 休市",
                    day.isoformat(),
                    publisher="exchange_calendars",
                    market=name,
                    timezone=str(cal.tz),
                )
            day += timedelta(days=1)


def _listing_symbol(listing):
    if isinstance(listing, str) and listing.startswith(("LSE:", "US:")):
        market, symbol = listing.split(":", 1)
        return symbol + ".L" if market == LONDON else symbol
    return None


def _listing(row):
    return _listing_symbol(broker_listing(row.get("broker_ticker"))) or row["ticker"].upper()


def _trade_symbol(read, args, issues, listing, ticker, raw, *, marker_ticker=None):
    resolved = _listing_symbol(listing)
    if not args.ticker:
        return resolved or ticker
    if resolved:
        return resolved if resolved == args.ticker else None
    stamp = _stamp(raw)
    if stamp and {ticker, marker_ticker} & {args.ticker, args.ticker.removesuffix(".L")}:
        instant = datetime.fromisoformat(stamp)
        day = (
            instant.astimezone(read.deps.timezone).date().isoformat()
            if instant.tzinfo
            else stamp[:10]
        )
        if args.start <= day <= args.end:
            issues.append("trade_listing_unresolved")
    return None


def _trades(read, args, codes, issues, keys):
    accounts = {CODE_SCOPE[c] for c in codes}
    if accounts & {"invest", "isa"}:
        markers = read.read(MARKERS)
        keys.append(MARKERS)
        if markers is None:
            issues.append("trade_markers_unavailable")
        for row in _rows((markers or {}).get("rows")):
            ticker = row.get("ticker")
            scoped_fills = (f for f in _rows(row.get("fills")) if f.get("account") in accounts)
            for index, fill in enumerate(scoped_fills):
                instrument = fill.get("broker_ticker")
                listing = broker_listing(instrument)
                fill_ticker = _trade_symbol(
                    read,
                    args,
                    issues,
                    listing,
                    instrument.upper() if instrument else ticker,
                    fill.get("at"),
                    marker_ticker=ticker,
                )
                if fill_ticker:
                    yield _entry(
                        "own_trade",
                        "Broker fill",
                        "账户成交",
                        fill.get("at"),
                        ticker=fill_ticker,
                        publisher="Trading 212",
                        account=fill["account"],
                        listing_verified=bool(_listing_symbol(listing)),
                        side=fill.get("side"),
                        quantity=_number(fill.get("quantity")),
                        amount=_number(fill.get("amount")),
                        currency=fill.get("currency"),
                        reference=str(index),
                    )
            if (
                not row.get("fills")
                and args.ticker
                and args.ticker.removesuffix(".L") == ticker
                and args.start <= str(row.get("date") or "") <= args.end
                and accounts.intersection(row.get("accounts") or [])
            ):
                issues.append("trade_listing_unresolved")
            if (
                not row.get("fills")
                and not args.ticker
                and row.get("accounts")
                and set(row["accounts"]) <= accounts
            ):
                yield _entry(
                    "own_trade",
                    "Daily trade marker",
                    "当日交易记录",
                    row.get("date"),
                    ticker=ticker,
                    publisher="Trading 212",
                    listing_verified=False,
                    side=row.get("kind"),
                )
    if "C" in codes:
        ledger = read.read(CFD_LEDGER)
        keys.append(CFD_LEDGER)
        if ledger is None:
            issues.append("cfd_ledger_unavailable")
        for row in _rows((ledger or {}).get("events")):
            ticker = row.get("symbol")
            if row.get("record_type") in {"Closed position", "closed_position"} or (
                row.get("record_type") == "Order" and row.get("order_status") == "EXECUTED"
            ):
                listing = broker_listing(row.get("instrument")) or broker_listing(ticker)
                ticker = _trade_symbol(read, args, issues, listing, ticker, row.get("occurred_at"))
                if not ticker:
                    continue
                yield _entry(
                    "own_trade",
                    "Imported CFD trade",
                    "已导入的差价合约交易",
                    row.get("occurred_at"),
                    ticker=ticker,
                    publisher="Trading 212",
                    account="cfd",
                    listing_verified=bool(listing),
                    side=row.get("direction"),
                    quantity=_number(row.get("units")),
                )


def _macros(payload, start, end, issues):
    events = {}
    revisions = {}
    for name, source in payload.get("sources", {}).items():
        if source.get("error"):
            issues.append(f"{name}_refresh_failed")
        as_of = source.get("as_of")
        stamp = _stamp(as_of)
        observed = datetime.fromisoformat(stamp) if stamp else None
        if observed is None or observed.tzinfo is None:
            observed = datetime.min.replace(tzinfo=UTC)
        for row in _rows(source.get("events")):
            result = {
                **row,
                "kind": "macro",
                "ticker": None,
                "reference": row["id"],
                "source_as_of": as_of,
            }
            # When both indexes were read together, an explicit withdrawal wins.
            revision = (observed, row["status"] == "cancelled")
            if row["id"] not in revisions or revision > revisions[row["id"]]:
                revisions[row["id"]] = revision
                events[row["id"]] = result
    joint_days = {
        e["date"]
        for e in events.values()
        if e["publisher"] == "Bureau of Economic Analysis"
        and "international trade in goods and services" in e["title_en"].lower()
    }
    return [
        e
        for e in events.values()
        if window_bounds(e["date"], e.get("end_date"))[0] <= end
        and window_bounds(e["date"], e.get("end_date"))[1] >= start
        and not (
            e["publisher"] == "U.S. Census Bureau"
            and e["date"] in joint_days
            and "international trade in goods and services" in e["title_en"].lower()
        )
    ]


def event_data(deps, args, *, upcoming):
    name = "upcoming_events" if upcoming else "news_and_events"
    read = _Read(deps, name, args, args.scope)
    codes = read.account_codes(args.scope)
    if not deps.manifest:
        return read.missing()
    if deps.listing_error:
        return read.missing(deps.listing_error)
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    issues = []
    keys = []
    symbols = set()
    if args.ticker:
        symbols.add(args.ticker)
    else:
        for code in sorted(codes & {"A", "B"}):
            positions, used, missing = _position_rows(read, CODE_SCOPE[code])
            keys.extend(used)
            issues.extend(missing)
            symbols.update(_listing(r) for r in positions)
        if "C" in codes:
            issues.append("cfd_open_positions_not_published")
    data = {}
    for key in [ANALYST, EARNINGS, FUNDAMENTALS, *([] if upcoming else [FINANCIALS])]:
        raw = read.read(key)
        keys.append(key)
        if raw is None:
            issues.append(key.split("/")[-1].removesuffix(".json") + "_unavailable")
        data[key] = _indexed(raw)
    raw = read.read(NEWS_KEY)
    keys.append(NEWS_KEY)
    diagnostics = read.read(NEWS_STATUS_KEY)
    if diagnostics:
        keys.append(NEWS_STATUS_KEY)
    news_rows = (raw or {}).get("securities", {})
    status_rows = (diagnostics or {}).get("securities", {})
    data[NEWS_KEY] = {
        ticker: {**row, **status_rows.get(ticker, {})} for ticker, row in news_rows.items()
    }
    if raw is None and not upcoming:
        issues.append("security_news_unavailable")
    # This is the pinned universe of the last scheduled research run. A
    # current editable watchlist cannot describe a historical publication.
    if upcoming and args.scope == "household" and not args.ticker:
        symbols.update(data[NEWS_KEY])
        if raw is None:
            issues.append("research_universe_unavailable")
    technical = _indexed(read.read(TECHNICAL))
    funds = _indexed(read.read(FUND_PRICES))
    keys.extend([TECHNICAL, FUND_PRICES])
    names = set()
    entries = []
    selected_tickers = set()
    trade_args = args
    for requested in sorted(symbols):
        if deps.pin_listing:
            pinned = deps.pin_listing(requested, deps.manifest)
        else:
            pinned = PinnedListing(requested, requested, requested, ()).with_event_claims(
                technical.get(requested),
                funds.get(requested),
            )
        ticker = pinned.symbol
        if args.ticker:
            trade_args = args.model_copy(update={"ticker": ticker})
        if ticker in selected_tickers:
            continue
        selected_tickers.add(ticker)
        if not pinned.venue().venues:
            pinned = pinned.with_event_claims(
                news_rows.get(ticker),
                status_rows.get(ticker),
                *(rows.get(ticker) for key, rows in data.items() if key != NEWS_KEY),
            )
        venue = pinned.venue()
        if venue.conflict:
            issues.append("listing_calendar_unavailable")
            continue
        if venue.calendar:
            names.add(venue.calendar)
        elif upcoming:
            issues.append("listing_calendar_unavailable")
        if not upcoming and not data[NEWS_KEY].get(ticker, {}).get("as_of"):
            issues.append("security_news_unavailable")
        if not upcoming and data[NEWS_KEY].get(ticker, {}).get("error"):
            issues.append("security_news_refresh_failed")
        if ticker not in data[ANALYST]:
            issues.append("analyst_events_unavailable")
        if not data[EARNINGS].get(ticker, {}).get("calendar"):
            issues.append("security_calendar_unavailable")
        selected = {}
        for key, rows in data.items():
            parent = (
                pinned.with_event_claims(news_rows.get(ticker), status_rows.get(ticker))
                if key == NEWS_KEY
                else pinned
            )
            row, rejected = parent.event_row(rows.get(ticker))
            if rejected:
                issues.append("listing_calendar_unavailable")
            selected[key] = {ticker: row}
        for entry in _public(ticker, selected, upcoming):
            if entry and entry["kind"] == "earnings" and entry.pop("currency_missing", False):
                issues.append("earnings_currency_unavailable")
            entries.append(entry)
    if upcoming:
        macro = read.read(MACRO_KEY)
        keys.append(MACRO_KEY)
        if not macro:
            issues.append("macro_calendar_unavailable")
        elif args.start < macro.get("window_start", args.start) or args.end > macro.get(
            "window_end", args.end
        ):
            issues.append("outside_published_macro_window")
        # Timed releases can cross a date boundary in the user's timezone.
        entries.extend(
            _macros(
                macro or {},
                (start - timedelta(days=1)).isoformat(),
                (end + timedelta(days=1)).isoformat(),
                issues,
            )
        )
        entries.extend(
            _market_days(names, start - timedelta(days=1), end + timedelta(days=1), issues)
        )
    else:
        entries.extend(_trades(read, trade_args, codes, issues, keys))
    # A single syndicated article can appear in several held security feeds.
    # Retain those associations while citing the article once.
    articles = [row for row in entries if row and row["kind"] == "news"]
    raw_headlines = chain.from_iterable(
        _headline_rows(data, ticker)
        for ticker in sorted(data[NEWS_KEY].keys() | data.get(FINANCIALS, {}).keys())
    )
    headlines = headline_stories(articles, raw_headlines)
    entries = [r for r in entries if r and r["kind"] != "news"] + headlines
    rows = {}
    for row in entries:
        local = (
            datetime.fromisoformat(row["instant"]).astimezone(deps.timezone)
            if row.get("instant")
            else None
        )
        day = local.date().isoformat() if local else row["date"]
        first, last = window_bounds(day, row.get("end_date"))
        if args.start > last or first > args.end:
            continue
        identity = ["news", row["reference"]] if row["kind"] == "news" else row
        evidence = _short_id("ev_", [deps.snapshot_id, identity])
        rows[evidence] = {
            **row,
            "evidence_id": evidence,
            "local_date": day,
            "local_time": local.isoformat() if local else None,
        }
    ordered = sorted(
        rows.values(),
        key=lambda r: (
            r["local_date"],
            datetime.fromisoformat(r["instant"]).astimezone(UTC).isoformat()
            if r["instant"]
            else "",
            r["kind"],
            r["evidence_id"],
        ),
        reverse=not upcoming,
    )
    metadata = {"timezone": deps.timezone.key, "start": args.start, "end": args.end}
    if not upcoming:
        metadata["news_basis"] = "Headlines are dated leads. A price move's cause is unverified."
    if not any(read.ref(key) for key in keys):
        return read.missing("event_sources_unavailable")
    page = read.page(ordered, args, metadata, keys=keys, issues=issues)
    page["evidence_id"] = _short_id("ev_", [page["evidence_id"], deps.timezone.key])
    return page


def news_and_events(ctx: Context, args: EventArgs) -> Json:
    """Read dated headlines, reports, dividends, rating changes and the selected account's own trades. Headlines are leads only."""
    return event_data(ctx.deps, args, upcoming=False)


def upcoming_events(ctx: Context, args: EventArgs) -> Json:
    """Read scheduled macro releases, earnings, dividends, exchange holidays and early closes in the user's timezone."""
    return event_data(ctx.deps, args, upcoming=True)
