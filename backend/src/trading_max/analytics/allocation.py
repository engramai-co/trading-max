"""Deterministic portfolio allocation and risk analytics.

This module contains the reusable part of the former ISA rebalance studies.
It accepts normalized, in-memory observations only; downloads, reports and
scenario files belong outside the calculation layer.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any, Literal

import numpy as np
from pydantic import Field

from trading_max.domain import DomainModel


class ConcentrationMetrics(DomainModel):
    hhi: float = Field(ge=0.0, le=1.0)
    effective_positions: float = Field(ge=1.0)
    largest_weight: float = Field(ge=0.0, le=1.0)


class RiskContribution(DomainModel):
    asset: str = Field(min_length=1)
    capital_weight: float
    risk_contribution: float


class StressResult(DomainModel):
    scenario: str = Field(min_length=1)
    return_pct: float
    shocked_value: float | None = None


def _finite(value: Any, *, field: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be numeric") from exc
    if not math.isfinite(parsed):
        raise ValueError(f"{field} must be finite")
    return parsed


def normalize_weights(weights: Mapping[str, Any]) -> dict[str, float]:
    """Validate and normalize non-negative asset weights to one."""

    cleaned: dict[str, float] = {}
    for raw_asset, raw_weight in weights.items():
        asset = str(raw_asset).strip()
        if not asset:
            raise ValueError("allocation asset names cannot be empty")
        weight = _finite(raw_weight, field=f"weight[{asset}]")
        if weight < 0:
            raise ValueError(f"weight[{asset}] cannot be negative")
        if weight:
            cleaned[asset] = weight
    total = sum(cleaned.values())
    if total <= 0:
        raise ValueError("allocation must contain positive weight")
    return {asset: weight / total for asset, weight in cleaned.items()}


def combine_allocations(
    accounts: Mapping[str, tuple[Any, Mapping[str, Any]]],
) -> dict[str, float]:
    """Combine account allocations using their current total values."""

    if not accounts:
        raise ValueError("at least one account is required")
    total_value = 0.0
    combined: dict[str, float] = {}
    for account, (raw_value, weights) in accounts.items():
        value = _finite(raw_value, field=f"value[{account}]")
        if value < 0:
            raise ValueError(f"value[{account}] cannot be negative")
        if value == 0:
            continue
        normalized = normalize_weights(weights)
        total_value += value
        for asset, weight in normalized.items():
            combined[asset] = combined.get(asset, 0.0) + value * weight
    if total_value <= 0:
        raise ValueError("combined account value must be positive")
    return normalize_weights({asset: value / total_value for asset, value in combined.items()})


def turnover(
    current: Mapping[str, Any],
    target: Mapping[str, Any],
) -> float:
    """Return one-way turnover as half the absolute weight difference."""

    left = normalize_weights(current)
    right = normalize_weights(target)
    assets = set(left) | set(right)
    return 0.5 * sum(abs(left.get(asset, 0.0) - right.get(asset, 0.0)) for asset in assets)


def concentration(weights: Mapping[str, Any]) -> ConcentrationMetrics:
    normalized = normalize_weights(weights)
    hhi = sum(weight * weight for weight in normalized.values())
    return ConcentrationMetrics(
        hhi=hhi,
        effective_positions=1.0 / hhi,
        largest_weight=max(normalized.values()),
    )


def stress_test(
    weights: Mapping[str, Any],
    scenarios: Mapping[str, Mapping[str, Any]],
    *,
    portfolio_value: float | None = None,
) -> list[StressResult]:
    """Apply additive asset shocks without silently filling missing shocks."""

    normalized = normalize_weights(weights)
    value = (
        _finite(portfolio_value, field="portfolio_value") if portfolio_value is not None else None
    )
    if value is not None and value < 0:
        raise ValueError("portfolio_value cannot be negative")
    results: list[StressResult] = []
    for scenario, shocks in scenarios.items():
        shock_return = 0.0
        for asset, weight in normalized.items():
            shock = _finite(shocks.get(asset, 0.0), field=f"shock[{asset}]")
            shock_return += weight * shock
        results.append(
            StressResult(
                scenario=str(scenario),
                return_pct=shock_return,
                shocked_value=(value * (1.0 + shock_return) if value is not None else None),
            )
        )
    return results


def risk_contributions(
    returns: Mapping[str, Sequence[float]],
    weights: Mapping[str, Any],
    *,
    annualization: float = 252.0,
) -> list[RiskContribution]:
    """Calculate covariance risk contributions for aligned asset returns."""

    normalized = normalize_weights(weights)
    if annualization <= 0 or not math.isfinite(annualization):
        raise ValueError("annualization must be positive and finite")
    assets = list(normalized)
    missing = [asset for asset in assets if asset not in returns]
    if missing:
        raise ValueError(f"returns are missing assets: {', '.join(missing)}")
    lengths = {len(returns[asset]) for asset in assets}
    if len(lengths) != 1 or not lengths or next(iter(lengths)) < 2:
        raise ValueError("returns must have equal length of at least two observations")
    matrix = np.asarray(
        [
            [_finite(value, field=f"returns[{asset}]") for value in returns[asset]]
            for asset in assets
        ],
        dtype=float,
    )
    covariance = np.cov(matrix, ddof=1) * annualization
    vector = np.asarray([normalized[asset] for asset in assets], dtype=float)
    portfolio_variance = float(vector @ covariance @ vector)
    if portfolio_variance <= 0 or not math.isfinite(portfolio_variance):
        raise ValueError("portfolio variance must be positive and finite")
    marginal = covariance @ vector
    components = vector * marginal / portfolio_variance
    return [
        RiskContribution(
            asset=asset,
            capital_weight=normalized[asset],
            risk_contribution=float(components[index]),
        )
        for index, asset in enumerate(assets)
    ]


def portfolio_return_series(
    returns: Sequence[Mapping[str, Any]],
    weights: Mapping[str, Any],
    *,
    rebalance: Literal["periodic", "buy_and_hold"] = "periodic",
    cash_return: float = 0.0,
) -> list[float]:
    """Build a deterministic portfolio return series with bounded inputs."""

    target = normalize_weights(weights)
    period_cash = _finite(cash_return, field="cash_return")
    live = dict(target)
    result: list[float] = []
    for observation in returns:
        if rebalance == "periodic":
            live = dict(target)
        period = 0.0
        for asset, weight in live.items():
            period += weight * _finite(
                observation.get(asset, period_cash if asset == "CASH" else 0.0),
                field=f"return[{asset}]",
            )
        if period <= -1.0:
            raise ValueError("portfolio return cannot be -100% or lower")
        result.append(period)
        if rebalance == "buy_and_hold":
            live = {
                asset: weight
                * (
                    1.0
                    + _finite(
                        observation.get(asset, period_cash if asset == "CASH" else 0.0),
                        field=f"return[{asset}]",
                    )
                )
                / (1.0 + period)
                for asset, weight in live.items()
            }
    return result


__all__ = [
    "ConcentrationMetrics",
    "RiskContribution",
    "StressResult",
    "combine_allocations",
    "concentration",
    "normalize_weights",
    "portfolio_return_series",
    "risk_contributions",
    "stress_test",
    "turnover",
]
