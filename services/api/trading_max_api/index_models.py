"""Index metadata, observed prices and separately dated portfolio context."""

from datetime import date, datetime
from typing import Literal

from pydantic import Field
from trading_max.reference.indices import IndexBasis, IndexKind, IndexRange, IndexScope, UsageRights

from .models import ApiModel
from .sector_models import SectorBreadth


class IndexIdentity(ApiModel):
    id: str
    scope: IndexScope
    name: str
    name_zh: str
    compiler: str
    compiler_id: str
    symbol: str | None
    currency: str | None
    calendar: str
    basis: IndexBasis
    kind: IndexKind
    history_years: int
    ranges: list[IndexRange]
    rights: UsageRights
    aliases: list[str]
    source: str | None


class IndexPoint(ApiModel):
    at: datetime
    value: float


class IndexQuote(ApiModel):
    index: IndexIdentity
    calendar_known: bool = True
    session_date: str | None = None
    level: float | None = None
    change: float | None = None
    as_of: datetime | None = None
    state: Literal["unavailable", "observed", "live", "closed", "stale"] = "unavailable"
    points: list[IndexPoint] = Field(default_factory=list)


class IndexMarket(ApiModel):
    scope: IndexScope
    quotes: list[IndexQuote]
    refresh_failed: bool = False


GlobalMapMarket = Literal["us", "ca", "uk", "eu", "ch", "jp", "au", "hk", "kr", "tw", "in"]
GlobalRowMarket = Literal["us", "ca", "uk", "eu", "ch", "jp", "au", "hk", "em"]


class GlobalMarketMove(ApiModel):
    market: GlobalMapMarket
    move: float | None
    not_open: bool
    # Share of MSCI ACWI in this market, a fraction; null without dated weights.
    weight: float | None = None


class GlobalContributionRow(ApiModel):
    market: GlobalRowMarket
    index_id: str
    weight: float
    move: float
    contribution: float
    not_open: bool


class GlobalMarketContribution(ApiModel):
    """Moves and contributions are fractions; multiply by 100 for percent or pp."""

    acwi_move: float | None
    acwi_level: float | None
    reference_date: date | None
    phase: Literal["live", "completed"] | None
    as_of: datetime | None
    weights_as_of: date | None
    weights_stale: bool
    prices_stale: bool = False
    markets: list[GlobalMarketMove]
    # Share of MSCI ACWI outside the map's markets, a fraction; null without dated weights.
    other_weight: float | None = None
    rows: list[GlobalContributionRow]
    residual: float | None
    state: Literal["ready", "partial", "unavailable"]


class IndexHistory(ApiModel):
    index: IndexIdentity
    range: IndexRange
    points: list[IndexPoint] = Field(default_factory=list)
    gaps: list[datetime] = Field(default_factory=list)
    max_drawdown: float | None = None
    volatility: float | None = None
    currency: str | None = None
    state: Literal["available", "partial", "unavailable", "stale"] = "unavailable"
    as_of: datetime | None = None
    hourly_close: bool = False


class IndexContribution(ApiModel):
    key: str
    name: str
    weight: float
    contribution: float | None


class IndexBasket(ApiModel):
    fund: str
    holdings_date: str
    session_date: str
    as_of: datetime | None
    coverage: float
    breadth: SectorBreadth
    leaders: list[IndexContribution]
    laggards: list[IndexContribution]
    top_holdings: list[IndexContribution]
    sectors: list[IndexContribution]
    estimated_move: float | None
    residual: float | None
    proxy_universe: str | None = None
    source_url: str | None = None
    prices_source: str = "Yahoo Finance"
    fetched_at: datetime | None = None
    holdings_fetched_at: datetime | None = None


class IndexBreadthPoint(ApiModel):
    date: date
    above_50: float | None = Field(ge=0, le=1)
    above_200: float | None = Field(ge=0, le=1)
    eligible_50: int = Field(ge=0)
    eligible_200: int = Field(ge=0)


class IndexBreadthHistory(ApiModel):
    fund: str
    holdings_url: str
    holdings_as_of: date
    holdings_fetched_at: datetime
    prices_source: str
    prices_fetched_at: datetime = Field(
        description="Latest retrieval of inputs used by this snapshot."
    )
    as_of: date
    calculated_at: datetime
    members: int = Field(gt=0)
    points: list[IndexBreadthPoint]


class IndexVixContext(ApiModel):
    source: str
    as_of: date
    fetched_at: datetime
    sample_start: date
    sample_end: date
    sample_size: int = Field(gt=0)
    close: float = Field(gt=0, allow_inf_nan=False)
    percentile: float = Field(ge=0, le=1)
    p10: float = Field(gt=0, allow_inf_nan=False)
    p90: float = Field(gt=0, allow_inf_nan=False)


class IndexValuationSnapshot(ApiModel):
    """A manually supplied, dated reading, identified by a registered source."""

    source: str
    source_url: str
    basis: Literal["index", "etf"]
    as_of: date
    fetched_at: datetime
    pe: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    forward_pe: float | None = Field(default=None, gt=0, allow_inf_nan=False)


class IndexValuationReference(ApiModel):
    source: str
    source_url: str
    basis: Literal["index", "etf"]


class IndexFundHolding(ApiModel):
    isin: str
    ticker: str
    name: str | None = None
    value_gbp: float
    shares: float | None = None


class IndexContext(ApiModel):
    basket: IndexBasket | None = None
    funds: list[IndexFundHolding] = Field(default_factory=list)
    exposure_gbp: float | None = None
    portfolio_as_of: str | None = None
    breadth_history: IndexBreadthHistory | None = None
    breadth_stale: bool = False
    vix: IndexVixContext | None = None
    vix_stale: bool = False
    valuation: IndexValuationSnapshot | None = None
    valuation_reference: IndexValuationReference | None = None
