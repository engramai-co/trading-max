"""Define typed response contracts for dashboard and research lenses."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import ConfigDict, Field, model_validator

from .models import (
    ApiModel,
    CfdImportStatus,
    GicsClassification,
    PortfolioImpact,
    ResearchAlert,
    ResearchEvent,
    ResearchModelRun,
    ResearchStatus,
    ResearchTimelinePoint,
    WatchlistCategory,
)

InvestableAccountCode = Literal["A", "B"]
AccountCode = Literal["A", "B", "C"]
ResearchLensName = Literal[
    "overview",
    "technical",
    "valuation",
    "fundamentals",
    "analyst",
    "options",
    "ledger",
]
DashboardLensName = Literal[
    "overview",
    "holdings-positions",
    "holdings-lookthrough",
    "analytics",
    "review",
    "account-analysis",
]


class AccountSummary(ApiModel):
    code: AccountCode
    name: str
    profile: str
    as_of: str
    total_value_gbp: float
    cash_gbp: float
    invested_gbp: float
    total_cost_gbp: float
    realized_pnl_gbp: float
    unrealized_pnl_gbp: float
    net_external_flows_gbp: float
    capital_delta_gbp: float
    twr: float | None
    daily_return: float | None
    account_type: Literal["investable", "cfd-imported"]
    is_investable: bool
    nav_quality: str


class CfdSummary(ApiModel):
    code: Literal["C"]
    name: str
    profile: str
    as_of: str
    ending_value_gbp: float
    net_external_flows_gbp: float
    realized_pnl_gbp: float
    reconciliation_gap_gbp: float
    reconciliation_status: str
    closed_positions: int
    overnight_charges_gbp: float
    closed_gross_pnl_gbp: float | None = None
    fx_fees_gbp: float | None = None
    closed_after_fx_pnl_gbp: float | None = None
    dividend_adjustments_gbp: float | None = None
    net_realised_pnl_gbp: float | None = None
    financing_to_gross_ratio: float | None = None
    financing_to_net_ratio: float | None = None
    pnl_sharpe_proxy: float | None
    max_drawdown_gbp: float
    nav_quality: str
    true_nav_available: bool
    source: str
    warning: str
    imported_files: int = 0
    last_imported_at: str | None = None
    coverage_start_date: str | None = None
    coverage_end_date: str | None = None
    latest_event_at: str | None = None
    stale_after_days: int
    is_stale: bool
    account_status: Literal["active", "retired"] = "active"
    stale_reminders_enabled: bool = True


class CfdCashFlows(ApiModel):
    deposits: float
    withdrawals: float
    internal_transfers: float
    adjustments: float
    account_cash_flow: float
    household_external_flow: float


class CfdRealisedPnl(ApiModel):
    closed_gross_result: float
    fx_fees: float
    closed_after_fx: float
    overnight_interest: float
    dividend_adjustment: float
    net_realised_pnl: float
    financing_drag_to_gross_ratio: float | None = None
    financing_drag_to_net_ratio: float | None = None
    max_realised_pnl_drawdown: float


class CfdTradeQuality(ApiModel):
    trade_count: int
    wins: int
    losses: int
    breakeven: int
    win_rate: float | None = None
    average_win: float | None = None
    average_loss: float | None = None
    payoff_ratio: float | None = None
    profit_factor: float | None = None
    expectancy: float | None = None
    average_duration_hours: float | None = None
    median_duration_hours: float | None = None
    same_day_count: int
    under_one_hour_count: int
    best_trade: float | None = None
    worst_trade: float | None = None
    longest_win_streak: int
    longest_loss_streak: int
    best_trade_concentration: float | None = None
    top_three_trade_concentration: float | None = None
    net_without_best_trade: float | None = None


class CfdAttributionBucket(ApiModel):
    key: str
    trade_count: int
    net_realised_pnl: float


class CfdAttribution(ApiModel):
    by_direction: list[CfdAttributionBucket] = Field(default_factory=list)
    by_instrument: list[CfdAttributionBucket] = Field(default_factory=list)
    by_duration: list[CfdAttributionBucket] = Field(default_factory=list)
    by_date: list[CfdAttributionBucket] = Field(default_factory=list)
    by_weekday: list[CfdAttributionBucket] = Field(default_factory=list)


class CfdRealisedPoint(ApiModel):
    occurred_at: str
    event_id: str
    record_type: str
    realised_pnl_change: float
    cumulative_realised_pnl: float
    account_cash_flow_change: float
    cumulative_account_cash_flow: float
    realised_cash_equity_proxy: float
    realised_pnl_drawdown: float


class CfdNotional(ApiModel):
    total_closed_notional: float
    average_closed_notional: float | None = None
    net_realised_to_notional_ratio: float | None = None
    financing_cost_to_notional_ratio: float | None = None
    missing_notional_trade_count: int


class CfdUnmatchedOrder(ApiModel):
    event_id: str
    order_id: str | None = None
    position_id: str | None = None
    occurred_at: str
    symbol: str | None = None
    direction: str | None = None
    intent: str | None = None


class CfdReviewCoverage(ApiModel):
    status: Literal["available", "partial", "unavailable"]
    unavailable_reason: str | None = None
    currency: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    raw_row_count: int
    event_count: int
    duplicate_event_count: int
    imported_file_count: int
    parser_version: str


class CfdMoneyOutcome(ApiModel):
    status: Literal["available", "partial", "unavailable"]
    unavailable_reason: str | None = None
    source: Literal["realised_cash_equity_proxy"]
    opening_realised_cash_equity_proxy_gbp: float
    ending_realised_cash_equity_proxy_gbp: float
    deposits_gbp: float
    withdrawals_gbp: float
    internal_transfers_gbp: float
    adjustments_gbp: float
    account_cash_flow_gbp: float
    household_external_flow_gbp: float
    net_realised_pnl_gbp: float
    max_realised_pnl_drawdown_gbp: float
    current_realised_pnl_drawdown_gbp: float
    true_nav_available: bool


class CfdStrategyRisk(ApiModel):
    status: Literal["unavailable"]
    unavailable_reason: str
    true_nav_available: bool
    twr_total_return: float | None = None
    sharpe: float | None = None
    sortino: float | None = None
    calmar: float | None = None
    information_ratio: float | None = None
    annualized_volatility: float | None = None
    max_drawdown_rate: float | None = None
    current_drawdown_rate: float | None = None


class CfdPhaseEvidence(ApiModel):
    type: str
    occurred_at: str
    amount_gbp: float
    detail: str


class CfdPhaseContributor(ApiModel):
    key: str
    event_count: int
    realised_pnl: float


class CfdPhase(ApiModel):
    phase_id: str
    classification: str
    start_date: str
    end_date: str
    opening_realised_cash_equity_proxy_gbp: float
    ending_realised_cash_equity_proxy_gbp: float
    account_cash_flow_gbp: float
    household_external_flow_gbp: float
    realised_pnl_gbp: float
    max_realised_pnl_drawdown_gbp: float
    ending_realised_pnl_drawdown_gbp: float
    top_contributors: list[CfdPhaseContributor] = Field(default_factory=list)
    top_detractors: list[CfdPhaseContributor] = Field(default_factory=list)
    evidence_events: list[CfdPhaseEvidence] = Field(default_factory=list)


class CfdPhases(ApiModel):
    status: Literal["available", "unavailable"]
    unavailable_reason: str | None = None
    method: str
    method_version: str
    items: list[CfdPhase] = Field(default_factory=list)


class CfdStructuralDiagnostics(ApiModel):
    status: Literal["available", "partial", "unavailable"]
    unavailable_reason: str | None = None
    observable_only: bool
    psychology_inferred: bool
    total_closed_notional: float
    average_closed_notional: float | None = None
    net_realised_to_notional_ratio: float | None = None
    financing_cost_to_notional_ratio: float | None = None
    best_trade_concentration: float | None = None
    top_three_trade_concentration: float | None = None
    net_without_best_trade: float | None = None
    by_direction: list[CfdAttributionBucket] = Field(default_factory=list)
    missing_notional_trade_count: int


class CfdEndingRisk(ApiModel):
    status: Literal["unavailable"]
    unavailable_reason: str
    true_mtm_available: bool
    unmatched_executed_order_count: int
    warnings: list[str] = Field(default_factory=list)


class CfdAccountReview(ApiModel):
    currency: str | None = None
    event_count: int
    coverage_start: str | None = None
    coverage_end: str | None = None
    coverage: CfdReviewCoverage
    money_outcome: CfdMoneyOutcome
    strategy_risk: CfdStrategyRisk
    phases: CfdPhases
    cash_flows: CfdCashFlows
    realised_pnl: CfdRealisedPnl
    trade_quality: CfdTradeQuality
    attribution: CfdAttribution
    realised_series: list[CfdRealisedPoint] = Field(default_factory=list)
    notional: CfdNotional
    structural_diagnostics: CfdStructuralDiagnostics
    ending_risk: CfdEndingRisk
    unmatched_executed_orders: list[CfdUnmatchedOrder] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    calculation_version: str
    import_status: CfdImportStatus


class AccountAnalysisMetrics(ApiModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="allow",
    )

    account: AccountCode
    name: str
    account_type: Literal["investable", "cfd-imported"] = Field(alias="accountType")
    metric_quality: str = Field(alias="metricQuality")
    start: str | None = None
    end: str | None = None
    buy_orders: float | None = None
    sell_orders: float | None = None
    turnover: float | None = None
    gross_result: float | None = None
    trade_fees: float | None = None
    cash_income: float | None = None
    period_net: float | None = None
    win_rate: float | None = None
    avg_win: float | None = None
    avg_loss: float | None = None
    payoff: float | None = None
    break_even_win_rate: float | None = None
    win_rate_margin: float | None = None
    profit_factor: float | None = None
    expectancy: float | None = None
    median_hold: float | None = None
    winner_hold: float | None = None
    loser_hold: float | None = None
    vol: float | None = None
    sharpe: float | None = None
    sortino: float | None = None
    max_dd: float | None = None
    trades: float | None = None
    net: float | None = None
    closed_before_overnight: float | None = None
    overnight: float | None = None
    net_flow: float | None = None
    median_hold_h: float | None = None
    winner_hold_h: float | None = None
    loser_hold_h: float | None = None
    same_day: float | None = None
    under_1h: float | None = None
    total_notional: float | None = None
    median_notional: float | None = None
    max_notional: float | None = None
    pnl_sharpe: float | None = None
    max_dd_gbp: float | None = None
    best_trade_share: float | None = None
    net_without_best: float | None = None
    risk_note: str = Field(alias="riskNote")


ReviewAvailability = Literal["available", "partial", "unavailable"]


class ReviewSection(ApiModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="allow",
    )

    status: ReviewAvailability
    unavailable_reason: str | None = None


class ReviewMoneyOutcome(ReviewSection):
    source: str | None = None
    opening_value_gbp: float | None = None
    ending_value_gbp: float | None = None
    deposits_gbp: float | None = None
    withdrawals_gbp: float | None = None
    net_external_flows_gbp: float | None = None
    net_pnl_gbp: float | None = None
    net_pnl_rate: float | None = None
    capital_base_gbp: float | None = None
    max_pnl_drawdown_gbp: float | None = None
    current_pnl_drawdown_gbp: float | None = None
    observations: int | None = None


class ReviewStrategyMetrics(ApiModel):
    model_config = ConfigDict(
        alias_generator=lambda value: value,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="allow",
    )

    periods: int | None = None
    twr_total_return: float | None = None
    annualized_return: float | None = None
    annualized_volatility: float | None = None
    sharpe_sonia: float | None = None
    sortino_sonia: float | None = None
    calmar_ratio: float | None = None
    information_ratio: float | None = None
    max_drawdown: float | None = None
    current_drawdown: float | None = None
    benchmark_ticker: str | None = None
    nav_quality: str | None = None
    metric_unavailable_reasons: dict[str, str] = Field(default_factory=dict)


class ReviewStrategyRisk(ReviewSection):
    source: str | None = None
    metrics: ReviewStrategyMetrics | None = None


class ReviewEvidence(ApiModel):
    type: str
    date: str
    amount_gbp: float | None = None
    detail: str = ""


class ReviewAttributionBucket(ApiModel):
    label: str
    trade_count: int = 0
    net_result_gbp: float = 0.0
    gross_wins_gbp: float = 0.0
    gross_losses_gbp: float = 0.0
    fees_gbp: float = 0.0
    share_of_absolute_result: float | None = None
    share_of_net_result: float | None = None


class ReviewPhase(ApiModel):
    phase_id: str
    classification: str
    start_date: str
    end_date: str
    opening_value_gbp: float
    ending_value_gbp: float
    net_external_flows_gbp: float
    net_pnl_gbp: float
    max_pnl_drawdown_gbp: float
    ending_pnl_drawdown_gbp: float
    top_contributors: list[ReviewAttributionBucket] = Field(default_factory=list)
    top_detractors: list[ReviewAttributionBucket] = Field(default_factory=list)
    evidence_events: list[ReviewEvidence] = Field(default_factory=list)


class ReviewPhases(ReviewSection):
    method: str | None = None
    method_version: str | None = None
    items: list[ReviewPhase] = Field(default_factory=list)


class ReviewTrade(ApiModel):
    ticker: str
    name: str
    start: str | None = None
    end: str | None = None
    duration_days: float = 0.0
    holding_bucket: str
    direction: str
    buy_orders: int = 0
    sell_orders: int = 0
    buy_notional_gbp: float = 0.0
    sell_notional_gbp: float = 0.0
    gross_result_gbp: float = 0.0
    fees_gbp: float = 0.0
    net_result_gbp: float = 0.0


class ReviewCounterfactual(ApiModel):
    remove_top_n: int
    removed_trade_count: int
    removed_result_gbp: float
    remaining_net_result_gbp: float
    remaining_profitable: bool


class ReviewTradeQuality(ReviewSection):
    scope: str | None = None
    trade_count: int = 0
    win_count: int = 0
    loss_count: int = 0
    win_rate: float | None = None
    average_win_gbp: float | None = None
    average_loss_gbp: float | None = None
    payoff_ratio: float | None = None
    profit_factor: float | None = None
    expectancy_gbp: float | None = None
    net_result_gbp: float | None = None
    gross_wins_gbp: float | None = None
    gross_losses_gbp: float | None = None
    average_holding_days: float | None = None
    median_holding_days: float | None = None
    same_day_count: int = 0
    short_holding_count: int = 0
    long_holding_count: int = 0
    longest_winning_streak: int = 0
    longest_losing_streak: int = 0
    left_tail_loss_p10_gbp: float | None = None
    best_trade: ReviewTrade | None = None
    worst_trade: ReviewTrade | None = None
    best_trades: list[ReviewTrade] = Field(default_factory=list)
    worst_trades: list[ReviewTrade] = Field(default_factory=list)
    best_trade_share_of_gross_wins: float | None = None
    top_n_counterfactuals: list[ReviewCounterfactual] = Field(default_factory=list)


class ReviewBuckets(ReviewSection):
    buckets: list[ReviewAttributionBucket] = Field(default_factory=list)


class ReviewCalendar(ReviewSection):
    year: list[ReviewAttributionBucket] = Field(default_factory=list)
    month: list[ReviewAttributionBucket] = Field(default_factory=list)
    weekday: list[ReviewAttributionBucket] = Field(default_factory=list)


class ReviewAttribution(ReviewSection):
    scope: str | None = None
    realised_net_result_gbp: float | None = None
    by_instrument: ReviewBuckets
    by_industry: ReviewBuckets
    by_country: ReviewBuckets
    by_direction: ReviewBuckets
    by_holding_bucket: ReviewBuckets
    by_calendar: ReviewCalendar
    components: ReviewSection
    conservation: dict[str, float] = Field(default_factory=dict)


class ReviewStructuralDiagnostics(ReviewSection):
    observable_only: bool = True
    psychology_inferred: bool = False
    gross_traded_notional_gbp: float | None = None
    buy_orders: int | None = None
    sell_orders: int | None = None
    average_active_positions_at_trade_events: float | None = None
    peak_active_positions_at_trade_events: int | None = None
    drawdown_buy_notional_gbp: float | None = None
    observations: list[dict[str, Any]] = Field(default_factory=list)
    partial_reasons: list[str] = Field(default_factory=list)


class ReviewHolding(ApiModel):
    ticker: str
    name: str
    quantity: float | None = None
    current_value_gbp: float
    total_cost_gbp: float | None = None
    unrealized_pnl_gbp: float | None = None
    weight: float | None = None


class ReviewEndingRisk(ReviewSection):
    position_count: int = 0
    invested_value_gbp: float | None = None
    account_value_gbp: float | None = None
    cash_gbp: float | None = None
    cash_weight: float | None = None
    unrealized_pnl_gbp: float | None = None
    holdings: list[ReviewHolding] = Field(default_factory=list)
    concentration: ReviewSection
    exposures: dict[str, ReviewSection] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class ReviewCoverage(ReviewSection):
    currency: str
    start_date: str | None = None
    end_date: str | None = None
    transaction_count: int = 0
    closed_campaign_count: int = 0
    nav_observation_count: int = 0
    ending_holding_count: int = 0
    inputs: dict[str, ReviewSection] = Field(default_factory=dict)
    quality: dict[str, Any] = Field(default_factory=dict)
    provenance: dict[str, Any] = Field(default_factory=dict)


class AccountReview(ApiModel):
    schema_version: int
    calculation_version: str
    account: dict[str, str]
    coverage: ReviewCoverage
    money_outcome: ReviewMoneyOutcome
    strategy_risk: ReviewStrategyRisk
    phases: ReviewPhases
    realised_trade_quality: ReviewTradeQuality
    attribution: ReviewAttribution
    structural_diagnostics: ReviewStructuralDiagnostics
    ending_risk: ReviewEndingRisk
    warnings: list[str] = Field(default_factory=list)


class OverviewReviewSummary(ApiModel):
    """Compact historical evidence for the Overview review entry."""

    account: AccountCode
    name: str
    coverage_start: str | None = None
    coverage_end: str | None = None
    max_pnl_drawdown_gbp: float | None = None
    net_pnl_gbp: float | None = None
    net_pnl_rate: float | None = None
    event_count: int = 0
    phase_count: int = 0


class AccountReportData(ApiModel):
    realized: dict[str, Any]
    policy: dict[str, Any]
    nav: dict[AccountCode, dict[str, Any]]
    analysis: dict[AccountCode, dict[str, Any]]
    capital_recovery: dict[str, Any] | None


class Holding(ApiModel):
    account: InvestableAccountCode
    ticker: str
    name: str
    quantity: float
    current_price: float
    diluted_cost_gbp: float | None
    diluted_cost_per_share_gbp: float | None
    diluted_cost_per_share_native: float | None
    diluted_cost_currency: str
    snapshot_fx_rate_native_per_gbp: float | None
    fx_impact_gbp: float | None
    price_currency: str
    current_value_gbp: float
    cost_gbp: float
    pnl_gbp: float
    pnl_pct: float
    allocation_pct: float


class NavPoint(ApiModel):
    date: str
    intraday: bool = False
    flow_status: Literal["daily_official", "verified", "unverified"]
    invest: float | None
    isa: float | None
    cfd: float | None
    total: float | None
    household: float | None
    invest_net_contributions_gbp: float | None = None
    isa_net_contributions_gbp: float | None = None
    total_net_contributions_gbp: float | None = None
    cfd_net_contributions_gbp: float | None = None
    household_net_contributions_gbp: float | None = None
    household_internal_transfer_counterflow_gbp: float | None = None
    household_unmatched_internal_transfer_gbp: float | None = None
    household_transfer_match_status: Literal["verified", "partial"] | None = None
    invest_net_pnl_gbp: float | None = None
    isa_net_pnl_gbp: float | None = None
    total_net_pnl_gbp: float | None = None
    cfd_net_pnl_gbp: float | None = None
    household_net_pnl_gbp: float | None = None
    invest_pnl_drawdown_gbp: float | None = None
    isa_pnl_drawdown_gbp: float | None = None
    total_pnl_drawdown_gbp: float | None = None
    cfd_pnl_drawdown_gbp: float | None = None
    household_pnl_drawdown_gbp: float | None = None
    cfd_overnight_interest_gbp: float | None = None
    cfd_net_realised_pnl_gbp: float | None = None
    invest_twr: float | None
    isa_twr: float | None
    total_twr: float | None
    invest_drawdown: float | None
    isa_drawdown: float | None
    total_drawdown: float | None
    cfd_proxy_drawdown: float | None


class RiskMetrics(ApiModel):
    sharpe: float | None
    sortino: float | None
    calmar: float | None
    information_ratio: float | None
    volatility: float | None
    max_drawdown: float | None
    current_drawdown: float | None
    benchmark_return: float | None
    twr: float | None
    annualized_return: float | None
    benchmark: str


class HistoryCoverage(ApiModel):
    requested_period: str
    available_sessions: int
    first_session: str
    last_session: str
    complete: bool
    warning: str | None


class AdrResearch(ApiModel):
    security_type: Literal["ADR"]
    adr_ticker: str
    primary_ticker: str
    depositary: str
    ordinary_shares_per_adr: float
    adr_per_ordinary_share: float
    adr_spot_usd: float
    primary_spot: float
    primary_currency: str
    fx_local_per_usd: float
    parity_usd: float
    premium_to_parity: float
    available_sessions: int
    first_trade_session: str
    average_volume20d: float
    average_dollar_volume20d: float
    arbitrage_assumption: Literal["none"]
    warning: str
    ratio_source: str


class PriceSeriesPoint(ApiModel):
    date: str
    open: float | None
    high: float | None
    low: float | None
    close: float
    volume: float | None
    sma20: float | None
    sma50: float | None
    sma200: float | None


class ResearchTradeMarker(ApiModel):
    ticker: str
    date: str
    kind: Literal["B", "S", "T"]
    accounts: list[Literal["invest", "isa"]]
    buy_orders: int
    sell_orders: int
    buy_quantity: float
    sell_quantity: float
    buy_average_price: float | None
    sell_average_price: float | None


class BenchmarkPricePoint(ApiModel):
    date: str
    close: float


class ResearchPriceSeries(ApiModel):
    ticker: str
    as_of: str
    currency: str
    available_sessions: int
    points: list[PriceSeriesPoint]
    trade_markers: list[ResearchTradeMarker] = Field(default_factory=list)


class TechnicalRow(ApiModel):
    ticker: str
    as_of: str
    currency: str
    history_coverage: HistoryCoverage
    adr_research: AdrResearch | None
    price: float
    score: float
    state: str
    rsi: float | None
    macd: float | None
    macd_signal: float | None
    macd_histogram: float | None
    sma20: float | None
    sma50: float | None
    sma200: float | None
    support20: float | None
    resistance20: float | None
    drawdown52w: float | None
    return20d: float | None
    return63d: float | None
    atr_pct: float | None
    signals: list[str]


class GammaPoint(ApiModel):
    spot: float
    net_gex: float


class OptionExpirySnapshot(ApiModel):
    expiry: str
    days_to_expiry: int | None = None
    call_open_interest: float | None = None
    put_open_interest: float | None = None
    put_call_oi_ratio: float | None = None
    call_volume: float | None = None
    put_volume: float | None = None
    call_iv: float | None = None
    put_iv: float | None = None
    call_wall: float | None = None
    put_wall: float | None = None
    max_pain: float | None = None


class OptionContractSnapshot(ApiModel):
    expiry: str
    side: Literal["call", "put"]
    contract_symbol: str | None = None
    strike: float
    last_price: float | None = None
    bid: float | None = None
    ask: float | None = None
    open_interest: float | None = None
    volume: float | None = None
    implied_volatility: float | None = None
    in_the_money: bool = False


class OptionSnapshot(ApiModel):
    ticker: str
    spot: float
    expiry_count: int
    captured_at: str
    put_call_oi_ratio: float | None
    call_wall: float | None
    put_wall: float | None
    max_pain: float | None
    net_gex: float | None
    gamma_regime: str | None
    gamma_flip: float | None
    gamma_profile: list[GammaPoint]
    expiries: list[OptionExpirySnapshot] = Field(default_factory=list)
    contracts: list[OptionContractSnapshot] = Field(default_factory=list)


class ValuationScenario(ApiModel):
    value: float | None = None
    value10: float | None = None
    revenue_cagr: float | None = None
    target_fcf_margin: float | None = None
    discount_rate: float | None = None
    exit_fcf_multiple: float | None = None
    share_cagr: float | None = None
    gordon_multiple: float | None = None


class TerminalCheck(ApiModel):
    gordon_multiple: float | None = None
    exit_multiple: float | None = None
    consistent: bool = False


class SensitivityAxis(ApiModel):
    deltas: list[float]
    values: list[float]


class ValuationSensitivity(ApiModel):
    discount_rate: SensitivityAxis
    revenue_growth: SensitivityAxis
    fcf_margin: SensitivityAxis


class ValuationRow(ApiModel):
    ticker: str
    as_of: str
    currency: str
    spot: float
    ev5: float | None
    ev10: float | None
    analyst_median: float | None
    implied_growth: float | None
    base_growth: float | None
    verdict: str
    trailing_pe: float | None
    forward_pe: float | None
    price_to_sales: float | None
    price_to_book: float | None
    enterprise_to_ebitda: float | None
    ev5_upside: float | None
    ev10_upside: float | None
    model_status: str
    model_warnings: list[str]
    method: str
    reported_growth: float | None
    implied_growth_bound: str | None
    value_range: dict[str, float | None]
    value_range10: dict[str, float | None]
    scenarios: dict[str, ValuationScenario]
    terminal_check: TerminalCheck
    sensitivity: ValuationSensitivity | None


class ResearchDirectoryInstrument(ApiModel):
    """Lightweight security metadata used before a research lens is opened."""

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
    # Capability flags are intentionally unknown in the lightweight shell.
    # They remain false until a scoped lens is requested.
    has_market: bool = False
    has_technical: bool = False
    has_options: bool = False
    has_valuation: bool = False
    has_earnings: bool = False
    has_fundamentals: bool = False
    held: bool = False
    exposure_gbp: float = 0.0


class ResearchShell(ApiModel):
    """Small, stable payload required to render the research workbench shell."""

    status: ResearchStatus
    watchlist_categories: list[WatchlistCategory] = Field(default_factory=list)
    instruments: list[ResearchDirectoryInstrument] = Field(default_factory=list)


class ResearchLensSnapshot(ApiModel):
    """Data for one research lens only.

    The workbench intentionally does not preload every lens.  Optional fields
    are populated according to ``view`` and keep the response contract typed
    without shipping unrelated artifacts to the browser.
    """

    ticker: str
    view: ResearchLensName
    run_id: str
    generated_at: str
    market: dict[str, Any] | None = None
    technical: TechnicalRow | None = None
    valuation: ValuationRow | None = None
    options: OptionSnapshot | None = None
    fundamentals: dict[str, Any] | None = None
    analyst: dict[str, Any] | None = None
    financials: dict[str, Any] | None = None
    latest_event: ResearchEvent | None = None
    portfolio_impact: PortfolioImpact | None = None
    timeline: list[ResearchTimelinePoint] = Field(default_factory=list)
    events: list[ResearchEvent] = Field(default_factory=list)
    models: list[ResearchModelRun] = Field(default_factory=list)
    alerts: list[ResearchAlert] = Field(default_factory=list)


class LookthroughCountry(ApiModel):
    country: str
    value_gbp: float
    allocation_pct: float
    is_non_country: bool


class LookthroughIndustry(ApiModel):
    industry: str
    value_gbp: float
    allocation_pct: float
    is_non_industry: bool


class LookthroughGicsSubIndustry(ApiModel):
    sub_industry_code: str | None
    sub_industry: str
    value_gbp: float
    allocation_pct: float
    is_non_gics: bool
    classification_status: Literal[
        "classified",
        "pending-identity",
        "pending-classification",
        "not-applicable",
    ] = "classified"

    @model_validator(mode="before")
    @classmethod
    def infer_legacy_status(cls, value: Any) -> Any:
        if not isinstance(value, dict) or (
            "classificationStatus" in value or "classification_status" in value
        ):
            return value
        copy = dict(value)
        code = copy.get("subIndustryCode") or copy.get("sub_industry_code")
        copy["classificationStatus"] = "classified" if code else "pending-classification"
        return copy


class LookthroughContributor(ApiModel):
    ticker: str
    value_gbp: float


class LookthroughPosition(ApiModel):
    entity_id: str = ""
    isin: str | None
    ticker: str | None
    name: str
    country: str | None
    resolution_method: Literal[
        "isin",
        "figi",
        "share-class-figi",
        "composite-figi",
        "ticker",
        "name",
        "unresolved",
    ] = "unresolved"
    resolution_confidence: float = 0.0
    identity_source: str = "legacy"
    security_type: str = "UNKNOWN"
    gics_status: Literal[
        "classified",
        "pending-identity",
        "pending-classification",
        "not-applicable",
    ] = "pending-identity"
    gics: GicsClassification | None = None
    value_gbp: float
    allocation_pct: float
    direct_value_gbp: float
    indirect_value_gbp: float
    etf_contributors: list[LookthroughContributor]


class LookthroughSource(ApiModel):
    ticker: str
    status: Literal["verified", "unavailable"] | None = None
    isin: str | None = None
    name: str | None = None
    issuer: str
    source_url: str
    as_of: str
    industry_as_of: str | None = None
    holdings_count: int
    weight_total_pct: float
    position_value_gbp: float


class LookthroughData(ApiModel):
    available: bool
    generated_at: str | None
    broker_as_of: str | None
    invested_value_gbp: float
    cash_value_gbp: float
    direct_value_gbp: float
    etf_value_gbp: float
    lookthrough_value_gbp: float
    non_security_value_gbp: float
    lookthrough_coverage_pct: float
    underlying_count: int
    country_basis: str
    country_allocation: list[LookthroughCountry]
    industry_basis: str
    industry_allocation: list[LookthroughIndustry]
    gics_sub_industry_basis: str
    gics_coverage_pct: float
    gics_portfolio_coverage_pct: float = 0.0
    gics_eligible_value_gbp: float = 0.0
    gics_classified_value_gbp: float = 0.0
    gics_pending_value_gbp: float = 0.0
    gics_not_applicable_value_gbp: float = 0.0
    gics_sub_industry_allocation: list[LookthroughGicsSubIndustry]
    positions: list[LookthroughPosition]
    sources: list[LookthroughSource]


class IsaBucket(ApiModel):
    bucket: str
    realized_net: float
    turnover: float
    compliance: float


class PolicySummary(ApiModel):
    win_rate: float
    payoff: float
    profit_factor: float
    expectancy: float
    isa_buckets: list[IsaBucket]


class DashboardLensSnapshot(ApiModel):
    """A page-scoped dashboard payload.

    Dashboard routes render a stable shell first and request exactly one lens.
    Optional fields are populated only when the selected interface needs them,
    preventing account history, look-through data, and research tables from
    being shipped to unrelated pages.
    """

    view: DashboardLensName
    run_id: str
    generated_at: str
    broker_as_of: str
    research_as_of: str
    total_value_gbp: float | None = None
    household_total_value_gbp: float | None = None
    total_cash_gbp: float | None = None
    total_invested_gbp: float | None = None
    total_unrealized_pnl_gbp: float | None = None
    latest_model_day_return: float | None = None
    accounts: list[AccountSummary] = Field(default_factory=list)
    selected_account: AccountSummary | None = None
    selected_account_analysis: AccountAnalysisMetrics | None = None
    selected_account_review: AccountReview | None = None
    selected_cfd_review: CfdAccountReview | None = None
    selected_account_report: dict[str, Any] | None = None
    selected_risk: RiskMetrics | None = None
    cfd: CfdSummary | None = None
    cfd_review: CfdAccountReview | None = None
    review_summaries: list[OverviewReviewSummary] = Field(default_factory=list)
    holdings: list[Holding] = Field(default_factory=list)
    nav: list[NavPoint] = Field(default_factory=list)
    intraday_nav: list[NavPoint] = Field(default_factory=list)
    risk: dict[InvestableAccountCode, RiskMetrics] = Field(default_factory=dict)
    benchmark_series: dict[str, list[BenchmarkPricePoint]] = Field(default_factory=dict)
    technical: list[TechnicalRow] = Field(default_factory=list)
    valuations: list[ValuationRow] = Field(default_factory=list)
    lookthrough: LookthroughData | None = None
    policy: PolicySummary | None = None


class DashboardResponse(ApiModel):
    generated_at: str
    broker_as_of: str
    research_as_of: str
    total_value_gbp: float
    household_total_value_gbp: float
    total_cash_gbp: float
    total_invested_gbp: float
    total_unrealized_pnl_gbp: float
    latest_model_day_return: float | None
    accounts: list[AccountSummary]
    account_analysis: dict[AccountCode, AccountAnalysisMetrics]
    account_reviews: dict[InvestableAccountCode, AccountReview] = Field(default_factory=dict)
    account_report: AccountReportData
    cfd: CfdSummary | None
    cfd_review: CfdAccountReview | None = None
    holdings: list[Holding]
    nav: list[NavPoint]
    intraday_nav: list[NavPoint]
    risk: dict[InvestableAccountCode, RiskMetrics]
    benchmark_series: dict[str, list[BenchmarkPricePoint]] = Field(default_factory=dict)
    technical: list[TechnicalRow]
    options: list[OptionSnapshot]
    valuations: list[ValuationRow]
    lookthrough: LookthroughData
    policy: PolicySummary
