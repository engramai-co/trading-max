"""Typed fundamentals, valuation, and earnings provider boundaries.

The loaders are injected at the application boundary. The default loader is
deliberately unavailable in offline mode, so a production stage must opt into
an explicitly configured market provider instead of silently fabricating data.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from numbers import Number
from typing import Any

import yfinance as yf
from pydantic import Field

from trading_max.domain import DomainModel

JsonObject = dict[str, Any]
InfoLoader = Callable[[str], Mapping[str, Any]]
CalendarLoader = Callable[[str], Any]
FxLoader = Callable[[str, str], float | None]
AnalystLoader = Callable[[str], Mapping[str, Any]]
FinancialsLoader = Callable[[str], Mapping[str, Any]]

FUNDAMENTAL_KEYS = (
    "longBusinessSummary",
    "quoteType",
    "marketCap",
    "enterpriseValue",
    "trailingPE",
    "forwardPE",
    "priceToSalesTrailing12Months",
    "priceToBook",
    "enterpriseToEbitda",
    "enterpriseToRevenue",
    "pegRatio",
    "profitMargins",
    "grossMargins",
    "operatingMargins",
    "ebitdaMargins",
    "returnOnEquity",
    "returnOnAssets",
    "revenueGrowth",
    "earningsGrowth",
    "earningsQuarterlyGrowth",
    "freeCashflow",
    "operatingCashflow",
    "totalRevenue",
    "netIncomeToCommon",
    "ebitda",
    "totalCash",
    "totalDebt",
    "debtToEquity",
    "currentRatio",
    "quickRatio",
    "beta",
    "sharesOutstanding",
    "floatShares",
    "heldPercentInsiders",
    "heldPercentInstitutions",
    "website",
    "shortRatio",
    "shortPercentOfFloat",
    "dividendYield",
    "payoutRatio",
    "financialCurrency",
    "recommendationMean",
    "recommendationKey",
    "numberOfAnalystOpinions",
    "targetMeanPrice",
    "targetHighPrice",
    "targetLowPrice",
    "targetMedianPrice",
)

# A stable-growth rate must not outrun the economy or the discount rate. V4
# uses a deliberately lower default than the former universal 4% assumption.
DCF_MATURE_GROWTH = 0.03
DCF_MIN_EXIT_MULTIPLE = 8.0
DCF_MAX_EXIT_MULTIPLE = 40.0
RISK_FREE_RATE = 0.043
EQUITY_RISK_PREMIUM = 0.05


@dataclass(frozen=True, slots=True)
class _SectorProfile:
    label: str
    growth_cap: float
    margin_cap: float
    discount: float
    exit_multiple: float
    share_cagr: float
    method: str = "dcf"


def _default_fx(report_currency: str, quote_currency: str) -> float | None:
    if report_currency == quote_currency:
        return 1.0
    try:
        ticker = f"{report_currency}{quote_currency}=X"
        fast = yf.Ticker(ticker).fast_info
        return float(fast["last_price"])
    except Exception:
        return None


class FundamentalsBatch(DomainModel):
    schema_version: int = 1
    artifact_type: str = "fundamentals_research_batch"
    as_of: str
    generated_at: datetime
    tickers: list[str]
    rows: list[JsonObject]
    warnings: list[str] = Field(default_factory=list)


class EarningsBatch(DomainModel):
    schema_version: int = 1
    artifact_type: str = "earnings_research_batch"
    as_of: str
    generated_at: datetime
    tickers: list[str]
    rows: list[JsonObject]
    warnings: list[str] = Field(default_factory=list)


class ValuationBatch(DomainModel):
    schema_version: int = 1
    artifact_type: str = "valuation_research_batch"
    as_of: str
    generated_at: datetime
    tickers: list[str]
    rows: list[JsonObject]
    warnings: list[str] = Field(default_factory=list)


class AnalystBatch(DomainModel):
    schema_version: int = 1
    artifact_type: str = "analyst_research_batch"
    as_of: str
    generated_at: datetime
    tickers: list[str]
    rows: list[JsonObject]
    warnings: list[str] = Field(default_factory=list)


class FinancialsBatch(DomainModel):
    schema_version: int = 1
    artifact_type: str = "financials_research_batch"
    as_of: str
    generated_at: datetime
    tickers: list[str]
    rows: list[JsonObject]
    warnings: list[str] = Field(default_factory=list)


class ResearchDataError(RuntimeError):
    """Raised when a provider cannot produce any usable research rows."""


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Number):
        return float(value)
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "to_dict"):
        return _json_safe(value.to_dict())
    return str(value)


def _default_info(ticker: str) -> Mapping[str, Any]:
    return yf.Ticker(ticker).get_info()


def _default_calendar(ticker: str) -> Any:
    return yf.Ticker(ticker).calendar


def _frame_to_records(frame: Any) -> list[dict[str, Any]]:
    if frame is None or getattr(frame, "empty", True):
        return []
    return _json_safe(frame.reset_index().to_dict(orient="records"))


def _default_analyst(ticker: str) -> Mapping[str, Any]:
    proxy = yf.Ticker(ticker)
    return {
        "priceTargets": _json_safe(dict(proxy.analyst_price_targets or {})),
        "recommendations": _frame_to_records(
            proxy.recommendations_summary
            if proxy.recommendations_summary is not None
            else proxy.recommendations
        ),
        "upgradesDowngrades": _frame_to_records(proxy.upgrades_downgrades)[:100],
        "earningsEstimate": _frame_to_records(proxy.earnings_estimate),
        "revenueEstimate": _frame_to_records(proxy.revenue_estimate),
        "growthEstimates": _frame_to_records(proxy.growth_estimates),
        "earningsHistory": _frame_to_records(proxy.earnings_history),
        "epsTrend": _frame_to_records(proxy.eps_trend),
        "epsRevisions": _frame_to_records(proxy.eps_revisions),
    }


def _default_financials(ticker: str) -> Mapping[str, Any]:
    proxy = yf.Ticker(ticker)
    return {
        "incomeStatement": _frame_to_records(proxy.income_stmt),
        "quarterlyIncomeStatement": _frame_to_records(proxy.quarterly_income_stmt),
        "balanceSheet": _frame_to_records(proxy.balance_sheet),
        "quarterlyBalanceSheet": _frame_to_records(proxy.quarterly_balance_sheet),
        "cashflow": _frame_to_records(proxy.cashflow),
        "quarterlyCashflow": _frame_to_records(proxy.quarterly_cashflow),
    }


class YFinanceResearchService:
    """Normalize provider metadata behind deterministic methods.

    The class name preserves the intended production adapter. Until a live
    provider is explicitly configured, its defaults fail loudly; tests and
    provider smoke runs inject the real loader at construction time.
    """

    def __init__(
        self,
        *,
        info_loader: InfoLoader = _default_info,
        calendar_loader: CalendarLoader = _default_calendar,
        fx_loader: FxLoader = _default_fx,
        analyst_loader: AnalystLoader = _default_analyst,
        financials_loader: FinancialsLoader = _default_financials,
    ) -> None:
        self.info_loader = info_loader
        self.calendar_loader = calendar_loader
        self.fx_loader = fx_loader
        self.analyst_loader = analyst_loader
        self.financials_loader = financials_loader

    def fundamentals(
        self,
        tickers: Sequence[str],
        *,
        as_of: str | None = None,
    ) -> FundamentalsBatch:
        universe = _universe(tickers)
        rows: list[JsonObject] = []
        warnings: list[str] = []
        for ticker in universe:
            try:
                info = dict(self.info_loader(ticker))
                rows.append(
                    {
                        "ticker": ticker,
                        "name": str(info.get("longName") or info.get("shortName") or ticker),
                        "currency": str(info.get("currency") or "USD"),
                        "sector": str(info.get("sector") or ""),
                        "industry": str(info.get("industry") or ""),
                        "metrics": {key: _json_safe(info.get(key)) for key in FUNDAMENTAL_KEYS},
                        "source": "yahoo-finance",
                    }
                )
            except Exception as exc:
                warnings.append(f"{ticker}: fundamentals unavailable ({type(exc).__name__}: {exc})")
        if not rows:
            raise ResearchDataError("fundamentals returned no usable rows")
        return FundamentalsBatch(
            as_of=as_of or datetime.now(UTC).date().isoformat(),
            generated_at=datetime.now(UTC),
            tickers=universe,
            rows=rows,
            warnings=warnings,
        )

    def earnings(
        self,
        tickers: Sequence[str],
        *,
        as_of: str | None = None,
    ) -> EarningsBatch:
        universe = _universe(tickers)
        rows: list[JsonObject] = []
        warnings: list[str] = []
        for ticker in universe:
            try:
                calendar = _json_safe(self.calendar_loader(ticker))
                rows.append(
                    {
                        "ticker": ticker,
                        "calendar": (calendar if isinstance(calendar, dict) else {}),
                        "source": "yahoo-finance-calendar",
                        "source_quality": "secondary-market-data",
                    }
                )
            except Exception as exc:
                warnings.append(f"{ticker}: earnings unavailable ({type(exc).__name__}: {exc})")
        if not rows:
            raise ResearchDataError("earnings returned no usable rows")
        return EarningsBatch(
            as_of=as_of or datetime.now(UTC).date().isoformat(),
            generated_at=datetime.now(UTC),
            tickers=universe,
            rows=rows,
            warnings=warnings,
        )

    def analyst(
        self,
        tickers: Sequence[str],
        *,
        as_of: str | None = None,
    ) -> AnalystBatch:
        universe = _universe(tickers)
        rows: list[JsonObject] = []
        warnings: list[str] = []
        for ticker in universe:
            try:
                payload = dict(self.analyst_loader(ticker))
                rows.append(
                    {
                        "ticker": ticker,
                        "analyst": payload,
                        "source": "yahoo-finance-analyst",
                    }
                )
            except Exception as exc:
                warnings.append(
                    f"{ticker}: analyst consensus unavailable ({type(exc).__name__}: {exc})"
                )
        if not rows:
            raise ResearchDataError("analyst returned no usable rows")
        return AnalystBatch(
            as_of=as_of or datetime.now(UTC).date().isoformat(),
            generated_at=datetime.now(UTC),
            tickers=universe,
            rows=rows,
            warnings=warnings,
        )

    def financials(
        self,
        tickers: Sequence[str],
        *,
        as_of: str | None = None,
    ) -> FinancialsBatch:
        universe = _universe(tickers)
        rows: list[JsonObject] = []
        warnings: list[str] = []
        for ticker in universe:
            try:
                payload = dict(self.financials_loader(ticker))
                rows.append(
                    {
                        "ticker": ticker,
                        "financials": payload,
                        "source": "yahoo-finance-financials",
                    }
                )
            except Exception as exc:
                warnings.append(
                    f"{ticker}: financial statements unavailable ({type(exc).__name__}: {exc})"
                )
        if not rows:
            raise ResearchDataError("financials returned no usable rows")
        return FinancialsBatch(
            as_of=as_of or datetime.now(UTC).date().isoformat(),
            generated_at=datetime.now(UTC),
            tickers=universe,
            rows=rows,
            warnings=warnings,
        )


def build_valuation(
    technical: Mapping[str, Any],
    fundamentals: Mapping[str, Any],
    *,
    assumptions: Mapping[str, Any] | None = None,
    fx_loader: FxLoader | None = None,
) -> ValuationBatch:
    """Calculate evidence-gated scenario valuation lenses.

    Provider ``freeCashflow`` is treated as a levered cash-flow proxy and is
    therefore paired with cost of equity. Exit-multiple scenarios are kept
    separate from their Gordon intrinsic cross-check, analyst targets remain a
    market reference, and unsupported companies return an unavailable lens
    instead of a fabricated point estimate.
    """

    technical_rows = {
        str(row.get("ticker", "")).upper(): row
        for row in technical.get("rows", [])
        if isinstance(row, Mapping)
    }
    fundamental_rows = {
        str(row.get("ticker", "")).upper(): row
        for row in fundamentals.get("rows", [])
        if isinstance(row, Mapping)
    }
    tickers = [str(item).upper() for item in technical.get("tickers", [])]
    rows: list[JsonObject] = []
    warnings = list(fundamentals.get("warnings", []))
    for ticker in tickers:
        tech = technical_rows.get(ticker, {})
        fundamental = fundamental_rows.get(ticker, {})
        metrics = fundamental.get("metrics", {})
        if not isinstance(metrics, Mapping):
            metrics = {}
        lenses = {
            key: _json_safe(metrics.get(key))
            for key in (
                "trailingPE",
                "forwardPE",
                "priceToSalesTrailing12Months",
                "priceToBook",
                "enterpriseToEbitda",
            )
        }
        spot = _number(tech.get("price"))
        total_revenue = _number(metrics.get("totalRevenue"))
        free_cashflow = _number(metrics.get("freeCashflow"))
        shares = _positive_number(metrics.get("sharesOutstanding"))
        market_cap = _positive_number(metrics.get("marketCap"))
        if shares is None and market_cap is not None and spot:
            shares = market_cap / spot
        quote_currency = str(fundamental.get("currency") or "USD")
        report_currency = str(
            metrics.get("financialCurrency")
            or fundamental.get("financialCurrency")
            or quote_currency
        )
        fx_rate: float | None = None
        if report_currency != quote_currency:
            if fx_loader is not None:
                fx_rate = _number(fx_loader(report_currency, quote_currency))
            if fx_rate is None:
                fx_rate = 0.0
        if fx_rate:
            if total_revenue is not None:
                total_revenue *= fx_rate
            if free_cashflow is not None:
                free_cashflow *= fx_rate
        total_revenue = _positive_number(total_revenue)
        free_cashflow = _number(free_cashflow)
        net_debt = _net_debt(metrics, fx_rate=fx_rate)
        sector, profile_label = _sector_profile(
            str(fundamental.get("sector") or ""),
            str(fundamental.get("industry") or metrics.get("industry") or ""),
        )
        cost_of_equity, discount_inputs = _company_cost_of_equity(metrics, sector)
        reported_growth = _number(metrics.get("revenueGrowth"))
        growth_capped = reported_growth is not None and reported_growth > sector.growth_cap
        base_growth = (
            min(max(reported_growth, -0.10), sector.growth_cap)
            if reported_growth is not None
            else None
        )
        current_fcf_margin = (
            free_cashflow / total_revenue
            if free_cashflow is not None and total_revenue is not None and total_revenue > 0
            else None
        )
        margin_normalized = (
            current_fcf_margin is not None and current_fcf_margin > sector.margin_cap
        )
        normalized_margin = sector.margin_cap if margin_normalized else current_fcf_margin
        scenario_overrides = _legacy_scenarios(assumptions, ticker)
        scenario_source = _scenario_assumption_source(assumptions, ticker)
        model_warnings = _valuation_input_warnings(
            spot=spot,
            total_revenue=total_revenue,
            shares=shares,
            base_growth=base_growth,
            fcf_margin=current_fcf_margin,
        )
        if free_cashflow is not None:
            model_warnings.append(
                "provider free cash flow is treated as a levered FCF proxy; "
                "FCFF/WACC valuation requires operating reinvestment inputs"
            )
        if discount_inputs.get("betaCapped"):
            model_warnings.append(
                f"raw beta {discount_inputs['rawBeta']:.2f} was capped at "
                f"{discount_inputs['beta']:.2f} for the discount-rate estimate"
            )
        if growth_capped and sector.method != "analyst":
            model_warnings.append(
                f"reported revenue growth {reported_growth:.0%} capped at "
                f"{sector.growth_cap:.0%} for the base scenario"
            )
        if margin_normalized and sector.method != "analyst":
            model_warnings.append(
                f"current FCF margin {current_fcf_margin:.0%} normalized to "
                f"{sector.margin_cap:.0%} for the base scenario"
            )
        if fx_rate == 0.0 and report_currency != quote_currency:
            model_warnings.append(
                f"FX conversion unavailable ({report_currency} -> {quote_currency})"
            )

        ev5: float | None = None
        ev10: float | None = None
        implied_growth: float | None = None
        implied_growth_bound: str | None = None
        scenarios: dict[str, JsonObject] | None = None
        terminal_check: dict[str, Any] | None = None
        method = "unavailable"
        assumptions_payload: JsonObject = {
            "startingRevenue": total_revenue,
            "netDebt": net_debt,
            "sharesOutstanding": shares,
            "baseRevenueGrowth": base_growth,
            "reportedRevenueGrowth": reported_growth,
            "freeCashflowMargin": current_fcf_margin,
            "normalizedFcfMargin": normalized_margin,
            "discountRate": cost_of_equity,
            "discountRateType": "cost-of-equity",
            "cashFlowType": "levered-free-cash-flow-proxy",
            "matureGrowth": DCF_MATURE_GROWTH,
            "shareCagr": sector.share_cagr,
            "fxRate": fx_rate if fx_rate else None,
            "discountRateInputs": discount_inputs,
            "profile": profile_label,
            "assumptionSource": scenario_source,
        }

        base_inputs_usable = (
            spot is not None
            and total_revenue is not None
            and shares is not None
            and fx_rate != 0.0
            and sector.method != "analyst"
        )
        positive_fcf = current_fcf_margin is not None and current_fcf_margin > 0
        explicit_preprofit_scenarios = not positive_fcf and _complete_scenario_overrides(
            scenario_overrides
        )
        scenario_usable = base_inputs_usable and (positive_fcf or explicit_preprofit_scenarios)
        if scenario_usable:
            start_margin = (
                normalized_margin
                if normalized_margin is not None and normalized_margin > 0
                else 0.0
            )
            method = "levered-fcf-exit-scenarios"
            if not positive_fcf:
                method = "explicit-preprofit-exit-scenarios"
                model_warnings.append(
                    "non-positive FCF; valuation depends on explicit versioned scenario assumptions"
                )
            scenarios = _build_dcf_scenarios(
                revenue=total_revenue,
                shares=shares,
                base_growth=base_growth,
                reported_growth=reported_growth,
                start_margin=start_margin,
                profile=sector,
                wacc=cost_of_equity,
                legacy=scenario_overrides,
            )
            ev5 = scenarios["base"]["value"]
            ev10 = scenarios["base"]["value10"]
            terminal_check = {
                "gordonMultiple": scenarios["base"]["gordonMultiple"],
                "exitMultiple": scenarios["base"]["exitFcfMultiple"],
                "terminalMethod": "exit-fcf-multiple",
                "gordonValue": scenarios["base"]["gordonValue"],
                "gordonValue10": scenarios["base"]["gordonValue10"],
            }
            gordon = terminal_check["gordonMultiple"]
            terminal_check["consistent"] = (
                gordon is not None and abs(terminal_check["exitMultiple"] - gordon) / gordon < 0.5
            )
            if not terminal_check["consistent"]:
                model_warnings.append(
                    "exit-multiple and Gordon terminal methods differ materially; "
                    "treat the result as a scenario range, not a point estimate"
                )
            implied_growth, implied_growth_bound = _implied_growth_v4(
                revenue=total_revenue,
                shares=shares,
                start_margin=start_margin,
                target_margin=scenarios["base"]["targetFcfMargin"],
                discount_rate=scenarios["base"]["discountRate"],
                share_cagr=scenarios["base"]["shareCagr"],
                spot=spot,
                exit_multiple=scenarios["base"]["exitFcfMultiple"],
            )
            assumptions_payload.update(
                {
                    "baseRevenueGrowth": scenarios["base"]["revenueCagr"],
                    "freeCashflowMargin": start_margin,
                    "normalizedFcfMargin": scenarios["base"]["targetFcfMargin"],
                    "discountRate": scenarios["base"]["discountRate"],
                    "exitFreeCashflowMultiple": scenarios["base"]["exitFcfMultiple"],
                    "shareCagr": scenarios["base"]["shareCagr"],
                    "gordonTerminalMultiple": gordon,
                }
            )
            sensitivity = _sensitivity_grid(
                revenue=total_revenue,
                shares=shares,
                start_margin=start_margin,
                target_margin=scenarios["base"]["targetFcfMargin"],
                discount_rate=scenarios["base"]["discountRate"],
                share_cagr=scenarios["base"]["shareCagr"],
                growth=scenarios["base"]["revenueCagr"],
                exit_multiple=scenarios["base"]["exitFcfMultiple"],
            )
        else:
            sensitivity = None
            if sector.method == "analyst":
                model_warnings.append(
                    "automatic cash-flow valuation is not suitable for financial companies; "
                    "residual-income or dividend/FCFE inputs are required"
                )
            elif base_inputs_usable and not positive_fcf:
                model_warnings.append(
                    "non-positive FCF requires explicit survival, financing, and scenario evidence"
                )
            else:
                model_warnings.append("required valuation inputs are unavailable")

        value_range = {name: scenario["value"] for name, scenario in (scenarios or {}).items()}
        value_range10 = {name: scenario["value10"] for name, scenario in (scenarios or {}).items()}
        selected_horizon = 10 if base_growth is not None and base_growth > 0.15 else 5
        model_status = "indicative" if ev5 is not None else "unavailable"
        verdict = _valuation_range_position(
            spot=spot,
            value_range=value_range10 if selected_horizon == 10 else value_range,
            has_model=bool(scenarios),
        )
        assumptions_payload["method"] = method
        assumptions_payload["terminalMethod"] = "exit-fcf-multiple"
        rows.append(
            {
                "ticker": ticker,
                "price": spot,
                "currency": quote_currency,
                "lenses": lenses,
                "ev5": ev5,
                "ev10": ev10,
                "impl": implied_growth,
                "implBound": implied_growth_bound,
                "base_g": base_growth,
                "reported_g": reported_growth,
                "med": _number(metrics.get("targetMedianPrice") or metrics.get("targetMeanPrice")),
                "verdict": verdict,
                "model_status": model_status,
                "model_warnings": model_warnings,
                "assumptions": assumptions_payload,
                "scenarios": scenarios,
                "valueRange": value_range,
                "valueRange10": value_range10,
                "terminalCheck": terminal_check,
                "sensitivity": sensitivity,
                "method": method,
                "valuationPolicy": {
                    "cashFlowType": "levered-free-cash-flow-proxy",
                    "discountRateType": "cost-of-equity",
                    "terminalMethod": "exit-fcf-multiple",
                    "intrinsicCrossCheck": "gordon-growth",
                    "selectedHorizonYears": selected_horizon,
                    "analystTargetsAreReferenceOnly": True,
                    "validationStatus": "not-backtested",
                },
                "source": "trading-max-valuation-v4",
            }
        )
    return ValuationBatch(
        as_of=str(
            technical.get("as_of")
            or fundamentals.get("as_of")
            or datetime.now(UTC).date().isoformat()
        ),
        generated_at=datetime.now(UTC),
        tickers=tickers,
        rows=rows,
        warnings=warnings,
    )


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _positive_number(value: Any) -> float | None:
    number = _number(value)
    return number if number is not None and number > 0 else None


def _net_debt(
    metrics: Mapping[str, Any],
    *,
    fx_rate: float | None = None,
) -> float | None:
    debt = _number(metrics.get("totalDebt"))
    cash = _number(metrics.get("totalCash"))
    if fx_rate:
        if debt is not None:
            debt *= fx_rate
        if cash is not None:
            cash *= fx_rate
    if debt is not None and cash is not None:
        return debt - cash
    return None


def _sector_profile(sector: str, industry: str) -> tuple[_SectorProfile, str]:
    text = f"{sector} {industry}".upper()
    if any(
        token in text
        for token in (
            "SEMICONDUCTOR",
            "CHIP",
            "MEMORY",
            "ELECTRONIC COMPONENTS",
        )
    ):
        return (
            _SectorProfile(
                "semiconductors",
                growth_cap=0.35,
                margin_cap=0.22,
                discount=0.115,
                exit_multiple=18.0,
                share_cagr=0.01,
            ),
            "semiconductor",
        )
    if any(
        token in text
        for token in (
            "SOFTWARE",
            "INTERNET CONTENT",
            "APPLICATION SOFTWARE",
            "DATA INFRASTRUCTURE",
        )
    ):
        return (
            _SectorProfile(
                "software",
                growth_cap=0.40,
                margin_cap=0.30,
                discount=0.105,
                exit_multiple=25.0,
                share_cagr=0.015,
            ),
            "software",
        )
    if any(
        token in text
        for token in (
            "COMMUNICATION EQUIPMENT",
            "COMPUTER HARDWARE",
            "ELECTRONIC MANUFACTURING",
            "TECHNOLOGY HARDWARE",
        )
    ):
        return (
            _SectorProfile(
                "hardware",
                growth_cap=0.30,
                margin_cap=0.18,
                discount=0.11,
                exit_multiple=16.0,
                share_cagr=0.01,
            ),
            "hardware",
        )
    if any(
        token in text
        for token in (
            "ELECTRICAL EQUIPMENT",
            "SPECIALTY INDUSTRIAL",
            "POWER",
            "ENGINEERING & CONSTRUCTION",
        )
    ):
        return (
            _SectorProfile(
                "power-industrial",
                growth_cap=0.40,
                margin_cap=0.20,
                discount=0.10,
                exit_multiple=20.0,
                share_cagr=0.005,
            ),
            "power",
        )
    if any(
        token in text
        for token in (
            "CAPITAL MARKETS",
            "BANKS",
            "ASSET MANAGEMENT",
            "FINANCIAL SERVICES",
        )
    ):
        return (
            _SectorProfile(
                "financial",
                growth_cap=0.20,
                margin_cap=0.15,
                discount=0.12,
                exit_multiple=12.0,
                share_cagr=0.005,
                method="analyst",
            ),
            "financial",
        )
    if any(token in text for token in ("CONSUMER", "RETAIL", "ENTERTAINMENT", "MEDIA")):
        return (
            _SectorProfile(
                "consumer-internet",
                growth_cap=0.35,
                margin_cap=0.28,
                discount=0.11,
                exit_multiple=22.0,
                share_cagr=0.01,
            ),
            "consumer",
        )
    return (
        _SectorProfile(
            "default",
            growth_cap=0.35,
            margin_cap=0.25,
            discount=0.12,
            exit_multiple=18.0,
            share_cagr=0.01,
        ),
        "default",
    )


def _company_cost_of_equity(
    metrics: Mapping[str, Any],
    profile: _SectorProfile,
) -> tuple[float, dict[str, Any]]:
    raw_beta = _number(metrics.get("beta"))
    beta = min(max(raw_beta, 0.6), 2.5) if raw_beta is not None else None
    market_cap = _positive_number(metrics.get("marketCap"))
    size_premium = 0.0
    if market_cap is not None:
        if market_cap < 2_000_000_000:
            size_premium = 0.02
        elif market_cap < 10_000_000_000:
            size_premium = 0.01
    cost_equity = (
        RISK_FREE_RATE + beta * EQUITY_RISK_PREMIUM + size_premium
        if beta is not None
        else profile.discount
    )
    cost_equity = min(max(cost_equity, 0.07), 0.22)
    return cost_equity, {
        "kind": "cost-of-equity",
        "rawBeta": raw_beta,
        "beta": beta,
        "betaCapped": raw_beta is not None and beta != raw_beta,
        "riskFreeRate": RISK_FREE_RATE,
        "equityRiskPremium": EQUITY_RISK_PREMIUM,
        "sizePremium": size_premium,
        "costEquity": cost_equity,
        "source": "capm-proxy" if beta is not None else "sector-default",
    }


def _legacy_scenarios(
    assumptions: Mapping[str, Any] | None,
    ticker: str,
) -> dict[str, Mapping[str, Any]] | None:
    if not assumptions:
        return None
    for company in assumptions.get("companies") or []:
        if not isinstance(company, Mapping):
            continue
        if str(company.get("ticker", "")).upper() != ticker:
            continue
        scenarios = company.get("scenarios")
        if not isinstance(scenarios, Mapping):
            return None
        return {
            name: scenario for name, scenario in scenarios.items() if isinstance(scenario, Mapping)
        }
    return None


def _scenario_assumption_source(
    assumptions: Mapping[str, Any] | None,
    ticker: str,
) -> str:
    if not assumptions:
        return "sector-template"
    for company in assumptions.get("companies") or []:
        if not isinstance(company, Mapping):
            continue
        if str(company.get("ticker", "")).upper() == ticker:
            return str(company.get("source") or "legacy-manual")
    return "sector-template"


def _complete_scenario_overrides(
    scenarios: dict[str, Mapping[str, Any]] | None,
) -> bool:
    if not scenarios:
        return False
    required_aliases = (
        ("revenue_cagr", "revenueCagr"),
        ("target_fcf_margin", "targetFcfMargin"),
        ("discount_rate", "discountRate"),
        ("exit_fcf_multiple", "exitFcfMultiple"),
        ("share_cagr", "shareCagr"),
    )
    for name in ("bear", "base", "bull"):
        scenario = scenarios.get(name)
        if not scenario:
            return False
        for aliases in required_aliases:
            if not any(_number(scenario.get(alias)) is not None for alias in aliases):
                return False
    return True


def _scenario_params(
    name: str,
    *,
    base_growth: float | None,
    reported_growth: float | None,
    start_margin: float | None,
    profile: _SectorProfile,
    wacc: float,
    legacy: dict[str, Mapping[str, Any]] | None,
) -> dict[str, float]:
    over = (legacy or {}).get(name) or {}

    def number(value: Any) -> float | None:
        return _number(value)

    def pick(*names: str) -> float | None:
        for field in names:
            value = over.get(field)
            if value is not None:
                return number(value)
        return None

    if name == "bear":
        growth = pick("revenue_cagr", "revenueCagr")
        if growth is None:
            growth = max((base_growth if base_growth is not None else 0.10) - 0.08, -0.10)
        margin = pick("target_fcf_margin", "targetFcfMargin")
        if margin is None:
            margin = max(
                (start_margin if start_margin is not None else profile.margin_cap * 0.6) - 0.05,
                0.03,
            )
        discount = pick("discount_rate", "discountRate")
        if discount is None:
            discount = min(wacc + 0.02, 0.18)
        exit_multiple = pick("exit_fcf_multiple", "exitFcfMultiple")
        if exit_multiple is None:
            exit_multiple = max(profile.exit_multiple * 0.75, DCF_MIN_EXIT_MULTIPLE)
        share_cagr = pick("share_cagr", "shareCagr")
        if share_cagr is None:
            share_cagr = profile.share_cagr + 0.005
    elif name == "bull":
        growth = pick("revenue_cagr", "revenueCagr")
        if growth is None:
            growth = min(
                max(reported_growth or base_growth or 0.15, 0.15),
                0.70,
            )
        margin = pick("target_fcf_margin", "targetFcfMargin")
        if margin is None:
            margin = min(
                (start_margin if start_margin is not None else profile.margin_cap * 0.75) + 0.06,
                profile.margin_cap + 0.10,
            )
        discount = pick("discount_rate", "discountRate")
        if discount is None:
            discount = max(wacc - 0.02, 0.07)
        exit_multiple = pick("exit_fcf_multiple", "exitFcfMultiple")
        if exit_multiple is None:
            exit_multiple = min(profile.exit_multiple * 1.25, DCF_MAX_EXIT_MULTIPLE)
        share_cagr = pick("share_cagr", "shareCagr")
        if share_cagr is None:
            share_cagr = max(profile.share_cagr - 0.005, 0.0)
    else:
        growth = pick("revenue_cagr", "revenueCagr")
        if growth is None:
            growth = base_growth if base_growth is not None else profile.growth_cap * 0.5
        margin = pick("target_fcf_margin", "targetFcfMargin")
        if margin is None:
            margin = start_margin if start_margin is not None else profile.margin_cap * 0.7
        discount = pick("discount_rate", "discountRate")
        if discount is None:
            discount = wacc
        exit_multiple = pick("exit_fcf_multiple", "exitFcfMultiple")
        if exit_multiple is None:
            exit_multiple = min(profile.exit_multiple, DCF_MAX_EXIT_MULTIPLE)
        share_cagr = pick("share_cagr", "shareCagr")
        if share_cagr is None:
            share_cagr = profile.share_cagr
    return {
        "growth": growth,
        "margin": margin,
        "discount": discount,
        "exitMultiple": exit_multiple,
        "shareCagr": share_cagr,
    }


def _growth_for_year(initial_growth: float, year: int, years: int) -> float:
    if years <= 5 or year <= 5:
        return initial_growth
    fade = (year - 5) / (years - 5)
    return initial_growth + (DCF_MATURE_GROWTH - initial_growth) * fade


def _levered_cashflow_value_per_share_v4(
    *,
    revenue: float,
    shares: float,
    growth: float,
    start_margin: float,
    target_margin: float,
    discount_rate: float,
    share_cagr: float,
    years: int,
    exit_multiple: float | None = None,
) -> float:
    projected_revenue = revenue
    present_value = 0.0
    for year in range(1, years + 1):
        projected_revenue *= 1 + _growth_for_year(growth, year, years)
        ramp = min(year / 3.0, 1.0)
        margin = start_margin + (target_margin - start_margin) * ramp
        fcf = projected_revenue * margin
        shares_y = shares * (1 + share_cagr) ** year
        present_value += fcf / shares_y / (1 + discount_rate) ** year
    fcf_terminal = projected_revenue * target_margin
    shares_terminal = shares * (1 + share_cagr) ** years
    if exit_multiple is not None:
        terminal_per_share = fcf_terminal * exit_multiple / shares_terminal
    elif discount_rate > DCF_MATURE_GROWTH:
        terminal_per_share = (
            fcf_terminal
            * (1 + DCF_MATURE_GROWTH)
            / (discount_rate - DCF_MATURE_GROWTH)
            / shares_terminal
        )
    else:
        terminal_per_share = 0.0
    # Provider free cash flow is a levered/equity cash-flow proxy. Subtracting
    # net debt here would mix an enterprise-value bridge into an equity model.
    value = present_value + terminal_per_share / (1 + discount_rate) ** years
    return max(value, 0.0)


def _build_dcf_scenarios(
    *,
    revenue: float,
    shares: float,
    base_growth: float | None,
    reported_growth: float | None,
    start_margin: float,
    profile: _SectorProfile,
    wacc: float,
    legacy: dict[str, Mapping[str, Any]] | None,
) -> dict[str, JsonObject]:
    scenarios: dict[str, JsonObject] = {}
    for name in ("bear", "base", "bull"):
        params = _scenario_params(
            name,
            base_growth=base_growth,
            reported_growth=reported_growth,
            start_margin=start_margin,
            profile=profile,
            wacc=wacc,
            legacy=legacy,
        )
        value5 = _levered_cashflow_value_per_share_v4(
            revenue=revenue,
            shares=shares,
            growth=params["growth"],
            start_margin=start_margin,
            target_margin=params["margin"],
            discount_rate=params["discount"],
            share_cagr=params["shareCagr"],
            years=5,
            exit_multiple=params["exitMultiple"],
        )
        value10 = _levered_cashflow_value_per_share_v4(
            revenue=revenue,
            shares=shares,
            growth=params["growth"],
            start_margin=start_margin,
            target_margin=params["margin"],
            discount_rate=params["discount"],
            share_cagr=params["shareCagr"],
            years=10,
            exit_multiple=params["exitMultiple"],
        )
        intrinsic5 = _levered_cashflow_value_per_share_v4(
            revenue=revenue,
            shares=shares,
            growth=params["growth"],
            start_margin=start_margin,
            target_margin=params["margin"],
            discount_rate=params["discount"],
            share_cagr=params["shareCagr"],
            years=5,
        )
        intrinsic10 = _levered_cashflow_value_per_share_v4(
            revenue=revenue,
            shares=shares,
            growth=params["growth"],
            start_margin=start_margin,
            target_margin=params["margin"],
            discount_rate=params["discount"],
            share_cagr=params["shareCagr"],
            years=10,
        )
        gordon = (
            1.0 / (params["discount"] - DCF_MATURE_GROWTH)
            if params["discount"] > DCF_MATURE_GROWTH
            else None
        )
        scenarios[name] = {
            "value": value5,
            "value10": value10,
            "revenueCagr": params["growth"],
            "targetFcfMargin": params["margin"],
            "discountRate": params["discount"],
            "exitFcfMultiple": params["exitMultiple"],
            "shareCagr": params["shareCagr"],
            "gordonMultiple": gordon,
            "terminalMethod": "exit-fcf-multiple",
            "gordonValue": intrinsic5,
            "gordonValue10": intrinsic10,
            "terminalValueRange": {
                "low": min(value5, intrinsic5),
                "high": max(value5, intrinsic5),
            },
            "terminalValueRange10": {
                "low": min(value10, intrinsic10),
                "high": max(value10, intrinsic10),
            },
        }
    return scenarios


def _sensitivity_grid(
    *,
    revenue: float,
    shares: float,
    start_margin: float,
    target_margin: float,
    discount_rate: float,
    share_cagr: float,
    growth: float,
    exit_multiple: float,
) -> dict[str, JsonObject]:
    def value(
        *,
        growth_delta: float = 0.0,
        margin_delta: float = 0.0,
        discount_delta: float = 0.0,
    ) -> float:
        return _levered_cashflow_value_per_share_v4(
            revenue=revenue,
            shares=shares,
            growth=growth + growth_delta,
            start_margin=start_margin,
            target_margin=max(target_margin + margin_delta, 0.0),
            discount_rate=discount_rate + discount_delta,
            share_cagr=share_cagr,
            years=5,
            exit_multiple=exit_multiple,
        )

    return {
        "discountRate": {
            "deltas": [-0.02, -0.01, 0.0, 0.01, 0.02],
            "values": [value(discount_delta=delta) for delta in (-0.02, -0.01, 0.0, 0.01, 0.02)],
        },
        "revenueGrowth": {
            "deltas": [-0.10, -0.05, 0.0, 0.05, 0.10],
            "values": [value(growth_delta=delta) for delta in (-0.10, -0.05, 0.0, 0.05, 0.10)],
        },
        "fcfMargin": {
            "deltas": [-0.05, -0.02, 0.0, 0.02, 0.05],
            "values": [value(margin_delta=delta) for delta in (-0.05, -0.02, 0.0, 0.02, 0.05)],
        },
    }


def _implied_growth_v4(
    *,
    revenue: float,
    shares: float,
    start_margin: float,
    target_margin: float,
    discount_rate: float,
    share_cagr: float,
    spot: float,
    exit_multiple: float,
) -> tuple[float | None, str | None]:
    low, high = -0.30, 0.80

    def value(growth: float) -> float:
        return _levered_cashflow_value_per_share_v4(
            revenue=revenue,
            shares=shares,
            growth=growth,
            start_margin=start_margin,
            target_margin=target_margin,
            discount_rate=discount_rate,
            share_cagr=share_cagr,
            years=5,
            exit_multiple=exit_multiple,
        )

    if value(high) < spot:
        return None, "above-80%"
    if value(low) > spot:
        return -0.99, "below--30%"
    for _ in range(80):
        midpoint = (low + high) / 2
        if value(midpoint) < spot:
            low = midpoint
        else:
            high = midpoint
    return (low + high) / 2, None


def _valuation_input_warnings(
    *,
    spot: float | None,
    total_revenue: float | None,
    shares: float | None,
    base_growth: float | None,
    fcf_margin: float | None,
) -> list[str]:
    values = {
        "spot price": spot,
        "total revenue": total_revenue,
        "shares outstanding": shares,
        "revenue growth": base_growth,
        "free cash-flow margin": fcf_margin,
    }
    return [f"missing {label}" for label, value in values.items() if value is None]


def _valuation_range_position(
    *,
    spot: float | None,
    value_range: dict[str, float],
    has_model: bool,
) -> str:
    if not has_model or not value_range:
        return "not-covered"
    bear = value_range.get("bear")
    base = value_range.get("base")
    bull = value_range.get("bull")
    if bear is None or base is None or bull is None or spot is None:
        return "not-covered"
    if spot < bear:
        return "below-model-range"
    if spot <= bull:
        return "within-model-range"
    return "above-model-range"


def _universe(tickers: Sequence[str]) -> list[str]:
    result = list(dict.fromkeys(item.strip().upper() for item in tickers if item.strip()))
    if not result:
        raise ResearchDataError("research requires a non-empty ticker universe")
    return result


__all__ = [
    "AnalystBatch",
    "EarningsBatch",
    "FinancialsBatch",
    "FundamentalsBatch",
    "ResearchDataError",
    "ValuationBatch",
    "YFinanceResearchService",
    "build_valuation",
]
