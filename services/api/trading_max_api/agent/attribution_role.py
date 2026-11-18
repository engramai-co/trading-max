"""Attribution for observed chart endpoints, using the page benchmark and matching FX window."""

from datetime import datetime
from typing import Literal

from pydantic import model_validator
from trading_max.portfolio_math import portfolio_money, select_portfolio_history

from . import insights, tools
from .deps import AccountScope
from .overview_roles import LONDON, line
from .roles import PageRole, RoleContext, RoleTools


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
            if len(value) > 40 or len(value) < 10:
                raise ValueError("Invalid chart endpoint")
            stamp = datetime.fromisoformat(value)
            if len(value) > 10 and stamp.utcoffset() is None:
                raise ValueError("Intraday endpoints need offsets")
        if len(self.start) == 10 and len(self.end) == 10:
            if self.end < self.start:
                raise ValueError("Reversed endpoints")
        elif (
            len(self.start) == 10
            or len(self.end) == 10
            or datetime.fromisoformat(self.start) > datetime.fromisoformat(self.end)
        ):
            raise ValueError("Inconsistent endpoints")
        return self


def matches(since: str | None, as_of: str | None, context: AttributionContext):
    if not since or not as_of:
        return False
    for raw, selected in ((since, context.start), (as_of, context.end)):
        observed = datetime.fromisoformat(raw)
        if len(selected) == 10:
            day = observed.astimezone(LONDON).date() if observed.tzinfo else observed.date()
            if day.isoformat() != selected:
                return False
        elif observed != datetime.fromisoformat(selected):
            return False
    return True


def selected_money(ctx: tools.Context, args: AttributionContext):
    """Cash-flow-adjusted money result from the chart's full-cadence records."""
    read = tools._Read(ctx.deps, "selected_money", args, args.scope)
    read.account_codes(args.scope)
    loaded = tools._history_input(read, args.scope, "ALL")
    if not loaded:
        return read.missing("history_unavailable")
    source, keys = loaded
    scope = tools._math_scope(args.scope)
    if len(args.start) > 10:
        # Use the history projection for verified flows and the household CFD proxy.
        history = select_portfolio_history(
            range="ALL",
            scope=scope,
            daily=source["nav"],
            intraday=source["intradayNav"],
            as_of=source["brokerAsOf"],
            require_cash_flows=True,
        )
        series = history["points"]
    else:
        series = source["nav"]
    start, end = (datetime.fromisoformat(value) for value in (args.start, args.end))
    rows = []
    for row in series:
        stamp = datetime.fromisoformat(row["date"])
        if (stamp.tzinfo is None) == (start.tzinfo is None) and start <= stamp <= end:
            rows.append(row)
    if (
        len(rows) < 2
        or datetime.fromisoformat(rows[0]["date"]) != start
        or datetime.fromisoformat(rows[-1]["date"]) != end
    ):
        return read.missing("endpoint_unavailable", keys=keys)
    money = portfolio_money(rows, scope)
    return read.result(
        data={
            "pnl": money["pnl"],
            "estimated": any(r.get("valuationSource") == "reconstructed" for r in rows),
        },
        keys=keys,
    )


def attribution_facts(read: RoleTools, context: AttributionContext):
    args = {**context.model_dump(), "snapshotId": read.deps.snapshot_id}
    daily = read.read(
        insights.daily_returns,
        insights.DailyArgs(
            scope=context.scope,
            benchmark=context.benchmark,
            start=context.start[:10],
            end=context.end[:10],
            limit=1,
        ),
    )
    data = daily.get("data") or {}

    def observed(section, zh, en, source="account", result=daily, tool="daily_returns"):
        return line(section, zh, en, result, source, tool, metric=section, **args)

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
            data.get("benchmark_basis")
            and data.get("benchmark_currency")
            and data.get("window_benchmarks")
        ):
            comparisons = " · ".join(
                f"{key} {value:+.2%}" for key, value in data["window_benchmarks"].items()
            )
            basis = f"{data['benchmark_currency']} · {data['benchmark_basis']}"
            facts.append(
                observed(
                    "benchmark",
                    f"同期基准 {comparisons}（{basis}）。",
                    f"Same-period benchmark returns were {comparisons} ({basis}).",
                    "market",
                )
            )
    if not any(f.section == "return" for f in facts):
        amount = read.read(selected_money, context)
        money = amount.get("data") or {}
        if (pnl := money.get("pnl")) is not None:
            proxy = context.scope in {"cfd", "household"}
            zh = "（含 CFD 已实现现金权益代理）" if proxy else ""
            en = " (includes imported realised CFD cash equity)" if proxy else ""
            if money["estimated"]:
                zh += "（含估算）"
                en += " (includes estimates)"
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
    if not any(f.section == "benchmark" for f in facts):
        facts.append(
            observed(
                "benchmark",
                f"{context.benchmark} 暂无与所选起止点匹配的基准收益。",
                f"No {context.benchmark} comparison matches these endpoints.",
                "market",
            )
        )
    for period in ("1D", "5D"):
        split = read.read(
            insights.holding_fx_split, insights.FXArgs(scope=context.scope, period=period, limit=1)
        )
        accounts = (split.get("data") or {}).get("accounts", {})
        expected = {"invest", "isa"} if context.scope == "broker_total" else {context.scope}
        if set(accounts) != expected or not all(
            matches(row.get("since"), row.get("as_of"), context) for row in accounts.values()
        ):
            continue
        if all(
            row.get("fx_effect_gbp") is not None and row.get("local_price_effect_gbp") is not None
            for row in accounts.values()
        ):
            fx = sum(row["fx_effect_gbp"] for row in accounts.values())
            price = sum(row["local_price_effect_gbp"] for row in accounts.values())
            facts.append(
                observed(
                    "fx",
                    f"持股价格影响 £{price:+,.2f}，汇率影响 £{fx:+,.2f}。",
                    f"Held-share price effect was £{price:+,.2f} and currency effect was £{fx:+,.2f}.",
                    "holdings",
                    split,
                    "holding_fx_split",
                )
            )
            break
    else:
        facts.append(
            observed(
                "fx",
                "这段区间没有可核实的持股价格与汇率拆分。",
                "A verified held-share price and currency split is unavailable for this range.",
                "holdings",
                split,
                "holding_fx_split",
            )
        )
    return facts


ATTRIBUTION = PageRole(
    "attribution",
    "analytics",
    frozenset({"daily_returns", "holding_fx_split", "selected_money"}),
    AttributionContext,
    "Select one fact from each section for the selected range. Preserve benchmark currency and basis. Price and currency effects apply only to held shares.",
    attribution_facts,
)
