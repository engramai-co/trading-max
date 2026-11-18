"""Verified trading habits and the outcomes at each review horizon."""

import json
from hashlib import sha256
from typing import Literal

from .tools import CODE_SCOPE, DECISIONS, Args, Context, _mapped, _number, _Read, _rows

EVIDENCE = "account/review_evidence.json"
Horizon = Literal["20_sessions", "to_date"]
Habit = Literal["before_earnings", "untraded_fall", "basket_buy"]
Scope = Literal["broker_total", "invest", "isa"]


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
    revision = []
    as_of = {}
    issues = []
    suffix = "horizon" if args.horizon == "20_sessions" else "to_date"
    for code in scopes:
        account = _mapped(accounts.get(code))
        if account.get("status") != "available":
            issues.append(f"{CODE_SCOPE[code]}_decisions_unavailable")
            continue
        as_of[CODE_SCOPE[code]] = account.get("as_of")
        journal = _mapped(evidence.get(code))
        if journal.get("coverage") != "complete":
            issues.append("partial_journal")
        for row in _rows(account.get("decisions")) + _rows(account.get("unpriced_basket_buys")):
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
                    bool(complete),
                    row.get("return_to_date") is not None and observed != 0,
                )
            )
            if row.get("side") == "buy":
                if row.get("before_earnings") is None:
                    issues.append("partial_earnings_history")
                for key in ("before_earnings", "basket_buy"):
                    if row.get(key):
                        groups[key].append(
                            (
                                _number(row.get(f"effect_{suffix}_gbp")) if scored else None,
                                _number(row.get(f"return_{suffix}")) if scored else None,
                            )
                        )
        for move in _rows(journal.get("holdingMoves")):
            if (_number(move.get("change")) or 0) >= 0:
                continue
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
    if not revision:
        return read.missing("decision_history_unavailable", keys=[DECISIONS, EVIDENCE])
    summaries = {}
    for key, group in groups.items():
        if args.habit is not None and key != args.habit:
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
