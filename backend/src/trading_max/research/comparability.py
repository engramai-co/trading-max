"""Comparison ledger: different observations must not become false errors."""

from typing import Literal

from pydantic import Field

from trading_max.domain import DomainModel


class ComparisonSample(DomainModel):
    security_id: str
    metric: str
    provider: str
    as_of: str | None = None
    period: str | None = None
    currency: str | None = None
    basis: str | None = None
    unit: str
    sample_count: int | None = Field(default=None, ge=0)
    population: str | None = None
    value: float | None = Field(default=None, allow_inf_nan=False)


class ObservationComparison(DomainModel):
    left: ComparisonSample
    right: ComparisonSample
    state: Literal["comparable", "different-definition", "insufficient-context"]
    reasons: list[str] = Field(default_factory=list)
    difference: float | None = None


def compare_samples(left: ComparisonSample, right: ComparisonSample) -> ObservationComparison:
    """Conservative identity checks; provider identity may differ intentionally."""
    identity = ("security_id", "metric", "as_of", "period", "basis", "unit")
    missing = [k for k in identity if not getattr(left, k) or not getattr(right, k)]
    if left.unit in {"currency", "perShare"} and (not left.currency or not right.currency):
        missing.append("currency")
    if left.value is None or right.value is None:
        missing.append("value")
    if (left.sample_count is not None or right.sample_count is not None) and (
        not left.population or not right.population
    ):
        missing.append("population")
    mismatches = [
        k
        for k in (*identity, "currency", "sample_count", "population")
        if getattr(left, k) != getattr(right, k)
    ]
    state = (
        "insufficient-context"
        if missing
        else "different-definition"
        if mismatches
        else "comparable"
    )
    return ObservationComparison(
        left=left,
        right=right,
        state=state,
        reasons=[*("missing:" + k for k in missing), *("different:" + k for k in mismatches)],
        difference=left.value - right.value if state == "comparable" else None,
    )
