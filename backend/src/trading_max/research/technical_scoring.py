"""Lightweight, shared technical-state scoring and its auditable contributions.

No provider, pandas or transport imports in this module: the API can explain
an existing artifact without fetching prices or recalculating indicators.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any


def score_breakdown(metrics: Mapping[str, Any]) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = {
        key: [] for key in ("trend", "momentum", "relative", "volume")
    }

    def numeric(value: Any) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value) if math.isfinite(value) else None

    def record(group: str, key: str, value: Any, reference: Any, weight: int) -> None:
        left, right = numeric(value), numeric(reference)
        groups[group].append(
            {
                "key": key,
                "value": left,
                "reference": right,
                "contribution": None
                if left is None or right is None
                else weight
                if left > right
                else -weight,
            }
        )

    moving = metrics.get("moving_averages") or {}
    momentum = metrics.get("momentum") or {}
    macd = momentum.get("macd") or {}
    strength = metrics.get("trend_strength") or {}
    for key, weight in (("sma20", 4), ("sma50", 10), ("sma200", 12)):
        record("trend", key, metrics.get("price"), moving.get(key), weight)
    record("trend", "sma_cross", moving.get("sma50"), moving.get("sma200"), 10)
    record("trend", "sma_slope", moving.get("sma50_slope_20d"), 0, 6)
    adx, plus, minus = (numeric(strength.get(key)) for key in ("adx14", "plus_di14", "minus_di14"))
    groups["trend"].append(
        {
            "key": "adx",
            "value": adx,
            "reference": 25,
            "contribution": None
            if adx is None or (adx >= 25 and (plus is None or minus is None))
            else 0
            if adx < 25
            else 5
            if plus > minus
            else -5,
        }
    )
    record("momentum", "macd_signal", macd.get("line"), macd.get("signal"), 5)
    record("momentum", "macd_histogram", macd.get("histogram"), 0, 4)
    rsi = numeric(momentum.get("rsi14"))
    groups["momentum"].append(
        {
            "key": "rsi",
            "value": rsi,
            "reference": None,
            "contribution": None
            if rsi is None
            else 5
            if 50 <= rsi <= 70
            else -5
            if rsi < 40
            else -2
            if rsi > 80
            else 0,
        }
    )
    relative = metrics.get("relative_strength") or {}
    for key, weight in (("spy_63d", 6), ("soxx_63d", 3)):
        record("relative", key, (relative.get(key) or {}).get("excess_return"), 0, weight)
    record(
        "volume",
        "up_down_volume",
        (metrics.get("volume") or {}).get("up_down_volume_ratio_20d"),
        1,
        3,
    )
    factors = [factor for items in groups.values() for factor in items]
    raw_score = 50 + sum(f["contribution"] or 0 for f in factors)
    score = max(0, min(100, raw_score))
    state = (
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
    return {
        "baseScore": 50,
        "rawScore": raw_score,
        "score": score,
        "state": state,
        "clampAdjustment": score - raw_score,
        "availableSignals": sum(f["contribution"] is not None for f in factors),
        "totalSignals": len(factors),
        "groups": [
            {
                "key": key,
                "contribution": sum(f["contribution"] or 0 for f in items)
                if any(f["contribution"] is not None for f in items)
                else None,
                "factors": items,
            }
            for key, items in groups.items()
        ],
    }


def technical_score(metrics: Mapping[str, Any]) -> tuple[int, str]:
    result = score_breakdown(metrics)
    return result["score"], result["state"]
