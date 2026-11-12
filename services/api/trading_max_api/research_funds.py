"""Independent issuer-backed fund research; no dependency on broker ingestion."""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from pathlib import Path

import httpx
from pydantic import Field
from trading_max.analytics.etf_details import ETFDetail
from trading_max.analytics.etf_journal import ETFDisclosure
from trading_max.analytics.etf_projection import ETFMatch, ETFReading, ETFTracking, tracking
from trading_max.analytics.lookthrough import FundSnapshot, fetch_fund_snapshot
from trading_max.domain.etf import FundReturnYear, FundShareClass
from trading_max.infrastructure.fund_holdings import (
    BUILTIN_FUND_ADAPTERS,
    USER_AGENT,
    OfficialFundHoldingsProvider,
)
from trading_max.infrastructure.fund_profiles import parse_ishares_profile
from trading_max.reference import SecurityDescriptor
from trading_max.research.facts import fingerprint, number

from .models import ApiModel
from .valuation_assumptions import _atomic_write


class FundResearch(ApiModel):
    ticker: str
    fetched_at: str
    source_url: str | None = None
    issuer: str | None = None
    isin: str | None = None
    index_name: str | None = None
    share_currency: str | None = None
    base_currency: str | None = None
    income_use: str | None = None
    methodology: str | None = None
    replication: str | None = None
    domicile: str | None = None
    inception: str | None = None
    total_assets_label: str | None = None
    total_assets_as_of: str | None = None
    expense_ratio: float | None = None
    hedging: str | None = None
    holdings: FundSnapshot | None = None
    profile: FundShareClass | None = None
    reading: ETFReading | None = None
    one_year_tracking: ETFTracking | None = None
    matches: list[ETFMatch] = Field(default_factory=list)
    disclosures: list[ETFDisclosure] = Field(default_factory=list)
    holdings_state: str = "no-holdings"
    return_currency: str | None = None
    return_basis: str | None = None
    annual_returns: list[FundReturnYear] = Field(default_factory=list)
    tracking_error: float | None = None
    tracking_error_state: str = "daily-nav-and-index-history-unavailable"
    state: str = "available"
    warnings: list[str] = Field(default_factory=list)


def _profile_fields(profile: FundShareClass) -> dict:
    fields = profile.model_dump(by_alias=False, exclude_none=True)
    size = profile.share_class_size
    if size is not None:
        fields["total_assets_label"] = f"{size.currency} {size.amount:,.0f}"
        fields["total_assets_as_of"] = profile.evidence["share_class_size"].effective_at
    return fields


def parse_ishares_page(html: str) -> dict:
    return _profile_fields(parse_ishares_profile(html, ""))


def fund_research_from_snapshot(
    ticker: str, detail: ETFDetail, *, include_holdings: bool = True
) -> FundResearch:
    reading, holdings = detail.reading, detail.holdings
    profile = holdings.profile if holdings else None
    return FundResearch(
        **{
            "ticker": ticker,
            "fetched_at": holdings.fetched_at if holdings else "",
            "source_url": holdings.source_url if holdings else None,
            "issuer": reading.issuer,
            "isin": reading.isin,
            "holdings": holdings.model_copy(update={"profile": None})
            if include_holdings and holdings
            else None,
            "profile": profile,
            "reading": reading,
            "one_year_tracking": reading.tracking,
            "matches": detail.matches if include_holdings else [],
            "tracking_error_state": "issuer-published"
            if profile and profile.tracking_error is not None
            else "missing",
            "holdings_state": reading.holdings_state,
            "state": "stale"
            if reading.holdings_state == "holdings-stale"
            else "missing"
            if not profile
            else "available",
            **(_profile_fields(profile) if profile else {}),
        },
    )


class FundResearchService:
    def __init__(self, root: Path):
        self.root = root / "research-cache" / "funds"
        self.provider = OfficialFundHoldingsProvider(root)
        self.lock = threading.RLock()

    def get(self, ticker: str, metrics: dict) -> FundResearch:
        with self.lock:
            reported_isin = str(metrics.get("isin") or "").strip().upper()
            spec = (
                next(
                    (
                        value
                        for value in BUILTIN_FUND_ADAPTERS.values()
                        if value.isin == reported_isin
                    ),
                    None,
                )
                if reported_isin
                else BUILTIN_FUND_ADAPTERS.get(ticker.removesuffix(".L"))
            )
            share_isin = reported_isin or (spec.isin if spec else "")
            path = self.root / (fingerprint([share_isin or ticker, "fund-research-v4"]) + ".json")
            previous = None
            if path.exists():
                previous = FundResearch.model_validate_json(path.read_text())
                if (
                    datetime.now(UTC) - datetime.fromisoformat(previous.fetched_at)
                ).total_seconds() < 64800:
                    return previous.model_copy(update={"ticker": ticker})
            result = FundResearch(
                ticker=ticker,
                fetched_at=datetime.now(UTC).isoformat(),
                source_url=spec.source_url if spec else None,
                issuer=spec.issuer if spec else metrics.get("fundFamily"),
                isin=reported_isin or (spec.isin if spec else None),
                base_currency=metrics.get("fundCurrency"),
                expense_ratio=number(metrics.get("annualReportExpenseRatio")),
            )
            try:
                result.holdings = fetch_fund_snapshot(
                    self.provider,
                    SecurityDescriptor(
                        ticker=ticker,
                        isin=reported_isin or (spec.isin if spec else ""),
                        name=" ".join(
                            str(metrics.get(key) or "")
                            for key in ("longName", "shortName", "fundFamily")
                        ),
                    ),
                )
                if result.holdings is not None:
                    result.isin = result.holdings.fund_isin or result.isin
                    result.source_url = result.holdings.source_url or result.source_url
                    result.issuer = result.holdings.issuer or result.issuer
                    result.holdings_state = result.holdings.holdings_state(datetime.now(UTC).date())
                    result.profile = result.holdings.profile
            except Exception as exc:
                result.warnings.append("holdings: " + type(exc).__name__)
                result.holdings_state = "data-failed"
                if previous and previous.holdings:
                    result.holdings = previous.holdings
                    result.holdings_state = "holdings-stale"
                    result.profile = previous.profile
            if (
                not result.profile
                and spec
                and spec.issuer == "iShares"
                and result.holdings_state != "data-failed"
            ):
                try:
                    response = httpx.get(
                        spec.source_url,
                        params={"siteEntryPassthrough": "true"},
                        headers={"User-Agent": USER_AGENT},
                        follow_redirects=True,
                        timeout=25,
                    )
                    response.raise_for_status()
                    profile = parse_ishares_profile(response.text, spec.source_url)
                    if profile.isin != spec.isin:
                        raise ValueError("share-class-mismatch")
                    result.profile = profile
                except Exception as exc:
                    if previous:
                        result = previous.model_copy(
                            update={
                                "state": "stale",
                                "warnings": ["issuer-profile: " + type(exc).__name__],
                            }
                        )
                    else:
                        result.warnings.append("issuer-profile: " + type(exc).__name__)
            if result.profile:
                result = FundResearch.model_validate(
                    {**result.model_dump(by_alias=False), **_profile_fields(result.profile)}
                )
            if result.holdings_state == "holdings-stale":
                result.state = "stale"
            elif result.holdings is None and not result.profile and result.expense_ratio is None:
                result.state = "missing"
            result.one_year_tracking = tracking(result.profile, datetime.now(UTC).date())
            if result.tracking_error is not None:
                result.tracking_error_state = "issuer-published"
            _atomic_write(path, result.model_dump(mode="json"))
            return result
