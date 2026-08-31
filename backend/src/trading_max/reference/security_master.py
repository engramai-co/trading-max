"""Deterministic issuer entity resolution and GICS lookup.

Instrument identity and issuer identity are deliberately separate:

* an ISIN, FIGI, share-class FIGI or listing ticker identifies a security;
* an entity ID identifies the economic issuer whose exposure is aggregated;
* GICS metadata belongs to that issuer and always carries source/version data.

The calculation layer never performs a network lookup. External adapters may
enrich ``reference/security-master.json`` ahead of a refresh; portfolio jobs
then consume the versioned catalog deterministically.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Literal, Protocol

from pydantic import Field

from trading_max.domain import DomainModel

ResolutionMethod = Literal[
    "isin",
    "figi",
    "share-class-figi",
    "composite-figi",
    "ticker",
    "name",
    "unresolved",
]
GicsEligibility = Literal["eligible", "not-applicable", "pending"]


class GicsClassification(DomainModel):
    """Four-level GICS classification with auditable provenance."""

    sector_code: str
    sector_name: str
    industry_group_code: str = ""
    industry_group_name: str = ""
    industry_code: str = ""
    industry_name: str = ""
    sub_industry_code: str = ""
    sub_industry_name: str = ""
    source: str
    version: str
    as_of: str = ""
    method: Literal["official", "derived", "manual"] = "derived"
    confidence: float = Field(default=1.0, ge=0, le=1)


class SecurityDescriptor(DomainModel):
    """Identifiers observed on one broker or fund-holdings record."""

    ticker: str = ""
    name: str = ""
    exchange: str = ""
    mic: str = ""
    isin: str = ""
    figi: str = ""
    composite_figi: str = ""
    share_class_figi: str = ""
    country: str | None = None
    industry: str | None = None


class SecurityListingRecord(DomainModel):
    """One exchange listing observed for an economic issuer."""

    ticker: str = Field(min_length=1)
    exchange: str = ""
    mic: str = ""
    isin: str = ""
    figi: str = ""
    composite_figi: str = ""
    share_class_figi: str = ""
    source: str
    as_of: str = ""


class SecurityEntityRecord(DomainModel):
    """One canonical issuer and every exact identifier known to represent it."""

    entity_id: str = Field(min_length=1)
    canonical_ticker: str = Field(min_length=1)
    entity_name: str = Field(min_length=1)
    security_type: str = "UNKNOWN"
    provider_security_type: str = ""
    provider_security_type2: str = ""
    market_sector: str = ""
    gics_eligibility: GicsEligibility = "pending"
    country_of_risk: str | None = None
    ticker_aliases: list[str] = Field(default_factory=list)
    name_aliases: list[str] = Field(default_factory=list)
    isins: list[str] = Field(default_factory=list)
    figis: list[str] = Field(default_factory=list)
    composite_figis: list[str] = Field(default_factory=list)
    share_class_figis: list[str] = Field(default_factory=list)
    listings: list[SecurityListingRecord] = Field(default_factory=list)
    profile_sector: str | None = None
    profile_industry: str | None = None
    profile_industry_key: str | None = None
    profile_crosswalk_version: str = ""
    gics: GicsClassification | None = None
    source: str
    as_of: str = ""


class SecurityMasterCatalog(DomainModel):
    schema_version: int = 3
    as_of: str = ""
    records: list[SecurityEntityRecord] = Field(default_factory=list)


class ResolvedSecurityEntity(DomainModel):
    entity_id: str
    canonical_ticker: str
    entity_name: str
    security_type: str = "UNKNOWN"
    provider_security_type: str = ""
    provider_security_type2: str = ""
    market_sector: str = ""
    gics_eligibility: GicsEligibility = "pending"
    country_of_risk: str | None = None
    gics: GicsClassification | None = None
    method: ResolutionMethod
    confidence: float = Field(ge=0, le=1)
    source: str
    source_as_of: str = ""


class SecurityMasterResolver(Protocol):
    def resolve(self, security: SecurityDescriptor) -> ResolvedSecurityEntity:
        """Resolve one observed instrument to an economic issuer."""

    def gics_lookup(self, security: SecurityDescriptor) -> GicsClassification | None:
        """Return sourced GICS metadata for the resolved issuer, if known."""


def _identifier(value: str) -> str:
    return value.strip().upper()


def normalize_security_type(value: str) -> str:
    """Normalize a provider security-type label without constraining its vocabulary."""

    return " ".join(value.strip().upper().replace("_", " ").replace("-", " ").split())


def is_fund_instrument(
    *,
    quote_type: str = "",
    provider_security_type: str = "",
    provider_security_type2: str = "",
) -> bool:
    """Return whether open provider facts positively identify a pooled vehicle.

    This is a tolerant parser, not a provider enum. Unknown future values
    remain valid persisted data and are left unresolved until another fact
    positively identifies the instrument.
    """

    normalized = normalize_security_type(
        f"{quote_type} {provider_security_type} {provider_security_type2}"
    )
    return any(
        marker in normalized
        for marker in (
            "EXCHANGE TRADED",
            "OPEN END FUND",
            "CLOSED END FUND",
            "MUTUAL FUND",
            "INVESTMENT FUND",
            "UNIT TRUST",
            "ETF",
            "ETN",
            "ETP",
        )
    )


def is_issuer_equity(
    *,
    quote_type: str = "",
    provider_security_type: str = "",
    provider_security_type2: str = "",
    market_sector: str = "",
) -> bool:
    """Return whether provider facts positively identify company equity."""

    if is_fund_instrument(
        quote_type=quote_type,
        provider_security_type=provider_security_type,
        provider_security_type2=provider_security_type2,
    ):
        return False
    normalized_quote = normalize_security_type(quote_type)
    normalized_provider_type = normalize_security_type(
        f"{provider_security_type} {provider_security_type2}"
    )
    normalized_market_sector = normalize_security_type(market_sector)
    return (
        normalized_quote in {"EQUITY", "STOCK"}
        or normalized_market_sector == "EQUITY"
        or any(
            marker in normalized_provider_type
            for marker in (
                "COMMON STOCK",
                "PREFERRED STOCK",
                "DEPOSITARY RECEIPT",
                "REIT",
            )
        )
    )


def canonical_security_type(
    *,
    quote_type: str = "",
    provider_security_type: str = "",
    provider_security_type2: str = "",
    market_sector: str = "",
) -> str:
    """Return the stable coarse type used by portfolio routing.

    This is intentionally derived from provider metadata rather than a
    provider-value enum. Raw provider values remain available separately.

    Exact-identity metadata (for example OpenFIGI facts returned for an ISIN)
    outranks a market-search quote label. Global issuer tickers frequently
    collide with US-listed funds: ``PST`` can mean Poste Italiane on its home
    venue or a ProShares ETF in the US. A provider-confirmed ``Common Stock``
    must therefore win over a fuzzy Yahoo ``ETF`` quote match, while a
    provider-confirmed pooled vehicle still wins over a generic equity market
    sector.
    """

    normalized_quote = normalize_security_type(quote_type)
    normalized_market_sector = normalize_security_type(market_sector)

    # Raw security types attached to an exact identifier are stronger evidence
    # than a quote type discovered through ticker/name search.
    if is_fund_instrument(
        provider_security_type=provider_security_type,
        provider_security_type2=provider_security_type2,
    ):
        return "ETF"
    if is_issuer_equity(
        provider_security_type=provider_security_type,
        provider_security_type2=provider_security_type2,
    ):
        return "EQUITY"

    # Fall back to the independently resolved market profile only when the
    # exact-identity provider did not supply a decisive instrument type.
    if is_fund_instrument(quote_type=quote_type):
        return "ETF"
    if is_issuer_equity(
        quote_type=quote_type,
        market_sector=market_sector,
    ):
        return "EQUITY"
    return normalized_quote or normalized_market_sector or "UNKNOWN"


def infer_gics_eligibility(
    *,
    quote_type: str = "",
    provider_security_type: str = "",
    provider_security_type2: str = "",
    market_sector: str = "",
    has_gics: bool = False,
) -> GicsEligibility:
    """Translate provider metadata into the three GICS applicability states.

    Provider security-type values are deliberately not represented by a
    closed enum. OpenFIGI and market-data vendors may add values at any time;
    the raw values are persisted on the security-master record. Only
    provider facts that are unambiguous are collapsed here:

    * an existing sourced GICS assignment is eligible;
    * Yahoo's issuer-equity quote types are eligible;
    * funds and non-equity market sectors are not applicable;
    * everything else remains pending instead of being guessed.
    """

    if has_gics:
        return "eligible"
    normalized_provider_type = normalize_security_type(
        f"{provider_security_type} {provider_security_type2}"
    )
    normalized_market_sector = normalize_security_type(market_sector)
    canonical_type = canonical_security_type(
        quote_type=quote_type,
        provider_security_type=provider_security_type,
        provider_security_type2=provider_security_type2,
        market_sector=market_sector,
    )
    if canonical_type == "ETF":
        return "not-applicable"
    if canonical_type == "EQUITY":
        return "eligible"
    if normalized_market_sector and normalized_market_sector != "EQUITY":
        return "not-applicable"
    if normalized_provider_type:
        return "pending"
    return "pending"


_NAME_NOISE = re.compile(
    r"\b(?:CLASS|CL)\s*[A-Z0-9]+\b|\bADR\b|\bADS\b|\bORDINARY SHARES?\b",
    re.IGNORECASE,
)
_LEGAL_SUFFIX = re.compile(
    r"\b(?:INCORPORATED|INC|CORPORATION|CORP|PLC|LIMITED|LTD|SA|NV)\b",
    re.IGNORECASE,
)
_TRAILING_DENOMINATION = re.compile(
    r"""
    (?:
        \b(?:ORD(?:INARY)?\s+)?(?:NO\s+PAR\s+VALUE|NPV)
        |
        \b(?:AUD|CAD|CHF|DKK|EUR|GBP|GBX|HKD|JPY|NOK|SEK|USD)
        \s*[-+]?\d+(?:[.,]\d+)?
    )\s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)
_NON_ALNUM = re.compile(r"[^A-Z0-9]+")


def normalize_entity_name(value: str) -> str:
    """Normalize an issuer name for deterministic cross-listing resolution."""

    normalized = _NAME_NOISE.sub(" ", value)
    normalized = _TRAILING_DENOMINATION.sub(" ", normalized)
    normalized = _LEGAL_SUFFIX.sub(" ", normalized)
    return _NON_ALNUM.sub(" ", normalized.upper()).strip()


def _fallback_entity_id(security: SecurityDescriptor) -> str:
    identity = (
        _identifier(security.isin)
        or _identifier(security.figi)
        or "|".join(
            (
                _identifier(security.ticker),
                _identifier(security.exchange or security.mic),
                normalize_entity_name(security.name),
            )
        )
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    return f"unresolved:{digest}"


class CatalogSecurityMaster:
    """Resolve exact identifiers against a versioned local catalog."""

    def __init__(self, catalog: SecurityMasterCatalog) -> None:
        self.catalog = catalog
        self._exact_indexes: dict[str, dict[str, SecurityEntityRecord]] = {
            "isin": {},
            "figi": {},
            "share-class-figi": {},
            "composite-figi": {},
        }
        self._ticker_index: dict[str, list[SecurityEntityRecord]] = {}
        self._listing_index: dict[tuple[str, str], list[SecurityEntityRecord]] = {}
        self._name_index: dict[str, list[SecurityEntityRecord]] = {}
        for record in catalog.records:
            self._register_weak(self._ticker_index, record.canonical_ticker, record)
            for value in record.ticker_aliases:
                self._register_weak(self._ticker_index, value, record)
            for value in record.name_aliases:
                self._register_weak(
                    self._name_index,
                    normalize_entity_name(value),
                    record,
                )
            self._register_weak(
                self._name_index,
                normalize_entity_name(record.entity_name),
                record,
            )
            for value in record.isins:
                self._register_exact("isin", value, record)
            for value in record.figis:
                self._register_exact("figi", value, record)
            for value in record.share_class_figis:
                self._register_exact("share-class-figi", value, record)
            for value in record.composite_figis:
                self._register_exact("composite-figi", value, record)
            for listing in record.listings:
                self._register_weak(self._ticker_index, listing.ticker, record)
                for market in (listing.exchange, listing.mic):
                    normalized_market = _identifier(market)
                    if normalized_market:
                        self._register_weak(
                            self._listing_index,
                            (_identifier(listing.ticker), normalized_market),
                            record,
                        )
                for dimension, value in (
                    ("isin", listing.isin),
                    ("figi", listing.figi),
                    ("share-class-figi", listing.share_class_figi),
                    ("composite-figi", listing.composite_figi),
                ):
                    self._register_exact(dimension, value, record)

    @staticmethod
    def _register_weak(
        index: dict[object, list[SecurityEntityRecord]],
        value: object,
        record: SecurityEntityRecord,
    ) -> None:
        normalized: object
        if isinstance(value, tuple):
            normalized = tuple(_identifier(str(part)) for part in value)
            if not all(normalized):
                return
        else:
            normalized = _identifier(str(value))
            if not normalized:
                return
        records = index.setdefault(normalized, [])
        if all(item.entity_id != record.entity_id for item in records):
            records.append(record)

    def _register_exact(
        self,
        dimension: str,
        value: str,
        record: SecurityEntityRecord,
    ) -> None:
        normalized = _identifier(value)
        if not normalized:
            return
        existing = self._exact_indexes[dimension].get(normalized)
        if existing is not None and existing.entity_id != record.entity_id:
            raise ValueError(
                f"security-master conflict for {dimension} {normalized}: "
                f"{existing.entity_id} vs {record.entity_id}"
            )
        self._exact_indexes[dimension][normalized] = record

    @classmethod
    def default(cls) -> CatalogSecurityMaster:
        """Return an empty catalog; company assignments are discovered at runtime."""

        return cls(SecurityMasterCatalog(schema_version=3))

    @classmethod
    def from_state_root(cls, state_root: Path) -> CatalogSecurityMaster:
        state_root = state_root.expanduser().resolve()
        reference_root = state_root / "reference"
        catalogs: list[SecurityMasterCatalog] = []
        for filename in ("security-master.json", "security-master-overrides.json"):
            path = reference_root / filename
            if not path.is_file():
                continue
            raw = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(raw, Mapping):
                raise ValueError(f"security-master catalog is not an object: {path}")
            catalogs.append(SecurityMasterCatalog.model_validate(raw))
        merged: dict[str, SecurityEntityRecord] = {}
        for catalog in catalogs:
            merged.update({record.entity_id: record for record in catalog.records})
        return cls(
            SecurityMasterCatalog(
                schema_version=max(
                    (catalog.schema_version for catalog in catalogs),
                    default=3,
                ),
                as_of=max((catalog.as_of for catalog in catalogs), default=""),
                records=list(merged.values()),
            )
        )

    def _match(
        self,
        security: SecurityDescriptor,
    ) -> tuple[SecurityEntityRecord, ResolutionMethod] | None:
        exact_candidates: tuple[tuple[str, str, ResolutionMethod], ...] = (
            ("isin", security.isin, "isin"),
            ("figi", security.figi, "figi"),
            ("share-class-figi", security.share_class_figi, "share-class-figi"),
            ("composite-figi", security.composite_figi, "composite-figi"),
        )
        for index, value, method in exact_candidates:
            record = self._exact_indexes[index].get(_identifier(value))
            if record is not None:
                return record, method

        ticker = _identifier(security.ticker)
        market = _identifier(security.mic or security.exchange)
        if ticker and market:
            listing_candidates = self._listing_index.get((ticker, market), [])
            if len(listing_candidates) == 1:
                return listing_candidates[0], "ticker"

        ticker_candidates = self._ticker_index.get(ticker, []) if ticker else []
        if len(ticker_candidates) == 1:
            return ticker_candidates[0], "ticker"

        normalized_name = normalize_entity_name(security.name)
        name_candidates = self._name_index.get(normalized_name, []) if normalized_name else []
        if len(name_candidates) == 1:
            return name_candidates[0], "name"

        if ticker_candidates and normalized_name:
            narrowed = [
                record
                for record in ticker_candidates
                if normalize_entity_name(record.entity_name) == normalized_name
                or normalized_name
                in {normalize_entity_name(alias) for alias in record.name_aliases}
            ]
            if len(narrowed) == 1:
                return narrowed[0], "name"
        return None

    def resolve(self, security: SecurityDescriptor) -> ResolvedSecurityEntity:
        matched = self._match(security)
        if matched is not None:
            record, method = matched
            confidence = 0.95 if method == "name" else 1.0
            return ResolvedSecurityEntity(
                entity_id=record.entity_id,
                canonical_ticker=record.canonical_ticker,
                entity_name=record.entity_name,
                security_type=record.security_type,
                provider_security_type=record.provider_security_type,
                provider_security_type2=record.provider_security_type2,
                market_sector=record.market_sector,
                gics_eligibility=(
                    record.gics_eligibility
                    if record.gics_eligibility != "pending"
                    else infer_gics_eligibility(
                        quote_type=record.security_type,
                        provider_security_type=record.provider_security_type,
                        provider_security_type2=record.provider_security_type2,
                        market_sector=record.market_sector,
                        has_gics=record.gics is not None,
                    )
                ),
                country_of_risk=record.country_of_risk or security.country,
                gics=record.gics,
                method=method,
                confidence=confidence,
                source=record.source,
                source_as_of=record.as_of,
            )
        ticker = _identifier(security.ticker)
        name = security.name.strip() or ticker or security.isin
        return ResolvedSecurityEntity(
            entity_id=_fallback_entity_id(security),
            canonical_ticker=ticker,
            entity_name=name,
            security_type="UNKNOWN",
            gics_eligibility="pending",
            country_of_risk=security.country,
            method="unresolved",
            confidence=0.0,
            source="unresolved",
        )

    def gics_lookup(self, security: SecurityDescriptor) -> GicsClassification | None:
        return self.resolve(security).gics


__all__ = [
    "CatalogSecurityMaster",
    "GicsClassification",
    "GicsEligibility",
    "ResolvedSecurityEntity",
    "SecurityDescriptor",
    "SecurityEntityRecord",
    "SecurityListingRecord",
    "SecurityMasterCatalog",
    "SecurityMasterResolver",
    "canonical_security_type",
    "infer_gics_eligibility",
    "normalize_entity_name",
    "normalize_security_type",
]
