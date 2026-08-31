"""Versioned domain contracts for the Trading Max backend.

Transport models in ``services/api`` remain compatible during migration. New
application code must depend on these contracts instead of the old script
output dictionaries.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def utc_now() -> datetime:
    return datetime.now(UTC)


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class DomainModel(BaseModel):
    """Base model with deterministic API-compatible aliases."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class StageStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    INTERRUPTED = "interrupted"


JobScope = Literal[
    "all",
    "accounts",
    "research",
    "intraday",
    "cfd",
    "live",
    "performance",
]


class InstrumentId(DomainModel):
    """Canonical identity for one listed instrument."""

    ticker: str = Field(min_length=1)
    exchange: str = ""
    isin: str = ""
    bloomberg_ticker: str = ""
    figi: str = ""

    @field_validator("ticker", "exchange", "isin", "bloomberg_ticker", "figi")
    @classmethod
    def strip_identity(cls, value: str) -> str:
        return value.strip()


class ArtifactQuality(DomainModel):
    status: Literal["verified", "warning", "unverified", "failed"] = "verified"
    coverage: str | None = None
    warnings: list[str] = Field(default_factory=list)


class ArtifactRef(DomainModel):
    schema_version: int = Field(default=1, ge=1)
    artifact_id: str = Field(min_length=1)
    key: str = Field(min_length=1)
    kind: str = "artifact"
    sha256: str = Field(min_length=1)
    media_type: str = "application/json"
    as_of: str | None = None
    generated_at: datetime = Field(default_factory=utc_now)
    producer_version: str = "unknown"
    dependency_artifact_ids: list[str] = Field(default_factory=list)
    quality: ArtifactQuality = Field(default_factory=ArtifactQuality)


class SnapshotManifest(DomainModel):
    schema_version: int = Field(default=1, ge=1)
    run_id: str = Field(min_length=1)
    created_at: datetime = Field(default_factory=utc_now)
    scope: JobScope
    source: str = Field(min_length=1)
    artifacts: list[ArtifactRef] = Field(default_factory=list)


class Money(DomainModel):
    """A money value whose currency cannot be implicit at a boundary."""

    amount: Decimal
    currency: str = Field(min_length=3, max_length=3)

    @field_validator("currency")
    @classmethod
    def uppercase_currency(cls, value: str) -> str:
        return value.strip().upper()


class ProducedArtifact(DomainModel):
    """Common provenance and quality metadata for calculated artifacts."""

    schema_version: int = Field(default=1, ge=1)
    as_of: str | None = None
    generated_at: datetime = Field(default_factory=utc_now)
    producer_version: str = "unknown"
    source_ids: list[str] = Field(default_factory=list)
    dependency_artifact_ids: list[str] = Field(default_factory=list)
    quality: ArtifactQuality = Field(default_factory=ArtifactQuality)


class AccountPerformance(ProducedArtifact):
    account_code: str = Field(min_length=1)
    twr: float | None = None
    annualized_return: float | None = None
    volatility: float | None = None
    sharpe: float | None = None
    sortino: float | None = None
    max_drawdown: float | None = None
    current_drawdown: float | None = None
    calmar: float | None = None
    information_ratio: float | None = None
    benchmark: str | None = None
    nav_quality: str = "unknown"


class AccountPolicyMetrics(ProducedArtifact):
    account_code: str = Field(min_length=1)
    win_rate: float | None = None
    payoff: float | None = None
    profit_factor: float | None = None
    expectancy: float | None = None
    turnover: float | None = None
    buckets: list[dict[str, Any]] = Field(default_factory=list)


class DilutedCostMetrics(ProducedArtifact):
    account_code: str = Field(min_length=1)
    instrument: InstrumentId
    diluted_cost: Money
    diluted_cost_per_share: Money | None = None
    fx_impact: Money | None = None


class CapitalRecoveryMetrics(ProducedArtifact):
    account_code: str = Field(min_length=1)
    invested: Money
    realised: Money
    unrecovered: Money
    recovery_ratio: float | None = None
    campaigns: list[dict[str, Any]] = Field(default_factory=list)


class PortfolioNavSeries(ProducedArtifact):
    account_code: str = Field(min_length=1)
    currency: str = "GBP"
    points: list[dict[str, Any]] = Field(default_factory=list)


class LookthroughExposure(ProducedArtifact):
    currency: str = "GBP"
    invested_value: Money
    direct_value: Money
    etf_value: Money
    lookthrough_value: Money
    coverage_pct: float = 0.0
    positions: list[dict[str, Any]] = Field(default_factory=list)
    country_allocation: list[dict[str, Any]] = Field(default_factory=list)
    industry_allocation: list[dict[str, Any]] = Field(default_factory=list)


class AllocationBreakdown(ProducedArtifact):
    currency: str = "GBP"
    total_value: Money
    dimensions: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)


class MarketSnapshot(ProducedArtifact):
    instruments: list[InstrumentId] = Field(default_factory=list)
    quotes: list[dict[str, Any]] = Field(default_factory=list)


class TechnicalResearch(ProducedArtifact):
    instrument: InstrumentId
    price: Money | None = None
    indicators: dict[str, Any] = Field(default_factory=dict)
    signals: list[str] = Field(default_factory=list)


class OptionsResearch(ProducedArtifact):
    instrument: InstrumentId
    spot: Money | None = None
    aggregate: dict[str, Any] = Field(default_factory=dict)
    gamma_proxy: dict[str, Any] = Field(default_factory=dict)


class FundamentalResearch(ProducedArtifact):
    instrument: InstrumentId
    metrics: dict[str, Any] = Field(default_factory=dict)


class ValuationResearch(ProducedArtifact):
    instrument: InstrumentId
    currency: str = "USD"
    lenses: dict[str, Any] = Field(default_factory=dict)
    verdict: str = "unknown"


class EarningsResearch(ProducedArtifact):
    instrument: InstrumentId
    fiscal_period: str | None = None
    reported: dict[str, Any] = Field(default_factory=dict)
    sources: list[str] = Field(default_factory=list)


class AdrResearch(ProducedArtifact):
    adr: InstrumentId
    primary: InstrumentId
    ratio: float | None = None
    parity: Money | None = None
    premium_to_parity: float | None = None
    available_sessions: int = 0
    warning: str | None = None


class TaxonomyAssignment(ProducedArtifact):
    instrument: InstrumentId
    taxonomy_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    method: Literal["llm", "manual", "gics"] = "llm"
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    rationale: str | None = None
    manual_override: bool = False


class LlmSynthesis(ProducedArtifact):
    lens: str = Field(min_length=1)
    locale: Literal["zh", "en"] = "zh"
    model: str = Field(min_length=1)
    prompt_version: str = Field(min_length=1)
    input_artifact_ids: list[str] = Field(default_factory=list)
    content: str = ""
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    token_usage: dict[str, int] = Field(default_factory=dict)
    cost_metadata: dict[str, Any] = Field(default_factory=dict)


class JobStageRecord(DomainModel):
    name: str = Field(min_length=1)
    version: str = "1"
    idempotency_key: str | None = None
    label: str = ""
    status: StageStatus = StageStatus.QUEUED
    attempt: int = Field(default=0, ge=0)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    return_code: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    artifact_ids: list[str] = Field(default_factory=list)


class JobRecord(DomainModel):
    schema_version: int = Field(default=1, ge=1)
    job_id: str = Field(min_length=1)
    scope: JobScope
    status: JobStatus = JobStatus.QUEUED
    trigger: Literal[
        "on_demand",
        "nightly",
        "intraday",
        "live",
        "performance",
        "research",
        "reconciliation",
        "system",
    ] = "on_demand"
    skip_sync: bool = False
    tickers: list[str] = Field(default_factory=list)
    attempts: int = Field(default=0, ge=0)
    created_at: datetime = Field(default_factory=utc_now)
    scheduled_for: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    lease_expires_at: datetime | None = None
    log_path: str | None = None
    cancel_requested: bool = False
    snapshot_run_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    stages: list[JobStageRecord] = Field(default_factory=list)
