"""Typed portfolio look-through and allocation analytics.

The service treats fund holdings as an explicit provider boundary. A missing or
partial fund file is surfaced as an unverified coverage warning; it is never
silently treated as a complete underlying portfolio.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from pydantic import Field

from trading_max.domain import DomainModel
from trading_max.reference import (
    CatalogSecurityMaster,
    SecurityDescriptor,
    SecurityMasterResolver,
    infer_gics_eligibility,
    is_fund_instrument,
)

COUNTRY_BY_ISIN_PREFIX = {
    "AU": "Australia",
    "BR": "Brazil",
    "CA": "Canada",
    "CH": "Switzerland",
    "CN": "China",
    "DE": "Germany",
    "FR": "France",
    "GB": "United Kingdom",
    "HK": "Hong Kong",
    "IN": "India",
    "JP": "Japan",
    "KR": "South Korea",
    "NL": "Netherlands",
    "SG": "Singapore",
    "TW": "Taiwan",
    "US": "United States",
}


class FundHolding(DomainModel):
    isin: str = ""
    ticker: str = ""
    name: str = ""
    figi: str = ""
    composite_figi: str = ""
    share_class_figi: str = ""
    country: str | None = None
    industry: str | None = None
    weight_pct: float
    asset_class: str = "Equity"

    @property
    def normalized_asset_class(self) -> str:
        return " ".join(
            self.asset_class.strip().upper().replace("_", " ").replace("-", " ").split()
        )

    @property
    def is_security(self) -> bool:
        normalized = self.normalized_asset_class
        return self.weight_pct > 0 and not any(
            marker in normalized
            for marker in (
                "CASH",
                "COLLATERAL",
                "DERIVATIVE",
                "FUTURE",
                "FORWARD",
                "FX",
                "MONEY MARKET",
            )
        )

    @property
    def is_equity(self) -> bool:
        normalized = self.normalized_asset_class
        return self.is_security and (
            normalized in {"EQUITY", "EQUITIES", "STOCK", "COMMON STOCK", "PREFERRED STOCK"}
            or "DEPOSITARY RECEIPT" in normalized
            or normalized == "REIT"
        )


class FundSnapshot(DomainModel):
    ticker: str
    as_of: str
    fetched_at: str = ""
    industry_as_of: str = ""
    cache_schema_version: int = 1
    holdings: list[FundHolding] = Field(default_factory=list)
    country_weights: dict[str, float] = Field(default_factory=dict)
    industry_weights: dict[str, float] = Field(default_factory=dict)
    source_url: str = ""
    issuer: str = ""

    def weight_total_pct(self) -> float:
        return sum(item.weight_pct for item in self.holdings)


class FundHoldingsProvider(Protocol):
    def fetch(self, ticker: str) -> FundSnapshot | None:
        """Return a normalized official holdings snapshot, if available."""


class RawFundHoldingsProvider:
    """Read normalized fund files from the private state root.

    Network adapters can write this same schema under ``raw/fund-holdings``;
    the calculation layer remains deterministic and never depends on mtime.
    """

    def __init__(self, state_root: Path) -> None:
        self.root = state_root.expanduser().resolve() / "raw" / "fund-holdings"

    def fetch(self, ticker: str) -> FundSnapshot | None:
        path = self.root / f"{ticker.upper()}.json"
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            raise ValueError(f"fund holdings payload is not an object: {path}")
        return FundSnapshot.model_validate(payload)


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def _country(isin: str) -> str:
    return COUNTRY_BY_ISIN_PREFIX.get(isin[:2].upper(), "Other markets")


def _industry(supplied: Any = None) -> str:
    value = str(supplied or "").strip()
    return value or "Unclassified"


def _clean(value: float) -> float:
    return round(value, 2)


def _allocation(
    values: Mapping[str, float],
    total: float,
    *,
    dimension: str,
) -> list[dict[str, Any]]:
    rows = [
        {
            dimension: key,
            "valueGbp": _clean(value),
            "allocationPct": value / total if total else 0.0,
            "isNonCountry": key == "Unclassified" if dimension == "country" else False,
            "isNonIndustry": key == "Unclassified" if dimension == "industry" else False,
        }
        for key, value in values.items()
        if abs(value) > 0.005
    ]
    rows.sort(key=lambda item: item["valueGbp"], reverse=True)
    return rows


def _gics_sub_industry_allocation(
    values: Mapping[tuple[str, str, str], float],
    total: float,
) -> list[dict[str, Any]]:
    rows = [
        {
            "subIndustryCode": code or None,
            "subIndustry": name,
            "valueGbp": _clean(value),
            "allocationPct": value / total if total else 0.0,
            "classificationStatus": status,
            "isNonGics": status != "classified",
        }
        for (code, name, status), value in values.items()
        if abs(value) > 0.005
    ]
    rows.sort(key=lambda item: item["valueGbp"], reverse=True)
    return rows


class LookthroughService:
    """Merge direct positions with normalized ETF constituents."""

    def __init__(
        self,
        provider: FundHoldingsProvider | Any,
        security_master: SecurityMasterResolver | None = None,
    ) -> None:
        self.provider = provider
        self.security_master = security_master or CatalogSecurityMaster.default()

    def _fetch(self, ticker: str) -> FundSnapshot | None:
        if hasattr(self.provider, "fetch"):
            return self.provider.fetch(ticker)
        return self.provider(ticker)

    def run(self, accounts: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
        positions = [
            (profile, position)
            for profile in ("invest", "isa")
            for position in accounts.get(profile, {}).get("positions", [])
            if isinstance(position, Mapping)
        ]
        invested_value = sum(
            _number(accounts.get(profile, {}).get("investments_value_gbp"))
            for profile in ("invest", "isa")
        )
        position_value = sum(
            _number(position.get("current_value_gbp")) for _, position in positions
        )
        if invested_value <= 0:
            invested_value = position_value
        cash_value = sum(
            _number(accounts.get(profile, {}).get("cash_gbp")) for profile in ("invest", "isa")
        )
        if invested_value <= 0:
            raise ValueError("look-through requires positive invested value")

        direct_value = 0.0
        etf_value = 0.0
        indirect_value = 0.0
        country_values: defaultdict[str, float] = defaultdict(float)
        industry_values: defaultdict[str, float] = defaultdict(float)
        exposures: dict[str, dict[str, Any]] = {}
        sources: list[dict[str, Any]] = []
        warnings: list[str] = []
        fund_snapshots: dict[str, FundSnapshot | None] = {}
        fund_position_keys: set[tuple[str, str]] = set()

        for _, position in positions:
            ticker = str(position.get("ticker") or "").strip().upper()
            isin = str(position.get("isin") or "").strip().upper()
            resolved = self.security_master.resolve(
                SecurityDescriptor(
                    ticker=ticker,
                    name=str(position.get("name") or ticker),
                    isin=isin,
                )
            )
            if not is_fund_instrument(
                quote_type=resolved.security_type,
                provider_security_type=resolved.provider_security_type,
                provider_security_type2=resolved.provider_security_type2,
            ):
                continue
            snapshot = self._fetch(ticker)
            fund_position_keys.add((ticker, isin))
            fund_snapshots[ticker] = snapshot

        def add_exposure(
            *,
            isin: str,
            ticker: str,
            name: str,
            country: str | None,
            value: float,
            direct: bool,
            fund_ticker: str | None = None,
            figi: str = "",
            composite_figi: str = "",
            share_class_figi: str = "",
            gics_eligible: bool = True,
            security_type_hint: str = "EQUITY",
        ) -> None:
            if value <= 0:
                return
            resolved = self.security_master.resolve(
                SecurityDescriptor(
                    ticker=ticker,
                    name=name,
                    isin=isin,
                    figi=figi,
                    composite_figi=composite_figi,
                    share_class_figi=share_class_figi,
                    country=country,
                )
            )
            resolved_security_type = (
                resolved.security_type
                if resolved.security_type != "UNKNOWN"
                else security_type_hint
            )
            resolved_eligibility = (
                resolved.gics_eligibility
                if resolved.security_type != "UNKNOWN" or resolved.gics is not None
                else infer_gics_eligibility(
                    quote_type=security_type_hint,
                    has_gics=resolved.gics is not None,
                )
            )
            effective_gics_eligible = gics_eligible and resolved_eligibility != "not-applicable"
            key = resolved.entity_id
            ticker = resolved.canonical_ticker or ticker.strip().upper()
            name = resolved.entity_name or name
            country = resolved.country_of_risk or country
            # A company row may represent multiple instruments, so an ISIN is
            # only retained for unresolved single-security exposure.
            isin = isin if resolved.method == "unresolved" else ""
            record = exposures.setdefault(
                key,
                {
                    "entityId": resolved.entity_id,
                    "isin": isin or None,
                    "ticker": ticker or None,
                    "name": name or ticker or isin,
                    "country": country,
                    "resolutionMethod": resolved.method,
                    "resolutionConfidence": resolved.confidence,
                    "identitySource": resolved.source,
                    "securityType": resolved_security_type,
                    "gicsEligible": effective_gics_eligible,
                    "gicsEligibilityStatus": resolved_eligibility,
                    "gics": (
                        resolved.gics.model_dump(mode="json", by_alias=True)
                        if resolved.gics is not None
                        else None
                    ),
                    "directValueGbp": 0.0,
                    "indirectValueGbp": 0.0,
                    "etfValues": defaultdict(float),
                },
            )
            if direct:
                record["directValueGbp"] += value
            else:
                record["indirectValueGbp"] += value
                if fund_ticker:
                    record["etfValues"][fund_ticker] += value
            if country and not record["country"]:
                record["country"] = country
            record["gicsEligible"] = bool(record["gicsEligible"] or effective_gics_eligible)
            if resolved_eligibility != "pending":
                record["gicsEligibilityStatus"] = resolved_eligibility
            if name and len(name) > len(str(record["name"] or "")):
                record["name"] = name

        for _, position in positions:
            ticker = str(position.get("ticker") or "").strip().upper()
            value = _number(position.get("current_value_gbp"))
            if value <= 0:
                continue
            isin = str(position.get("isin") or "").strip().upper()
            if (ticker, isin) in fund_position_keys:
                etf_value += value
                continue
            resolved = self.security_master.resolve(
                SecurityDescriptor(
                    ticker=ticker,
                    name=str(position.get("name") or ticker),
                    isin=isin,
                    figi=str(position.get("figi") or ""),
                    composite_figi=str(position.get("composite_figi") or ""),
                    share_class_figi=str(position.get("share_class_figi") or ""),
                    country=_country(isin),
                    industry=str(position.get("industry") or ""),
                )
            )
            country = resolved.country_of_risk or _country(isin)
            industry = (
                resolved.gics.sector_name
                if resolved.gics is not None
                else _industry(position.get("industry"))
            )
            direct_value += value
            country_values[country] += value
            industry_values[industry] += value
            add_exposure(
                isin=isin,
                ticker=ticker,
                name=str(position.get("name") or ticker),
                country=country,
                value=value,
                direct=True,
                gics_eligible=True,
                security_type_hint=(
                    resolved.security_type if resolved.security_type != "UNKNOWN" else "EQUITY"
                ),
                figi=str(position.get("figi") or ""),
                composite_figi=str(position.get("composite_figi") or ""),
                share_class_figi=str(position.get("share_class_figi") or ""),
            )

        etf_positions: defaultdict[str, float] = defaultdict(float)
        for _, position in positions:
            ticker = str(position.get("ticker") or "").strip().upper()
            value = _number(position.get("current_value_gbp"))
            isin = str(position.get("isin") or "").strip().upper()
            if (ticker, isin) in fund_position_keys and value > 0:
                etf_positions[ticker] += value
        for ticker, fund_value in etf_positions.items():
            snapshot = fund_snapshots.get(ticker)
            if snapshot is None:
                warning = f"{ticker}: official fund holdings are unavailable"
                warnings.append(warning)
                sources.append(
                    {
                        "ticker": ticker,
                        "status": "unavailable",
                        "asOf": "",
                        "sourceUrl": "",
                        "issuer": "",
                        "holdingsCount": 0,
                        "weightTotalPct": 0.0,
                        "positionValueGbp": _clean(fund_value),
                    }
                )
                country_values["Unclassified"] += fund_value
                industry_values["Unclassified"] += fund_value
                add_exposure(
                    isin="",
                    ticker=ticker,
                    name=ticker,
                    country="Unclassified",
                    value=fund_value,
                    direct=True,
                    gics_eligible=False,
                    security_type_hint="ETF",
                )
                continue
            weight_total = snapshot.weight_total_pct()
            if not math.isclose(weight_total, 100.0, abs_tol=0.2):
                warning = (
                    f"{ticker}: constituent weights reconcile to {weight_total:.2f}%, not 100%"
                )
                warnings.append(warning)
                country_values["Unclassified"] += fund_value
                industry_values["Unclassified"] += fund_value
                add_exposure(
                    isin="",
                    ticker=ticker,
                    name=ticker,
                    country="Unclassified",
                    value=fund_value,
                    direct=True,
                    gics_eligible=False,
                    security_type_hint="ETF",
                )
                continue
            country_weights = dict(snapshot.country_weights)
            industry_weights = dict(snapshot.industry_weights)
            if not country_weights:
                for holding in snapshot.holdings:
                    country_weights[holding.country or "Unclassified"] = (
                        country_weights.get(holding.country or "Unclassified", 0)
                        + holding.weight_pct
                    )
            if not industry_weights:
                for holding in snapshot.holdings:
                    industry = holding.industry or "Unclassified"
                    industry_weights[industry] = (
                        industry_weights.get(industry, 0) + holding.weight_pct
                    )
            for country, weight in country_weights.items():
                country_values[country or "Unclassified"] += fund_value * weight / 100
            for industry, weight in industry_weights.items():
                industry_values[industry or "Unclassified"] += fund_value * weight / 100
            for holding in snapshot.holdings:
                if not holding.is_security:
                    continue
                value = fund_value * holding.weight_pct / 100
                indirect_value += value
                add_exposure(
                    isin=holding.isin,
                    ticker=holding.ticker,
                    name=holding.name,
                    country=holding.country,
                    value=value,
                    direct=False,
                    fund_ticker=ticker,
                    figi=holding.figi,
                    composite_figi=holding.composite_figi,
                    share_class_figi=holding.share_class_figi,
                    gics_eligible=holding.is_equity,
                    security_type_hint=("EQUITY" if holding.is_equity else holding.asset_class),
                )
            sources.append(
                {
                    "ticker": ticker,
                    "status": "verified",
                    "asOf": snapshot.as_of,
                    "industryAsOf": snapshot.industry_as_of or snapshot.as_of,
                    "sourceUrl": snapshot.source_url,
                    "issuer": snapshot.issuer,
                    "holdingsCount": len(snapshot.holdings),
                    "weightTotalPct": weight_total,
                    "positionValueGbp": _clean(fund_value),
                }
            )

        covered_value = direct_value + indirect_value
        residual = invested_value - sum(country_values.values())
        if abs(residual) > 0.05:
            country_values["Unclassified"] += residual
        residual = invested_value - sum(industry_values.values())
        if abs(residual) > 0.05:
            industry_values["Unclassified"] += residual

        output_positions: list[dict[str, Any]] = []
        gics_sub_industry_values: defaultdict[
            tuple[str, str, str],
            float,
        ] = defaultdict(float)
        gics_classified_value = 0.0
        gics_eligible_value = 0.0
        gics_pending_value = 0.0
        gics_not_applicable_value = 0.0
        for record in exposures.values():
            total = record["directValueGbp"] + record["indirectValueGbp"]
            gics = record["gics"] if isinstance(record["gics"], Mapping) else {}
            sub_industry_code = str(gics.get("subIndustryCode") or "")
            sub_industry_name = str(gics.get("subIndustryName") or "")
            if sub_industry_code and sub_industry_name:
                gics_classified_value += total
                gics_eligible_value += total
                classification_status = "classified"
                gics_key = (
                    sub_industry_code,
                    sub_industry_name,
                    classification_status,
                )
            elif bool(record["gicsEligible"]):
                gics_eligible_value += total
                gics_pending_value += total
                classification_status = (
                    "pending-identity"
                    if record["resolutionMethod"] == "unresolved"
                    else "pending-classification"
                )
                gics_key = ("", "Pending classification", classification_status)
            else:
                gics_not_applicable_value += total
                classification_status = "not-applicable"
                gics_key = ("", "Not GICS applicable", classification_status)
            gics_sub_industry_values[gics_key] += total
            contributors = [
                {"ticker": ticker, "valueGbp": _clean(value)}
                for ticker, value in sorted(
                    record["etfValues"].items(),
                    key=lambda item: item[1],
                    reverse=True,
                )
                if value > 0.005
            ]
            output_positions.append(
                {
                    "entityId": record["entityId"],
                    "isin": record["isin"],
                    "ticker": record["ticker"],
                    "name": record["name"],
                    "country": record["country"],
                    "resolutionMethod": record["resolutionMethod"],
                    "resolutionConfidence": record["resolutionConfidence"],
                    "identitySource": record["identitySource"],
                    "securityType": record["securityType"],
                    "gicsStatus": classification_status,
                    "gics": record["gics"],
                    "valueGbp": _clean(total),
                    "allocationPct": total / invested_value,
                    "directValueGbp": _clean(record["directValueGbp"]),
                    "indirectValueGbp": _clean(record["indirectValueGbp"]),
                    "etfContributors": contributors,
                }
            )
        output_positions.sort(key=lambda item: item["valueGbp"], reverse=True)
        gics_residual = invested_value - sum(gics_sub_industry_values.values())
        if abs(gics_residual) > 0.05:
            gics_not_applicable_value += gics_residual
            gics_sub_industry_values[("", "Not GICS applicable", "not-applicable")] += gics_residual
        as_of_values = [
            str(accounts.get(profile, {}).get("fetched_at") or "") for profile in ("invest", "isa")
        ]
        return {
            "schemaVersion": 5,
            "available": True,
            "generatedAt": datetime.now(UTC).isoformat(),
            "brokerAsOf": max(as_of_values, default=""),
            "investedValueGbp": _clean(invested_value),
            "cashValueGbp": _clean(cash_value),
            "directValueGbp": _clean(direct_value),
            "etfValueGbp": _clean(etf_value),
            "lookthroughValueGbp": _clean(covered_value),
            "nonSecurityValueGbp": _clean(invested_value - covered_value),
            "lookthroughCoveragePct": covered_value / invested_value,
            "underlyingCount": len(output_positions),
            "countryBasis": "country of risk / official fund geography",
            "countryAllocation": _allocation(
                country_values,
                invested_value,
                dimension="country",
            ),
            "industryBasis": ("official fund sector allocation / direct equity classification"),
            "industryAllocation": _allocation(
                industry_values,
                invested_value,
                dimension="industry",
            ),
            "gicsSubIndustryBasis": (
                "GICS sub-industry assigned by the dynamic security master; "
                "pending equity and non-applicable fund residual are explicit"
            ),
            "gicsCoveragePct": (
                gics_classified_value / gics_eligible_value if gics_eligible_value else 0.0
            ),
            "gicsPortfolioCoveragePct": gics_classified_value / invested_value,
            "gicsEligibleValueGbp": _clean(gics_eligible_value),
            "gicsClassifiedValueGbp": _clean(gics_classified_value),
            "gicsPendingValueGbp": _clean(gics_pending_value),
            "gicsNotApplicableValueGbp": _clean(gics_not_applicable_value),
            "gicsSubIndustryAllocation": _gics_sub_industry_allocation(
                gics_sub_industry_values,
                invested_value,
            ),
            "positions": output_positions,
            "sources": sources,
            "warnings": list(dict.fromkeys(warnings)),
        }


__all__ = [
    "FundHolding",
    "FundHoldingsProvider",
    "FundSnapshot",
    "LookthroughService",
    "RawFundHoldingsProvider",
]
