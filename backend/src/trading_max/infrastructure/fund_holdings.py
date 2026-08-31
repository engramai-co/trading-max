"""Official ETF constituent adapters with a durable normalized cache."""

from __future__ import annotations

import json
import math
import re
import tempfile
import time
from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
import pandas as pd
from pypdf import PdfReader

from trading_max.analytics.lookthrough import FundHolding, FundSnapshot

ISHARES_API = (
    "https://www.ishares.com/varnish-api/uk-retail01-product-data/"
    "product-data/api/v2/get-product-data"
)
INVESCO_API = "https://dng-api.invesco.com/cache/v1/accounts/en_GB/shareclasses"
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
}


@dataclass(frozen=True, slots=True)
class FundSpec:
    ticker: str
    isin: str
    name: str
    issuer: str
    source_url: str
    product_id: str | None = None
    data_isin: str | None = None


# These entries configure issuer-specific download adapters. They are not a
# security universe and are never used to decide whether an instrument is a
# fund. Security type is resolved dynamically by the reference-data service.
BUILTIN_FUND_ADAPTERS: dict[str, FundSpec] = {
    "XUSE": FundSpec(
        ticker="XUSE",
        isin="IE000R4ZNTN3",
        name="iShares MSCI World ex-USA UCITS ETF",
        issuer="iShares",
        product_id="340748",
        source_url="https://www.ishares.com/uk/individual/en/products/340748",
    ),
    "SEMI": FundSpec(
        ticker="SEMI",
        isin="IE000I8KRLL9",
        name="iShares MSCI Global Semiconductors UCITS ETF",
        issuer="iShares",
        product_id="319084",
        source_url="https://www.ishares.com/uk/individual/en/products/319084",
    ),
    "IUMF": FundSpec(
        ticker="IUMF",
        isin="IE00BD1F4N50",
        name="iShares Edge MSCI USA Momentum Factor UCITS ETF",
        issuer="iShares",
        product_id="285208",
        source_url="https://www.ishares.com/uk/individual/en/products/285208",
    ),
    "EQGB": FundSpec(
        ticker="EQGB",
        isin="IE00BYVTMW98",
        name="Invesco EQQQ Nasdaq-100 UCITS ETF",
        issuer="Invesco",
        data_isin="IE00BFZXGZ54",
        source_url=(
            "https://www.invesco.com/uk/en/financial-products/etfs/"
            "invesco-eqqq-nasdaq-100-ucits-etf-acc.html"
        ),
    ),
    "HEMC": FundSpec(
        ticker="HEMC",
        isin="IE000KCS7J59",
        name="HSBC MSCI Emerging Markets UCITS ETF",
        issuer="HSBC Asset Management",
        source_url=HSBC_PRODUCT_URL,
    ),
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
        country = holding.country or "Other markets" if holding.is_equity else "Cash & derivatives"
        industry = (
            holding.industry or "Other industries" if holding.is_equity else "Cash & derivatives"
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
    if not spec.data_isin:
        raise ValueError(f"{spec.ticker}: missing Invesco share-class id")
    base = f"{INVESCO_API}/{spec.data_isin}"
    holdings_payload = _get_json(
        client,
        f"{base}/holdings/index",
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
            country=_country_from_isin(_string(item.get("isin"))),
            industry=None,
            weight_pct=_number(item.get("weight")),
            asset_class="Equity",
        )
        for item in holdings_payload.get("holdings") or []
        if isinstance(item, dict)
    ]
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


def fetch_official_snapshot(
    ticker: str,
    *,
    client: httpx.Client | None = None,
) -> FundSnapshot:
    spec = BUILTIN_FUND_ADAPTERS.get(ticker.upper())
    if spec is None:
        raise ValueError(f"unsupported ETF: {ticker}")
    owns_client = client is None
    active_client = client or httpx.Client(
        timeout=httpx.Timeout(45.0),
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "en-GB,en;q=0.9"},
    )
    try:
        if spec.issuer == "iShares":
            return fetch_ishares(active_client, spec)
        if spec.issuer == "Invesco":
            return fetch_invesco(active_client, spec)
        if spec.issuer == "HSBC Asset Management":
            return fetch_hsbc(active_client, spec)
        raise ValueError(f"unsupported issuer: {spec.issuer}")
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
        fetcher: Callable[[str], FundSnapshot] = fetch_official_snapshot,
    ) -> None:
        self.root = state_root.expanduser().resolve() / "raw" / "fund-holdings"
        self.max_age = max_age
        self.fetcher = fetcher

    def _read(self, ticker: str) -> FundSnapshot | None:
        path = self.root / f"{ticker}.json"
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, Mapping):
            raise ValueError(f"fund holdings payload is not an object: {path}")
        return FundSnapshot.model_validate(payload)

    def _is_fresh(self, snapshot: FundSnapshot) -> bool:
        if snapshot.cache_schema_version != 2 or not snapshot.fetched_at:
            return False
        fetched_at = datetime.fromisoformat(snapshot.fetched_at.replace("Z", "+00:00"))
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=UTC)
        return datetime.now(UTC) - fetched_at <= self.max_age

    def fetch(self, ticker: str) -> FundSnapshot | None:
        normalized = ticker.strip().upper()
        cached = self._read(normalized)
        if cached is not None and self._is_fresh(cached):
            return cached
        if normalized not in BUILTIN_FUND_ADAPTERS:
            # Operator- or adapter-managed snapshots are valid for any fund.
            # The built-in issuer adapters only define how to refresh the
            # products they support; they are not an ETF universe whitelist.
            return cached
        try:
            snapshot = self.fetcher(normalized)
        except Exception:
            if cached is not None:
                return cached
            raise
        _atomic_json(
            self.root / f"{normalized}.json",
            snapshot.model_dump(mode="json", by_alias=True),
        )
        return snapshot


__all__ = [
    "BUILTIN_FUND_ADAPTERS",
    "FundSpec",
    "OfficialFundHoldingsProvider",
    "fetch_hsbc",
    "fetch_invesco",
    "fetch_ishares",
    "fetch_official_snapshot",
]
