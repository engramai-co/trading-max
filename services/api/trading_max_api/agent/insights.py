"""Deterministic, snapshot-bound readings shared by HTTP and assistant tools."""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import replace
from datetime import UTC, date, datetime
from itertools import pairwise
from typing import Annotated, Literal

from pydantic import AfterValidator, StringConstraints, model_validator
from trading_max.analytics.exposure_history import DIMENSIONS, PREFIX, TOP_COMPANIES
from trading_max.analytics.key_moments import key_moments
from trading_max.infrastructure import SnapshotIntegrityError
from trading_max.portfolio_math import benchmark_comparison, in_range, period_return
from trading_max.research.held_funds import FUND_PRICES_KEY
from trading_max.research.venues import VenueConflict

from ..dashboard import _benchmark_series
from ..dashboard_models import ResearchPriceSeries
from ..projections.day_change import measures_broker_observation, within_trading_days
from ..projections.nav import nav_series
from ..projections.values import csv_rows
from ..research import published_price_series_id
from .deps import AssistantDeps
from .moment_events import listing_moment_events
from .tools import (
    ANALYST,
    BROKER,
    CODE_SCOPE,
    DECISIONS,
    EARNINGS,
    FINANCIALS,
    FUNDAMENTALS,
    HISTORY_KEYS,
    LIVE,
    MAX_RESULT_BYTES,
    TECHNICAL,
    Context,
    ExposureArgs,
    Json,
    Paged,
    PageRange,
    Scoped,
    Ticker,
    _broker,
    _bytes,
    _exposure_reading,
    _iso,
    _mapped,
    _math_scope,
    _number,
    _position_rows,
    _Read,
    _rows,
    _text,
    _ticker_row,
)


def _day(value: str) -> str:
    return date.fromisoformat(value).isoformat()


type CalendarDay = Annotated[
    str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$"), AfterValidator(_day)
]


class DailyArgs(Scoped, Paged):
    range: PageRange = "3M"
    start: CalendarDay | None = None
    end: CalendarDay | None = None
    benchmark: Literal["VOO", "QQQ", "VT", "ALL"] = "VOO"

    @model_validator(mode="after")
    def ordered_window(self):
        if bool(self.start) != bool(self.end) or (self.start and self.end < self.start):
            raise ValueError("A custom range requires ordered start and end dates.")
        return self


class FXArgs(Scoped, Paged):
    period: Literal["1D", "5D", "open_position"]


class ExposureHistoryArgs(ExposureArgs):
    on_or_before: CalendarDay


class ReviewArgs(Scoped, Paged):
    horizon: Literal["20_sessions", "to_date", "decision_default"] = "decision_default"
    ticker: Ticker | None = None
    since: CalendarDay | None = None
    decision_date: CalendarDay | None = None
    side: Literal["buy", "sell"] | None = None

    @model_validator(mode="after")
    def focused_decision(self):
        if (self.side or self.decision_date) and not (
            self.side and self.decision_date and self.ticker and self.scope in {"invest", "isa"}
        ):
            raise ValueError("A focused decision needs an account, ticker, date and side.")
        return self


class MomentsArgs(Scoped):
    ticker: Ticker
    start: CalendarDay
    end: CalendarDay
    published_series_id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{20}$")] | None = None

    @model_validator(mode="after")
    def ordered(self):
        if self.end < self.start:
            raise ValueError("The range end must be on or after the start.")
        return self


def daily_data(deps: AssistantDeps, args: DailyArgs) -> Json:
    read = _Read(deps, "daily_returns", args, args.scope)
    requested = read.account_codes(args.scope)
    scope = _math_scope(args.scope)
    if scope in {"household", "cfd"}:
        return read.result("not_applicable", reason="cfd_proxy_has_no_twr")
    # The Returns page opens a 3M daily chart when entered with the money view's 1D range.
    window = "3M" if args.range == "1D" else args.range
    if args.start:
        window = "ALL"
    broker = read.read(BROKER) or {}
    accounts = _mapped(broker.get("accounts"))
    codes = requested & accounts.keys()
    keys = [BROKER, *(HISTORY_KEYS["AB".index(c)] for c in sorted(codes))]
    if not codes:
        return read.missing("history_unavailable", keys=keys)
    try:
        # Use the dashboard's NAV construction, scoped before it carries other
        # accounts forward. A CFD-only or ISA-only date cannot create an Invest close.
        daily = nav_series(
            *(
                deps.store.read_text(deps.snapshot_id, HISTORY_KEYS[i]) if code in codes else ""
                for i, code in enumerate("AB")
            ),
            include_daily_returns=True,
        )
        if window != "ALL":
            # Returns cuts the full published calendar before selecting the
            # investment scope. Other accounts supply dates, never returns.
            calendar = {p["date"] for p in daily}
            for code, key in zip("ABC", HISTORY_KEYS[:3], strict=True):
                if code not in codes and (code == "C" or code in accounts) and read.ref(key):
                    calendar.update(
                        r["Date"] for r in csv_rows(deps.store.read_text(deps.snapshot_id, key))
                    )
            visible = {p["date"] for p in in_range([{"date": d} for d in calendar], window)}
            daily = [p for p in daily if p["date"] in visible]
    except (FileNotFoundError, SnapshotIntegrityError, KeyError, TypeError, ValueError):
        return read.missing("history_unavailable", keys=keys)
    if args.start:
        daily = [p for p in daily if args.start <= p["date"] <= args.end]
    raw = read.read(TECHNICAL) or {}
    names = ["VOO", "QQQ", "VT"] if args.benchmark == "ALL" else [args.benchmark]
    comparison = benchmark_comparison(daily, scope, _benchmark_series(raw), names)
    aligned = {
        line["name"]: dict(
            zip((p["date"] for p in comparison["points"]), line["values"], strict=True)
        )
        for line in comparison["comparisons"]
    }
    issues = ["some_benchmarks_unavailable"] if comparison["missing"] else []
    if comparison["comparisons"] and (
        not raw.get("benchmark_currency") or not raw.get("benchmark_return_basis")
    ):
        issues.append("benchmark_basis_not_published")
    rows = []
    for a, b in pairwise(daily):
        value = b.get(scope + "DailyReturn")
        if value is None:
            issues.append("daily_twr_missing")
            continue
        benchmarks = {
            name: period_return(values.get(a["date"]), values.get(b["date"]))
            for name, values in aligned.items()
        }
        if any(value is None for value in benchmarks.values()):
            issues.append("benchmark_daily_endpoints_missing")
        rows.append(
            {
                "date": b["date"],
                "from_date": a["date"],
                "return_fraction": value,
                "benchmark_return_fractions": benchmarks,
            }
        )
    # Official daily returns are published to twelve fractional decimal places.
    ranks = sorted(round(row["return_fraction"], 12) for row in rows)
    for row in rows:
        row["worst_rank"] = 1 + bisect_left(ranks, round(row["return_fraction"], 12))
    if not rows:
        return read.missing("daily_twr_endpoints_missing", keys=(*keys, TECHNICAL))
    return read.page(
        list(reversed(rows)),
        args,
        {
            "currency": "GBP",
            "basis": "published_daily_twr",
            "range": window,
            "window_start": daily[0]["date"],
            "window_end": daily[-1]["date"],
            "benchmark": args.benchmark,
            "benchmark_currency": _text(raw.get("benchmark_currency")),
            "benchmark_basis": _text(raw.get("benchmark_return_basis")),
        },
        keys=(*keys, TECHNICAL),
        issues=issues,
    )


def fx_data(deps: AssistantDeps, args: FXArgs) -> Json:
    read = _Read(deps, "holding_fx_split", args, args.scope)
    codes = read.account_codes(args.scope)
    if "C" in codes:
        return read.result("not_applicable", reason="broker_positions_only")
    rows, issues, coverage = [], [], {}
    incomplete_scopes = set()
    if args.period == "open_position":
        positions, keys, issues = _position_rows(read, args.scope, observed_accounts=coverage)
        for row in positions:
            change, fx = row["unrealized_profit_loss_gbp"], row["fx_impact_gbp"]
            rows.append(
                {
                    "scope": row["scope"],
                    "ticker": row["ticker"],
                    "instrument": row["broker_ticker"],
                    "contribution_gbp": change,
                    "fx_effect_gbp": fx,
                    "local_price_effect_gbp": change - fx
                    if change is not None and fx is not None
                    else None,
                }
            )
    else:
        key = (
            "account/attribution/day.json"
            if args.period == "1D"
            else "account/attribution/window.json"
        )
        keys = [key]
        accounts = _mapped(within_trading_days(read.read(key) or {}).get("accounts"))
        broker_accounts = {}
        if args.period == "1D":
            _, live, broker = _broker(read)
            keys.extend([BROKER, *([LIVE] if live else [])])
            broker_accounts = _mapped(broker.get("accounts"))
        for code in sorted(codes):
            account = _mapped(accounts.get(code))
            if args.period == "1D" and not measures_broker_observation(
                account, _mapped(broker_accounts.get(code))
            ):
                issues.append(f"{CODE_SCOPE[code]}_broker_observation_mismatch")
                continue
            if account.get("unreconciled_instruments"):
                issues.append("share_units_unreconciled")
                incomplete_scopes.add(CODE_SCOPE[code])
            if not isinstance(account.get("contributions"), list):
                issues.append(f"{CODE_SCOPE[code]}_attribution_missing")
                continue
            scope = CODE_SCOPE[code]
            coverage[scope] = {
                "since": _iso(account.get("since")),
                "as_of": _iso(account.get("as_of")),
            }
            rows.extend(
                {
                    "scope": scope,
                    "ticker": _text(row.get("ticker"), 64),
                    "instrument": _text(row.get("instrument"), 64),
                    **{
                        k: _number(row.get(k))
                        for k in ("contribution_gbp", "fx_effect_gbp", "local_price_effect_gbp")
                    },
                }
                for row in _rows(account["contributions"])
            )
    if not coverage:
        return read.result(
            "unavailable", reason="position_attribution_unavailable", keys=keys, issues=issues
        )
    for scope, account in coverage.items():
        tracked = [r for r in rows if r["scope"] == scope]
        for field in ("contribution_gbp", "local_price_effect_gbp", "fx_effect_gbp"):
            values = [r[field] for r in tracked]
            account[field] = (
                round(sum(values), 2)
                if scope not in incomplete_scopes and all(v is not None for v in values)
                else None
            )
            if account[field] is None:
                issues.append("position_split_incomplete")
    return read.page(
        rows,
        args,
        {"currency": "GBP", "period": args.period, "accounts": coverage},
        keys=keys,
        issues=issues,
    )


def exposure_data(deps: AssistantDeps, args: ExposureHistoryArgs) -> Json:
    read = _Read(deps, "dated_exposure", args, args.scope)
    read.account_codes(args.scope)
    if args.scope != "broker_total":
        return read.result("not_applicable", reason="exposure_is_broker_total_only")
    dates = (
        sorted(
            ref.key[len(PREFIX) : -5]
            for ref in deps.manifest.artifacts
            if ref.key.startswith(PREFIX)
        )
        if deps.manifest
        else []
    )
    if not dates:
        return read.missing("no_recorded_exposure_history")
    date_key = next((day for day in reversed(dates) if day <= args.on_or_before), None)
    if date_key is None:
        return read.result(
            "unavailable",
            {"history_available_from": dates[0]},
            keys=[f"{PREFIX}{dates[0]}.json"],
            reason="before_recorded_history",
        )
    key = f"{PREFIX}{date_key}.json"
    raw = read.read(key) or {}
    rows_key, _, basis = DIMENSIONS[args.dimension]
    if not isinstance(raw.get(rows_key), list):
        return read.missing("exposure_dimension_unavailable", keys=[key])
    rows, coverage, issues = _exposure_reading(raw, args.dimension, dated=True)
    if (ref := read.ref(key)) and ref.warnings:
        issues.append("source_reported_warnings")
    return read.page(
        rows,
        args,
        {
            "history_available_from": dates[0],
            "requested_date": args.on_or_before,
            "observation_date": date_key,
            "broker_as_of": _iso(raw.get("brokerAsOf")),
            "currency": "GBP",
            "dimension": args.dimension,
            "basis": raw.get(basis) if basis else "direct_and_fund_constituents",
            **coverage,
            "invested_value_gbp": _number(raw.get("investedValueGbp")),
            "company_limit": TOP_COMPANIES if args.dimension == "company" else None,
        },
        keys=[key],
        issues=issues,
    )


def review_data(deps: AssistantDeps, args: ReviewArgs) -> Json:
    read = _Read(deps, "decision_timing_and_habits", args, args.scope)
    codes = read.account_codes(args.scope)
    if "C" in codes:
        return read.result("not_applicable", reason="broker_decisions_only")
    accounts = _mapped((read.read(DECISIONS) or {}).get("accounts"))
    rows, issues, as_of = [], [], {}
    horizon = "20_sessions" if args.horizon == "decision_default" else args.horizon
    for code in sorted(codes):
        account = _mapped(accounts.get(code))
        if account.get("status") != "available":
            issues.append(f"{CODE_SCOPE[code]}_decisions_unavailable")
            continue
        as_of[CODE_SCOPE[code]] = _iso(account.get("as_of"))
        for row in _rows(account.get("decisions")):
            ticker, day = _text(row.get("ticker"), 64), _iso(row.get("date"))
            side = row.get("side")
            if not day or not ticker or side not in {"buy", "sell"}:
                continue
            if (args.since and day < args.since) or (args.ticker and ticker.upper() != args.ticker):
                continue
            complete = row.get("horizon_complete")
            if complete is None:
                complete = row.get("effect_horizon_gbp") is not None
            if args.decision_date:
                if (day, side) != (args.decision_date, args.side):
                    continue
                if args.horizon == "decision_default":
                    horizon = "20_sessions" if complete else "to_date"
            observed = _number(row.get("observed_days"))
            usable = (
                complete
                if horizon == "20_sessions"
                else (
                    observed > 0 if observed is not None else row.get("return_to_date") is not None
                )
            )
            suffix = "horizon" if horizon == "20_sessions" else "to_date"
            effect = _number(row.get(f"effect_{suffix}_gbp")) if usable else None
            timing = _mapped(row.get(f"hindsight_{suffix}")) if effect is not None else {}
            rows.append(
                {
                    "scope": CODE_SCOPE[code],
                    "ticker": ticker,
                    "date": day,
                    "side": side,
                    "horizon": horizon,
                    "observed_days": observed,
                    "effect_gbp": effect,
                    "hindsight": {
                        "best_date": _iso(timing.get("best_date")),
                        "window_end": _iso(timing.get("window_end")),
                        **{
                            k: _number(timing.get(k))
                            for k in ("best_close_gbp", "average_order_gbp", "missed_gbp")
                        },
                    }
                    if timing
                    else None,
                }
            )
            if effect is not None and not timing:
                issues.append("hindsight_timing_unavailable")
    if not as_of:
        return read.missing("decision_history_unavailable", keys=[DECISIONS])
    habits = []
    for side in ("buy", "sell"):
        group = [row for row in rows if row["side"] == side]
        effects = [row["effect_gbp"] for row in group if row["effect_gbp"] is not None]
        favourable = sum(e > 0 for e in effects)
        habits.append(
            {
                "side": side,
                "decisions": len(group),
                "evaluated": len(effects),
                "favourable": favourable,
                "adverse": sum(e < 0 for e in effects),
                "unchanged": sum(e == 0 for e in effects),
                "favourable_fraction": favourable / len(effects) if effects else None,
                "effect_gbp": round(sum(effects), 2) if effects else None,
            }
        )
    rows.sort(key=lambda row: (row["date"], row["scope"], row["ticker"]), reverse=True)
    return read.page(
        rows,
        args,
        {
            "currency": "GBP",
            "horizon": horizon,
            "as_of": as_of,
            "habits": habits,
            "order_size_basis": "mean_security_purchase_order_through_decision_in_account",
        },
        keys=[DECISIONS],
        issues=issues,
    )


TRADE_MARKERS = "account/trade_markers.json"


def dated_events(
    read: _Read, args: MomentsArgs, codes: set[str], series: ResearchPriceSeries
) -> tuple[list[dict], list[str], list[str]]:
    """Dated evidence for the selected listing. Extra sources can supply the same event rows."""
    events = []
    keys = []
    issues = []

    def add(stamp, kind, reference):
        stamp = _iso(stamp)
        if stamp is None or not reference or not args.start <= stamp[:10] <= args.end:
            return
        events.append({"date": stamp[:10], "kind": kind, "reference": _text(str(reference), 240)})

    def listing_row(key):
        return _ticker_row(read.read(key), series.published_bar_ticker or args.ticker) or {}

    analyst = _mapped(listing_row(ANALYST).get("analyst"))
    if analyst:
        keys.append(ANALYST)
    if not isinstance(analyst.get("earningsEvents"), list):
        issues.append("earnings_events_unavailable")
    if not isinstance(analyst.get("upgradesDowngrades"), list):
        issues.append("rating_changes_unavailable")
    for row in _rows(analyst.get("earningsEvents")):
        if row.get("status") == "reported":
            add(row.get("date"), "earnings", row.get("id"))
    for row in _rows(analyst.get("upgradesDowngrades")):
        if (row.get("Action") or row.get("action")) not in {"up", "down", "init"}:
            continue
        stamp = row.get("index") or row.get("GradeDate") or row.get("gradeDate")
        epoch = _number(row.get("epochGradeDate"))
        if not stamp and epoch is not None and 0 <= epoch < 253402300800:
            stamp = datetime.fromtimestamp(epoch, UTC).date().isoformat()
        add(stamp, "rating_change", row.get("Firm") or row.get("firm"))
    financials = _mapped(listing_row(FINANCIALS).get("financials"))
    filing_evidence = _mapped(financials.get("evidence"))
    filing_rows = filing_evidence.get("filings")
    if isinstance(filing_rows, list):
        keys.append(FINANCIALS)
    filing_status = _mapped(_mapped(filing_evidence.get("status")).get("filings")).get("state")
    if not isinstance(filing_rows, list) or filing_status in {"missing", "failed"}:
        issues.append("filings_unavailable")
    for row in _rows(filing_evidence.get("filings")):
        add(row.get("date"), "filing", row.get("accession") or row.get("id"))
    fundamental = listing_row(FUNDAMENTALS)
    extra_events, extra_keys, extra_issues = listing_moment_events(
        read,
        args,
        series,
        _mapped(listing_row(EARNINGS).get("calendar")),
        _mapped(fundamental.get("metrics") or fundamental.get("info")),
        filing_evidence,
    )
    keys.extend(extra_keys)
    issues.extend(extra_issues)
    scopes = {CODE_SCOPE[code] for code in codes}
    if not scopes & {"invest", "isa"}:
        return [*events, *extra_events], keys, issues
    if series.unresolved_trade_accounts is None:
        issues.append("trade_markers_unavailable")
        return [*events, *extra_events], keys, issues
    keys.append(TRADE_MARKERS)
    if any(
        args.start <= day <= args.end and accounts & scopes
        for day, accounts in series.unresolved_trade_accounts.items()
    ):
        issues.append("trade_listing_unresolved")
    for row in series.trade_markers:
        # The chart resolves listing identity. Limit its marker to the authorised accounts.
        kinds = {"B" if f.side == "buy" else "S" for f in row.fills if f.account in scopes}
        kinds.update(
            kind for accounts, kind in row.aggregate_sides if accounts and accounts <= scopes
        )
        if kinds:
            marker = next(iter(kinds)) if len(kinds) == 1 else "T"
            add(row.date, "own_trade", marker)
    return [*events, *extra_events], keys, issues


def moments_data(deps: AssistantDeps, args: MomentsArgs) -> Json:
    read = _Read(deps, "price_key_moments", args, args.scope)
    codes = read.account_codes(args.scope)
    if deps.price_series is None or deps.manifest is None:
        return read.missing("published_daily_bars_unavailable")
    try:
        series = deps.price_series(args.ticker, deps.manifest, limit=2000)
    except VenueConflict:
        return read.result(
            "unavailable",
            reason="published_daily_bars_unavailable",
            issues=["listing_calendar_unavailable"],
        )
    except (FileNotFoundError, SnapshotIntegrityError, ValueError):
        return read.missing("published_daily_bars_unavailable")
    series_id = series.published_series_id
    key = next(
        (
            key
            for key in (FUND_PRICES_KEY, TECHNICAL)
            if (ref := read.ref(key))
            and published_price_series_id(ref.sha256, series.ticker) == series_id
        ),
        None,
    )
    if not key or not series.points or not series.published_bar_ticker:
        return read.missing("published_daily_bars_unavailable")
    read = replace(read, evidence_context=series_id)
    if args.published_series_id and args.published_series_id != series_id:
        return read.missing("displayed_price_series_mismatch", keys=[key])
    bars = [p.model_dump(mode="json") for p in series.points]
    events, keys, issues = dated_events(
        read,
        args,
        codes,
        series,
    )
    moments = key_moments(bars, events, args.start, args.end)
    has_bars = any(args.start <= bar["date"] <= args.end for bar in bars)
    if not has_bars:
        return read.missing("no_visible_daily_bars", keys=[key])
    result = read.result(
        "partial" if issues else "ok",
        data={
            "ticker": series.ticker,
            "start": args.start,
            "end": args.end,
            "interval": "1d",
            "basis": "published_daily_closes",
            "published_series_id": series_id,
            "items": moments,
        },
        keys=[key, *keys],
        issues=issues,
    )

    # Keep references intact, including long publisher URLs. Drop supporting
    # rows before dropping a ranked session that has only one reference left.
    while _bytes(result) > MAX_RESULT_BYTES:
        if "result_byte_limit" not in result["quality"]["issues"]:
            result["status"] = "partial"
            result["quality"]["issues"].append("result_byte_limit")
        longest = max(moments, key=lambda item: len(item["events"]))
        if len(longest["events"]) > 1:
            longest["events"].pop()
        else:
            moments.pop()
    return result


def daily_returns(ctx: Context, args: DailyArgs) -> Json:
    """Rank cash-flow-adjusted daily portfolio TWR in the Returns chart window. Worst rank 1 is lowest."""
    return daily_data(ctx.deps, args)


def holding_fx_split(ctx: Context, args: FXArgs) -> Json:
    """Read GBP local price and FX effects per holding and account. Periods 1D/5D cover held shares;
    open_position covers unrealised P&L since acquisition, as in Holdings."""
    return fx_data(ctx.deps, args)


def dated_exposure(ctx: Context, args: ExposureHistoryArgs) -> Json:
    """Read the last recorded broker-wide look-through on or before a calendar date. Disclose the actual observation date."""
    return exposure_data(ctx.deps, args)


def decision_timing_and_habits(ctx: Context, args: ReviewArgs) -> Json:
    """Read hindsight entry/exit timing and rule-based buy/sell statistics. A missing effect is unscored."""
    return review_data(ctx.deps, args)


def price_key_moments(ctx: Context, args: MomentsArgs) -> Json:
    """Find at most three unusual days with checkable events in published daily price bars.
    Events are leads, not proof of what caused a price move."""
    return moments_data(ctx.deps, args)
