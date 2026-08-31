"""Deterministic performance primitives with explicit cash-flow semantics."""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime
from itertools import pairwise

from pydantic import Field, field_validator

from trading_max.domain import DomainModel


class PerformancePoint(DomainModel):
    """One valuation point; ``external_flow`` occurs before this valuation."""

    as_of: datetime
    value: float = Field(gt=0)
    external_flow: float = 0.0

    @field_validator("value", "external_flow")
    @classmethod
    def finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("performance values must be finite")
        return value


class PerformanceMetrics(DomainModel):
    """Risk and return metrics calculated from a cash-flow-aware series."""

    periods: int = Field(ge=0)
    twr: float | None = None
    annualized_return: float | None = None
    volatility: float | None = None
    sharpe: float | None = None
    sortino: float | None = None
    max_drawdown: float | None = None
    current_drawdown: float | None = None
    calmar: float | None = None
    information_ratio: float | None = None


def _finite_or_none(value: float) -> float | None:
    return value if math.isfinite(value) else None


def interval_returns(points: Sequence[PerformancePoint]) -> list[float]:
    """Return cash-flow-adjusted interval returns.

    The flow recorded on point ``i`` is assumed to have happened immediately
    before that point's valuation. This convention is explicit so a caller can
    reject or transform intraday flows rather than silently treating deposits
    as investment gains.
    """

    if len(points) < 2:
        return []
    returns: list[float] = []
    for previous, current in pairwise(points):
        denominator = previous.value + current.external_flow
        if denominator <= 0:
            raise ValueError("cash-flow-adjusted starting value must be positive")
        returns.append(current.value / denominator - 1.0)
    return returns


def cumulative_curve(returns: Sequence[float]) -> list[float]:
    curve = [1.0]
    for value in returns:
        curve.append(curve[-1] * (1.0 + value))
    return curve


def drawdowns(curve: Sequence[float]) -> list[float]:
    if not curve:
        return []
    peak = curve[0]
    result: list[float] = []
    for value in curve:
        peak = max(peak, value)
        result.append(value / peak - 1.0)
    return result


def _sample_std(values: Sequence[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / (len(values) - 1)
    return math.sqrt(variance)


def calculate_performance(
    points: Sequence[PerformancePoint],
    *,
    periods_per_year: float = 252.0,
    risk_free_per_period: float = 0.0,
    benchmark_returns: Sequence[float] | None = None,
) -> PerformanceMetrics:
    """Calculate standard ratios without treating external cash as P&L."""

    if periods_per_year <= 0 or not math.isfinite(periods_per_year):
        raise ValueError("periods_per_year must be positive and finite")
    returns = interval_returns(points)
    curve = cumulative_curve(returns)
    dd = drawdowns(curve)
    # A single valuation is a baseline, not a zero-return observation. Keep
    # every return and risk metric unavailable until at least one interval
    # exists so first-run accounts never present a misleading 0.0% result.
    twr = curve[-1] - 1.0 if returns else None
    annualized_return = (
        (1.0 + twr) ** (periods_per_year / len(returns)) - 1.0
        if twr is not None and returns
        else None
    )
    excess = [value - risk_free_per_period for value in returns]
    std = _sample_std(excess)
    downside_values = [min(value, 0.0) for value in excess]
    downside = _sample_std(downside_values) if len(downside_values) >= 2 else None
    volatility = std * math.sqrt(periods_per_year) if std is not None else None
    sharpe = (
        sum(excess) / len(excess) / std * math.sqrt(periods_per_year) if std and returns else None
    )
    sortino = (
        sum(excess) / len(excess) / downside * math.sqrt(periods_per_year)
        if downside and returns
        else None
    )
    max_dd = min(dd) if returns and dd else None
    calmar = (
        annualized_return / abs(max_dd)
        if annualized_return is not None and max_dd and max_dd < 0
        else None
    )
    information_ratio = None
    if benchmark_returns is not None:
        if len(benchmark_returns) != len(returns):
            raise ValueError("benchmark returns must match portfolio intervals")
        active = [
            portfolio - benchmark
            for portfolio, benchmark in zip(returns, benchmark_returns, strict=True)
        ]
        active_std = _sample_std(active)
        information_ratio = (
            sum(active) / len(active) / active_std * math.sqrt(periods_per_year)
            if active_std and active
            else None
        )
    return PerformanceMetrics(
        periods=len(returns),
        twr=_finite_or_none(twr) if twr is not None else None,
        annualized_return=_finite_or_none(annualized_return)
        if annualized_return is not None
        else None,
        volatility=_finite_or_none(volatility) if volatility is not None else None,
        sharpe=_finite_or_none(sharpe) if sharpe is not None else None,
        sortino=_finite_or_none(sortino) if sortino is not None else None,
        max_drawdown=_finite_or_none(max_dd) if max_dd is not None else None,
        current_drawdown=_finite_or_none(dd[-1]) if returns and dd else None,
        calmar=_finite_or_none(calmar) if calmar is not None else None,
        information_ratio=(
            _finite_or_none(information_ratio) if information_ratio is not None else None
        ),
    )


__all__ = [
    "PerformanceMetrics",
    "PerformancePoint",
    "calculate_performance",
    "cumulative_curve",
    "drawdowns",
    "interval_returns",
]
