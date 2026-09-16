"""Financial observations, period identity and research capability contracts.

These functions are pure projections of stored provider evidence. They never
fetch, repair with guessed values, or mutate the immutable source artifact.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
from datetime import UTC, date, datetime
from itertools import pairwise
from typing import Any, Literal

from pydantic import Field

from trading_max.domain import DomainModel

DataState = Literal["available", "missing", "notApplicable", "unsupported", "stale", "invalid"]


class EvidenceRef(DomainModel):
    source: str
    field: str
    version: str
    url: str | None = None
    published_at: str | None = None
    accession: str | None = None


class FinancialPeriod(DomainModel):
    id: str
    kind: Literal["annual", "quarterly", "ttm", "semiannual", "irregular"]
    label: str
    fiscal_year: int | None = None
    fiscal_quarter: int | None = None
    fiscal_half: int | None = None
    provider_end: str
    actual_end: str | None = None
    actual_start: str | None = None
    components: list[str] = Field(default_factory=list)
    identity_status: Literal["reported", "provider", "derived"] = "provider"


class MetricObservation(DomainModel):
    id: str
    metric: str
    value: float | None
    unit: Literal["currency", "perShare", "shares", "ratio"] = "currency"
    currency: str | None = None
    period_id: str
    basis: str
    state: DataState
    reason: str | None = None
    evidence: list[EvidenceRef] = Field(default_factory=list)
    formula: str | None = None
    formula_version: str = "financial-facts-v1"


class FinancialFacts(DomainModel):
    version: str
    currency: str | None
    periods: list[FinancialPeriod] = Field(default_factory=list)
    observations: list[MetricObservation] = Field(default_factory=list)
    latest_ttm: str | None = None
    reconciliation: dict[str, Any] = Field(default_factory=dict)


class QuoteSnapshot(DomainModel):
    id: str
    ticker: str
    price: float | None
    currency: str | None
    quote_unit: str | None
    reporting_currency: str | None = None
    fund_base_currency: str | None = None
    exchange: str | None = None
    timezone: str | None = None
    as_of: str | None = None
    session: str = "unknown"
    change: float | None = None
    change_pct: float | None = None
    delay_minutes: int | None = None
    source: str = "yahoo-finance"


class DatasetClock(DomainModel):
    dataset: str
    last_attempt_at: str | None = None
    as_of: str | None = None
    fetched_at: str | None = None
    last_successful_at: str | None = None
    state: DataState = "missing"
    reason: str | None = None
    version: str | None = None


class ResearchCapability(DomainModel):
    task: str
    state: DataState
    reason: str | None = None
    intervals: list[str] = Field(default_factory=list)
    first_period: str | None = None
    last_period: str | None = None


class ResearchContext(DomainModel):
    quote: QuoteSnapshot
    asset_type: str
    capabilities: list[ResearchCapability] = Field(default_factory=list)
    datasets: list[DatasetClock] = Field(default_factory=list)


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:20]


STATEMENTS = {"income": "IncomeStatement", "balance": "BalanceSheet", "cash": "Cashflow"}
METRICS: dict[str, tuple[str, ...]] = {
    "revenue": ("Total Revenue", "Operating Revenue"),
    "costOfRevenue": ("Cost Of Revenue", "Reconciled Cost Of Revenue"),
    "grossProfit": ("Gross Profit",),
    "operatingExpense": ("Operating Expense",),
    "operatingIncome": ("Operating Income",),
    "pretaxIncome": ("Pretax Income",),
    "tax": ("Tax Provision",),
    "netIncome": ("Net Income", "Net Income Common Stockholders"),
    "eps": ("Diluted EPS", "Basic EPS"),
    "operatingCashflow": ("Operating Cash Flow", "Cash Flow From Continuing Operating Activities"),
    "capex": ("Capital Expenditure", "Capital Expenditure Reported"),
    "cash": ("Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"),
    "debt": ("Total Debt",),
    "equity": ("Stockholders Equity", "Common Stock Equity"),
    "tangibleEquity": ("Net Tangible Assets",),
    "assets": ("Total Assets",),
    "buybacks": ("Repurchase Of Capital Stock", "Common Stock Payments"),
    "dividends": ("Cash Dividends Paid", "Common Stock Dividend Paid"),
    "shareCount": ("Ordinary Shares Number", "Share Issued"),
    "dilutedShares": ("Diluted Average Shares",),
}
STOCK_METRICS = {"cash", "debt", "equity", "tangibleEquity", "assets", "shareCount"}


def _end(value: Any) -> str | None:
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        return None


def _fiscal_end_month(metrics: Mapping[str, Any], annual_dates: list[str]) -> int | None:
    raw = number(metrics.get("lastFiscalYearEnd"))
    if raw:
        return datetime.fromtimestamp(raw, UTC).month
    return int(annual_dates[-1][5:7]) if annual_dates else None


def build_financial_facts(
    raw: Mapping[str, Any],
    metrics: Mapping[str, Any],
    *,
    source_version: str | None = None,
    period_evidence: list[dict[str, Any]] | None = None,
) -> FinancialFacts:
    version = source_version or fingerprint(raw)
    currency = str(metrics.get("financialCurrency") or "") or None
    columns: dict[tuple[str, str], dict[str, tuple[float, str]]] = {}
    for kind in ("annual", "quarterly"):
        for suffix in STATEMENTS.values():
            key = suffix[0].lower() + suffix[1:] if kind == "annual" else "quarterly" + suffix
            for row in raw.get(key) or []:
                if not isinstance(row, Mapping):
                    continue
                field = str(row.get("index") or row.get("Breakdown") or "")
                for label, value in row.items():
                    end, n = _end(label), number(value)
                    if end and n is not None:
                        values = columns.setdefault((kind, end), {})
                        # A duplicate non-identical field is not silently accepted.
                        if field in values and values[field][0] != n:
                            values[field] = (float("nan"), key + "." + field)
                        else:
                            values[field] = (n, key + "." + field)
    annual_dates = sorted(end for kind, end in columns if kind == "annual")
    fiscal_month = _fiscal_end_month(metrics, annual_dates)
    facts = FinancialFacts(version=version, currency=currency)
    values_by_period: dict[str, dict[str, MetricObservation]] = {}
    for (kind, end), values in sorted(columns.items(), reverse=True):
        # Empty historic columns must not become empty screen-sized table columns.
        if not any(name in values for names in METRICS.values() for name in names):
            continue
        month = int(end[5:7])
        year = int(end[:4]) + int(fiscal_month is not None and month > fiscal_month)
        quarter = ((month - fiscal_month - 1) % 12) // 3 + 1 if fiscal_month else None
        matched = next(
            (
                p
                for p in period_evidence or []
                if p.get("providerEnd") == end and p.get("providerKind", p.get("kind")) == kind
            ),
            {},
        )
        year = matched.get("fiscalYear") or year
        quarter = matched.get("fiscalQuarter") or quarter
        kind = matched.get("kind") or kind
        period_id = kind + ":" + end
        half = (quarter + 1) // 2 if quarter and kind == "semiannual" else None
        label = (
            f"FY{year}"
            if kind == "annual"
            else f"H{half} FY{year}"
            if half
            else (
                f"{matched.get('actualStart')} → {matched.get('actualEnd')}"
                if kind == "irregular"
                else f"Q{quarter} FY{year}"
                if quarter
                else end[:7]
            )
        )
        period = FinancialPeriod(
            id=period_id,
            kind=kind,
            label=label,
            fiscal_year=year,
            fiscal_quarter=quarter if kind == "quarterly" else None,
            fiscal_half=half,
            provider_end=end,
            actual_end=matched.get("actualEnd"),
            actual_start=matched.get("actualStart"),
            identity_status="reported" if matched.get("actualEnd") else "provider",
        )
        facts.periods.append(period)
        observations: dict[str, MetricObservation] = {}
        for metric, fields in METRICS.items():
            found = next((values[field] for field in fields if field in values), None)
            value = number(found[0]) if found else None
            if value is not None and metric in {"capex", "buybacks", "dividends"}:
                value = -abs(value)
            unit = (
                "perShare"
                if metric == "eps"
                else "shares"
                if metric in {"shareCount", "dilutedShares"}
                else "currency"
            )
            observations[metric] = MetricObservation(
                id=fingerprint([version, period_id, metric]),
                metric=metric,
                value=value,
                unit=unit,
                currency=currency if unit != "shares" else None,
                period_id=period_id,
                basis="reported-statement",
                state="available" if value is not None else "invalid" if found else "missing",
                reason=None
                if value is not None
                else "conflicting-source-rows"
                if found
                else "not-reported",
                evidence=[
                    EvidenceRef(
                        source="yahoo-finance-financials",
                        field=found[1],
                        version=version,
                        url=matched.get("url"),
                        published_at=matched.get("publishedAt"),
                        accession=matched.get("accession"),
                    )
                ]
                if found
                else [],
            )
        values_by_period[period_id] = observations

    quarters = sorted(
        (p for p in facts.periods if p.kind == "quarterly"), key=lambda p: p.provider_end
    )
    for index in range(3, len(quarters)):
        four = quarters[index - 3 : index + 1]
        ends = [date.fromisoformat(p.provider_end) for p in four]
        if not all(70 <= (b - a).days <= 110 for a, b in pairwise(ends)):
            continue
        period_id = "ttm:" + four[-1].provider_end
        period = FinancialPeriod(
            id=period_id,
            kind="ttm",
            label="TTM · " + four[-1].label,
            fiscal_year=four[-1].fiscal_year,
            fiscal_quarter=four[-1].fiscal_quarter,
            provider_end=four[-1].provider_end,
            actual_end=four[-1].actual_end,
            actual_start=four[0].actual_start,
            components=[p.id for p in four],
            identity_status="derived",
        )
        facts.periods.append(period)
        target: dict[str, MetricObservation] = {}
        for metric in METRICS:
            items = [values_by_period[p.id][metric] for p in four]
            selected = items[-1:] if metric in STOCK_METRICS else items
            value = (
                sum(item.value for item in selected if item.value is not None)
                if all(item.value is not None for item in selected)
                else None
            )
            if metric == "dilutedShares" and value is not None:
                value /= 4
            target[metric] = items[-1].model_copy(
                update={
                    "id": fingerprint([version, period_id, metric]),
                    "period_id": period_id,
                    "value": value,
                    "state": "available" if value is not None else "missing",
                    "reason": None if value is not None else "incomplete-four-quarters",
                    "formula": "period-end balance"
                    if metric in STOCK_METRICS
                    else "mean of four quarters"
                    if metric == "dilutedShares"
                    else "sum of four non-overlapping quarters",
                    "evidence": [ref for item in selected for ref in item.evidence],
                }
            )
        values_by_period[period_id] = target
        facts.latest_ttm = period_id

    for period in facts.periods:
        observations = values_by_period[period.id]

        def derived(
            metric: str,
            operands: list[str],
            fn: Any,
            formula: str,
            unit: str = "ratio",
            *,
            observations=observations,
            period=period,
        ) -> None:
            items = [observations.get(name) for name in operands]
            nums = [item.value if item else None for item in items]
            value = number(fn(*nums)) if all(n is not None for n in nums) else None
            observations[metric] = MetricObservation(
                id=fingerprint([version, period.id, metric]),
                metric=metric,
                value=value,
                unit=unit,
                currency=currency if unit == "currency" else None,
                period_id=period.id,
                basis="statement-derived",
                state="available" if value is not None else "missing",
                reason=None if value is not None else "missing-or-invalid-denominator",
                formula=formula,
                evidence=[ref for item in items if item for ref in item.evidence],
            )

        derived(
            "freeCashflow",
            ["operatingCashflow", "capex"],
            lambda ocf, capex: ocf + capex,
            "Operating Cash Flow − |Capital Expenditure|",
            "currency",
        )
        for metric, profit in (
            ("grossMargin", "grossProfit"),
            ("operatingMargin", "operatingIncome"),
            ("netMargin", "netIncome"),
            ("fcfMargin", "freeCashflow"),
        ):
            derived(
                metric,
                [profit, "revenue"],
                lambda a, b: a / b if b > 0 else None,
                profit + " / revenue",
            )
    for period in facts.periods:
        observations = values_by_period[period.id]
        prior = next(
            (
                p
                for p in facts.periods
                if p.kind == period.kind
                and p.fiscal_year == (period.fiscal_year or 0) - 1
                and p.fiscal_quarter == period.fiscal_quarter
            ),
            None,
        )
        if period.kind in {"annual", "ttm"}:
            balance_prior = prior or next(
                (
                    p
                    for p in facts.periods
                    if p.kind == "quarterly"
                    and p.fiscal_year == (period.fiscal_year or 0) - 1
                    and p.fiscal_quarter == period.fiscal_quarter
                    and p.fiscal_half == period.fiscal_half
                    and period.kind != "irregular"
                ),
                None,
            )
            for metric, denominator in (("roe", "equity"), ("roa", "assets")):
                income = observations.get("netIncome")
                last = observations.get(denominator)
                first = (
                    values_by_period.get(balance_prior.id, {}).get(denominator)
                    if balance_prior
                    else None
                )
                valid = (
                    income
                    and income.value is not None
                    and last
                    and last.value is not None
                    and last.value > 0
                    and first
                    and first.value is not None
                    and first.value > 0
                )
                value = income.value / ((first.value + last.value) / 2) if valid else None
                observations[metric] = MetricObservation(
                    id=fingerprint([version, period.id, metric]),
                    metric=metric,
                    value=value,
                    unit="ratio",
                    period_id=period.id,
                    basis="average-balance",
                    state="available" if value is not None else "missing",
                    reason=None if value is not None else "non-positive-or-missing-average-balance",
                    formula="net income / average beginning and ending " + denominator,
                    evidence=[
                        ref for item in (income, first, last) if item for ref in item.evidence
                    ],
                )
        for metric in ("revenue", "netIncome", "eps", "freeCashflow"):
            prior = next(
                (
                    p
                    for p in facts.periods
                    if p.kind == period.kind
                    and p.fiscal_year == (period.fiscal_year or 0) - 1
                    and p.fiscal_quarter == period.fiscal_quarter
                ),
                None,
            )
            previous = values_by_period.get(prior.id, {}).get(metric) if prior else None
            current = observations.get(metric)
            value = (
                current.value / previous.value - 1
                if current
                and current.value is not None
                and previous
                and previous.value is not None
                and previous.value > 0
                else None
            )
            observations[metric + "Growth"] = MetricObservation(
                id=fingerprint([version, period.id, metric, "yoy"]),
                metric=metric + "Growth",
                value=value,
                unit="ratio",
                period_id=period.id,
                basis="same-fiscal-period-yoy",
                state="available" if value is not None else "missing",
                reason=None if value is not None else "non-positive-or-missing-base",
                formula="current / prior-year same fiscal period − 1",
                evidence=[
                    *(current.evidence if current else []),
                    *(previous.evidence if previous else []),
                ],
            )
        facts.observations.extend(observations.values())

    statement_fcf = values_by_period.get(facts.latest_ttm or "", {}).get("freeCashflow")
    provider_fcf = number(metrics.get("freeCashflow"))
    facts.reconciliation = {
        "statementFreeCashflow": statement_fcf.value if statement_fcf else None,
        "providerFreeCashflow": provider_fcf,
        "difference": statement_fcf.value - provider_fcf
        if statement_fcf and statement_fcf.value is not None and provider_fcf is not None
        else None,
        "statementBasis": "operating-cash-flow-less-capex",
        "providerBasis": "provider-summary-unspecified",
        "modelBasis": "operating-cash-flow-less-capex-equity-proxy",
        "modelDiscountBasis": "cost-of-equity",
    }
    return facts


def make_quote(
    ticker: str, market: Mapping[str, Any], fundamental: Mapping[str, Any]
) -> QuoteSnapshot:
    metrics = fundamental.get("metrics") or {}
    raw_unit = str(fundamental.get("currency") or market.get("currency") or "") or None
    currency = "GBP" if raw_unit in {"GBp", "GBX"} else raw_unit
    price = number(market.get("spot", market.get("price")))
    timestamp = metrics.get("regularMarketTime")
    regular_price = number(metrics.get("regularMarketPrice"))
    if regular_price is not None and isinstance(timestamp, (int, float)):
        price = regular_price / 100 if raw_unit in {"GBp", "GBX"} else regular_price
    as_of = (
        datetime.fromtimestamp(timestamp, UTC).isoformat()
        if isinstance(timestamp, (float, int))
        else str(market.get("asOf") or "") or None
    )
    previous = number(metrics.get("regularMarketPreviousClose"))
    if previous is not None and raw_unit in {"GBp", "GBX"}:
        previous /= 100
    change = price - previous if price is not None and previous is not None else None
    session = (
        "regular"
        if regular_price is not None and isinstance(timestamp, (int, float))
        else "unknown"
    )
    return QuoteSnapshot(
        id=fingerprint([ticker, currency, price, as_of]),
        ticker=ticker,
        price=price,
        currency=currency,
        quote_unit=raw_unit,
        reporting_currency=metrics.get("financialCurrency"),
        fund_base_currency=metrics.get("fundCurrency"),
        exchange=metrics.get("fullExchangeName"),
        timezone=metrics.get("exchangeTimezoneName"),
        as_of=as_of,
        session=session,
        change=change,
        change_pct=change / previous if change is not None and previous and previous > 0 else None,
        delay_minutes=int(metrics["exchangeDataDelayedBy"])
        if number(metrics.get("exchangeDataDelayedBy")) is not None
        else None,
    )


def comparable_observations(a: MetricObservation, b: MetricObservation) -> bool:
    """Provider disagreement is meaningful only after identity and basis match."""
    return (a.metric, a.currency, a.unit, a.period_id, a.basis) == (
        b.metric,
        b.currency,
        b.unit,
        b.period_id,
        b.basis,
    )
