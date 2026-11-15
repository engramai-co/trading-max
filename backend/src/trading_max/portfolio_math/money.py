"""Cash-flow-adjusted amounts and their drawdown at the full valuation cadence."""

from collections.abc import Sequence

from .math import drawdowns, minimum_observed
from .nav import difference, nav_number
from .types import DrawdownObservation, Money, MoneyDrawdownEpisode, NavPoint, Scope, Series


def _drawdown_episode(
    points: Sequence[NavPoint], drawdown: Series, maximum: float | None
) -> MoneyDrawdownEpisode | None:
    if maximum is None or maximum >= 0:
        return None
    trough = drawdown.index(maximum)
    peak = next(i for i in reversed(range(trough)) if drawdown[i] == 0)
    recovery = next((i for i in range(trough + 1, len(drawdown)) if drawdown[i] == 0), None)

    def observation(index: int) -> DrawdownObservation:
        point = points[index]
        return {"date": point["date"], "estimated": point.get("valuationSource") == "reconstructed"}

    return {
        "peak": observation(peak),
        "trough": observation(trough),
        "recovery": None if recovery is None else observation(recovery),
    }


def portfolio_money(points: Sequence[NavPoint], scope: Scope) -> Money:
    first = points[0] if points else None
    opening = nav_number(first, scope)
    opening_flows = nav_number(first, scope, "NetContributionsGbp")
    period_flows = [
        difference(opening_flows, nav_number(point, scope, "NetContributionsGbp"))
        for point in points
    ]
    value_changes = [difference(opening, nav_number(point, scope)) for point in points]
    pnls = [
        None if value is None or flow is None else value - flow
        for value, flow in zip(value_changes, period_flows, strict=True)
    ]

    def relative(values: Series) -> Series:
        return [
            None if value is None or opening is None or opening <= 0 else value / opening
            for value in values
        ]

    drawdown = drawdowns(pnls)
    complete = len(pnls) > 1 and all(value is not None for value in pnls)
    max_drawdown = minimum_observed(drawdown) if complete else None
    return {
        "opening": opening,
        "ending": nav_number(points[-1] if points else None, scope),
        "contributions": period_flows[-1] if len(points) > 1 else None,
        "pnl": pnls[-1] if len(points) > 1 else None,
        "maxDrawdown": max_drawdown,
        "drawdownEpisode": _drawdown_episode(points, drawdown, max_drawdown),
        "pnls": pnls,
        "pnlPercents": relative(pnls),
        "drawdown": drawdown,
        "drawdownPercents": relative(drawdown),
        "periodFlows": period_flows,
        "valueChanges": value_changes,
        "valueChangePercents": relative(value_changes),
    }
