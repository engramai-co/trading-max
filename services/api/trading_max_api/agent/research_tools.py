"""Evidence for a security's opening card and its published earnings brief."""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Annotated, Literal

from pydantic import StringConstraints, model_validator
from trading_max.infrastructure import SnapshotIntegrityError
from trading_max.reference.msci_world_sectors import WORLD_INDUSTRY_INDICES
from trading_max.reference.taxonomy import classification_for_profile
from trading_max.research.earnings_changes import consensus_estimates
from trading_max.research.held_funds import FUND_PRICES_KEY

from ..research_listing import PinnedListing
from .insights import (
    TRADE_MARKERS,
    CalendarDay,
    MomentsArgs,
    dated_events,
    moments_data,
)
from .moment_events import moment_stories
from .tools import (
    ANALYST,
    FINANCIALS,
    FUNDAMENTALS,
    LOOKTHROUGH,
    MARKET,
    TECHNICAL,
    Args,
    Context,
    Ticker,
    _digest,
    _iso,
    _mapped,
    _number,
    _Read,
    _rows,
    _ticker_row,
)

SeriesId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{20}$")]
# A company profile is restated a sentence at a time; later sentences add detail.
PROFILE_SENTENCES = 12
_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[\"“(]?[A-Z0-9])")
# Abbreviations that end with a full stop but rarely end an English sentence.
_ABBREVIATION = re.compile(
    r"(?:(?:^|[\s(])(?:[A-Z]\.)+|\b(?:Inc|Co|Corp|Ltd|Plc|Bros|No|Nos|St|Mt|Mr|Mrs|Ms|Dr|Jr|Sr"
    r"|vs|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.)$"
)


class SecurityArgs(Args):
    ticker: Ticker


def profile_sentences(text: str) -> list[str]:
    """Split an English description into sentences without breaking at common abbreviations."""
    sentences, start = [], 0
    for boundary in _SENTENCE_END.finditer(text):
        if _ABBREVIATION.search(text[start : boundary.start()]):
            continue
        sentences.append(text[start : boundary.start()].strip())
        start = boundary.end()
    sentences.append(text[start:].strip())
    return [sentence for sentence in sentences if sentence]


def sentence_id(sentence: str) -> str:
    """A short fingerprint (32-bit FNV-1a of UTF-8) that lets a citation find its sentence."""
    value = 0x811C9DC5
    for byte in sentence.encode():
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


def company_profile(ctx: Context, args: SecurityArgs) -> dict:
    """Read the selected company's English business description, numbered sentence by sentence."""
    read = _Read(ctx.deps, "company_profile", args, "public_research")
    pinned = ctx.deps.selected_listing(args.ticker)
    if pinned.venue().conflict:
        return read.missing("listing_unavailable")
    batch = read.read(FUNDAMENTALS) or {}
    row, _ = pinned.event_row(
        pinned.published_row(_rows(batch.get("rows", batch.get("fundamentals"))))
    )
    metrics = _mapped(row.get("metrics") or row.get("info"))
    if str(metrics.get("quoteType") or "").upper() in {"ETF", "ETP", "MUTUALFUND", "INDEX"}:
        return read.result("not_applicable")
    text = " ".join(str(metrics.get("longBusinessSummary") or "").split())
    if not text:
        return read.missing("company_profile_unavailable", keys=[FUNDAMENTALS])
    # Only the provider's English description needs a Chinese restatement.
    if _CJK.search(text):
        return read.result("not_applicable", keys=[FUNDAMENTALS])
    return read.result(
        data={
            "ticker": pinned.ticker,
            "language": "en",
            "sentences": profile_sentences(text)[:PROFILE_SENTENCES],
            "version": _digest(["company-profile-v1", text]),
            "as_of": _iso(batch.get("generated_at")),
        },
        keys=[FUNDAMENTALS],
    )


class PositionArgs(SecurityArgs):
    published_series_id: SeriesId
    index_id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{1,64}$")] | None = None


def last_listing_trade(read, ticker, end, currency, fallback=()):
    markers = (
        read.deps.listing_markers(read.deps.manifest, ticker, currency or "")[0]
        if read.deps.manifest and read.deps.listing_markers
        else fallback
    )
    eligible = [row for row in markers if row.date <= end]
    if not eligible:
        return None
    for row in sorted(eligible, key=lambda marker: marker.date, reverse=True):
        fills = [fill for fill in row.fills if fill.account in {"invest", "isa"}]
        archived = {
            kind
            for accounts, kind in row.aggregate_sides
            if accounts and accounts <= {"invest", "isa"}
        }
        if archived:
            sides = archived | {"B" if fill.side == "buy" else "S" for fill in fills}
            side = "buy" if sides == {"B"} else "sell" if sides == {"S"} else "trade"
            return row.date, None, side
        if fills:
            last = max(fills, key=lambda fill: fill.at)
            return row.date, last.at, last.side
    return None


def research_position(ctx: Context, args: PositionArgs) -> dict:
    """Read the exact chart's close and its change since the last verified Invest or ISA trade."""
    deps = ctx.deps
    read = _Read(deps, "research_position", args, "broker_total")
    read.account_codes("broker_total")
    if args.index_id:
        history = (
            deps.index_history(args.index_id, args.published_series_id)
            if deps.index_history
            else None
        )
        if (
            not history
            or len(history.points) < 2
            or (history.index.symbol or "INDEX") != args.ticker
        ):
            return read.missing("displayed_index_series_unavailable")
        opening, latest = history.points[0], history.points[-1]
        end = latest.at.date().isoformat()
        trade = (
            last_listing_trade(read, args.ticker, end, history.currency)
            if history.index.kind == "etf-price"
            else None
        )
        if trade:
            opening = next(
                (
                    p
                    for p in history.points
                    if history.display_interval == "1d" and p.at.date().isoformat() == trade[0]
                ),
                None,
            )
        issues = [] if history.state == "available" else ["index_history_" + history.state]
        return read.result(
            "partial" if issues else "ok",
            data={
                "ticker": args.ticker,
                "trade_date": trade[0] if trade else None,
                "side": trade[2] if trade else None,
                "start": opening.at.date().isoformat() if opening else None,
                "end": latest.at.date().isoformat(),
                "close": latest.value,
                "currency": history.currency,
                "range": history.range,
                "unit": "price" if history.index.kind == "etf-price" else "points",
                "change": latest.value / opening.value - 1
                if opening and opening.value > 0
                else None,
            },
            keys=[TRADE_MARKERS] if trade else [],
            issues=issues,
        )
    observed = (
        deps.observed_prices(deps.snapshot_id, args.ticker, args.published_series_id)
        if (deps.observed_prices and deps.snapshot_id)
        else None
    )
    if observed:
        series = observed
    else:
        if not deps.price_series or not deps.manifest:
            return read.missing()
        try:
            series = deps.price_series(args.ticker, deps.manifest, limit=2000)
        except (FileNotFoundError, ValueError, SnapshotIntegrityError):
            return read.missing("published_daily_bars_unavailable")
        if (
            series.published_series_id != args.published_series_id
            or not series.points
            or not series.published_bar_ticker
        ):
            return read.missing("displayed_price_series_mismatch")
    pinned = PinnedListing.from_price_series(args.ticker, series)
    ticker = pinned.ticker
    latest = series.points[-1]
    last_trade = last_listing_trade(
        read, ticker, latest.date, series.currency, series.trade_markers
    )
    previous = series.points[-2] if len(series.points) >= 2 else None
    base = (
        next((p for p in series.points if p.date == last_trade[0]), None)
        if last_trade
        else previous
    )
    benchmarks = []
    fund, _ = pinned.event_row(_ticker_row(read.read(FUNDAMENTALS), ticker))
    profile = classification_for_profile(
        sector=fund.get("sector"),
        industry=fund.get("industry"),
        industry_key=_mapped(fund.get("metrics")).get("industryKey"),
    )
    held_codes = {
        classification["sectorCode"]
        for row in _rows((read.read(LOOKTHROUGH) or {}).get("positions"))
        if row.get("ticker") == ticker
        and (classification := _mapped(row.get("gics"))).get("sectorCode")
    }
    code = (
        next(iter(held_codes)) if len(held_codes) == 1 else profile.sector_code if profile else None
    )
    sector = next((spec for spec in WORLD_INDUSTRY_INDICES if spec.gics == code), None)
    sector_status = "unmapped" if not sector else "unavailable"
    technical, _ = pinned.event_row(_ticker_row(read.read(TECHNICAL), ticker))
    if not observed and series.currency == "USD" and technical.get("as_of") == latest.date:
        comparisons = [("spy_63d", "SPY")]
        if sector and sector.symbol:
            comparisons.append((sector.symbol, sector.symbol))
        if fund.get("industry") == "Semiconductors":
            comparisons.append(("soxx_63d", "SOXX"))
        for key, symbol in comparisons:
            stats = _mapped(_mapped(technical.get("relative_strength")).get(key))
            asset, other = (
                _number(stats.get("asset_return")),
                _number(stats.get("benchmark_return")),
            )
            if asset is not None and other is not None and stats.get("start") and stats.get("end"):
                is_sector = sector and symbol == sector.symbol
                if is_sector:
                    sector_status = "available"
                benchmarks.append(
                    {
                        "symbol": symbol,
                        "name": f"MSCI World {sector.name}" if is_sector else symbol,
                        "benchmark_basis": "price-index"
                        if is_sector
                        else "split-and-dividend-adjusted",
                        "sessions": 63,
                        "start": stats["start"],
                        "end": stats["end"],
                        "asset": asset,
                        "benchmark": other,
                    }
                )
    event = None
    event_keys = []
    if last_trade:
        start = max(
            last_trade[0], (date.fromisoformat(latest.date) - timedelta(days=365)).isoformat()
        )
        window = MomentsArgs(ticker=ticker, scope="broker_total", start=start, end=latest.date)
        records, event_keys, _ = dated_events(
            read, window, read.account_codes("broker_total"), series
        )
        event = max(
            (
                row
                for row in records
                if row["kind"] not in {"own_trade", "news"} and row["date"] > last_trade[0]
            ),
            key=lambda row: row["date"],
            default=None,
        )
    return read.result(
        data={
            "ticker": ticker,
            "end": latest.date,
            "close": latest.close,
            "currency": series.currency,
            "adjustment": series.adjustment,
            "event": event,
            "benchmarks": benchmarks,
            "sector_comparison": sector_status,
            "trade_date": last_trade[0] if last_trade else None,
            "side": last_trade[2] if last_trade else None,
            "start": base.date if base else None,
            "change": latest.close / base.close - 1 if base and base.close > 0 else None,
        },
        keys=[TECHNICAL, FUND_PRICES_KEY, FUNDAMENTALS, LOOKTHROUGH, TRADE_MARKERS, *event_keys],
    )


def earnings_observations(analyst: dict, today: str) -> dict:
    reported = sorted(
        (
            event
            for event in _rows(analyst.get("earningsEvents"))
            if event.get("status") == "reported"
            and event.get("id")
            and _iso(event.get("date"))
            and event["date"][:10] <= today
        ),
        key=lambda event: event["date"],
        reverse=True,
    )
    report = None
    if reported:
        event = reported[0]
        report = {key: event.get(key) for key in ("date", "id", "fiscalPeriod", "currency")}
        report.update(
            actual=_number(event.get("actualEps")),
            estimate=_number(event.get("estimatedEps")),
            surprise=_number(event.get("surprisePct")),
        )
    return {"report": report, "estimates": consensus_estimates(analyst)}


def research_earnings(ctx: Context, args: SecurityArgs) -> dict:
    """Read the latest reported earnings and consensus EPS or sales for dated fiscal periods."""
    read = _Read(ctx.deps, "research_earnings", args, "public_research")
    pinned = ctx.deps.selected_listing(args.ticker)
    if pinned.venue().conflict:
        return read.missing("listing_calendar_unavailable")
    ticker = pinned.ticker
    fund, _ = pinned.event_row(_ticker_row(read.read(FUNDAMENTALS), ticker))
    kind = str(_mapped(fund.get("metrics")).get("quoteType") or "").upper()
    if kind in {"ETF", "ETP", "MUTUALFUND", "INDEX"}:
        return read.result("not_applicable")
    batch = read.read(ANALYST) or {}
    clock = _mapped(_mapped(batch.get("rowClocks")).get(ticker))
    if clock and clock.get("state") != "available":
        return read.missing("fresh_estimates_unavailable", keys=[ANALYST])
    row, _ = pinned.event_row(_ticker_row(batch, ticker))
    analyst = _mapped(row.get("analyst"))
    if not analyst or not ctx.deps.manifest:
        return read.missing("analyst_data_unavailable", keys=[ANALYST])
    observations = earnings_observations(analyst, ctx.deps.manifest.created_at.date().isoformat())
    if not observations["report"] and not observations["estimates"]:
        return read.missing("earnings_data_unavailable", keys=[ANALYST])
    return read.result(
        data={
            **observations,
            "changes": row.get("estimateChanges", []),
            "ticker": ticker,
            "version": _digest(["earnings-v2", observations, row.get("estimateChanges", [])]),
            "as_of": _iso(analyst.get("asOf")) or _iso(batch.get("generated_at")),
        },
        keys=[ANALYST],
    )


def earnings_universe(ctx: Context, args: Args) -> dict:
    """Return the exact symbols in this research publication's held and research-list universe."""
    read = _Read(ctx.deps, "earnings_universe", args, "public_research")
    batch = read.read(ANALYST) or {}
    clocks = _mapped(batch.get("rowClocks"))
    fresh = {
        row["ticker"]
        for row in _rows(batch.get("rows"))
        if row.get("ticker")
        and (
            not clocks
            or (
                clocks.get(row["ticker"], {}).get("state") == "available"
                and clocks[row["ticker"]].get("fetchedAt") == batch.get("generated_at")
            )
        )
    }
    # The market job resolves the held and watchlisted equities before fetching analyst rows.
    market = read.read(MARKET) or {}
    if isinstance(market.get("equity_tickers"), list):
        fresh.intersection_update(market["equity_tickers"])
    return read.result(data={"tickers": sorted(fresh)}, keys=[ANALYST, MARKET])


class HeadlineArgs(SecurityArgs):
    date: CalendarDay
    reference: Annotated[str, StringConstraints(min_length=1, max_length=2048)]
    scope: Literal["broker_total"] = "broker_total"
    published_series_id: SeriesId | None = None
    index_id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{1,64}$")] | None = None
    start: CalendarDay | None = None
    end: CalendarDay | None = None

    @model_validator(mode="after")
    def complete_chart(self):
        if any((self.start, self.end, self.published_series_id, self.index_id)) and not (
            self.start
            and self.end
            and self.published_series_id
            and self.start <= self.date <= self.end
        ):
            raise ValueError(
                "A selected chart requires the displayed series and a window containing the date."
            )
        return self


def research_headline(ctx: Context, args: HeadlineArgs) -> dict:
    """Read a dated publisher headline. A chart selection restricts it to that exact candidate."""
    read = _Read(ctx.deps, "research_headline", args, "public_research")
    ticker, published = args.ticker, args.date
    if args.published_series_id:
        window = MomentsArgs(**args.model_dump(exclude={"reference"}))
        selected = moments_data(ctx.deps, window).get("data") or {}
        event = next(
            (
                event
                for moment in selected.get("items", [])
                for event in moment["events"]
                if event["kind"] == "news" and event["reference"] == args.reference
            ),
            None,
        )
        if not event:
            return read.missing("headline_outside_selected_moment")
        ticker = selected.get("listing") or selected["ticker"]
        published = event.get("publication_date", args.date)
    if args.published_series_id and not args.index_id:
        series = ctx.deps.displayed_price_series(args.ticker, args.published_series_id)
        if not series:
            return read.missing("displayed_price_series_mismatch")
        pinned = PinnedListing.from_price_series(args.ticker, series)
    else:
        pinned = ctx.deps.selected_listing(ticker)
    ticker = pinned.ticker
    stories, keys, _ = moment_stories(read, pinned, _ticker_row(read.read(FINANCIALS), ticker))
    row = next(
        (
            row
            for row in stories
            if row["date"][:10] == published and row["reference"] == args.reference
        ),
        None,
    )
    if not row:
        return read.missing("headline_unavailable")
    return read.result(
        data={
            "ticker": ticker,
            "title": row["title_en"],
            "reference": row["reference"],
            "publisher": row["publisher"],
            "url": row["source_url"],
            "role": "lead",
            "date": row.get("instant") or row["date"],
        },
        keys=keys,
    )
