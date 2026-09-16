"""Deterministic valuation previews over frozen, evidence-linked inputs."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from trading_max.domain import DomainModel
from trading_max.research.facts import EvidenceRef, fingerprint
from trading_max.research.fundamentals import _growth_for_year


class ScenarioInputs(DomainModel):
    revenue_cagr: float = Field(ge=-0.8, le=2)
    target_fcf_margin: float = Field(ge=-1, le=1)
    discount_rate: float = Field(ge=0.01, le=0.6)
    exit_fcf_multiple: float = Field(ge=0, le=100)
    share_cagr: float = Field(ge=-0.3, le=1)


class AssumptionReference(DomainModel):
    metric: Literal["revenueGrowth"] = "revenueGrowth"
    scenario: Literal["bear", "base", "bull"]
    period: str
    as_of: str
    value: float
    source: Literal["yahoo-finance-consensus", "historical-revenue-cagr"] = (
        "yahoo-finance-consensus"
    )
    reference_value: float | None = None
    adjustment: float = 0
    evidence: list[EvidenceRef] = Field(default_factory=list)


class ValuationPreviewRequest(DomainModel):
    horizon: Literal[5, 10] = 5
    scenarios: dict[Literal["bear", "base", "bull"], ScenarioInputs]
    data_version: str | None = None
    references: list[AssumptionReference] = Field(default_factory=list, max_length=3)


class FrozenValuationBasis(DomainModel):
    ticker: str
    quote_id: str
    data_version: str
    currency: str
    spot: float = Field(gt=0)
    revenue: float = Field(gt=0)
    shares: float = Field(gt=0)
    start_margin: float = Field(ge=-1, le=1)
    cash_flow_type: Literal["operating-cash-flow-less-capex-equity-proxy"] = (
        "operating-cash-flow-less-capex-equity-proxy"
    )
    discount_rate_type: Literal["cost-of-equity"] = "cost-of-equity"
    evidence: list[EvidenceRef] = Field(default_factory=list)


class ProjectionYear(DomainModel):
    year: int
    growth: float
    revenue: float
    fcf_margin: float
    free_cashflow: float
    shares: float
    cashflow_per_share: float
    discount_factor: float
    present_value: float


class ScenarioProjection(DomainModel):
    inputs: ScenarioInputs
    years: list[ProjectionYear]
    operating_value: float
    terminal_value: float
    terminal_present_value: float
    terminal_contribution: float | None
    equity_floor_adjustment: float = 0
    value: float
    upside: float


class SensitivityCell(DomainModel):
    growth: float
    discount_rate: float
    value: float
    upside: float


class ValuationPreview(DomainModel):
    id: str
    formula_version: str = "equity-proxy-projection-v1"
    basis: FrozenValuationBasis
    horizon: Literal[5, 10]
    scenarios: dict[str, ScenarioProjection]
    sensitivity: list[SensitivityCell]
    implied_growth: float | None
    implied_growth_bound: Literal["below", "above"] | None = None
    implied_growth_reason: str | None = None
    references: list[AssumptionReference] = Field(default_factory=list)


def project(
    basis: FrozenValuationBasis, inputs: ScenarioInputs, horizon: int
) -> ScenarioProjection:
    years = []
    revenue = basis.revenue
    for year in range(1, horizon + 1):
        growth = _growth_for_year(inputs.revenue_cagr, year, horizon)
        revenue *= 1 + growth
        margin = basis.start_margin + (inputs.target_fcf_margin - basis.start_margin) * min(
            year / 3, 1
        )
        fcf = revenue * margin
        shares = basis.shares * (1 + inputs.share_cagr) ** year
        discount = 1 / (1 + inputs.discount_rate) ** year
        years.append(
            ProjectionYear(
                year=year,
                growth=growth,
                revenue=revenue,
                fcf_margin=margin,
                free_cashflow=fcf,
                shares=shares,
                cashflow_per_share=fcf / shares,
                discount_factor=discount,
                present_value=fcf / shares * discount,
            )
        )
    operating = sum(y.present_value for y in years)
    terminal = max(years[-1].cashflow_per_share, 0) * inputs.exit_fcf_multiple
    terminal_pv = terminal * years[-1].discount_factor
    value = max(operating + terminal_pv, 0)
    return ScenarioProjection(
        inputs=inputs,
        years=years,
        operating_value=operating,
        terminal_value=terminal,
        terminal_present_value=terminal_pv,
        terminal_contribution=terminal_pv / value if value > 0 else None,
        equity_floor_adjustment=max(-(operating + terminal_pv), 0),
        value=value,
        upside=value / basis.spot - 1,
    )


def preview(basis: FrozenValuationBasis, request: ValuationPreviewRequest) -> ValuationPreview:
    if request.data_version and request.data_version != basis.data_version:
        raise ValueError("research-data-version-changed")
    if set(request.scenarios) != {"bear", "base", "bull"}:
        raise ValueError("three-complete-scenarios-required")
    base = request.scenarios["base"]
    scenarios = {
        key: project(basis, params, request.horizon) for key, params in request.scenarios.items()
    }
    cells = []
    for discount_delta in (-0.02, -0.01, 0, 0.01, 0.02):
        for growth_delta in (-0.1, -0.05, 0, 0.05, 0.1):
            params = base.model_copy(
                update={
                    "revenue_cagr": max(-0.8, min(2, base.revenue_cagr + growth_delta)),
                    "discount_rate": min(0.6, max(0.01, base.discount_rate + discount_delta)),
                }
            )
            result = project(basis, params, request.horizon)
            cells.append(
                SensitivityCell(
                    growth=params.revenue_cagr,
                    discount_rate=params.discount_rate,
                    value=result.value,
                    upside=result.upside,
                )
            )
    low, high = -0.3, 0.8

    def value(growth: float) -> float:
        return project(
            basis, base.model_copy(update={"revenue_cagr": growth}), request.horizon
        ).value

    samples = [value(low), value(high)]
    # For negative cash flows, growth can deepen losses before a turnaround.
    # Do not present a single implied growth from an unproven monotone solve.
    monotonic = basis.start_margin >= 0 and base.target_fcf_margin >= 0 and samples[-1] > samples[0]
    bound = (
        ("below" if basis.spot < samples[0] else "above" if basis.spot > samples[-1] else None)
        if monotonic
        else None
    )
    implied = None
    if monotonic and bound is None:
        for _ in range(64):
            mid = (low + high) / 2
            if value(mid) < basis.spot:
                low = mid
            else:
                high = mid
        implied = (low + high) / 2
    return ValuationPreview(
        id=fingerprint([basis.model_dump(), request.model_dump()]),
        basis=basis,
        horizon=request.horizon,
        scenarios=scenarios,
        sensitivity=cells,
        implied_growth=implied,
        implied_growth_bound=bound,
        implied_growth_reason=None if monotonic else "non-monotonic-or-flat-cashflows",
        references=request.references,
    )
