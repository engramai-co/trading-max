"""Evidence for a security's opening card and its published earnings brief."""

from __future__ import annotations

from typing import Annotated

from pydantic import StringConstraints
from trading_max.infrastructure import SnapshotIntegrityError
from trading_max.research.held_funds import FUND_PRICES_KEY
from trading_max.research.listing import broker_listing
from trading_max.research.news import NEWS_KEY

from .events import _listing_symbol
from .insights import TRADE_MARKERS, CalendarDay, moment_headlines
from .tools import (
    ANALYST,
    FUNDAMENTALS,
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


class SecurityArgs(Args):
    ticker: Ticker


class PositionArgs(SecurityArgs):
    published_series_id: SeriesId
    index_id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{1,64}$")] | None = None


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
        return read.result(
            data={
                "ticker": args.ticker,
                "start": opening.at.date().isoformat(),
                "end": latest.at.date().isoformat(),
                "close": latest.value,
                "currency": history.currency,
                "range": history.range,
                "unit": "price" if history.index.kind == "etf-price" else "points",
                "change": latest.value / opening.value - 1 if opening.value > 0 else None,
            }
        )
    observed = (
        deps.observed_prices(deps.snapshot_id, args.ticker, args.published_series_id)
        if (deps.observed_prices and deps.snapshot_id)
        else None
    )
    if observed:
        series = observed
        ticker = series.ticker
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
        ticker = series.published_bar_ticker
    latest = series.points[-1]
    markers = read.read(TRADE_MARKERS)
    trades = sorted(
        (row["date"], fill.get("at") or "", fill["side"])
        for row in _rows((markers or {}).get("rows"))
        if _iso(row.get("date")) and row["date"] <= latest.date
        for fill in _rows(row.get("fills"))
        if fill.get("account") in {"invest", "isa"}
        and fill.get("side") in {"buy", "sell"}
        and _listing_symbol(broker_listing(fill.get("broker_ticker"))) == ticker
    )
    previous = series.points[-2] if len(series.points) >= 2 else None
    last_trade = trades[-1] if trades else None
    base = (
        next((p for p in series.points if p.date == last_trade[0]), None)
        if last_trade
        else previous
    )
    benchmarks = []
    technical = _ticker_row(read.read(TECHNICAL), ticker) or {}
    if not observed and series.currency == "USD" and technical.get("as_of") == latest.date:
        industry = (_ticker_row(read.read(FUNDAMENTALS), ticker) or {}).get("industry")
        comparisons = [("spy_63d", "SPY")]
        if industry == "Semiconductors":
            comparisons.append(("soxx_63d", "SOXX"))
        for key, symbol in comparisons:
            stats = _mapped(_mapped(technical.get("relative_strength")).get(key))
            asset, other = (
                _number(stats.get("asset_return")),
                _number(stats.get("benchmark_return")),
            )
            if asset is not None and other is not None:
                benchmarks.append(
                    {"symbol": symbol, "sessions": 63, "asset": asset, "benchmark": other}
                )
    return read.result(
        data={
            "ticker": ticker,
            "end": latest.date,
            "close": latest.close,
            "currency": series.currency,
            "adjustment": series.adjustment,
            "benchmarks": benchmarks,
            "trade_date": last_trade[0] if last_trade else None,
            "side": last_trade[2] if last_trade else None,
            "start": base.date if base else None,
            "change": latest.close / base.close - 1 if base and base.close > 0 else None,
        },
        keys=[TECHNICAL, FUND_PRICES_KEY, TRADE_MARKERS],
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
    estimates = []
    for field, metric in (("earningsEstimate", "eps"), ("revenueEstimate", "revenue")):
        for row in _rows(analyst.get(field)):
            currency, end, mean = (
                row.get("currency"),
                _iso(row.get("endDate")),
                _number(row.get("avg")),
            )
            period = row.get("period") or row.get("index")
            if end and currency and mean is not None and period in {"0q", "+1q", "0y", "+1y"}:
                estimates.append(
                    {
                        "metric": metric,
                        "end": end[:10],
                        "period": period,
                        "currency": currency,
                        "mean": mean,
                    }
                )
    estimates.sort(key=lambda r: (r["end"], r["period"], r["metric"]))
    return {"report": report, "estimates": estimates}


def research_earnings(ctx: Context, args: SecurityArgs) -> dict:
    """Read the latest reported earnings and consensus EPS or sales for dated fiscal periods."""
    read = _Read(ctx.deps, "research_earnings", args, "public_research")
    fund = _ticker_row(read.read(FUNDAMENTALS), args.ticker) or {}
    kind = str(_mapped(fund.get("metrics")).get("quoteType") or "").upper()
    if kind in {"ETF", "ETP", "MUTUALFUND", "INDEX"}:
        return read.result("not_applicable")
    batch = read.read(ANALYST) or {}
    clock = _mapped(_mapped(batch.get("rowClocks")).get(args.ticker))
    if clock and clock.get("state") != "available":
        return read.missing("fresh_estimates_unavailable", keys=[ANALYST])
    analyst = _mapped((_ticker_row(batch, args.ticker) or {}).get("analyst"))
    if not analyst or not ctx.deps.manifest:
        return read.missing("analyst_data_unavailable", keys=[ANALYST])
    observations = earnings_observations(analyst, ctx.deps.manifest.created_at.date().isoformat())
    if not observations["report"] and not observations["estimates"]:
        return read.missing("earnings_data_unavailable", keys=[ANALYST])
    return read.result(
        data={
            **observations,
            "ticker": args.ticker,
            "version": _digest(observations),
            "as_of": _iso(analyst.get("asOf")) or _iso(batch.get("generated_at")),
        },
        keys=[ANALYST],
    )


def earnings_universe(ctx: Context, args: Args) -> dict:
    """Return the exact symbols in this research publication's held and research-list universe."""
    read = _Read(ctx.deps, "earnings_universe", args, "public_research")
    return read.result(
        data={"tickers": sorted((read.read(NEWS_KEY) or {}).get("securities", {}))}, keys=[NEWS_KEY]
    )


class HeadlineArgs(SecurityArgs):
    date: CalendarDay
    reference: Annotated[str, StringConstraints(min_length=1, max_length=2048)]


def research_headline(ctx: Context, args: HeadlineArgs) -> dict:
    """Read a dated publisher headline selected as a lead for the exact listing."""
    read = _Read(ctx.deps, "research_headline", args, "public_research")
    row = next(
        (
            row
            for row in moment_headlines(read, args.ticker)
            if row["date"][:10] == args.date and (row.get("id") or row["url"]) == args.reference
        ),
        None,
    )
    if not row:
        return read.missing("headline_unavailable")
    return read.result(
        data={"ticker": args.ticker, **{k: row[k] for k in ("title", "publisher", "url", "date")}},
        keys=[NEWS_KEY],
    )
