from datetime import UTC, datetime, timedelta
from math import sqrt

import pytest
from trading_max.analytics.performance import PerformancePoint, calculate_performance


def _points(values: list[float]) -> list[PerformancePoint]:
    return [
        PerformancePoint(
            as_of=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=index), value=value
        )
        for index, value in enumerate(values)
    ]


def test_sortino_constant_losses_have_nonzero_downside_risk() -> None:
    metrics = calculate_performance(_points([100, 90, 81]), periods_per_year=1)
    assert metrics.sortino == pytest.approx(-1)


def test_sortino_uses_target_shortfalls_over_all_intervals() -> None:
    metrics = calculate_performance(_points([100, 90, 108]), periods_per_year=1)
    assert metrics.sortino == pytest.approx(0.05 / sqrt(0.01 / 2))
