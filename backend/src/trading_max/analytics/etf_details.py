"""Separate, potentially large ETF evidence; never part of the overview response."""

from pydantic import Field

from trading_max.analytics.etf_projection import ETFMatch, ETFReading
from trading_max.analytics.lookthrough import FundSnapshot
from trading_max.domain.contracts import DomainModel


class ETFDetail(DomainModel):
    run_id: str = ""
    reading: ETFReading
    holdings: FundSnapshot | None = None
    matches: list[ETFMatch] = Field(default_factory=list)


def etf_detail_key(isin: str) -> str:
    return f"account/etfs/{isin}.json"


def etf_holdings_key(isin: str) -> str:
    return f"account/etf_holdings/{isin}.json"
