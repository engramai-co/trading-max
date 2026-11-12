"""Index metadata, observed prices and separately dated portfolio context."""

from datetime import datetime
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
