"""Select comparable statements and a listing's model family before valuation."""

import re
from collections.abc import Mapping
from typing import Any, Literal

from trading_max.reference.security_master import ResolvedSecurityEntity

from .facts import FinancialFacts, FinancialPeriod, MetricObservation, number
from .listing import EQUAL_DISTRIBUTION_CLASSES, REVIEWED_ORDINARY_SOURCES, REVIEWED_RECEIPTS

Family = Literal["cash-flow", "net-income", "residual-income"]
PeriodChoice = Literal[
    "latest-four-quarters", "previous-four-quarters", "latest-fiscal-year", "previous-fiscal-year"
]


def period_choice(facts: FinancialFacts, period: FinancialPeriod) -> PeriodChoice:
    if period.kind == "annual":
        latest = max(p.provider_end for p in facts.periods if p.kind == "annual")
        return "latest-fiscal-year" if period.provider_end == latest else "previous-fiscal-year"
    latest = max(
        (p.provider_end for p in facts.periods if p.kind == "quarterly"),
        default=period.provider_end,
    )
    return "latest-four-quarters" if period.provider_end == latest else "previous-four-quarters"


RECEIPT_RATIOS = {listing: ratio for listing, (_, ratio) in REVIEWED_RECEIPTS.items()}

EXCLUDED_ASSETS = {"ETF", "ETP", "MUTUALFUND", "INDEX"}
# Exact US listings. See docs/architecture/valuation-model.md for filing references.
REVIEWED_FAMILIES: dict[str, Family] = {
    "IBKR": "net-income",
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
    if {
        "Cash Cash Equivalents And Federal Funds Sold",
        "Other Non Interest Expense",
    } <= fields or fields & {
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
    facts: FinancialFacts, family: Family, listing: str | None = None
) -> tuple[FinancialPeriod | None, dict[str, MetricObservation]]:
    """Try consecutive four-quarter windows, then fiscal years, newest first."""
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
    incomplete_cash = (None, {})
    for p in [*windows, *annual]:
        values = groups.get(p.id, {})
        ordinary = values.get("ordinaryShares")
        needs_statement_shares = (
            listing in EQUAL_DISTRIBUTION_CLASSES or RECEIPT_RATIOS.get(listing, 1) != 1
        )
        if needs_statement_shares and (not ordinary or ordinary.value <= 0):
            continue
        revenue = values.get("revenue")
        if family == "residual-income":
            book = values.get("commonEquity")
            if book and book.value > 0 and "commonIncome" in values:
                return p, values
        elif revenue and revenue.value == 0:
            return p, values
        elif revenue and revenue.value > 0:
            if family == "net-income" and ("commonIncome" in values or "netIncome" in values):
                return p, values
            flow, cash = values.get("freeCashflow"), values.get("cash")
            if family == "cash-flow" and flow and (flow.value >= 0 or (cash and cash.value >= 0)):
                return p, values
            if family == "cash-flow" and flow and incomplete_cash[0] is None:
                # Retain the missing-cash diagnostic only when every complete
                # window and fiscal year has been exhausted.
                incomplete_cash = (p, values)
    return incomplete_cash


def catalog_security_type(ticker: str, security: ResolvedSecurityEntity | None) -> str:
    if not security or security.method != "ticker" or security.canonical_ticker.upper() != ticker:
        return ""
    return " ".join(
        (security.security_type, security.provider_security_type, security.provider_security_type2)
    )


def share_unit(
    listing: str | None, filed_units: Mapping[str, str], security_type: str = ""
) -> str | None:
    """Resolve the security on this venue independently of the reporting currency."""
    if not listing:
        return None
    filed = filed_units.get(listing)
    kind = security_type.lower()
    if (
        listing in REVIEWED_RECEIPTS
        or filed == "receipt"
        or "deposit" in kind
        or re.search(r"\b(?:adr|ads)\b", kind)
    ):
        return "receipt"
    if filed is not None and filed != "ordinary":
        return None
    if listing in REVIEWED_ORDINARY_SOURCES:
        return "ordinary"
    # An identified second ordinary class can have different economic rights.
    # Counts or voting-class labels alone cannot translate it to the quoted unit.
    if sum(unit == "ordinary" for unit in filed_units.values()) > 1 or re.search(
        r"[-.][AB](?:\.|$)", listing
    ):
        return None
    if filed == "ordinary" or any(
        label in kind for label in ("common stock", "ordinary share", "common share")
    ):
        return "ordinary"
    return None


def listing_shares(
    ticker: str,
    listing: str | None,
    name: str,
    shares: float | None,
    values: dict[str, MetricObservation],
    is_adr: bool = False,
    ordinary_listing: bool = False,
) -> tuple[float | None, float | None]:
    # Never divide an already ADR-adjusted quote-provider count by the ratio.
    if not listing or ":" not in listing:
        return None, None
    market, symbol = listing.split(":", 1)
    if not symbol or ticker.strip().upper() != (symbol + ".L" if market == "LSE" else symbol):
        return None, None
    ratio = RECEIPT_RATIOS.get(listing)
    if ratio:
        ordinary = values.get("ordinaryShares")
        if ordinary and ordinary.value and ordinary.value > 0:
            return ordinary.value / ratio, ratio
        return (shares if ratio == 1 else None), ratio
    if not ordinary_listing:
        return None, None
    if is_adr or any(x in name.lower() for x in ("depositary", "depository", " adr", " ads")):
        return None, None
    ordinary = values.get("ordinaryShares")
    if ordinary and ordinary.value and ordinary.value > 0:
        return ordinary.value, None
    return (None if listing in EQUAL_DISTRIBUTION_CLASSES else shares), None
