"""The diagnostic explanation must not change the established scoring rules."""

import random

import pytest
from trading_max.research.technical_scoring import score_breakdown, technical_score


def legacy_score(m):
    """Independent frozen oracle from the pre-diagnosis algorithm."""
    score = 50
    moving = m["moving_averages"]
    for key, weight in (("sma20", 4), ("sma50", 10), ("sma200", 12)):
        if m["price"] is not None and moving[key] is not None:
            score += weight if m["price"] > moving[key] else -weight
    if moving["sma50"] is not None and moving["sma200"] is not None:
        score += 10 if moving["sma50"] > moving["sma200"] else -10
    if moving["sma50_slope_20d"] is not None:
        score += 6 if moving["sma50_slope_20d"] > 0 else -6
    macd = m["momentum"]["macd"]
    if macd["line"] is not None and macd["signal"] is not None:
        score += 5 if macd["line"] > macd["signal"] else -5
    if macd["histogram"] is not None:
        score += 4 if macd["histogram"] > 0 else -4
    rsi = m["momentum"]["rsi14"]
    if rsi is not None:
        if 50 <= rsi <= 70:
            score += 5
        elif rsi < 40:
            score -= 5
        elif rsi > 80:
            score -= 2
    for key, weight in (("spy_63d", 6), ("soxx_63d", 3)):
        excess = m["relative_strength"][key]["excess_return"]
        if excess is not None:
            score += weight if excess > 0 else -weight
    ratio = m["volume"]["up_down_volume_ratio_20d"]
    if ratio is not None:
        score += 3 if ratio > 1 else -3
    trend = m["trend_strength"]
    if (
        all(trend[k] is not None for k in ("adx14", "plus_di14", "minus_di14"))
        and trend["adx14"] >= 25
    ):
        score += 5 if trend["plus_di14"] > trend["minus_di14"] else -5
    return max(0, min(100, score))


def test_explanations_preserve_legacy_results_and_reconcile_500_scenarios():
    rng = random.Random(212)  # noqa: S311 — deterministic synthetic test inputs, not secrets
    for _ in range(500):

        def pick():
            return rng.choice([None, 0, 1, 25, 40, 50, 70, 80, rng.uniform(-5, 100)])

        metrics = {
            "price": pick(),
            "moving_averages": {k: pick() for k in ("sma20", "sma50", "sma200", "sma50_slope_20d")},
            "momentum": {
                "rsi14": pick(),
                "macd": {k: pick() for k in ("line", "signal", "histogram")},
            },
            "relative_strength": {k: {"excess_return": pick()} for k in ("spy_63d", "soxx_63d")},
            "volume": {"up_down_volume_ratio_20d": pick()},
            "trend_strength": {k: pick() for k in ("adx14", "plus_di14", "minus_di14")},
        }
        result = score_breakdown(metrics)
        assert result["score"] == legacy_score(metrics)
        assert result["rawScore"] == 50 + sum(g["contribution"] or 0 for g in result["groups"])
        assert result["rawScore"] + result["clampAdjustment"] == result["score"]
        score, state = technical_score(metrics)
        assert state == (
            "强势趋势"
            if score >= 70
            else "偏强"
            if score >= 56
            else "中性/分歧"
            if score >= 45
            else "偏弱"
            if score >= 31
            else "弱势/趋势破坏"
        )


@pytest.mark.parametrize(
    "rsi,expected",
    [(39.99, -5), (40, 0), (49.99, 0), (50, 5), (70, 5), (70.01, 0), (80, 0), (80.01, -2)],
)
def test_rsi_boundary_points(rsi, expected):
    result = score_breakdown({"momentum": {"rsi14": rsi}})
    assert result["groups"][1]["factors"][-1]["contribution"] == expected


def test_missing_is_not_a_neutral_reading_and_zero_keeps_legacy_penalty():
    absent = score_breakdown({})
    assert absent["availableSignals"] == 0
    assert all(g["contribution"] is None for g in absent["groups"])
    present = score_breakdown({"momentum": {"macd": {"histogram": 0}, "rsi14": 45}})
    assert present["availableSignals"] == 2
    assert present["groups"][1]["factors"][1]["contribution"] == -4
    assert present["groups"][1]["factors"][2]["contribution"] == 0
    for invalid in (float("nan"), float("inf"), True, "50"):
        assert score_breakdown({"momentum": {"rsi14": invalid}})["availableSignals"] == 0


@pytest.mark.parametrize("direction", [-1, 1])
def test_clamp_is_explicit_not_an_unexplained_group_sum(direction):
    up = direction > 0
    result = score_breakdown(
        {
            "price": 300 if up else 1,
            "moving_averages": {
                "sma20": 200,
                "sma50": 200 if up else 50,
                "sma200": 100,
                "sma50_slope_20d": direction,
            },
            "momentum": {
                "rsi14": 60 if up else 20,
                "macd": {"line": direction, "signal": 0, "histogram": direction},
            },
            "relative_strength": {k: {"excess_return": direction} for k in ("spy_63d", "soxx_63d")},
            "volume": {"up_down_volume_ratio_20d": 2 if up else 0.5},
            "trend_strength": {"adx14": 30, "plus_di14": 40 if up else 10, "minus_di14": 20},
        }
    )
    assert result["score"] == (100 if up else 0)
    assert result["clampAdjustment"] != 0
    assert result["availableSignals"] == result["totalSignals"] == 12
