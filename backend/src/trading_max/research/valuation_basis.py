"""Select comparable statements and a listing's model family before valuation."""

from collections.abc import Mapping
from typing import Any, Literal

from .facts import FinancialFacts, FinancialPeriod, MetricObservation, number

Family = Literal["cash-flow", "net-income", "residual-income"]
PeriodChoice = Literal["latest-four-quarters", "previous-four-quarters", "latest-fiscal-year"]


def period_choice(facts: FinancialFacts, period: FinancialPeriod) -> PeriodChoice:
    if period.kind == "annual":
        return "latest-fiscal-year"
    latest = max(
        (p.provider_end for p in facts.periods if p.kind == "quarterly"),
        default=period.provider_end,
    )
    return "latest-four-quarters" if period.provider_end == latest else "previous-four-quarters"


EXCLUDED_ASSETS = {"ETF", "ETP", "MUTUALFUND", "INDEX"}
# Exact US listings. See docs/architecture/valuation-model.md for filing references.
REVIEWED_FAMILIES: dict[str, Family] = {
    "IREN": "cash-flow",
    "COIN": "net-income",
    "HOOD": "net-income",
    "SOFI": "residual-income",
}


def classify(ticker: str, gics: str, raw: Mapping[str, Any]) -> tuple[Family, str]:
    if ticker in REVIEWED_FAMILIES:
        return REVIEWED_FAMILIES[ticker], "reviewed-listing"
    if len(gics) == 8 and gics.isdigit():
        if gics.startswith("401010") or (gics.startswith("403010") and gics != "40301010"):
            return "residual-income", "gics-" + gics
        if gics == "40203020":
            return "net-income", "gics-" + gics
        return "cash-flow", "gics-" + gics
    fields = {
        row.get("index") or row.get("Breakdown")
        for key in (
            "balanceSheet",
            "quarterlyBalanceSheet",
            "incomeStatement",
            "quarterlyIncomeStatement",
        )
        for row in raw.get(key) or []
        if isinstance(row, Mapping) and any(number(value) is not None for value in row.values())
    }
    if fields & {
        "Total Deposits",
        "Deposits",
        "Policyholder Liabilities",
        "Insurance Contract Liabilities",
        "Net Policyholder Benefits And Claims",
    }:
        return "residual-income", "statement-structure"
    if fields & {
        "Payables To Customers",
        "Customer Payables",
        "Securities Loaned",
        "Receivables From Brokers Dealers And Clearing Organizations",
    }:
        return "net-income", "statement-structure"
    return "cash-flow", "statement-structure"


def statement_basis(
    facts: FinancialFacts, family: Family
) -> tuple[FinancialPeriod | None, dict[str, MetricObservation]]:
    """Choose four consecutive quarters, then the most recent fiscal year only."""
    groups: dict[str, dict[str, MetricObservation]] = {}
    for obs in facts.observations:
        if obs.value is not None and obs.state == "available":
            groups.setdefault(obs.period_id, {})[obs.metric] = obs
    windows = sorted(
        (p for p in facts.periods if p.kind == "ttm"), key=lambda p: p.provider_end, reverse=True
    )
    annual = sorted(
        (p for p in facts.periods if p.kind == "annual"), key=lambda p: p.provider_end, reverse=True
    )
    required = {"revenue", "freeCashflow" if family == "cash-flow" else "netIncome"}
    if family == "residual-income":
        required = {"revenue", "commonEquity", "commonIncome"}
    for p in [*windows, *annual[:1]]:
        values = groups.get(p.id, {})
        revenue = values.get("revenue")
        if (revenue and revenue.value == 0) or required <= values.keys():
            return p, values
    return None, {}


def listing_shares(
    ticker: str,
    listing: str | None,
    name: str,
    shares: float | None,
    values: dict[str, MetricObservation],
    is_adr: bool = False,
) -> tuple[float | None, float | None]:
    # Never divide an already ADR-adjusted quote-provider count by the ratio.
    ratios = {"US:TSM": 5, "US:ARM": 1, "US:NOK": 1}
    ratio = ratios.get(listing or "")
    if ratio:
        ordinary = values.get("ordinaryShares")
        if ordinary and ordinary.value and ordinary.value > 0:
            return ordinary.value / ratio, ratio
        return (shares if ratio == 1 else None), ratio
    if ticker in {"TSM", "ARM", "NOK"}:
        return None, None
    if is_adr or any(x in name.lower() for x in ("depositary", "depository", " adr", " ads")):
        return None, None
    return shares, None
