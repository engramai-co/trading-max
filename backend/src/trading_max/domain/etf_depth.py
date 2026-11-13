"""Published, point-in-time evidence for the ETF research desk."""

from datetime import date, datetime
from typing import Literal

from trading_max.domain.contracts import DomainModel
from trading_max.domain.etf import FundEvidence

HMRC_REPORTING_KEY = "reference/hmrc_reporting_funds.json"
ETF_PEERS_KEY = "research/etf_peers.json"


class ReportingPeriod(DomainModel):
    effective_from: date
    ceased_on: date | None = None


class ReportingRegister(DomainModel):
    source_url: str
    attachment_url: str
    publication_date: date
    fetched_at: datetime
    parser_version: str
    periods: dict[str, list[ReportingPeriod]]


class UKReportingFund(DomainModel):
    state: Literal["reporting", "ceased", "effective-later", "not-listed", "unavailable"]
    publication_date: date | None = None
    effective_from: date | None = None
    ceased_on: date | None = None
    evidence: FundEvidence | None = None
