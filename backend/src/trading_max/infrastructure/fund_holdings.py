"""Official ETF constituent adapters with a durable normalized cache."""

from __future__ import annotations

import json
import math
import re
import tempfile
import time
from collections import defaultdict
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
import pandas as pd
from pypdf import PdfReader

from trading_max.analytics.lookthrough import FundHolding, FundSnapshot
from trading_max.reference import SecurityDescriptor

from .fund_catalogs import FundCatalog
from .fund_downloads import as_of_date, percentage
from .fund_specs import BUILTIN_FUND_ADAPTERS, FundSpec

ISHARES_API = (
    "https://www.ishares.com/varnish-api/uk-retail01-product-data/"
    "product-data/api/v2/get-product-data"
)
INVESCO_API = "https://dng-api.invesco.com/cache/v1/accounts/en_GB/shareclasses"
VANGUARD_API = "https://www.vanguard.co.uk/gpx/graphql"
HSBC_PRODUCT_URL = (
    "https://www.assetmanagement.hsbc.co.uk/en/individual-investor/funds/ie000kcs7j59"
)
HSBC_HOLDINGS_URL = (
    "https://www.assetmanagement.hsbc.co.uk/en/api/v1/download/document/ie000kcs7j59/gb/en/holdings"
)
HSBC_FACTSHEET_URL = (
    "https://www.assetmanagement.hsbc.co.uk/en/api/v1/download/document/"
    "ie000kcs7j59/gb/en/factsheet"
)
USER_AGENT = "TradingMax/1.0 (portfolio analytics; official issuer data)"

COUNTRY_ALIASES = {
    "Cash": "Cash & derivatives",
    "Cash & Others": "Cash & derivatives",
    "Cashand/orDerivatives": "Cash & derivatives",
    "Korea (South)": "South Korea",
    "Mainland China": "China",
    "None": "Cash & derivatives",
    "Other Locations": "Other markets",
    "UnitedKingdom": "United Kingdom",
    "UnitedStates": "United States",
}
INDUSTRY_ALIASES = {
    "Cash": "Cash & derivatives",
    "Cash & Others": "Cash & derivatives",
    "Cash and/or Derivatives": "Cash & derivatives",
    "Cashand/orDerivatives": "Cash & derivatives",
    "Communication": "Communication Services",
    "communicationServices": "Communication Services",
    "consumerDiscretionary": "Consumer Discretionary",
    "consumerStaples": "Consumer Staples",
    "energy": "Energy",
    "financials": "Financials",
    "healthCare": "Health Care",
    "informationTechnology": "Information Technology",
    "industrials": "Industrials",
    "materials": "Materials",
    "realEstate": "Real Estate",
    "utilities": "Utilities",
    "other": "Other industries",
    "Other": "Other industries",
}
ISIN_PREFIX_COUNTRIES = {
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
    "AT": "Austria",
    "BE": "Belgium",
    "CL": "Chile",
    "CO": "Colombia",
    "CZ": "Czech Republic",
    "DK": "Denmark",
    "ES": "Spain",
    "FI": "Finland",
    "GR": "Greece",
    "HU": "Hungary",
    "ID": "Indonesia",
    "IE": "Ireland",
    "IL": "Israel",
    "IT": "Italy",
    "KW": "Kuwait",
    "LU": "Luxembourg",
    "MX": "Mexico",
    "MY": "Malaysia",
    "NO": "Norway",
    "NZ": "New Zealand",
    "PE": "Peru",
    "PH": "Philippines",
    "PL": "Poland",
    "PT": "Portugal",
    "QA": "Qatar",
    "SA": "Saudi Arabia",
    "SE": "Sweden",
    "TH": "Thailand",
    "TR": "Turkey",
    "AE": "United Arab Emirates",
    "ZA": "South Africa",
    "EG": "Egypt",
    "IS": "Iceland",
    "PK": "Pakistan",
    "RO": "Romania",
    "RU": "Russia",
}


def _string(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    result = str(value).strip()
    return "" if result.lower() in {"", "nan", "none", "null"} else result


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def _iso_date(value: Any) -> str:
    raw = _string(value)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return raw
    if raw.isdigit() and len(raw) == 8:
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    parsed = pd.to_datetime(value, errors="coerce", dayfirst=True)
    if pd.isna(parsed):
        return raw
    return parsed.date().isoformat()


def _country(value: Any, *, default: str = "Cash & derivatives") -> str:
    raw = _string(value)
    return COUNTRY_ALIASES.get(raw, raw) if raw else default


def _industry(value: Any, *, default: str = "Other industries") -> str:
    raw = _string(value)
    return INDUSTRY_ALIASES.get(raw, raw) if raw else default


def _country_from_isin(isin: str) -> str:
    return ISIN_PREFIX_COUNTRIES.get(isin[:2].upper(), "Other markets")


def _check_total(label: str, values: list[FundHolding] | Mapping[str, float]) -> None:
    total = (
        sum(item.weight_pct for item in values)
        if isinstance(values, list)
        else sum(values.values())
    )
    if not math.isclose(total, 100.0, abs_tol=0.2):
        raise ValueError(f"{label}: weights reconcile to {total:.4f}%, not 100%")


def _get_json(
    client: httpx.Client,
    url: str,
    *,
    params: dict[str, str],
) -> dict[str, Any]:
    failure: Exception | None = None
    for attempt in range(3):
        try:
            response = client.get(url, params=params)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError(f"expected JSON object, got {type(payload).__name__}")
            return payload
        except (httpx.HTTPError, ValueError) as exc:
            failure = exc
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"official source request failed: {url}: {failure}") from failure


def fetch_ishares(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    if not spec.product_id:
        raise ValueError(f"{spec.ticker}: missing iShares product id")
    payload = _get_json(
        client,
        ISHARES_API,
        params={
            "appSubType": "ISHARES",
            "appType": "PRODUCT_PAGE",
            "component": "holdings.all",
            "locale": "en_GB",
            "portfolioId": spec.product_id,
            "targetSite": "ishares-uk",
            "userType": "individual",
            "excludeContent": "true",
            "includeConfig": "true",
        },
    )
    try:
        points = payload["componentsByNameMap"]["holdings"]["containersByNameMap"]["all"][
            "dataPointsByNameMap"
        ]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{spec.ticker}: iShares holdings schema changed") from exc

    fields = {
        field: list((points.get(field) or {}).get("value") or [])
        for field in (
            "ticker",
            "issueName",
            "isin",
            "countryOfRisk",
            "sectorName",
            "holdingPercent",
            "assetClass",
        )
    }
    length = len(fields["holdingPercent"])
    if length == 0 or any(len(items) != length for items in fields.values()):
        raise ValueError(f"{spec.ticker}: iShares holdings arrays are incomplete")

    holdings = [
        FundHolding(
            isin=_string(fields["isin"][index]),
            ticker=_string(fields["ticker"][index]),
            name=_string(fields["issueName"][index]),
            country=(
                _country(fields["countryOfRisk"][index])
                if _string(fields["countryOfRisk"][index])
                else None
            ),
            industry=(
                _industry(fields["sectorName"][index])
                if _string(fields["sectorName"][index])
                else None
            ),
            weight_pct=_number(fields["holdingPercent"][index]),
            asset_class=_string(fields["assetClass"][index]),
        )
        for index in range(length)
    ]
    country_weights: defaultdict[str, float] = defaultdict(float)
    industry_weights: defaultdict[str, float] = defaultdict(float)
    for holding in holdings:
        country = (
            holding.country or "Other markets" if holding.is_security else "Cash & derivatives"
        )
        industry = (
            holding.industry or "Other industries" if holding.is_security else "Cash & derivatives"
        )
        country_weights[country] += holding.weight_pct
        industry_weights[industry] += holding.weight_pct
    _check_total(spec.ticker, holdings)
    _check_total(f"{spec.ticker} country", country_weights)
    _check_total(f"{spec.ticker} industry", industry_weights)
    return FundSnapshot(
        ticker=spec.ticker,
        as_of=_iso_date((points.get("asOfDate") or {}).get("value")),
        fetched_at=datetime.now(UTC).isoformat(),
        industry_as_of=_iso_date((points.get("asOfDate") or {}).get("value")),
        cache_schema_version=2,
        holdings=holdings,
        country_weights=dict(country_weights),
        industry_weights=dict(industry_weights),
        source_url=spec.source_url,
        issuer=spec.issuer,
    )


def fetch_invesco(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    base = f"{INVESCO_API}/{spec.isin}"
    profile = _get_json(client, base, params={"idType": "isin", "loadType": "initial"})
    if (profile.get("aliases") or {}).get("isin") != spec.isin:
        raise ValueError(f"{spec.ticker}: Invesco share-class ISIN mismatch")
    if profile.get("replicationMethod") != "Physical":
        raise ValueError(f"{spec.ticker}: a swap/substitute basket is not economic look-through")
    holdings_payload = _get_json(
        client,
        f"{base}/holdings/fund",
        params={"idType": "isin", "loadType": "initial"},
    )
    country_payload = _get_json(
        client,
        f"{base}/weightedHoldings/fund",
        params={"idType": "isin", "breakdown": "country"},
    )
    industry_payload = _get_json(
        client,
        f"{base}/weightedHoldings/fund",
        params={"idType": "isin", "breakdown": "sector"},
    )
    holdings = [
        FundHolding(
            isin=_string(item.get("isin")),
            ticker="",
            name=_string(item.get("name")),
            country=None,
            industry=None,
            weight_pct=percentage(item.get("weight")),
            asset_class=(
                "Cash & derivatives"
                if item.get("name") == "Cash and/or Derivatives"
                else str((profile.get("investmentStrategy") or {}).get("assetType") or "Other")
            ),
        )
        for item in holdings_payload.get("holdings") or []
        if isinstance(item, dict)
    ]
    if sum(bool(holding.isin) for holding in holdings) != int(holdings_payload["numberOfHoldings"]):
        raise ValueError(f"{spec.ticker}: incomplete Invesco holdings")
    country_weights: defaultdict[str, float] = defaultdict(float)
    for item in country_payload.get("holdingWeights") or []:
        if isinstance(item, dict) and _string(item.get("name")):
            country_weights[_country(item.get("name"))] += _number(item.get("value"))
    industry_weights: defaultdict[str, float] = defaultdict(float)
    for item in industry_payload.get("holdingWeights") or []:
        if isinstance(item, dict) and _string(item.get("name")):
            industry_weights[_industry(item.get("name"))] += _number(item.get("value"))
    if not holdings:
        raise ValueError(f"{spec.ticker}: Invesco returned no holdings")
    _check_total(spec.ticker, holdings)
    _check_total(f"{spec.ticker} country", country_weights)
    _check_total(f"{spec.ticker} industry", industry_weights)
    return FundSnapshot(
        ticker=spec.ticker,
        as_of=_iso_date(holdings_payload.get("effectiveDate")),
        fetched_at=datetime.now(UTC).isoformat(),
        industry_as_of=_iso_date(holdings_payload.get("effectiveDate")),
        cache_schema_version=2,
        holdings=holdings,
        country_weights=dict(country_weights),
        industry_weights=dict(industry_weights),
        source_url=spec.source_url,
        issuer=spec.issuer,
    )


def _parse_hsbc_sector_pdf(content: bytes) -> tuple[dict[str, float], str]:
    text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages)
    marker = "Sector allocation (%)"
    if marker not in text:
        raise ValueError("HEMC: sector allocation is absent from the official factsheet")
    section = text.split(marker, 1)[1]
    lines = [line.strip() for line in section.splitlines() if line.strip()]
    names: list[str] = []
    values: list[float] = []
    for line in lines:
        if re.fullmatch(r"\d+(?:\.\d+)?", line):
            values.append(float(line))
            if len(values) == len(names):
                break
        elif not values:
            names.append(line)
    if not names or len(names) != len(values):
        raise ValueError("HEMC: official factsheet sector schema changed")
    weights: defaultdict[str, float] = defaultdict(float)
    for name, value in zip(names, values, strict=True):
        weights[_industry(name)] += value
    _check_total("HEMC industry", weights)
    match = re.search(
        r"Source:\s*HSBC Asset Management,\s*data as at\s+([^\n]+)",
        text,
    )
    return dict(weights), _iso_date(match.group(1) if match else "")


def _parse_hsbc_workbook(
    content: bytes,
) -> tuple[list[FundHolding], dict[str, float], str]:
    header = pd.read_excel(BytesIO(content), header=None, engine="xlrd")
    table = pd.read_excel(BytesIO(content), header=6, engine="xlrd")
    required = {"ISIN", "SecurityName", "Country", "Weighting"}
    if not required.issubset(table.columns):
        raise ValueError("HEMC: official holdings workbook schema changed")
    holdings: list[FundHolding] = []
    country_weights: defaultdict[str, float] = defaultdict(float)
    for row in table.to_dict(orient="records"):
        weight = _number(row.get("Weighting"), fallback=float("nan"))
        if not math.isfinite(weight):
            continue
        isin = _string(row.get("ISIN"))
        country = _string(row.get("Country"))
        holding = FundHolding(
            isin=isin,
            ticker="",
            name=_string(row.get("SecurityName")),
            country=_country(country) if country else None,
            industry=None,
            weight_pct=weight,
            asset_class="Equity" if isin else "Cash & derivatives",
        )
        holdings.append(holding)
        bucket = holding.country or "Other markets" if holding.is_equity else "Cash & derivatives"
        country_weights[bucket] += weight
    if not holdings:
        raise ValueError("HEMC: HSBC returned no holdings")
    _check_total("HEMC", holdings)
    _check_total("HEMC country", country_weights)
    return holdings, dict(country_weights), _iso_date(header.iloc[2, 1])


def fetch_hsbc(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    holdings_response = client.get(HSBC_HOLDINGS_URL)
    holdings_response.raise_for_status()
    factsheet_response = client.get(HSBC_FACTSHEET_URL)
    factsheet_response.raise_for_status()
    holdings, country_weights, as_of = _parse_hsbc_workbook(holdings_response.content)
    industry_weights, industry_as_of = _parse_hsbc_sector_pdf(factsheet_response.content)
    return FundSnapshot(
        ticker=spec.ticker,
        as_of=as_of,
        fetched_at=datetime.now(UTC).isoformat(),
        industry_as_of=industry_as_of,
        cache_schema_version=2,
        holdings=holdings,
        country_weights=country_weights,
        industry_weights=industry_weights,
        source_url=spec.source_url,
        issuer=spec.issuer,
    )


def fetch_vanguard(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    """Read every page from the same holdings API as Vanguard's fund directory."""
    query = """query FundsHoldingsQuery($portIds: [String!], $lastItemKey: String) {
      borHoldings(portIds: $portIds) {
        holdings(limit: 1500, lastItemKey: $lastItemKey) {
          items { issuerName securityLongDescription gicsSectorDescription
                  marketValuePercentage ticker securityType effectiveDate bloombergIsoCountry }
          totalHoldings lastItemKey
        }
      }
    }"""
    holdings: list[FundHolding] = []
    dates: set[str] = set()
    seen: set[str] = set()
    cursor = None
    expected = None
    for _ in range(100):
        response = client.post(
            VANGUARD_API,
            headers={"x-consumer-id": "uk2"},
            json={
                "operationName": "FundsHoldingsQuery",
                "query": query,
                "variables": {"portIds": [spec.product_id], "lastItemKey": cursor},
            },
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("errors"):
            raise ValueError(f"{spec.ticker}: Vanguard holdings request failed")
        page = payload["data"]["borHoldings"][0]["holdings"]
        count = int(page["totalHoldings"])
        if expected is not None and count != expected:
            raise ValueError(f"{spec.ticker}: holdings changed during pagination")
        expected = count
        for row in page["items"]:
            dates.add(_iso_date(row["effectiveDate"]))
            code = str(row.get("bloombergIsoCountry") or "")
            asset = str(row.get("securityType") or "")
            if asset.startswith("EQ."):
                asset_class = "Equity"
            elif asset.startswith("FI."):
                asset_class = "Fixed Income"
            elif asset.startswith("MM."):
                asset_class = "Money Market"
            elif asset == "CRNY":
                asset_class = "Cash"
            elif asset.startswith(("CT.", "DE.")):
                asset_class = "Derivative"
            else:
                asset_class = asset
            holdings.append(
                FundHolding(
                    ticker=str(row.get("ticker") or ""),
                    name=str(row.get("securityLongDescription") or row.get("issuerName") or ""),
                    weight_pct=float(row["marketValuePercentage"]),
                    country=ISIN_PREFIX_COUNTRIES.get(code, code or None),
                    industry=row.get("gicsSectorDescription") or None,
                    asset_class=asset_class,
                )
            )
        cursor = page.get("lastItemKey")
        if not cursor:
            break
        if cursor in seen:
            raise ValueError(f"{spec.ticker}: repeated holdings page")
        seen.add(cursor)
    else:
        raise ValueError(f"{spec.ticker}: holdings pagination did not finish")
    if not holdings or len(holdings) != expected or len(dates) != 1 or not next(iter(dates)):
        raise ValueError(f"{spec.ticker}: incomplete or inconsistent holdings snapshot")
    _check_total(spec.ticker, holdings)
    countries: defaultdict[str, float] = defaultdict(float)
    industries: defaultdict[str, float] = defaultdict(float)
    for holding in holdings:
        countries[
            (holding.country or "Other markets") if holding.is_security else "Cash & derivatives"
        ] += holding.weight_pct
        industries[
            (holding.industry or "Other industries")
            if holding.is_security
            else "Cash & derivatives"
        ] += holding.weight_pct
    return FundSnapshot(
        ticker=spec.ticker,
        as_of=next(iter(dates)),
        industry_as_of=next(iter(dates)),
        fetched_at=datetime.now(UTC).isoformat(),
        cache_schema_version=2,
        holdings=holdings,
        country_weights=dict(countries),
        industry_weights=dict(industries),
        source_url=spec.source_url,
        issuer=spec.issuer,
    )


def fetch_official_snapshot(
    ticker: str,
    *,
    client: httpx.Client | None = None,
    spec: FundSpec | None = None,
) -> FundSnapshot:
    spec = spec or BUILTIN_FUND_ADAPTERS.get(ticker.upper())
    if spec is None:
        raise ValueError(f"unsupported ETF: {ticker}")
    owns_client = client is None
    active_client = client or httpx.Client(
        timeout=httpx.Timeout(45.0),
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "en-GB,en;q=0.9"},
    )
    try:
        from .fund_vaneck_spdr import fetch_spdr, fetch_vaneck

        adapters = {
            "iShares": fetch_ishares,
            "Invesco": fetch_invesco,
            "HSBC Asset Management": fetch_hsbc,
            "Vanguard": fetch_vanguard,
            "VanEck": fetch_vaneck,
            "State Street": fetch_spdr,
        }
        if spec.issuer not in adapters:
            from .fund_isin_issuers import ISIN_ADAPTERS

            adapters.update(ISIN_ADAPTERS)
        if spec.issuer not in adapters:
            raise ValueError(f"unsupported issuer: {spec.issuer}")
        snapshot = adapters[spec.issuer](active_client, spec)
        return snapshot.model_copy(
            update={
                "fund_isin": spec.isin,
                "cache_schema_version": 3,
                "as_of": as_of_date(snapshot.as_of),
            }
        )
    finally:
        if owns_client:
            active_client.close()


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = (
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ).encode("utf-8")
        + b"\n"
    )
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(content)
        handle.flush()
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class OfficialFundHoldingsProvider:
    """Use a daily official snapshot cache with stale-on-error resilience."""

    def __init__(
        self,
        state_root: Path,
        *,
        max_age: timedelta = timedelta(hours=18),
        fetcher: Callable[[str], FundSnapshot] | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.legacy_root = state_root.expanduser().resolve() / "raw" / "fund-holdings"
        self.root = self.legacy_root / "v3"
        self.max_age = max_age
        self.fetcher = fetcher
        self.client = client
        self.catalog = FundCatalog(state_root.expanduser().resolve())

    def _read(self, ticker: str) -> FundSnapshot | None:
        path = self.root / f"{ticker}.json"
        if not path.is_file():
            path = self.legacy_root / f"{ticker}.json"
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            raise ValueError(f"fund holdings payload is not an object: {path}")
        return FundSnapshot.model_validate(payload)

    def _is_fresh(self, snapshot: FundSnapshot) -> bool:
        if snapshot.cache_schema_version != 3 or not snapshot.fetched_at:
            return False
        try:
            fetched_at = datetime.fromisoformat(snapshot.fetched_at.replace("Z", "+00:00"))
        except ValueError:
            return False
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=UTC)
        return timedelta(0) <= datetime.now(UTC) - fetched_at <= self.max_age

    def fetch(self, ticker: str) -> FundSnapshot | None:
        return self.fetch_security(SecurityDescriptor(ticker=ticker))

    def fetch_security(self, security: SecurityDescriptor) -> FundSnapshot | None:
        normalized = security.ticker.strip().upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9._^-]{0,63}", normalized):
            raise ValueError("invalid fund ticker")
        try:
            cached = self._read(normalized)
        except (ValueError, OSError):
            cached = None
        expected_isin = security.isin.strip().upper()
        legacy = BUILTIN_FUND_ADAPTERS.get(normalized.removesuffix(".L"))
        if cached is not None and expected_isin:
            cached_isin = cached.fund_isin or (legacy.isin if legacy else "")
            if cached_isin and cached_isin != expected_isin:
                cached = None
            elif not cached_isin:
                # A ticker-only file cannot establish an observed ISIN.
                cached = None
        if cached is not None and self._is_fresh(cached):
            return cached
        retry_path = self.root / ".retry" / f"{normalized}.json"
        try:
            retry = json.loads(retry_path.read_text())
            if (
                retry.get("isin") == expected_isin
                and retry.get("version") == "issuer-adapters-v1"
                and datetime.now(UTC) < datetime.fromisoformat(retry["retryAfter"])
            ):
                return cached
        except (OSError, ValueError, KeyError, TypeError):
            pass
        owns_client = self.client is None
        client = self.client or httpx.Client(
            timeout=httpx.Timeout(30.0),
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en-GB,en;q=0.9"},
        )
        try:
            spec = self.catalog.resolve(security, client)
            if spec is None:
                return cached
            snapshot = (
                self.fetcher(normalized.removesuffix(".L"))
                if self.fetcher is not None
                else fetch_official_snapshot(normalized, client=client, spec=spec)
            )
            if snapshot.fund_isin and snapshot.fund_isin != spec.isin:
                raise ValueError(f"{normalized}: holdings snapshot ISIN mismatch")
            snapshot = snapshot.model_copy(
                update={"ticker": normalized, "fund_isin": spec.isin, "cache_schema_version": 3}
            )
        except Exception:
            _atomic_json(
                retry_path,
                {
                    "isin": expected_isin,
                    "version": "issuer-adapters-v1",
                    "retryAfter": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
                },
            )
            if cached is not None:
                return cached
            raise
        finally:
            if owns_client:
                client.close()
        _atomic_json(
            self.root / f"{normalized}.json",
            snapshot.model_dump(mode="json", by_alias=True),
        )
        retry_path.unlink(missing_ok=True)
        return snapshot


__all__ = [
    "BUILTIN_FUND_ADAPTERS",
    "FundSpec",
    "OfficialFundHoldingsProvider",
    "fetch_hsbc",
    "fetch_invesco",
    "fetch_ishares",
    "fetch_official_snapshot",
    "fetch_vanguard",
]
