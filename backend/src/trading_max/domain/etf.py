"""Share-class evidence. A listing's quote unit is separate from NAV currency."""

from typing import Literal

from pydantic import Field

from trading_max.domain.contracts import DomainModel
from trading_max.reference.security_master import SecurityListingRecord


class FundEvidence(DomainModel):
    source_url: str
    effective_at: str | None = None
    fetched_at: str
    parser_version: str
    coverage: Literal["available", "missing", "failed"]


class FundSize(DomainModel):
    amount: float
    currency: str


class FundListing(SecurityListingRecord):
    quote_currency: str | None = None
    quote_unit: str | None = None
    evidence: FundEvidence

    @property
    def key(self) -> tuple[str, str, str]:
        return self.isin, self.mic, self.ticker


class FundReturnYear(DomainModel):
    year: int
    nav_return: float
    benchmark_return: float
    tracking_difference: float


class FundReturnPair(DomainModel):
    """Issuer-published total returns, as fractions, for one stated period."""

    period_end: str
    nav_return: float
    benchmark_return: float
    nav_currency: str
    benchmark_currency: str
    nav_hedging: str | None = None
    benchmark_hedging: str | None = None
    evidence: FundEvidence


class FundShareClass(DomainModel):
    isin: str
    issuer: str
    name: str | None = None
    index_name: str | None = None
    benchmark_currency: str | None = None
    benchmark_hedging: str | None = None
    share_currency: str | None = None
    base_currency: str | None = None
    income_use: str | None = None
    methodology: str | None = None
    replication: str | None = None
    domicile: str | None = None
    inception: str | None = None
    fund_size: FundSize | None = None
    share_class_size: FundSize | None = None
    expense_ratio: float | None = None
    fee_basis: str | None = None
    hedging: str | None = None
    rebalance_frequency: str | None = None
    index_rules: str | None = None
    return_currency: str | None = None
    return_basis: str | None = None
    annual_returns: list[FundReturnYear] = Field(default_factory=list)
    one_year: FundReturnPair | None = None
    tracking_error: float | None = None
    listings: list[FundListing] = Field(default_factory=list)
    evidence: dict[str, FundEvidence] = Field(default_factory=dict)
