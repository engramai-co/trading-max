"""Define shared API, snapshot, job, settings, and analysis models."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> datetime:
    return datetime.now(UTC)


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
    )


JobScope = Literal[
    "all",
    "accounts",
    "research",
    "intraday",
    "cfd",
    "live",
    "performance",
]
JobTrigger = Literal[
    "on_demand",
    "nightly",
    "intraday",
    "live",
    "performance",
    "research",
    "reconciliation",
]
AnalysisPage = Literal[
    "overview",
    "holdings",
    "analytics",
    "research",
    "technical",
    "valuation",
    "fundamentals",
    "analyst",
    "financials",
    "options",
    "ledger",
]
AnalysisLens = Literal[
    "daily_cio_brief",
    "hidden_exposure",
    "return_attribution",
    "watchlist_opportunity_map",
    "technical_regime",
    "valuation_scenario",
    "fundamental_health",
    "analyst_consensus",
    "financial_statements",
    "options_positioning",
    "thesis_change",
]
AnalysisTrigger = Literal["on_demand", "nightly", "snapshot"]


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


class AnalysisStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class ArtifactInfo(ApiModel):
    key: str
    source_path: str
    size_bytes: int
    sha256: str
    media_type: str
    schema_version: int = 1
    kind: str = "artifact"
    data_as_of: str | None = None
    generated_at: datetime | None = None
    source_kind: str | None = None
    model_version: str | None = None
    dependency_hashes: dict[str, str] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class SnapshotManifest(ApiModel):
    schema_version: int = 2
    run_id: str
    created_at: datetime
    scope: JobScope
    source: str
    artifacts: list[ArtifactInfo]


class RefreshRequest(ApiModel):
    scope: JobScope = "all"
    skip_sync: bool = False
    tickers: list[str] = Field(default_factory=list)


class CfdImportFile(ApiModel):
    sha256: str
    filename: str
    imported_at: datetime
    raw_rows: int
    canonical_events: int
    coverage_start_date: str | None = None
    coverage_end_date: str | None = None
    latest_event_at: str | None = None
    warnings: list[str] = Field(default_factory=list)


class CfdImportStatus(ApiModel):
    schema_version: int = 1
    parser_version: str
    files: list[CfdImportFile] = Field(default_factory=list)
    imported_files: int = 0
    total_raw_rows: int = 0
    unique_events: int = 0
    duplicate_events: int = 0
    coverage_start_date: str | None = None
    coverage_end_date: str | None = None
    latest_event_at: str | None = None
    last_imported_at: datetime | None = None
    stale_after_days: int = 14
    is_stale: bool = False
    account_status: Literal["active", "retired"] = "active"
    stale_reminders_enabled: bool = True
    warnings: list[str] = Field(default_factory=list)


class CfdImportResult(ApiModel):
    status: Literal["imported", "duplicate"]
    file: CfdImportFile
    ledger: CfdImportStatus


class JobStageRecord(ApiModel):
    name: str
    label: str
    idempotency_key: str | None = None
    status: StageStatus = StageStatus.QUEUED
    started_at: datetime | None = None
    finished_at: datetime | None = None
    return_code: int | None = None
    error: str | None = None


class JobRecord(ApiModel):
    schema_version: int = 2
    job_id: str
    scope: JobScope
    skip_sync: bool
    trigger: JobTrigger = "on_demand"
    scheduled_for: datetime | None = None
    status: JobStatus
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    snapshot_run_id: str | None = None
    return_code: int | None = None
    error: str | None = None
    tickers: list[str] = Field(default_factory=list)
    stages: list[JobStageRecord] = Field(default_factory=list)


class HealthResponse(ApiModel):
    status: Literal["ok", "degraded"]
    service: str = "trading_max-api"
    latest_run_id: str | None = None
    bootstrap_error: str | None = None
    active_job_id: str | None = None
    write_auth_enabled: bool
    queue: dict[str, Any] = Field(default_factory=dict)
    worker: dict[str, Any] | None = None
    artifact_age_seconds: float | None = None


class ReadinessResponse(ApiModel):
    status: Literal["ready", "degraded", "not_ready"]
    service: str = "trading_max-api"
    latest_run_id: str | None = None
    bootstrap_error: str | None = None
    worker: dict[str, Any] | None = None
    queue: dict[str, Any] = Field(default_factory=dict)


class JobList(ApiModel):
    jobs: list[JobRecord] = Field(default_factory=list)


class NightlySchedule(ApiModel):
    enabled: bool
    timezone: str
    local_time: str
    local_times: list[str] = Field(default_factory=list)
    next_run_at: datetime | None = None
    last_job: JobRecord | None = None


class IntradaySchedule(ApiModel):
    enabled: bool
    timezone: str
    interval_seconds: int
    window_start: str
    window_end: str
    weekdays: list[int] = Field(default_factory=list)
    next_run_at: datetime | None = None
    last_job: JobRecord | None = None
    consecutive_failures: int = 0
    submitted_count: int = 0
    succeeded_count: int = 0
    failed_count: int = 0
    flow_unverified_count: int = 0
    skipped_busy_count: int = 0
    last_error: str | None = None


class PerformanceSchedule(IntradaySchedule):
    material_change_triggered: bool = False


class AlertMonitorState(ApiModel):
    enabled: bool
    phase: str
    held_interval_seconds: int
    watchlist_interval_seconds: int
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    held_updated_at: datetime | None = None
    watchlist_updated_at: datetime | None = None
    quote_count: int = 0
    active_alert_count: int = 0
    last_error: str | None = None


class RefreshState(ApiModel):
    active_job_id: str | None = None
    latest_job: JobRecord | None = None
    latest_full_job: JobRecord | None = None
    latest_intraday_job: JobRecord | None = None
    nightly: NightlySchedule
    intraday: IntradaySchedule
    live: IntradaySchedule
    performance: PerformanceSchedule
    research: NightlySchedule
    alerts: AlertMonitorState


class ResearchArtifactState(ApiModel):
    key: str
    kind: str
    data_as_of: str | None = None
    generated_at: datetime | None = None
    age_days: float | None = None
    freshness: Literal["fresh", "aging", "stale", "unknown"]
    source_kind: str | None = None
    model_version: str | None = None
    warnings: list[str] = Field(default_factory=list)


class ResearchStatus(ApiModel):
    run_id: str
    generated_at: datetime
    overall_freshness: Literal["fresh", "aging", "stale", "unknown"]
    artifacts: list[ResearchArtifactState]


class ResearchInstrument(ApiModel):
    ticker: str
    name: str = ""
    exchange: str = ""
    website: str = ""
    bloomberg_ticker: str = ""
    figi: str = ""
    category_id: str = ""
    research_theme_id: str | None = None
    taxonomy_status: Literal["classifying", "assigned", "needs-review", "unclassified"] = (
        "unclassified"
    )
    taxonomy_label_zh: str | None = None
    taxonomy_label_en: str | None = None
    taxonomy_version: int | None = None
    taxonomy_decision_id: str | None = None
    gics: GicsClassification | None = None
    order: int = 0
    status: Literal["pending", "running", "ready", "partial", "failed"] = "pending"
    last_run_id: str | None = None
    last_error: str | None = None
    has_market: bool = False
    has_technical: bool = False
    has_options: bool = False
    has_valuation: bool = False
    has_earnings: bool = False
    has_fundamentals: bool = False
    held: bool = False
    exposure_gbp: float = 0.0


class ResearchEvent(ApiModel):
    ticker: str
    as_of: str
    event_type: str
    title: str
    summary: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    sources: list[dict[str, str]] = Field(default_factory=list)


class ResearchAlert(ApiModel):
    alert_id: str
    ticker: str
    alert_type: str
    severity: Literal["info", "warning", "critical"]
    title: str
    message: str
    as_of: str | None = None


class ResearchModelRun(ApiModel):
    run_id: str
    generated_at: datetime
    data_as_of: str | None = None
    model_version: str | None = None
    ticker: str
    values: dict[str, Any]
    changes: dict[str, float | str | None] = Field(default_factory=dict)
    dependency_hashes: dict[str, str] = Field(default_factory=dict)


class ResearchTimelinePoint(ApiModel):
    run_id: str
    generated_at: datetime
    data_as_of: str | None = None
    technical: dict[str, Any] | None = None
    valuation: dict[str, Any] | None = None
    options: dict[str, Any] | None = None


class PortfolioImpact(ApiModel):
    ticker: str
    total_value_gbp: float
    direct_value_gbp: float
    indirect_value_gbp: float
    exposure_value_gbp: float
    allocation_pct: float
    held: bool = False
    holding_accounts: list[str] = Field(default_factory=list)
    country: str | None = None
    industry: str | None = None
    etf_contributors: list[dict[str, Any]] = Field(default_factory=list)


class ResearchTickerSnapshot(ApiModel):
    ticker: str
    run_id: str
    generated_at: datetime
    market: dict[str, Any] | None = None
    technical: dict[str, Any] | None = None
    valuation: dict[str, Any] | None = None
    options: dict[str, Any] | None = None
    fundamentals: dict[str, Any] | None = None
    analyst: dict[str, Any] | None = None
    financials: dict[str, Any] | None = None
    latest_event: ResearchEvent | None = None
    portfolio_impact: PortfolioImpact


class ResearchOverview(ApiModel):
    status: ResearchStatus
    watchlist_categories: list[WatchlistCategory] = Field(default_factory=list)
    instruments: list[ResearchInstrument]
    fundamentals: list[dict[str, Any]] = Field(default_factory=list)
    selected: ResearchTickerSnapshot | None = None
    timeline: list[ResearchTimelinePoint] = Field(default_factory=list)
    events: list[ResearchEvent] = Field(default_factory=list)
    models: list[ResearchModelRun] = Field(default_factory=list)
    alerts: list[ResearchAlert] = Field(default_factory=list)


class WatchlistCategory(ApiModel):
    id: str
    label_zh: str
    label_en: str
    description_zh: str = ""
    description_en: str = ""
    order: int = 0
    taxonomy: Literal["gics-sub-industry", "research-theme", "llm-taxonomy"] = "gics-sub-industry"
    code: str | None = None


class GicsClassification(ApiModel):
    sector_code: str
    sector_name: str
    industry_group_code: str
    industry_group_name: str
    industry_code: str
    industry_name: str
    sub_industry_code: str
    sub_industry_name: str
    source: str
    version: str
    as_of: str = ""
    method: Literal["official", "derived", "manual"] = "derived"
    confidence: float = Field(default=1.0, ge=0, le=1)


class WatchlistItem(ApiModel):
    ticker: str
    name: str
    exchange: str
    bloomberg_ticker: str
    figi: str
    composite_figi: str = ""
    share_class_figi: str = ""
    category_id: str = ""
    research_theme_id: str | None = None
    taxonomy_status: Literal["classifying", "assigned", "needs-review", "unclassified"] = (
        "unclassified"
    )
    taxonomy_label_zh: str | None = None
    taxonomy_label_en: str | None = None
    taxonomy_version: int | None = None
    taxonomy_decision_id: str | None = None
    gics: GicsClassification | None = None
    order: int = 0
    status: Literal["pending", "running", "ready", "partial", "failed"] = "pending"
    added_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    last_run_id: str | None = None
    last_error: str | None = None


class WatchlistState(ApiModel):
    schema_version: int = 4
    updated_at: datetime = Field(default_factory=utc_now)
    classification_system: str = "Trading Max LLM taxonomy"
    classification_level: str = "Research theme"
    categories: list[WatchlistCategory] = Field(default_factory=list)
    research_themes: list[WatchlistCategory] = Field(default_factory=list)
    items: list[WatchlistItem] = Field(default_factory=list)


class SecuritySearchResult(ApiModel):
    ticker: str
    name: str
    exchange: str
    bloomberg_ticker: str
    figi: str
    composite_figi: str = ""
    share_class_figi: str = ""
    entity_id: str = ""
    canonical_ticker: str = ""
    gics: GicsClassification | None = None
    resolution_method: str = "unresolved"
    resolution_confidence: float = 0.0
    identity_source: str = "unresolved"
    security_type: str | None = None
    already_watched: bool = False


class SecuritySearchResponse(ApiModel):
    query: str
    source: Literal["openfigi", "watchlist"]
    corrected_query: str | None = None
    results: list[SecuritySearchResult] = Field(default_factory=list)


class WatchlistAddRequest(ApiModel):
    security: SecuritySearchResult
    category_id: str = ""
    refresh: bool = True


class WatchlistMoveRequest(ApiModel):
    category_id: str


class WatchlistMutation(ApiModel):
    item: WatchlistItem | None = None
    job: JobRecord | None = None
    message: str | None = None


class UserProfile(ApiModel):
    profile_id: str = "local"
    display_name: str
    initials: str
    avatar_color: str
    locale: Literal["zh", "en"] = "zh"
    base_currency: str = "GBP"
    timezone: str = "Europe/London"
    account_labels: dict[str, str] = Field(default_factory=dict)
    revision: int = 1
    updated_at: datetime


class UserProfilePatch(ApiModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    initials: str | None = Field(default=None, min_length=1, max_length=4)
    avatar_color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    locale: Literal["zh", "en"] | None = None
    base_currency: str | None = Field(default=None, min_length=3, max_length=3)
    timezone: str | None = Field(default=None, min_length=1, max_length=80)
    account_labels: dict[str, str] | None = None


class AutomationSettings(ApiModel):
    live_enabled: bool
    live_timezone: str
    live_interval_seconds: int
    live_window_start: str
    live_window_end: str
    live_weekdays: list[int] = Field(default_factory=list)
    performance_enabled: bool
    performance_timezone: str
    performance_interval_seconds: int
    research_enabled: bool
    research_timezone: str
    research_local_times: list[str] = Field(default_factory=list)
    daily_reconciliation_local_time: str
    # Compatibility projections for clients predating the three-scope scheduler.
    nightly_enabled: bool
    nightly_timezone: str
    nightly_local_time: str
    nightly_local_times: list[str] = Field(default_factory=list)
    intraday_enabled: bool
    intraday_timezone: str
    intraday_interval_seconds: int
    intraday_window_start: str
    intraday_window_end: str
    intraday_weekdays: list[int] = Field(default_factory=list)
    revision: int = Field(ge=1)
    updated_at: datetime


class AutomationSettingsUpdate(ApiModel):
    live_enabled: bool | None = None
    performance_enabled: bool | None = None
    research_enabled: bool | None = None
    nightly_enabled: bool | None = None
    intraday_enabled: bool | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class CfdAccountPreferenceUpdate(ApiModel):
    account_status: Literal["active", "retired"]


class IntegrationSummary(ApiModel):
    integration_id: str
    provider: Literal["trading212", "deepseek", "openai", "opencode"]
    profile: str | None = None
    enabled: bool = False
    configured: bool = False
    model: str | None = None
    base_url: str | None = None
    credential_fingerprint: str | None = None
    needs_secret: bool = True
    last_test_at: datetime | None = None
    last_test_status: Literal["succeeded", "failed", "untested"] = "untested"
    last_error_code: str | None = None
    revision: int = 1
    updated_at: datetime


class LLMProviderDescriptor(ApiModel):
    provider: Literal["opencode", "deepseek"]
    label: str
    adapter: str
    base_url: str
    models: list[str] = Field(default_factory=list)
    default_model: str


class LLMRoutePolicy(ApiModel):
    default_route: str
    overrides: dict[str, str] = Field(default_factory=dict)
    revision: int = Field(ge=1)
    updated_at: datetime


class LLMRoutePolicyUpdate(ApiModel):
    default_route: str = "opencode/deepseek-v4-flash"
    overrides: dict[str, str] = Field(default_factory=dict)
    expected_revision: int | None = Field(default=None, ge=1)


class LLMIntegrationCandidate(ApiModel):
    api_key: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=100)


class LLMIntegrationRequest(LLMIntegrationCandidate):
    validation_token: str = Field(min_length=1, max_length=2_000)
    enabled: bool = True


class IntegrationOverview(ApiModel):
    deployment_mode: Literal["personal_tailnet", "local_workstation"]
    profile: UserProfile
    integrations: list[IntegrationSummary] = Field(default_factory=list)
    llm_providers: list[LLMProviderDescriptor] = Field(default_factory=list)
    llm_route_policy: LLMRoutePolicy | None = None


class LLMProvidersResponse(ApiModel):
    providers: list[LLMProviderDescriptor] = Field(default_factory=list)
    integrations: list[IntegrationSummary] = Field(default_factory=list)
    route_policy: LLMRoutePolicy


class Trading212IntegrationCandidate(ApiModel):
    api_key_id: str = Field(min_length=1, max_length=200)
    secret_key: str = Field(min_length=1, max_length=500)
    environment: Literal["live", "demo"] = "live"


class Trading212IntegrationRequest(Trading212IntegrationCandidate):
    validation_token: str = Field(min_length=1, max_length=2_000)
    enabled: bool = True


class DeepSeekIntegrationCandidate(ApiModel):
    api_key: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=100)
    base_url: str = Field(default="https://api.deepseek.com", max_length=200)


class DeepSeekIntegrationRequest(DeepSeekIntegrationCandidate):
    validation_token: str = Field(min_length=1, max_length=2_000)
    enabled: bool = True


class IntegrationTestResult(ApiModel):
    integration_id: str
    status: Literal["succeeded", "failed"]
    tested_at: datetime
    message: str
    model: str | None = None
    validation_token: str | None = None


class LocalizedAnalysisText(ApiModel):
    zh: str
    en: str


class AnalysisEvidence(ApiModel):
    label: LocalizedAnalysisText
    detail: LocalizedAnalysisText
    metric: str | None = None
    source_refs: list[str] = Field(default_factory=list)


class TaxonomyAssignment(ApiModel):
    ticker: str
    theme_id: str
    confidence: float = Field(ge=0, le=1)
    rationale: LocalizedAnalysisText | None = None
    create_theme: bool = False
    theme_label_zh: str | None = None
    theme_label_en: str | None = None
    theme_description_zh: str | None = None
    theme_description_en: str | None = None


class AnalysisContent(ApiModel):
    headline: LocalizedAnalysisText
    summary: LocalizedAnalysisText
    evidence: list[AnalysisEvidence] = Field(default_factory=list)
    counterpoints: list[LocalizedAnalysisText] = Field(default_factory=list)
    risks: list[LocalizedAnalysisText] = Field(default_factory=list)
    invalidation_conditions: list[LocalizedAnalysisText] = Field(default_factory=list)
    next_observations: list[LocalizedAnalysisText] = Field(default_factory=list)
    taxonomy_assignments: list[TaxonomyAssignment] = Field(default_factory=list)


class AnalysisArtifact(ApiModel):
    schema_version: int = 1
    artifact_id: str
    analysis_id: AnalysisLens
    page: AnalysisPage
    ticker: str | None = None
    snapshot_run_id: str
    generated_at: datetime
    provider: str
    model: str
    route: str = "fake/trading-max-fake-v1"
    adapter: str = "unknown"
    provider_revision: int | None = Field(default=None, ge=1)
    route_policy_revision: int | None = Field(default=None, ge=1)
    prompt_version: str
    input_hash: str
    confidence: float = Field(ge=0, le=1)
    content: AnalysisContent
    source_refs: list[str] = Field(default_factory=list)
    usage: dict[str, int] = Field(default_factory=dict)
    latency_ms: int = 0
    fake: bool = False


class AnalysisRunRequest(ApiModel):
    lenses: list[AnalysisLens] = Field(default_factory=list)
    # Temporary request-only compatibility for V1 clients deployed before
    # analysis identity moved from routes to logical lenses.
    pages: list[AnalysisPage] = Field(default_factory=list)
    ticker: str | None = None
    force: bool = False


class AnalysisRunRecord(ApiModel):
    schema_version: int = 1
    run_id: str
    snapshot_run_id: str
    trigger: AnalysisTrigger = "on_demand"
    status: AnalysisStatus
    lenses: list[AnalysisLens]
    ticker: str | None = None
    provider: str
    model: str
    route: str = "fake/trading-max-fake-v1"
    adapter: str = "unknown"
    provider_revision: int | None = Field(default=None, ge=1)
    route_policy_revision: int | None = Field(default=None, ge=1)
    force: bool = False
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    artifact_ids: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    cached: bool = False


class AnalysisRunList(ApiModel):
    runs: list[AnalysisRunRecord] = Field(default_factory=list)


class AnalysisStatusResponse(ApiModel):
    provider: str
    model: str
    fake: bool
    latest_run: AnalysisRunRecord | None = None
