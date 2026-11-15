"""Compare the Python calculations with the committed TypeScript outputs."""

import json
from datetime import UTC, datetime, timedelta
from math import copysign, isclose, isinf, isnan
from pathlib import Path
from typing import Any

import pytest
from trading_max import portfolio_math
from trading_max.portfolio_math.nav import numeric

FIXTURE = Path(__file__).parents[1] / "fixtures/portfolio_math/typescript.json"
CASES = json.loads(FIXTURE.read_text())
ABS_TOL = 1e-9
REL_TOL = 1e-12
UNDEFINED = object()
SPECIAL = {
    "NaN": float("nan"),
    "Infinity": float("inf"),
    "-Infinity": float("-inf"),
    "-0": -0.0,
    "undefined": UNDEFINED,
}


def _decode(value: Any) -> Any:
    if isinstance(value, dict):
        if value.keys() == {"$js"}:
            return SPECIAL[value["$js"]]
        return {key: _decode(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode(item) for item in value]
    return value


def _expand_timeline(compact: dict[str, Any]) -> dict[str, Any]:
    """Decode the fixture transport independently of the production implementation."""
    categories = []
    for start, count, step_ms in compact["segments"]:
        first = datetime.fromisoformat(start)
        if first.tzinfo is None:
            first = first.replace(tzinfo=UTC)
        for index in range(count):
            stamp = first + timedelta(milliseconds=index * step_ms)
            categories.append(
                stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")
                if "T" in start
                else stamp.date().isoformat()
            )
    indexes = [None] * len(categories)
    anchors = [False] * len(categories)
    for position, row, anchor in compact["rows"]:
        indexes[position], anchors[position] = row, anchor
    timeline = {"categories": categories, "rowIndexes": indexes, "anchors": anchors}
    if "displayIntervalMinutes" in compact:
        timeline["displayIntervalMinutes"] = compact["displayIntervalMinutes"]
    return timeline


def _evaluate(function: str, data: Any) -> Any:
    if function == "select_portfolio_history":
        data = dict(data)
        if "asOf" in data:
            data["as_of"] = data.pop("asOf")
        if "requireCashFlows" in data:
            data["require_cash_flows"] = data.pop("requireCashFlows")
        return portfolio_math.select_portfolio_history(**data)
    if function == "pnls_at":
        snapshot, selection, instants = data
        return portfolio_math.pnls_at(portfolio_math.prepare_history(snapshot, selection), instants)
    if function == "numeric":
        return numeric(*data)
    if function == "deepest_drawdown":
        result = portfolio_math.deepest_drawdown(*data)
        return UNDEFINED if result is None else result
    return getattr(portfolio_math, function)(*data)


def _compare(actual: Any, expected: Any, path: str = "$") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys(), path
        for key, value in expected.items():
            _compare(actual[key], value, f"{path}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), path
        for index, (actual_item, expected_item) in enumerate(zip(actual, expected, strict=True)):
            _compare(actual_item, expected_item, f"{path}[{index}]")
    elif isinstance(expected, bool):
        assert actual is expected, path
    elif isinstance(expected, int | float):
        assert isinstance(actual, int | float) and not isinstance(actual, bool), path
        if isnan(expected):
            assert isnan(actual), path
        elif isinf(expected):
            assert actual == expected, path
        elif expected == 0:
            assert actual == 0 and copysign(1, actual) == copysign(1, expected), path
        elif isinstance(expected, int):
            # JavaScript JSON writes integral numbers without a fractional
            # part. Dates, timestamps, indexes and integers compare exactly.
            assert actual == expected, (path, actual, expected)
        else:
            assert isclose(actual, expected, abs_tol=ABS_TOL, rel_tol=REL_TOL), (
                path,
                actual,
                expected,
            )
    else:
        assert actual == expected, (path, actual, expected)


@pytest.mark.parametrize("case", CASES, ids=lambda case: f"{case['function']}:{case['name']}")
def test_typescript_parity(case):
    function = case["function"]
    data = _decode(case["input"])
    expected = _decode(case["output"])
    if function in {"select_portfolio_history", "prepare_history"}:
        history = expected["history"] if function == "prepare_history" else expected
        history["timeline"] = _expand_timeline(history["timeline"])
    _compare(_evaluate(function, data), expected)
