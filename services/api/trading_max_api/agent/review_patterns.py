"""Verified trading habits and the outcomes at each review horizon."""

import json
from hashlib import sha256
from typing import Literal

from trading_max.analytics.decision_review import CALCULATION_VERSION

from .tools import CODE_SCOPE, DECISIONS, Args, Context, _mapped, _number, _Read, _rows

EVIDENCE = "account/review_evidence.json"
Horizon = Literal["20_sessions", "to_date"]
Habit = Literal["before_earnings", "untraded_fall", "basket_buy"]
Scope = Literal["broker_total", "invest", "isa"]
HABIT_CALCULATIONS = {"decisions-v6", "decisions-v7", CALCULATION_VERSION}


class HabitArgs(Args):
    scope: Scope
    horizon: Horizon = "20_sessions"
    habit: Habit | None = None
    compare_horizons: bool = False


def review_patterns(ctx: Context, args: HabitArgs) -> dict:
    """Count verified pre-earnings purchases, untraded falls and same-day baskets.
    The untraded-fall effect is the signed net of hypothetical purchases at the mean purchase size through each day.
    Use compare_horizons=true to compare the two horizons for the same account and habit.
    Cite /data/groups/GROUP/FIELD and /data/comparison/groups/GROUP/FIELD for the other horizon.
    Supported fields are count, evaluated, effect_gbp and mean_return.
    """
    read = _Read(ctx.deps, "review_patterns", args, args.scope)
    scopes = sorted(read.account_codes(args.scope))
    accounts = _mapped((read.read(DECISIONS) or {}).get("accounts"))
    evidence = _mapped((read.read(EVIDENCE) or {}).get("accounts"))
    result = _summarise(read, scopes, accounts, evidence, args)
    if args.compare_horizons and result.get("data"):
        other = "to_date" if args.horizon == "20_sessions" else "20_sessions"
        comparison = _summarise(
            read, scopes, accounts, evidence, args.model_copy(update={"horizon": other})
        )
        result["data"]["comparison"] = {"horizon": other, "groups": comparison["data"]["groups"]}
    return result


def _summarise(read, scopes, accounts, evidence, args):
    groups = {k: [] for k in ("before_earnings", "untraded_fall", "basket_buy")}
    coverage = {key: set() for key in groups}
    revision = []
    as_of = {}
    issues = []
    suffix = "horizon" if args.horizon == "20_sessions" else "to_date"
    for code in scopes:
        account = _mapped(accounts.get(code))
        decisions = _rows(account.get("decisions"))
        journal = _mapped(evidence.get(code))
        if account.get("status") != "available":
            issues.append(f"{CODE_SCOPE[code]}_decisions_unavailable")
            continue
        rows = decisions + _rows(account.get("unpriced_basket_buys"))
        purchases = [row for row in rows if row.get("side") == "buy"]
        moves = _rows(journal.get("holdingMoves"))
        falls = [move for move in moves if (_number(move.get("change")) or 0) < 0]
        if not rows and not falls:
            continue
        # Basket flags are sparse. The list of unpriced members also records
        # that the account was checked, including when no basket was found.
        if isinstance(account.get("unpriced_basket_buys"), list) or any(
            isinstance(row.get("basket_buy"), bool) for row in purchases
        ):
            coverage["basket_buy"].add(code)
        if any(isinstance(row.get("before_earnings"), bool) for row in purchases):
            coverage["before_earnings"].add(code)
        # A complete habit-era journal can establish a zero. Earlier journals
        # supply individual qualifying falls, even without hypothetical outcomes.
        if falls or (
            account.get("calculation_version") in HABIT_CALCULATIONS
            and journal.get("coverage") == "complete"
            and isinstance(journal.get("holdingMoves"), list)
        ):
            coverage["untraded_fall"].add(code)
        supported = [key for key in groups if code in coverage[key]]
        if not supported:
            continue
        revision.append((code, supported))
        as_of[CODE_SCOPE[code]] = account.get("as_of")
        if args.habit in (None, "untraded_fall") and journal.get("coverage") != "complete":
            issues.append("partial_journal")
        for row in rows:
            complete = row.get("horizon_complete", row.get("effect_horizon_gbp") is not None)
            observed = row.get("observed_days")
            scored = (
                complete
                if suffix == "horizon"
                else (
                    observed > 0
                    if isinstance(observed, int)
                    else row.get("return_to_date") is not None
                )
            )
            revision.append(
                (
                    code,
                    row.get("date"),
                    row.get("ticker"),
                    row.get("side"),
                    row.get("before_earnings"),
                    row.get("basket_buy"),
                    bool(complete),
                    row.get("return_to_date") is not None and observed != 0,
                )
            )
            if row.get("side") == "buy":
                if args.habit in (None, "before_earnings") and row.get("before_earnings") is None:
                    issues.append("partial_earnings_history")
                for key in ("before_earnings", "basket_buy"):
                    if row.get(key):
                        groups[key].append(
                            (
                                _number(row.get(f"effect_{suffix}_gbp")) if scored else None,
                                _number(row.get(f"return_{suffix}")) if scored else None,
                            )
                        )
        for move in falls:
            money = _number(
                move.get(
                    "hypotheticalHorizonGbp" if suffix == "horizon" else "hypotheticalToDateGbp"
                )
            )
            groups["untraded_fall"].append((money, None))
            revision.append(
                (
                    code,
                    move.get("date"),
                    move.get("ticker"),
                    "no_trade",
                    move.get("hypotheticalHorizonGbp") is not None,
                    move.get("hypotheticalToDateGbp") is not None,
                )
            )
    summaries = {}
    for key, group in groups.items():
        if args.habit is not None and key != args.habit:
            continue
        if len(coverage[key]) < len(scopes):
            issues.append(f"partial_{key}_coverage")
        if not coverage[key]:
            continue
        effects = [money for money, _ in group if money is not None]
        returns = [value for money, value in group if money is not None and value is not None]
        summaries[key] = {
            "count": len(group),
            "evaluated": len(effects),
            "effect_gbp": round(sum(effects), 2) if effects else None,
            "mean_return": sum(returns) / len(returns)
            if returns and len(returns) == len(effects)
            else None,
        }
    if not summaries:
        return read.missing("decision_history_unavailable", keys=[DECISIONS, EVIDENCE])
    version = sha256(json.dumps(revision, separators=(",", ":")).encode()).hexdigest()[:24]
    return read.result(
        "partial" if issues else "ok",
        {
            "groups": summaries,
            "revision": version,
            "currency": "GBP",
            "horizon": args.horizon,
            "as_of": as_of,
        },
        keys=[DECISIONS, EVIDENCE],
        issues=issues,
    )
