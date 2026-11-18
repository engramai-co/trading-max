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


class HabitArgs(Args):
    scope: Scope
    horizon: Horizon = "20_sessions"


def review_patterns(ctx: Context, args: HabitArgs) -> dict:
    """Count verified pre-earnings purchases, untraded falls and same-day baskets.
    Money after an untraded fall is hypothetical, sized to the mean purchase through that day.
    """
    read = _Read(ctx.deps, "review_patterns", args, args.scope)
    scopes = sorted(read.account_codes(args.scope))
    accounts = _mapped((read.read(DECISIONS) or {}).get("accounts"))
    evidence = _mapped((read.read(EVIDENCE) or {}).get("accounts"))
    groups = {k: [] for k in ("before_earnings", "untraded_fall", "basket_buy")}
    revision = []
    issues = []
    suffix = "horizon" if args.horizon == "20_sessions" else "to_date"
    for code in scopes:
        account = _mapped(accounts.get(code))
        if (
            account.get("status") != "available"
            or account.get("calculation_version") != CALCULATION_VERSION
        ):
            issues.append(f"{CODE_SCOPE[code]}_decisions_unavailable")
            continue
        journal = _mapped(evidence.get(code))
        if journal.get("coverage") != "complete":
            issues.append("partial_journal")
        for row in _rows(account.get("decisions")):
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
        effects = [money for money, _ in group if money is not None]
        returns = [value for _, value in group if value is not None]
        summaries[key] = {
            "count": len(group),
            "evaluated": len(effects),
            "effect_gbp": round(sum(effects), 2) if effects else None,
            "mean_return": sum(returns) / len(returns) if returns else None,
        }
    version = sha256(json.dumps(revision, separators=(",", ":")).encode()).hexdigest()[:24]
    return read.result(
        "partial" if issues else "ok",
        {"groups": summaries, "revision": version, "currency": "GBP", "horizon": args.horizon},
        keys=[DECISIONS, EVIDENCE],
        issues=issues,
    )
