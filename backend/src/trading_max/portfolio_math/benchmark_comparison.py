"""Shared dates and rebased benchmark prices used by the Returns view."""

from collections.abc import Mapping, Sequence
from typing import cast

from ._js import numeric
from .nav import nav_number
from .types import BenchmarkComparison, BenchmarkLine, BenchmarkPricePoint, NavPoint, Scope


def benchmark_comparison(
    points: Sequence[NavPoint],
    scope: Scope,
    series: Mapping[str, Sequence[BenchmarkPricePoint]] | None,
    names: Sequence[str],
) -> BenchmarkComparison:
    portfolio = [point for point in points if nav_number(point, scope, "Twr") is not None]
    benchmarks = []
    for name in names:
        prices = {}
        for point in series.get(name, ()) if series is not None else ():
            close = point.get("close")
            prices[point["date"][:10]] = numeric(close if close is not None else point.get("price"))
        benchmarks.append((name, prices))

    def priced(prices: dict[str, float | None], point: NavPoint) -> bool:
        return (prices.get(point["date"][:10]) or 0) > 0

    usable = [
        (name, prices)
        for name, prices in benchmarks
        if sum(priced(prices, point) for point in portfolio) > 1
    ]
    shared = (
        [point for point in portfolio if all(priced(prices, point) for _, prices in usable)]
        if usable
        else []
    )
    if len(shared) < 2:
        return {"points": portfolio, "comparisons": [], "missing": bool(names)}
    comparisons: list[BenchmarkLine] = []
    for name, prices in usable:
        values = [cast(float, prices[point["date"][:10]]) for point in shared]
        start = values[0]
        comparisons.append({"name": name, "values": [price / start - 1 for price in values]})
    return {"points": shared, "comparisons": comparisons, "missing": len(usable) < len(names)}
