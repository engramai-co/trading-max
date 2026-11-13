"""Project issuer tracking and exact-security overlap once, during publication."""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable, Iterable
from datetime import date
from typing import TYPE_CHECKING, Literal

from pydantic import Field

from trading_max.domain.contracts import DomainModel
from trading_max.domain.etf import FundEvidence, FundShareClass, FundSize
from trading_max.reference import SecurityDescriptor

if TYPE_CHECKING:
    from trading_max.analytics.lookthrough import FundSnapshot

ETF_SUMMARY_KEY = "account/etf_summary.json"
ETF_PROJECTION_VERSION = "etf-v1"
MAX_HOLDINGS_AGE_DAYS = 45
MAX_TRACKING_AGE_DAYS = 120


class ETFTracking(DomainModel):
    state: Literal["available", "stale", "incomparable", "missing"]
    difference_pp: float | None = None
    period_end: str | None = None
    currency: str | None = None
    benchmark_currency: str | None = None
    nav_hedging: str | None = None
    benchmark_hedging: str | None = None
    evidence: FundEvidence | None = None


class ETFOverlap(DomainModel):
    state: Literal["available", "stale", "missing"]
    value: float | None = None
    fund_coverage: float | None = None
    rest_coverage: float | None = None
    fund_holdings_date: str | None = None
    rest_holdings_dates: list[str] = Field(default_factory=list)
    dates_valid: bool = False
    portfolio_as_of: str | None = None


class ETFMatch(DomainModel):
    security_id: str
    name: str
    fund_weight: float
    rest_direct_weight: float
    rest_via_fund: dict[str, float]
    overlap: float


class ETFReading(DomainModel):
    isin: str | None = None
    tickers: list[str]
    name: str | None = None
    issuer: str | None = None
    index_name: str | None = None
    expense_ratio: float | None = None
    fee_basis: str | None = None
    income_use: str | None = None
    domicile: str | None = None
    hedging: str | None = None
    share_class_size: FundSize | None = None
    fund_size: FundSize | None = None
    holdings_state: Literal["available", "holdings-stale", "no-holdings", "data-failed"]
    tracking: ETFTracking
    overlap: ETFOverlap
    evidence: dict[str, FundEvidence] = Field(default_factory=dict)


class ETFPortfolio(DomainModel):
    run_id: str = ""
    broker_as_of: str | None = None
    funds: list[ETFReading] = Field(default_factory=list)


def recent(value: str | None, today: date, max_days: int) -> bool:
    try:
        age = (today - date.fromisoformat(value or "")).days
    except ValueError:
        return False
    return 0 <= age <= max_days


def tracking(profile: FundShareClass | None, today: date) -> ETFTracking:
    if not profile:
        return ETFTracking(state="missing")
    pair = profile.one_year
    currency = pair.nav_currency if pair else profile.share_currency
    benchmark_currency = pair.benchmark_currency if pair else profile.benchmark_currency
    nav_hedging = pair.nav_hedging if pair else profile.hedging
    benchmark_hedging = pair.benchmark_hedging if pair else profile.benchmark_hedging
    common = {
        "period_end": pair.period_end if pair else None,
        "currency": currency,
        "benchmark_currency": benchmark_currency,
        "nav_hedging": nav_hedging,
        "benchmark_hedging": benchmark_hedging,
        "evidence": pair.evidence if pair else profile.evidence.get("benchmark_currency"),
    }
    if (currency and benchmark_currency and currency != benchmark_currency) or (
        nav_hedging and benchmark_hedging and nav_hedging != benchmark_hedging
    ):
        return ETFTracking(state="incomparable", **common)
    if not pair or not all((currency, benchmark_currency, nav_hedging, benchmark_hedging)):
        if "one_year" in profile.evidence:
            common["evidence"] = profile.evidence["one_year"]
        return ETFTracking(state="missing", **common)
    return ETFTracking(
        state="available" if recent(pair.period_end, today, MAX_TRACKING_AGE_DAYS) else "stale",
        difference_pp=round((pair.nav_return - pair.benchmark_return) * 100, 10),
        **common,
    )


class ETFExposure:
    """Build one table of direct and fund exposures; subtract the selected share class."""

    def __init__(self, exact_id: Callable[[SecurityDescriptor], str | None]) -> None:
        self.exact_id = exact_id
        self.direct_value = 0.0
        self.direct: defaultdict[str, float] = defaultdict(float)
        self.fund_values: defaultdict[str, float] = defaultdict(float)
        self.funds: dict[str, FundSnapshot | None] = {}
        self.fund_tickers: defaultdict[str, set[str]] = defaultdict(set)
        self.fund_states: dict[str, str] = {}
        self.names: dict[str, str] = {}

    def add_direct(self, security: SecurityDescriptor, value: float) -> None:
        self.direct_value += value
        identity = self.exact_id(security)
        if identity:
            self.direct[identity] += value
            self.names[identity] = security.name or security.ticker or identity

    def add_fund(
        self,
        share_class_key: str,
        ticker: str,
        value: float,
        snapshot: FundSnapshot | None,
        *,
        failed: bool,
    ) -> None:
        self.fund_values[share_class_key] += value
        self.fund_tickers[share_class_key].add(ticker)
        if share_class_key not in self.funds or (not self.funds[share_class_key] and snapshot):
            self.funds[share_class_key] = snapshot
        if failed:
            self.fund_states[share_class_key] = "data-failed"

    def project(self, today: date, portfolio_as_of: str | None):
        amounts = dict(self.direct)
        via: defaultdict[str, dict[str, float]] = defaultdict(dict)
        weights: dict[str, dict[str, float]] = {}
        covered_value = sum(self.direct.values())
        total_value = self.direct_value + sum(self.fund_values.values())
        for share_class, snapshot in self.funds.items():
            if not snapshot or not math.isclose(snapshot.weight_total_pct(), 100, abs_tol=0.2):
                continue
            known: defaultdict[str, float] = defaultdict(float)
            for holding in snapshot.holdings:
                if not holding.is_security:
                    continue
                security = SecurityDescriptor(
                    isin=holding.isin,
                    figi=holding.figi,
                    share_class_figi=holding.share_class_figi,
                )
                identity = self.exact_id(security)
                if identity:
                    known[identity] += holding.weight_pct / 100
                    self.names.setdefault(identity, holding.name or holding.ticker or identity)
            weights[share_class] = dict(known)
            for identity, weight in known.items():
                value = self.fund_values[share_class] * weight
                via[identity][share_class] = value
                amounts[identity] = amounts.get(identity, 0) + value
                covered_value += value

        for key in sorted(self.funds):
            snapshot = self.funds[key]
            profile = snapshot.profile if snapshot else None
            tickers = sorted(self.fund_tickers[key])
            value = self.fund_values[key]
            fund_weights = weights.get(key, {})
            fund_covered = sum(fund_weights.values())
            rest = total_value - value
            rest_covered = max(0.0, covered_value - fund_covered * value)
            fund_date = snapshot.as_of or None if snapshot else None
            rest_funds: Iterable[FundSnapshot | None] = (
                item for fund, item in self.funds.items() if fund != key
            )
            rest_dates = []
            dates_valid = bool(
                portfolio_as_of
                and recent(portfolio_as_of[:10], today, MAX_HOLDINGS_AGE_DAYS)
                and snapshot
                and snapshot.holdings_state(today) == "available"
            )
            for item in rest_funds:
                if item and item.holdings and item.as_of:
                    rest_dates.append(item.as_of)
                    dates_valid &= item.holdings_state(today) == "available"
                else:
                    dates_valid = False
            rows = []
            if rest > 0 and fund_covered > 0 and rest_covered > 1e-9:
                for identity, fund_weight in fund_weights.items():
                    rest_amount = amounts[identity] - via[identity].get(key, 0)
                    if rest_amount <= 1e-9:
                        continue
                    rows.append(
                        ETFMatch(
                            security_id=identity,
                            name=self.names[identity],
                            fund_weight=fund_weight,
                            rest_direct_weight=self.direct.get(identity, 0) / rest,
                            rest_via_fund={
                                fund: amount / rest
                                for fund, amount in via[identity].items()
                                if fund != key
                            },
                            overlap=min(fund_weight, rest_amount / rest),
                        )
                    )
                state = "available" if dates_valid else "stale"
                overlap = min(1.0, sum(row.overlap for row in rows))
            else:
                state = "missing"
                overlap = None
            holding_state = (
                snapshot.holdings_state(today)
                if snapshot
                else self.fund_states.get(key, "no-holdings")
            )
            if snapshot and snapshot.holdings and key not in weights:
                holding_state = "data-failed"
            yield (
                ETFReading(
                    isin=None if key.startswith("listing:") else key,
                    tickers=tickers,
                    name=profile.name if profile else None,
                    issuer=snapshot.issuer or None if snapshot else None,
                    holdings_state=holding_state,
                    tracking=tracking(profile, today),
                    overlap=ETFOverlap(
                        state=state,
                        value=overlap,
                        fund_coverage=min(1.0, fund_covered) if fund_weights else None,
                        rest_coverage=min(1.0, rest_covered / rest)
                        if rest > 0 and rest_covered > 1e-9
                        else None,
                        fund_holdings_date=fund_date,
                        rest_holdings_dates=sorted(set(rest_dates)),
                        dates_valid=dates_valid,
                        portfolio_as_of=portfolio_as_of,
                    ),
                    evidence={
                        **(
                            {
                                field: fact
                                for field, fact in profile.evidence.items()
                                if field
                                in {
                                    "index_name",
                                    "expense_ratio",
                                    "income_use",
                                    "domicile",
                                    "hedging",
                                    "share_class_size",
                                    "fund_size",
                                }
                            }
                            if profile
                            else {}
                        ),
                        **(
                            {"holdings_date": snapshot.evidence["holdings_date"]}
                            if snapshot and "holdings_date" in snapshot.evidence
                            else {}
                        ),
                    },
                    **(
                        {
                            field: getattr(profile, field)
                            for field in (
                                "index_name",
                                "expense_ratio",
                                "fee_basis",
                                "income_use",
                                "domicile",
                                "hedging",
                                "share_class_size",
                                "fund_size",
                            )
                        }
                        if profile
                        else {}
                    ),
                ),
                sorted(rows, key=lambda row: (-row.overlap, row.security_id)),
                snapshot,
            )
