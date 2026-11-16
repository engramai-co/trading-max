"""Running peaks and observed minima, without filling observation gaps."""

from collections.abc import Sequence
from math import copysign, isfinite

from .types import NullableNumber, Series


def drawdowns(values: Sequence[NullableNumber], compounded: bool = False) -> Series:
    high: float | None = None
    result: Series = []
    for value in values:
        if value is None or not isfinite(value):
            result.append(None)
            continue
        value = float(value)
        # Math.max chooses positive zero over negative zero, independent of order.
        if high is None or value > high or (value == high == 0 and copysign(1, value) > 0):
            high = value
        if compounded:
            result.append(None if high <= -1 else (1 + value) / (1 + high) - 1)
        else:
            result.append(value - high)
    return result


def minimum_observed(values: Sequence[NullableNumber]) -> float | None:
    result = None
    for value in values:
        if value is None or not isfinite(value):
            continue
        value = float(value)
        # Math.min preserves the sign if either tied zero is negative.
        if result is None or value < result or (value == result == 0 and copysign(1, value) < 0):
            result = value
    return result
