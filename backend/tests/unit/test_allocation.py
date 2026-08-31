from __future__ import annotations

import pytest
from trading_max.analytics.allocation import (
    combine_allocations,
    concentration,
    normalize_weights,
    portfolio_return_series,
    risk_contributions,
    stress_test,
    turnover,
)


def test_normalize_and_combine_allocations() -> None:
    assert normalize_weights({"A": 2, "B": 1}) == pytest.approx({"A": 2 / 3, "B": 1 / 3})
    combined = combine_allocations(
        {
            "invest": (100, {"A": 1}),
            "isa": (300, {"B": 1}),
        }
    )
    assert combined == pytest.approx({"A": 0.25, "B": 0.75})


def test_turnover_and_concentration_are_scale_invariant() -> None:
    assert turnover({"A": 1, "B": 1}, {"A": 3, "B": 1}) == pytest.approx(0.25)
    metrics = concentration({"A": 3, "B": 1})
    assert metrics.hhi == pytest.approx(0.625)
    assert metrics.effective_positions == pytest.approx(1.6)


def test_stress_test_preserves_unmentioned_assets_as_zero_shock() -> None:
    result = stress_test(
        {"A": 3, "B": 1},
        {"recession": {"A": -0.2}},
        portfolio_value=1000,
    )
    assert result[0].return_pct == pytest.approx(-0.15)
    assert result[0].shocked_value == pytest.approx(850)


def test_risk_contributions_sum_to_one() -> None:
    result = risk_contributions(
        {
            "A": [0.01, 0.02, -0.01, 0.03],
            "B": [0.00, 0.01, 0.00, 0.02],
        },
        {"A": 1, "B": 1},
    )
    assert sum(item.risk_contribution for item in result) == pytest.approx(1.0)


def test_portfolio_series_supports_periodic_and_buy_and_hold() -> None:
    observations = [{"A": 0.1, "B": 0.0}, {"A": 0.0, "B": 0.1}]
    periodic = portfolio_return_series(observations, {"A": 1, "B": 1})
    drifted = portfolio_return_series(
        observations,
        {"A": 1, "B": 1},
        rebalance="buy_and_hold",
    )
    assert periodic == pytest.approx([0.05, 0.05])
    assert drifted[1] < periodic[1]


@pytest.mark.parametrize(
    "weights",
    [{}, {"A": -1}, {"A": float("nan")}],
)
def test_invalid_allocations_fail_loudly(weights: dict[str, float]) -> None:
    with pytest.raises(ValueError):
        normalize_weights(weights)
