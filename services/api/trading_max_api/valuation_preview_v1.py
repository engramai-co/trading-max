"""Wire models of the published v1 cash-flow worksheet."""

from typing import Literal

from pydantic import Field
from trading_max.domain import DomainModel
from trading_max.research.facts import EvidenceRef
from trading_max.research.valuation_preview import (
    LEGACY_VERSION,
    AssumptionReference,
    SensitivityCell,
)


class OperatingScenarioInputs(DomainModel):
    revenue_cagr: float = Field(ge=-0.8, le=2)
    target_fcf_margin: float = Field(ge=-1, le=1)
    discount_rate: float = Field(ge=0.01, le=0.6)
    exit_fcf_multiple: float = Field(ge=0, le=100)
    share_cagr: float = Field(ge=-0.3, le=1)


class OperatingBasis(DomainModel):
    ticker: str
    quote_id: str
    data_version: str
    currency: str
    spot: float = Field(gt=0)
    # Held securities are valued against the broker price the holdings page shows.
    spot_source: Literal["quote", "broker"] = "quote"
    spot_as_of: str | None = None
    revenue: float = Field(gt=0)
    shares: float = Field(gt=0)
    start_margin: float = Field(ge=-1, le=1)
    cash_flow_type: Literal["operating-cash-flow-less-capex-equity-proxy"] = (
        "operating-cash-flow-less-capex-equity-proxy"
    )
    discount_rate_type: Literal["cost-of-equity"] = "cost-of-equity"
    evidence: list[EvidenceRef] = Field(default_factory=list)


class OperatingProjectionYear(DomainModel):
    year: int
    growth: float
    revenue: float
    fcf_margin: float
    free_cashflow: float
    shares: float
    cashflow_per_share: float
    discount_factor: float
    present_value: float


class OperatingProjection(DomainModel):
    inputs: OperatingScenarioInputs
    years: list[OperatingProjectionYear]
    operating_value: float
    terminal_value: float
    terminal_present_value: float
    terminal_contribution: float | None
    equity_floor_adjustment: float = 0
    value: float
    upside: float


class OperatingValuationPreview(DomainModel):
    id: str
    formula_version: str = LEGACY_VERSION
    basis: OperatingBasis
    horizon: Literal[5, 10]
    scenarios: dict[str, OperatingProjection]
    sensitivity: list[SensitivityCell]
    implied_growth: float | None
    implied_growth_bound: Literal["below", "above"] | None = None
    implied_growth_reason: str | None = None
    references: list[AssumptionReference] = Field(default_factory=list)
    default_source: (
        Literal["saved-model", "configured-scenarios", "sector-template", "user-input"] | None
    ) = None
