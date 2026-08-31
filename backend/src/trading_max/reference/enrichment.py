"""Dynamic security identity and business-profile enrichment.

The provider boundary is online; the resulting catalog is durable and the
portfolio calculation layer remains deterministic.  Resolution is ISIN-first,
then ticker, then issuer name.  Existing high-confidence records survive
provider failures (stale-on-error) instead of being overwritten with blanks.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from collections.abc import Iterable, Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Protocol

import httpx
import yfinance as yf
from pydantic import Field

from trading_max.domain import DomainModel

from .security_master import (
    CatalogSecurityMaster,
    GicsEligibility,
    SecurityDescriptor,
    SecurityEntityRecord,
    SecurityListingRecord,
    SecurityMasterCatalog,
    canonical_security_type,
    infer_gics_eligibility,
    is_fund_instrument,
    normalize_entity_name,
)
from .taxonomy import PROFILE_CROSSWALK_VERSION, classification_for_profile


class EnrichmentCandidate(DomainModel):
    security: SecurityDescriptor
    exposure_gbp: float = Field(default=0.0, ge=0)
    gics_eligibility_hint: GicsEligibility = "pending"


class MarketSecurityProfile(DomainModel):
    symbol: str
    name: str
    quote_type: str = ""
    provider_security_type: str = ""
    provider_security_type2: str = ""
    market_sector: str = ""
    exchange: str = ""
    mic: str = ""
    figi: str = ""
    composite_figi: str = ""
    share_class_figi: str = ""
    country: str | None = None
    sector: str | None = None
    industry: str | None = None
    sector_key: str | None = None
    industry_key: str | None = None
    source: str = "yahoo-finance"
    as_of: str


class SecurityProfileProvider(Protocol):
    def resolve(self, security: SecurityDescriptor) -> MarketSecurityProfile | None:
        """Resolve one observed instrument and return its business profile."""


class SecurityIdentity(DomainModel):
    """Provider-resolved instrument identity, independent of company fundamentals."""

    symbol: str = ""
    name: str = ""
    exchange: str = ""
    figi: str = ""
    composite_figi: str = ""
    share_class_figi: str = ""
    provider_security_type: str = ""
    provider_security_type2: str = ""
    market_sector: str = ""
    source: str
    as_of: str


class SecurityIdentityProvider(Protocol):
    def resolve_many(
        self,
        securities: Iterable[SecurityDescriptor],
    ) -> dict[str, SecurityIdentity]:
        """Resolve exact identifiers in batches without relying on a ticker universe."""


class NoopSecurityIdentityProvider:
    def resolve_many(
        self,
        securities: Iterable[SecurityDescriptor],
    ) -> dict[str, SecurityIdentity]:
        del securities
        return {}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _query_candidates(security: SecurityDescriptor) -> tuple[str, ...]:
    values = (security.isin, security.ticker, security.name)
    return tuple(dict.fromkeys(value.strip() for value in values if value.strip()))


def _name_similarity(left: str, right: str) -> float:
    normalized_left = normalize_entity_name(left)
    normalized_right = normalize_entity_name(right)
    if not normalized_left or not normalized_right:
        return 0.0
    if normalized_left == normalized_right:
        return 1.0
    left_tokens = set(normalized_left.split())
    right_tokens = set(normalized_right.split())
    token_score = (
        len(left_tokens & right_tokens) / len(left_tokens | right_tokens)
        if left_tokens and right_tokens
        else 0.0
    )
    return max(
        token_score,
        SequenceMatcher(None, normalized_left, normalized_right).ratio(),
    )


OPENFIGI_MAPPING_URL = "https://api.openfigi.com/v3/mapping"
_YAHOO_LISTING_SUFFIX = re.compile(r"\.[A-Z0-9-]+$", re.IGNORECASE)


class OpenFigiSecurityIdentityProvider:
    """Batch-map ISIN/FIGI identifiers into durable, provider-sourced identity."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        timeout: float = 20.0,
        max_retries: int = 3,
    ) -> None:
        self.api_key = (
            api_key
            if api_key is not None
            else os.getenv(
                "TRADING_MAX_OPENFIGI_API_KEY",
                "",
            )
        )
        self.timeout = timeout
        self.max_retries = max_retries

    @staticmethod
    def _job(security: SecurityDescriptor) -> dict[str, str] | None:
        if security.isin.strip():
            return {"idType": "ID_ISIN", "idValue": security.isin.strip().upper()}
        for value in (
            security.figi,
            security.composite_figi,
            security.share_class_figi,
        ):
            if value.strip():
                return {"idType": "ID_BB_GLOBAL", "idValue": value.strip().upper()}
        return None

    @staticmethod
    def _select_row(
        security: SecurityDescriptor,
        rows: Iterable[Mapping[str, Any]],
    ) -> Mapping[str, Any] | None:
        expected_ticker = security.ticker.strip().upper()
        expected_market = (security.mic or security.exchange).strip().upper()
        scored: list[tuple[float, Mapping[str, Any]]] = []
        for row in rows:
            symbol = _text(row.get("ticker")).upper()
            if not symbol:
                continue
            exchange = _text(row.get("exchCode")).upper()
            score = _name_similarity(security.name, _text(row.get("name"))) * 80
            if expected_ticker and symbol == expected_ticker:
                score += 100
            if expected_market and exchange == expected_market:
                score += 40
            if _text(row.get("marketSector")).upper() == "EQUITY":
                score += 10
            scored.append((score, row))
        if not scored:
            return None
        scored.sort(
            key=lambda item: (
                item[0],
                bool(_text(item[1].get("compositeFIGI"))),
                bool(_text(item[1].get("shareClassFIGI"))),
            ),
            reverse=True,
        )
        return scored[0][1]

    def _post(self, jobs: list[dict[str, str]]) -> list[Mapping[str, Any]]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Trading Max security-master/1",
        }
        if self.api_key:
            headers["X-OPENFIGI-APIKEY"] = self.api_key
        for attempt in range(self.max_retries):
            response = httpx.post(
                OPENFIGI_MAPPING_URL,
                json=jobs,
                headers=headers,
                timeout=self.timeout,
            )
            if response.status_code != 429:
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, list):
                    raise ValueError("OpenFIGI mapping response is not an array")
                return [item if isinstance(item, Mapping) else {} for item in payload]
            if attempt + 1 >= self.max_retries:
                response.raise_for_status()
            reset = response.headers.get("ratelimit-reset") or response.headers.get(
                "retry-after",
                "1",
            )
            try:
                delay = max(min(float(reset), 10.0), 0.25)
            except ValueError:
                delay = 1.0
            time.sleep(delay)
        return []

    def resolve_many(
        self,
        securities: Iterable[SecurityDescriptor],
    ) -> dict[str, SecurityIdentity]:
        keyed_jobs: list[tuple[str, SecurityDescriptor, dict[str, str]]] = []
        seen: set[str] = set()
        for security in securities:
            key = _identity_key(security)
            job = self._job(security)
            if not key or job is None or key in seen:
                continue
            seen.add(key)
            keyed_jobs.append((key, security, job))
        if not keyed_jobs:
            return {}
        batch_size = 100 if self.api_key else 10
        resolved: dict[str, SecurityIdentity] = {}
        as_of = datetime.now(UTC).date().isoformat()
        for start in range(0, len(keyed_jobs), batch_size):
            batch = keyed_jobs[start : start + batch_size]
            try:
                responses = self._post([item[2] for item in batch])
            except (httpx.HTTPError, ValueError):
                continue
            for (key, security, _), response in zip(batch, responses, strict=False):
                rows = response.get("data")
                if not isinstance(rows, list):
                    continue
                row = self._select_row(
                    security,
                    (item for item in rows if isinstance(item, Mapping)),
                )
                if row is None:
                    continue
                resolved[key] = SecurityIdentity(
                    symbol=_text(row.get("ticker")).upper(),
                    name=_text(row.get("name")) or security.name,
                    exchange=_text(row.get("exchCode")),
                    figi=_text(row.get("figi")).upper(),
                    composite_figi=_text(row.get("compositeFIGI")).upper(),
                    share_class_figi=_text(row.get("shareClassFIGI")).upper(),
                    provider_security_type=_text(row.get("securityType")),
                    provider_security_type2=_text(row.get("securityType2")),
                    market_sector=_text(row.get("marketSector")),
                    source="openfigi-v3",
                    as_of=as_of,
                )
        return resolved


class YahooFinanceSecurityProfileProvider:
    """Resolve global securities using Yahoo search and profile endpoints."""

    def __init__(self, *, max_search_results: int = 10) -> None:
        self.max_search_results = max_search_results

    @staticmethod
    def _symbol_root(value: str) -> str:
        """Return the provider-neutral part of a Yahoo listing symbol.

        OpenFIGI commonly returns a local exchange ticker such as ``BMW`` or
        ``9999``, while Yahoo appends a venue suffix such as ``BMW.DE`` or
        ``9999.HK``. The suffix is provider routing metadata, not issuer
        identity.
        """

        return _YAHOO_LISTING_SUFFIX.sub("", value.strip().upper())

    @staticmethod
    def _profile_completeness(row: Mapping[str, Any]) -> int:
        return sum(
            bool(_text(row.get(field))) for field in ("sector", "industry", "longname", "shortname")
        )

    def _search_row(self, security: SecurityDescriptor) -> Mapping[str, Any] | None:
        expected_isin = security.isin.strip().upper()
        expected_ticker = security.ticker.strip().upper()
        expected_ticker_root = self._symbol_root(expected_ticker)
        expected_market = (security.mic or security.exchange).strip().upper()
        candidates: dict[tuple[str, str], tuple[float, Mapping[str, Any]]] = {}
        for query in _query_candidates(security):
            quotes = yf.Search(query, max_results=self.max_search_results).quotes
            security_rows = [row for row in quotes if _text(row.get("symbol"))]
            for row in security_rows:
                symbol = _text(row.get("symbol")).upper()
                symbol_root = self._symbol_root(symbol)
                exchange = (_text(row.get("exchange")) or _text(row.get("exchDisp"))).upper()
                row_name = _text(row.get("longname")) or _text(row.get("shortname"))
                name_similarity = _name_similarity(security.name, row_name)
                exact_symbol = bool(expected_ticker and symbol == expected_ticker)
                root_symbol = bool(expected_ticker_root and symbol_root == expected_ticker_root)
                # Yahoo search rows do not echo the queried ISIN. Never admit
                # a result merely because it was returned for that query or
                # because its profile is complete: issuer/ticker evidence is
                # required independently.
                if not (exact_symbol or root_symbol or name_similarity >= 0.65):
                    continue
                score = 0.0
                if exact_symbol:
                    score += 120
                elif root_symbol:
                    # Match a dynamically discovered local ticker to Yahoo's
                    # venue-qualified symbol without maintaining an exchange
                    # suffix table or company seed.
                    score += 90
                if expected_market and exchange == expected_market:
                    score += 40
                score += name_similarity * 80
                if expected_isin and query.strip().upper() == expected_isin:
                    # Yahoo may understand an ISIN query, but its search rows
                    # do not echo the ISIN. Treat that as supporting evidence,
                    # never as proof that the first result is the instrument.
                    score += 25
                    if symbol_root == expected_isin:
                        # Yahoo also exposes synthetic identifier symbols such
                        # as ``KYG...SG``. Prefer the actual exchange listing
                        # when issuer/ticker evidence is available.
                        score -= 40
                score += self._profile_completeness(row) * 5
                key = (symbol, exchange)
                current = candidates.get(key)
                if current is None or score > current[0]:
                    candidates[key] = (score, row)
        if not candidates:
            return None
        ordered = sorted(
            candidates.values(),
            key=lambda item: (
                item[0],
                self._profile_completeness(item[1]),
                _text(item[1].get("symbol")),
            ),
            reverse=True,
        )
        best_score, best = ordered[0]
        if best_score < 35:
            return None
        best_symbol = _text(best.get("symbol")).upper()
        best_name = _text(best.get("longname")) or _text(best.get("shortname"))
        if (
            expected_ticker_root
            and best_symbol != expected_ticker
            and self._symbol_root(best_symbol) == expected_ticker_root
        ):
            root_matches = [
                row
                for _, row in ordered
                if self._symbol_root(_text(row.get("symbol"))) == expected_ticker_root
            ]
            root_names = {
                normalize_entity_name(_text(row.get("longname")) or _text(row.get("shortname")))
                for row in root_matches
            } - {""}
            if len(root_names) > 1 and _name_similarity(security.name, best_name) < 0.7:
                return None
        if len(ordered) > 1 and best_score - ordered[1][0] < 5:
            first_symbol = best_symbol
            second_symbol = _text(ordered[1][1].get("symbol")).upper()
            first_name = best_name
            second = ordered[1][1]
            second_name = _text(second.get("longname")) or _text(second.get("shortname"))
            # Multiple venues for one issuer are safe because the security
            # master persists them as listings on one economic entity.
            # Similarly scored rows for different issuers remain unresolved.
            if first_symbol != second_symbol and _name_similarity(first_name, second_name) < 0.9:
                return None
        return best

    def resolve(self, security: SecurityDescriptor) -> MarketSecurityProfile | None:
        row = self._search_row(security)
        symbol = _text(row.get("symbol")) if row is not None else ""
        if not symbol:
            return None
        quote_type = _text(row.get("quoteType")).upper() if row is not None else ""
        search_sector = _text(row.get("sector")) if row is not None else ""
        search_industry = _text(row.get("industry")) if row is not None else ""
        if search_sector and search_industry:
            return MarketSecurityProfile(
                symbol=symbol,
                name=(
                    _text(row.get("longname"))
                    or _text(row.get("shortname"))
                    or security.name
                    or symbol
                ),
                quote_type=quote_type or "EQUITY",
                market_sector="Equity",
                exchange=(_text(row.get("exchDisp")) or _text(row.get("exchange"))),
                country=security.country,
                sector=search_sector,
                industry=search_industry,
                industry_key=search_industry,
                as_of=datetime.now(UTC).date().isoformat(),
            )
        if is_fund_instrument(quote_type=quote_type):
            return MarketSecurityProfile(
                symbol=symbol,
                name=(
                    _text(row.get("longname"))
                    or _text(row.get("shortname"))
                    or security.name
                    or symbol
                ),
                quote_type=quote_type,
                exchange=(_text(row.get("exchDisp")) or _text(row.get("exchange"))),
                country=security.country,
                as_of=datetime.now(UTC).date().isoformat(),
            )
        info = yf.Ticker(symbol).get_info()
        info_quote_type = _text(info.get("quoteType")).upper()
        return MarketSecurityProfile(
            symbol=_text(info.get("symbol")) or symbol,
            name=(
                _text(info.get("longName"))
                or _text(info.get("shortName"))
                or security.name
                or symbol
            ),
            quote_type=info_quote_type or quote_type,
            exchange=_text(info.get("exchange")),
            country=_text(info.get("country")) or security.country,
            sector=_text(info.get("sector")) or None,
            industry=_text(info.get("industry")) or None,
            sector_key=_text(info.get("sectorKey")) or None,
            industry_key=_text(info.get("industryKey")) or None,
            as_of=datetime.now(UTC).date().isoformat(),
        )


class SecurityMasterEnrichmentReport(DomainModel):
    schema_version: int = 3
    generated_at: datetime
    candidates: int
    request_budget: int
    attempted: int
    deferred: int
    enriched: int
    cached: int
    failed: int
    classified_exposure_gbp: float
    resolved_unclassified_exposure_gbp: float
    unresolved_exposure_gbp: float
    unexpanded_fund_exposure_gbp: float
    total_exposure_gbp: float
    gics_eligible_exposure_gbp: float
    gics_not_applicable_exposure_gbp: float
    classification_coverage_pct: float
    material_unclassified: list[dict[str, Any]] = Field(default_factory=list)
    material_unresolved: list[dict[str, Any]] = Field(default_factory=list)
    failures: list[dict[str, str]] = Field(default_factory=list)


def _identity_key(security: SecurityDescriptor) -> str:
    return (
        security.isin.strip().upper()
        or security.figi.strip().upper()
        or "|".join(
            (
                security.ticker.strip().upper(),
                (security.mic or security.exchange).strip().upper(),
                security.name.strip().upper(),
            )
        )
    )


def _entity_id(profile: MarketSecurityProfile, security: SecurityDescriptor) -> str:
    if (
        canonical_security_type(
            quote_type=profile.quote_type,
            provider_security_type=profile.provider_security_type,
            provider_security_type2=profile.provider_security_type2,
            market_sector=profile.market_sector,
        )
        == "ETF"
    ):
        identity = "|".join(
            (
                canonical_security_type(
                    quote_type=profile.quote_type,
                    provider_security_type=profile.provider_security_type,
                    provider_security_type2=profile.provider_security_type2,
                    market_sector=profile.market_sector,
                ),
                security.isin.strip().upper(),
                profile.symbol.strip().upper(),
            )
        )
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
        return f"fund:{digest}"
    identity = "|".join((normalize_entity_name(profile.name),))
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    return f"issuer:{digest}"


def _listing_record(
    profile: MarketSecurityProfile,
    security: SecurityDescriptor,
) -> SecurityListingRecord:
    return SecurityListingRecord(
        ticker=profile.symbol.strip().upper() or security.ticker.strip().upper(),
        exchange=profile.exchange or security.exchange,
        mic=profile.mic or security.mic,
        isin=security.isin.strip().upper(),
        figi=security.figi.strip().upper(),
        composite_figi=security.composite_figi.strip().upper(),
        share_class_figi=security.share_class_figi.strip().upper(),
        source=profile.source,
        as_of=profile.as_of,
    )


def _identity_profile(
    identity: SecurityIdentity,
    security: SecurityDescriptor,
) -> MarketSecurityProfile:
    canonical_type = canonical_security_type(
        provider_security_type=identity.provider_security_type,
        provider_security_type2=identity.provider_security_type2,
        market_sector=identity.market_sector,
    )
    return MarketSecurityProfile(
        symbol=identity.symbol or security.ticker,
        name=identity.name or security.name or identity.symbol or security.isin,
        quote_type=canonical_type,
        provider_security_type=identity.provider_security_type,
        provider_security_type2=identity.provider_security_type2,
        market_sector=identity.market_sector,
        exchange=identity.exchange or security.exchange,
        mic=security.mic,
        figi=identity.figi,
        composite_figi=identity.composite_figi,
        share_class_figi=identity.share_class_figi,
        country=security.country,
        source=identity.source,
        as_of=identity.as_of,
    )


def _atomic_catalog(path: Path, catalog: SecurityMasterCatalog) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                catalog.model_dump(mode="json", by_alias=True),
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


class SecurityMasterEnricher:
    """Incrementally enrich a durable catalog, prioritised by GBP exposure."""

    def __init__(
        self,
        state_root: Path,
        *,
        provider: SecurityProfileProvider | None = None,
        identity_provider: SecurityIdentityProvider | None = None,
        max_age: timedelta = timedelta(days=30),
        max_requests: int | None = None,
        target_coverage: float = 0.98,
        material_exposure_pct: float = 0.005,
        max_workers: int = 6,
    ) -> None:
        self.state_root = state_root.expanduser().resolve()
        self.catalog_path = self.state_root / "reference" / "security-master.json"
        self.provider = provider or YahooFinanceSecurityProfileProvider()
        self.identity_provider = (
            identity_provider
            if identity_provider is not None
            else (
                OpenFigiSecurityIdentityProvider()
                if provider is None
                else NoopSecurityIdentityProvider()
            )
        )
        self.max_age = max_age
        self.max_requests = (
            max_requests
            if max_requests is not None
            else int(
                os.environ.get(
                    "TRADING_MAX_SECURITY_PROFILE_REQUEST_BUDGET",
                    "1000",
                )
            )
        )
        if self.max_requests < 1:
            raise ValueError("security profile request budget must be positive")
        self.target_coverage = target_coverage
        self.material_exposure_pct = material_exposure_pct
        self.max_workers = max_workers

    def _local_catalog(self) -> SecurityMasterCatalog:
        if not self.catalog_path.is_file():
            return SecurityMasterCatalog(schema_version=3)
        return SecurityMasterCatalog.model_validate_json(
            self.catalog_path.read_text(encoding="utf-8")
        )

    def _is_fresh(self, record: SecurityEntityRecord) -> bool:
        if not record.as_of:
            return False
        try:
            as_of = datetime.fromisoformat(record.as_of).date()
        except ValueError:
            return False
        return datetime.now(UTC).date() - as_of <= self.max_age

    @staticmethod
    def _has_instrument_type_conflict(record: SecurityEntityRecord) -> bool:
        """Detect cached routing decisions contradicted by their raw evidence."""

        evidence_type = canonical_security_type(
            quote_type=record.security_type,
            provider_security_type=record.provider_security_type,
            provider_security_type2=record.provider_security_type2,
            market_sector=record.market_sector,
        )
        if evidence_type != record.security_type:
            return True
        evidence_eligibility = infer_gics_eligibility(
            quote_type=evidence_type,
            provider_security_type=record.provider_security_type,
            provider_security_type2=record.provider_security_type2,
            market_sector=record.market_sector,
            has_gics=record.gics is not None,
        )
        return evidence_eligibility != record.gics_eligibility

    @staticmethod
    def _merge_record(
        existing: SecurityEntityRecord | None,
        candidate: EnrichmentCandidate,
        profile: MarketSecurityProfile,
    ) -> SecurityEntityRecord:
        security = candidate.security
        repairs_type_conflict = (
            existing is not None and SecurityMasterEnricher._has_instrument_type_conflict(existing)
        )
        profile_sector = profile.sector or (existing.profile_sector if existing else None)
        profile_industry = profile.industry or (existing.profile_industry if existing else None)
        profile_industry_key = profile.industry_key or (
            existing.profile_industry_key if existing else None
        )
        gics = classification_for_profile(
            sector=profile_sector,
            industry=profile_industry,
            industry_key=profile_industry_key,
            as_of=profile.as_of,
        )
        aliases = {
            security.ticker.strip().upper(),
            profile.symbol.strip().upper(),
        }
        names = {
            security.name.strip(),
            profile.name.strip(),
        }
        if existing is not None and not repairs_type_conflict:
            aliases.update(existing.ticker_aliases)
            aliases.add(existing.canonical_ticker)
            names.update(existing.name_aliases)
            names.add(existing.entity_name)
        listings = [] if existing is None or repairs_type_conflict else list(existing.listings)
        listing = _listing_record(profile, security)
        listing_key = (
            listing.ticker,
            listing.exchange.strip().upper(),
            listing.mic.strip().upper(),
            listing.isin,
            listing.figi,
        )
        if all(
            (
                item.ticker,
                item.exchange.strip().upper(),
                item.mic.strip().upper(),
                item.isin,
                item.figi,
            )
            != listing_key
            for item in listings
        ):
            listings.append(listing)
        resolved_entity_id = _entity_id(profile, security)
        return SecurityEntityRecord(
            entity_id=(
                existing.entity_id
                if existing is not None and not repairs_type_conflict
                else resolved_entity_id
            ),
            canonical_ticker=(
                profile.symbol.strip().upper()
                or (existing.canonical_ticker if existing else "")
                or security.ticker.strip().upper()
            ),
            entity_name=profile.name or security.name or profile.symbol,
            security_type=canonical_security_type(
                quote_type=profile.quote_type,
                provider_security_type=(
                    profile.provider_security_type
                    or (existing.provider_security_type if existing else "")
                ),
                provider_security_type2=(
                    profile.provider_security_type2
                    or (existing.provider_security_type2 if existing else "")
                ),
                market_sector=profile.market_sector or (existing.market_sector if existing else ""),
            ),
            provider_security_type=(
                profile.provider_security_type
                or (existing.provider_security_type if existing else "")
            ),
            provider_security_type2=(
                profile.provider_security_type2
                or (existing.provider_security_type2 if existing else "")
            ),
            market_sector=profile.market_sector or (existing.market_sector if existing else ""),
            gics_eligibility=infer_gics_eligibility(
                quote_type=profile.quote_type,
                provider_security_type=(
                    profile.provider_security_type
                    or (existing.provider_security_type if existing else "")
                ),
                provider_security_type2=(
                    profile.provider_security_type2
                    or (existing.provider_security_type2 if existing else "")
                ),
                market_sector=profile.market_sector or (existing.market_sector if existing else ""),
                has_gics=gics is not None or bool(existing and existing.gics is not None),
            ),
            country_of_risk=(
                profile.country
                or (existing.country_of_risk if existing else None)
                or security.country
            ),
            ticker_aliases=sorted(value for value in aliases if value),
            name_aliases=sorted(value for value in names if value),
            isins=sorted(
                {
                    *([] if existing is None else existing.isins),
                    security.isin.strip().upper(),
                }
                - {""}
            ),
            figis=sorted(
                {
                    *([] if existing is None else existing.figis),
                    security.figi.strip().upper(),
                }
                - {""}
            ),
            composite_figis=sorted(
                {
                    *([] if existing is None else existing.composite_figis),
                    security.composite_figi.strip().upper(),
                }
                - {""}
            ),
            share_class_figis=sorted(
                {
                    *([] if existing is None else existing.share_class_figis),
                    security.share_class_figi.strip().upper(),
                }
                - {""}
            ),
            listings=sorted(
                listings,
                key=lambda item: (
                    item.ticker,
                    item.exchange,
                    item.mic,
                    item.isin,
                ),
            ),
            profile_sector=profile_sector,
            profile_industry=profile_industry,
            profile_industry_key=profile_industry_key,
            profile_crosswalk_version=PROFILE_CROSSWALK_VERSION,
            gics=gics or (existing.gics if existing else None),
            source=profile.source,
            as_of=profile.as_of,
        )

    @staticmethod
    def _with_identity(
        candidate: EnrichmentCandidate,
        identity: SecurityIdentity | None,
    ) -> EnrichmentCandidate:
        if identity is None:
            return candidate
        security = candidate.security
        return candidate.model_copy(
            update={
                "security": security.model_copy(
                    update={
                        "ticker": security.ticker or identity.symbol,
                        "name": identity.name or security.name,
                        "exchange": security.exchange or identity.exchange,
                        "figi": security.figi or identity.figi,
                        "composite_figi": (security.composite_figi or identity.composite_figi),
                        "share_class_figi": (
                            security.share_class_figi or identity.share_class_figi
                        ),
                    }
                )
            }
        )

    @staticmethod
    def _profile_with_identity(
        profile: MarketSecurityProfile,
        identity: SecurityIdentity | None,
    ) -> MarketSecurityProfile:
        if identity is None:
            return profile
        return profile.model_copy(
            update={
                # Yahoo owns the venue-qualified quote symbol used for market
                # profile lookup (for example ``9999.HK``). OpenFIGI often
                # returns the local ticker root (``9999``); it enriches exact
                # identifiers and provider types but must not downgrade the
                # successfully resolved Yahoo listing.
                "symbol": profile.symbol or identity.symbol,
                "name": profile.name or identity.name,
                "exchange": profile.exchange or identity.exchange,
                "figi": profile.figi or identity.figi,
                "composite_figi": profile.composite_figi or identity.composite_figi,
                "share_class_figi": (profile.share_class_figi or identity.share_class_figi),
                "provider_security_type": (
                    identity.provider_security_type or profile.provider_security_type
                ),
                "provider_security_type2": (
                    identity.provider_security_type2 or profile.provider_security_type2
                ),
                "market_sector": identity.market_sector or profile.market_sector,
                "source": (
                    f"{identity.source}+{profile.source}"
                    if identity.source not in profile.source
                    else profile.source
                ),
            }
        )

    def enrich(
        self,
        candidates: Iterable[EnrichmentCandidate],
        *,
        exhaustive: bool = False,
    ) -> SecurityMasterEnrichmentReport:
        merged_candidates: dict[str, EnrichmentCandidate] = {}
        for candidate in candidates:
            key = _identity_key(candidate.security)
            if not key:
                continue
            previous = merged_candidates.get(key)
            if previous is None:
                merged_candidates[key] = candidate
            else:
                previous_hint = previous.gics_eligibility_hint
                current_hint = candidate.gics_eligibility_hint
                merged_candidates[key] = previous.model_copy(
                    update={
                        "exposure_gbp": previous.exposure_gbp + candidate.exposure_gbp,
                        "gics_eligibility_hint": (
                            previous_hint if previous_hint == current_hint else "pending"
                        ),
                    }
                )
        ordered = sorted(
            merged_candidates.values(),
            key=lambda item: item.exposure_gbp,
            reverse=True,
        )
        resolver = CatalogSecurityMaster.from_state_root(self.state_root)
        records = {record.entity_id: record for record in resolver.catalog.records}
        reclassified: dict[str, SecurityEntityRecord] = {}
        for entity_id, record in records.items():
            if record.gics is not None and record.gics.method in {"official", "manual"}:
                # Licensed-provider and operator-reviewed assignments outrank
                # the public-profile crosswalk. A refresh must never silently
                # downgrade authoritative reference data to a derived value.
                reclassified[entity_id] = record
                continue
            if not record.profile_industry:
                reclassified[entity_id] = record
                continue
            current = classification_for_profile(
                sector=record.profile_sector,
                industry=record.profile_industry,
                industry_key=record.profile_industry_key,
                as_of=record.as_of,
            )
            reclassified[entity_id] = record.model_copy(
                update={
                    "gics": current,
                    "profile_crosswalk_version": PROFILE_CROSSWALK_VERSION,
                }
            )
        records = reclassified
        resolver = CatalogSecurityMaster(
            SecurityMasterCatalog(
                schema_version=3,
                records=list(records.values()),
            )
        )
        total_exposure = sum(candidate.exposure_gbp for candidate in ordered)
        classified_exposure = 0.0
        attempted = deferred = enriched = cached = failed = 0
        failures: list[dict[str, str]] = []

        pending: list[tuple[EnrichmentCandidate, SecurityEntityRecord | None]] = []
        for candidate in ordered:
            resolved = resolver.resolve(candidate.security)
            existing = records.get(resolved.entity_id)
            requires_type_repair = (
                existing is not None
                and self._has_instrument_type_conflict(existing)
                and not (
                    existing.gics is not None and existing.gics.method in {"official", "manual"}
                )
            )
            if requires_type_repair:
                pending.append((candidate, existing))
                continue
            requires_identity_backfill = (
                existing is not None
                and not (
                    existing.gics is not None and existing.gics.method in {"official", "manual"}
                )
                and bool(
                    candidate.security.isin
                    or candidate.security.figi
                    or candidate.security.composite_figi
                    or candidate.security.share_class_figi
                )
                and not (
                    existing.provider_security_type
                    or existing.provider_security_type2
                    or existing.market_sector
                )
            )
            if requires_identity_backfill:
                pending.append((candidate, existing))
                continue
            if resolved.gics is not None and existing is not None and self._is_fresh(existing):
                classified_exposure += candidate.exposure_gbp
                cached += 1
                continue
            if (
                existing is not None
                and existing.gics_eligibility == "not-applicable"
                and self._is_fresh(existing)
            ):
                cached += 1
                continue
            if existing is not None and existing.profile_industry and self._is_fresh(existing):
                # The provider profile was resolved successfully but the
                # current versioned crosswalk has no GICS node for it. Keep
                # the explicit unclassified state until either the profile or
                # crosswalk version changes; do not spend the request budget
                # fetching the same metadata on every refresh.
                cached += 1
                continue
            pending.append((candidate, existing))

        # Exact-identity enrichment must obey the same per-run request budget
        # as profile enrichment.  A fresh portfolio can expand a handful of
        # ETFs into thousands of constituents; sending that entire universe to
        # the unauthenticated OpenFIGI adapter before applying ``max_requests``
        # makes first-run onboarding appear hung for tens of minutes.  The
        # remaining candidates stay deferred and converge through the durable
        # catalog on later refreshes.
        identity_pending = pending[: self.max_requests]
        identities: dict[str, SecurityIdentity] = {}
        try:
            identities = self.identity_provider.resolve_many(
                candidate.security for candidate, _ in identity_pending
            )
        except Exception:
            # Identity enrichment is additive. Yahoo remains an independent
            # fallback and durable catalog rows remain stale-on-error.
            identities = {}
        identity_by_enriched_key: dict[str, SecurityIdentity] = {}
        enriched_pending: list[tuple[EnrichmentCandidate, SecurityEntityRecord | None]] = []
        for candidate, existing in pending:
            identity = identities.get(_identity_key(candidate.security))
            enriched_candidate = self._with_identity(candidate, identity)
            enriched_pending.append((enriched_candidate, existing))
            if identity is not None:
                identity_by_enriched_key[_identity_key(enriched_candidate.security)] = identity
        pending = enriched_pending

        cursor = 0
        batch_size = max(self.max_workers * 4, 1)
        while cursor < len(pending):
            if attempted >= self.max_requests or (
                not exhaustive
                and total_exposure > 0
                and classified_exposure / total_exposure >= self.target_coverage
            ):
                break
            batch = pending[
                cursor : min(
                    cursor + batch_size,
                    cursor + self.max_requests - attempted,
                )
            ]
            profiles: dict[str, MarketSecurityProfile | Exception | None] = {}
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                futures = {
                    executor.submit(
                        self.provider.resolve,
                        candidate.security,
                    ): _identity_key(candidate.security)
                    for candidate, _ in batch
                }
                for future in as_completed(futures):
                    key = futures[future]
                    try:
                        profiles[key] = future.result()
                    except Exception as exc:
                        profiles[key] = exc

            attempted += len(batch)
            cursor += len(batch)
            for candidate, existing in batch:
                identity = identity_by_enriched_key.get(_identity_key(candidate.security))
                enriched_candidate = candidate
                result = profiles.get(_identity_key(candidate.security))
                try:
                    if isinstance(result, Exception) and identity is None:
                        raise result
                    profile = result if not isinstance(result, Exception) else None
                    if profile is None:
                        if identity is None:
                            raise LookupError("provider returned no security profile")
                        profile = _identity_profile(identity, enriched_candidate.security)
                    profile = self._profile_with_identity(profile, identity)
                    provisional_entity_id = (
                        existing.entity_id
                        if existing
                        else _entity_id(profile, enriched_candidate.security)
                    )
                    existing = records.get(provisional_entity_id) or existing
                    updated = self._merge_record(existing, enriched_candidate, profile)
                    if existing is not None and existing.entity_id != updated.entity_id:
                        records.pop(existing.entity_id, None)
                    records[updated.entity_id] = updated
                    if updated.gics is not None:
                        classified_exposure += candidate.exposure_gbp
                    enriched += 1
                except Exception as exc:
                    failed += 1
                    failures.append(
                        {
                            "ticker": candidate.security.ticker,
                            "isin": candidate.security.isin,
                            "error": str(exc),
                        }
                    )
        deferred = len(pending) - cursor

        as_of = datetime.now(UTC).date().isoformat()
        catalog = SecurityMasterCatalog(
            schema_version=3,
            as_of=as_of,
            records=sorted(records.values(), key=lambda record: record.entity_id),
        )
        _atomic_catalog(self.catalog_path, catalog)
        final_resolver = CatalogSecurityMaster.from_state_root(self.state_root)
        material_threshold = total_exposure * self.material_exposure_pct
        material_unclassified: list[dict[str, Any]] = []
        material_unresolved: list[dict[str, Any]] = []
        final_classified = 0.0
        gics_eligible_exposure = 0.0
        resolved_unclassified_exposure = 0.0
        unresolved_exposure = 0.0
        unexpanded_fund_exposure = 0.0
        gics_not_applicable_exposure = 0.0
        for candidate in ordered:
            resolved = final_resolver.resolve(candidate.security)
            effective_eligibility = (
                resolved.gics_eligibility
                if resolved.gics_eligibility != "pending"
                else candidate.gics_eligibility_hint
            )
            if resolved.gics is not None:
                final_classified += candidate.exposure_gbp
                gics_eligible_exposure += candidate.exposure_gbp
            elif effective_eligibility == "not-applicable":
                gics_not_applicable_exposure += candidate.exposure_gbp
                if is_fund_instrument(
                    quote_type=resolved.security_type,
                    provider_security_type=resolved.provider_security_type,
                    provider_security_type2=resolved.provider_security_type2,
                ):
                    unexpanded_fund_exposure += candidate.exposure_gbp
            elif resolved.method == "unresolved" or effective_eligibility == "pending":
                # Economic-exposure candidates originate from direct equity
                # positions or equity constituents. Identity resolution being
                # pending does not make them ineligible for GICS.
                gics_eligible_exposure += candidate.exposure_gbp
                if resolved.method == "unresolved":
                    unresolved_exposure += candidate.exposure_gbp
                else:
                    resolved_unclassified_exposure += candidate.exposure_gbp
            else:
                gics_eligible_exposure += candidate.exposure_gbp
                resolved_unclassified_exposure += candidate.exposure_gbp
            if (
                resolved.gics is None
                and effective_eligibility != "not-applicable"
                and candidate.exposure_gbp >= material_threshold
            ):
                material_unclassified.append(
                    {
                        "ticker": candidate.security.ticker or None,
                        "isin": candidate.security.isin or None,
                        "name": candidate.security.name,
                        "exposureGbp": round(candidate.exposure_gbp, 2),
                        "resolutionStatus": (
                            "unresolved" if resolved.method == "unresolved" else "profile-unmapped"
                        ),
                    }
                )
            if (
                resolved.method == "unresolved"
                and effective_eligibility != "not-applicable"
                and candidate.exposure_gbp >= material_threshold
            ):
                material_unresolved.append(
                    {
                        "ticker": candidate.security.ticker or None,
                        "isin": candidate.security.isin or None,
                        "name": candidate.security.name,
                        "exposureGbp": round(candidate.exposure_gbp, 2),
                    }
                )
        return SecurityMasterEnrichmentReport(
            generated_at=datetime.now(UTC),
            candidates=len(ordered),
            request_budget=self.max_requests,
            attempted=attempted,
            deferred=deferred,
            enriched=enriched,
            cached=cached,
            failed=failed,
            classified_exposure_gbp=round(final_classified, 2),
            resolved_unclassified_exposure_gbp=round(
                resolved_unclassified_exposure,
                2,
            ),
            unresolved_exposure_gbp=round(unresolved_exposure, 2),
            unexpanded_fund_exposure_gbp=round(unexpanded_fund_exposure, 2),
            total_exposure_gbp=round(total_exposure, 2),
            gics_eligible_exposure_gbp=round(gics_eligible_exposure, 2),
            gics_not_applicable_exposure_gbp=round(
                gics_not_applicable_exposure,
                2,
            ),
            classification_coverage_pct=(
                final_classified / gics_eligible_exposure if gics_eligible_exposure else 0.0
            ),
            material_unclassified=material_unclassified,
            material_unresolved=material_unresolved,
            failures=failures,
        )


__all__ = [
    "EnrichmentCandidate",
    "MarketSecurityProfile",
    "SecurityMasterEnricher",
    "SecurityMasterEnrichmentReport",
    "SecurityProfileProvider",
    "YahooFinanceSecurityProfileProvider",
]
