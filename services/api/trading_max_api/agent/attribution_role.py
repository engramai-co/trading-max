"""Attribution for observed chart endpoints, using the page benchmark and matching FX window."""

import re
from datetime import UTC, datetime
from typing import Literal

from pydantic import model_validator
from trading_max.portfolio_math import portfolio_money, select_portfolio_history

from . import insights, tools
from .deps import AccountScope
from .overview_roles import LONDON, line
from .roles import PageRole, RoleContext, RoleTools


def chart_instant(value: str) -> datetime:
    stamp = datetime.fromisoformat(value)
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)


class AttributionContext(RoleContext):
    scope: AccountScope
    benchmark: Literal["VOO", "QQQ", "VT", "ALL"]
    range: tools.PageRange = "ALL"
    view: Literal["money", "returns", "risk"] = "returns"
    start: str
    end: str

    @model_validator(mode="after")
    def ordered(self):
        for value in (self.start, self.end):
            if len(value) > 40 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T.+)?", value):
                raise ValueError("Invalid chart endpoint")
            stamp = datetime.fromisoformat(value)
            if len(value) > 10 and stamp.utcoffset() is None:
                raise ValueError("Intraday endpoints need offsets")
        if chart_instant(self.end) <= chart_instant(self.start):
            raise ValueError("Select two distinct endpoints in order")
        return self


def matches(since: str | None, as_of: str | None, context: AttributionContext):
    if not since or not as_of:
        return False
    # Daily NAV rows expose a trading date without a valuation instant.
    for raw, selected in ((since, context.start), (as_of, context.end)):
        observed, anchor = datetime.fromisoformat(raw), datetime.fromisoformat(selected)
        if observed.utcoffset() is None or anchor.utcoffset() is None or observed != anchor:
            return False
    return True


def selected_money(ctx: tools.Context, args: AttributionContext):
    """Cash-flow-adjusted money result from the chart's full-cadence records."""
    read = tools._Read(ctx.deps, "selected_money", args, args.scope)
    read.account_codes(args.scope)
    loaded = tools._history_input(read, args.scope, args.range)
    if not loaded:
        return read.missing("history_unavailable")
    source, keys = loaded
    scope = tools._math_scope(args.scope)
    if args.view == "money" or len(args.start) > 10 or len(args.end) > 10:
        # Use the history projection for verified flows and the household CFD proxy.
        history = select_portfolio_history(
            range=args.range,
            scope=scope,
            daily=source["nav"],
            intraday=source["intradayNav"],
            as_of=source["brokerAsOf"],
            require_cash_flows=True,
        )
        series = history["points"]
    else:
        series = source["nav"]
    start, end = map(chart_instant, (args.start, args.end))
    rows = [row for row in series if start <= chart_instant(row["date"]) <= end]
    if (
        len(rows) < 2
        or datetime.fromisoformat(rows[0]["date"]) != datetime.fromisoformat(args.start)
        or datetime.fromisoformat(rows[-1]["date"]) != datetime.fromisoformat(args.end)
    ):
        return read.missing("endpoint_unavailable", keys=keys)
    money = portfolio_money(rows, scope)
    return read.result(
        data={
            "pnl": money["pnl"],
            "start": args.start,
            "end": args.end,
            "currency": "GBP",
            "estimated": any(r.get("valuationSource") == "reconstructed" for r in rows),
        },
        keys=keys,
    )


def selected_daily(ctx: tools.Context, args: AttributionContext):
    """Return daily portfolio and benchmark observations within the inspected endpoints."""
    read = tools._Read(ctx.deps, "selected_daily", args, args.scope)
    if len(args.start) != 10 or len(args.end) != 10:
        return read.missing("daily_endpoints_unavailable")
    result = insights.daily_returns(
        ctx,
        insights.DailyArgs(
            scope=args.scope,
            benchmark=args.benchmark,
            range=args.range,
            start=args.start,
            end=args.end,
            limit=1,
        ),
    )
    data = result.get("data") or {}
    if data.get("window_start") != args.start or data.get("window_end") != args.end:
        return read.missing("daily_endpoints_unavailable")
    return {**result, "evidence_id": read.result()["evidence_id"]}


def selected_fx(ctx: tools.Context, args: AttributionContext):
    """Verified held-share price and currency effects for the selected valuation instants."""
    read = tools._Read(ctx.deps, "selected_fx", args, args.scope)
    read.account_codes(args.scope)
    if len(args.start) == 10 or len(args.end) == 10:
        return read.missing("valuation_instants_unavailable")
    expected = {"invest", "isa"} if args.scope == "broker_total" else {args.scope}
    for period in ("1D", "5D"):
        split = insights.holding_fx_split(
            ctx, insights.FXArgs(scope=args.scope, period=period, limit=1)
        )
        accounts = (split.get("data") or {}).get("accounts", {})
        if set(accounts) != expected or not all(
            matches(row.get("since"), row.get("as_of"), args)
            and row.get("fx_effect_gbp") is not None
            and row.get("local_price_effect_gbp") is not None
            for row in accounts.values()
        ):
            continue
        return {
            **read.result(
                data={
                    "currency": "GBP",
                    "start": args.start,
                    "end": args.end,
                    "fx_effect_gbp": sum(row["fx_effect_gbp"] for row in accounts.values()),
                    "local_price_effect_gbp": sum(
                        row["local_price_effect_gbp"] for row in accounts.values()
                    ),
                }
            ),
            "quality": split["quality"],
            "sources": split["sources"],
        }
    return read.missing("matching_fx_window_unavailable")


BENCHMARK_BASES = {
    "auto_adjusted_close": ("复权收盘价", "adjusted closing prices"),
    "adjusted_price_gbp": ("复权价格", "adjusted prices"),
}


def attribution_facts(read: RoleTools, context: AttributionContext):
    args = {**context.model_dump(), "snapshotId": read.deps.snapshot_id}
    daily = read.read(selected_daily, context)
    data = daily.get("data") or {}

    def observed(
        section, zh, en, source="account", result=daily, tool="selected_daily", **metadata
    ):
        return line(section, zh, en, result, source, tool, metric=section, **args, **metadata)

    facts = []
    if (
        len(context.start) == 10
        and data.get("window_start") == context.start
        and data.get("window_end") == context.end
    ):
        if (ret := data.get("window_twr_fraction")) is not None:
            facts.append(
                observed(
                    "return",
                    f"区间组合时间加权收益为 {ret:+.2%}。",
                    f"Portfolio time-weighted return was {ret:+.2%} over this range.",
                )
            )
        worst = data.get("worst_day")
        if worst:
            day, r = worst["date"], worst["return_fraction"]
            facts.append(
                observed(
                    "rank",
                    f"{day} 收益 {r:+.2%}，在区间内可核实的 {data['total_items']} 个日收益中最低。",
                    f"{day} returned {r:+.2%}, the lowest of {data['total_items']} observed daily returns.",
                )
            )
        if (
            data.get("benchmark_basis") in BENCHMARK_BASES
            and data.get("benchmark_currency")
            and data.get("window_benchmarks")
        ):
            comparisons = " · ".join(
                f"{key} {value:+.2%}" for key, value in data["window_benchmarks"].items()
            )
            zh_basis, en_basis = BENCHMARK_BASES[data["benchmark_basis"]]
            currency = data["benchmark_currency"]
            requested = {"VOO", "QQQ", "VT"} if context.benchmark == "ALL" else {context.benchmark}
            missing = ", ".join(sorted(requested - data["window_benchmarks"].keys()))
            missing_en = f" {missing} has no comparison for this window." if missing else ""
            missing_zh = f" {missing} 暂无同区间对比。" if missing else ""
            facts.append(
                observed(
                    "benchmark",
                    f"同期基准 {comparisons}（{currency} · {zh_basis}）。{missing_zh}",
                    f"Same-period benchmark returns were {comparisons} ({currency} · {en_basis}).{missing_en}",
                    "market",
                    benchmark_basis=data["benchmark_basis"],
                    benchmark_currency=currency,
                )
            )
    if context.view == "money" or not any(f.section == "return" for f in facts):
        amount = read.read(selected_money, context)
        money = amount.get("data") or {}
        if (pnl := money.get("pnl")) is not None:
            proxy = context.scope in {"cfd", "household"}
            zh = "（含 CFD 已实现现金权益代理）" if proxy else ""
            en = " (includes imported realised CFD cash equity)" if proxy else ""
            if money["estimated"]:
                zh += "（含估算）"
                en += " (includes estimates)"
            facts = [fact for fact in facts if fact.section != "return"]
            facts.append(
                observed(
                    "return",
                    f"所选区间的净盈亏为 £{pnl:+,.2f}{zh}。",
                    f"Cash-flow-adjusted net P&L was £{pnl:+,.2f}{en}.",
                    "account",
                    amount,
                    "selected_money",
                )
            )
        elif not any(f.section == "return" for f in facts):
            facts.append(
                observed(
                    "return",
                    "所选区间没有可核实的组合收益或净盈亏。",
                    "Neither portfolio return nor net P&L could be verified for these endpoints.",
                    "account",
                    amount,
                    "selected_money",
                )
            )
    if not any(f.section == "benchmark" for f in facts):
        facts.append(
            observed(
                "benchmark",
                f"{context.benchmark} 暂无与所选起止点匹配的基准收益。",
                f"No {context.benchmark} comparison matches these endpoints.",
                "market",
            )
        )
    split = read.read(selected_fx, context)
    if effects := split.get("data"):
        fx, price = effects["fx_effect_gbp"], effects["local_price_effect_gbp"]
        interval = f"{effects['start']} – {effects['end']}"
        facts.append(
            observed(
                "fx",
                f"{interval}，持股价格影响 £{price:+,.2f}，汇率影响 £{fx:+,.2f}。",
                f"{interval}: held-share price effect was £{price:+,.2f} and currency effect was £{fx:+,.2f}.",
                "holdings",
                split,
                "selected_fx",
            )
        )
    else:
        facts.append(
            observed(
                "fx",
                "这段区间没有可核实的持股价格与汇率拆分。",
                "A verified held-share price and currency split is unavailable for this range.",
                "holdings",
                split,
                "selected_fx",
            )
        )
    return facts


ATTRIBUTION = PageRole(
    "attribution",
    "analytics",
    frozenset({"selected_daily", "selected_fx", "selected_money"}),
    AttributionContext,
    "Select one fact from each section for the selected range. Preserve benchmark currency and basis. Price and currency effects apply only to held shares.",
    attribution_facts,
)
