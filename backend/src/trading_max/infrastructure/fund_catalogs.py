"""Discover issuer download identities from their public product catalogues."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from lxml import html

from trading_max.reference import SecurityDescriptor

from .fund_downloads import isin, issuer_url, text
from .fund_specs import BUILTIN_FUND_ADAPTERS, FundSpec

ISHARES_CATALOG = "https://www.ishares.com/varnish-api/blk-product-screener-server/api/v1/product-screener/product-data"
VANGUARD_DIRECTORY = "https://www.vanguard.co.uk/uk-fund-directory"
VANGUARD_QUERY = """query FundFinderFunds($portIds: [String!]!) {
  funds(portIds: $portIds) { profile {
    portId fundFullName assetClassificationLevel1 polarisPdtTypeIndicator
    identifiers(altIds: ["ISIN", "Ticker"]) { altId altIdValue }
    listings { identifiers(altIds: ["RIC", "TIDM"]) { altId altIdValue } }
  } }
}"""


def catalog_ishares(client: httpx.Client) -> list[FundSpec]:
    response = client.get(
        ISHARES_CATALOG,
        params={
            "country": "gb",
            "language": "en",
            "siteName": "ishares-uk",
            "userType": "individual",
        },
    )
    response.raise_for_status()
    result = []
    for row in response.json().values():
        if "etf" not in str(row.get("productView", "")).lower() or not isin(row.get("isin")):
            continue
        ticker = text(row.get("localExchangeTicker"))
        result.append(
            FundSpec(
                ticker=ticker,
                isin=isin(row["isin"]),
                name=row["fundName"],
                issuer="iShares",
                source_url=issuer_url(row["productPageUrl"], "https://www.ishares.com"),
                product_id=str(row["portfolioId"]),
                aliases=(ticker + ".L",) if ticker else (),
            )
        )
    return result


def catalog_vanguard(client: httpx.Client) -> list[FundSpec]:
    response = client.get(VANGUARD_DIRECTORY)
    response.raise_for_status()
    page = html.fromstring(response.content)
    state = json.loads(page.xpath('//script[@id="serverApp-state"]/text()')[0])
    config = state["_angular_initial_state"][":items"]["root"][":items"]["site-config"]
    response = client.post(
        "https://www.vanguard.co.uk/gpx/graphql",
        headers={"x-consumer-id": "uk2"},
        json={"query": VANGUARD_QUERY, "variables": {"portIds": config["portIds"].split(",")}},
    )
    response.raise_for_status()
    result = []
    for fund in response.json()["data"]["funds"]:
        row = fund.get("profile") or {}
        if row.get("polarisPdtTypeIndicator") != "ETF":
            continue
        identifiers = {item["altId"]: item["altIdValue"] for item in row["identifiers"]}
        fund_isin = isin(identifiers.get("ISIN"))
        if not fund_isin:
            continue
        aliases = tuple(
            sorted(
                {
                    item["altIdValue"]
                    for listing in row["listings"]
                    for item in listing["identifiers"]
                    if item["altId"] in {"RIC", "TIDM"} and item.get("altIdValue")
                }
            )
        )
        result.append(
            FundSpec(
                ticker=text(identifiers.get("Ticker")),
                isin=fund_isin,
                name=row["fundFullName"],
                issuer="Vanguard",
                source_url=VANGUARD_DIRECTORY,
                product_id=row["portId"],
                aliases=aliases,
            )
        )
    return result


def catalog_vaneck(client: httpx.Client) -> list[FundSpec]:
    origin = "https://www.vaneck.com"
    url = origin + "/uk/en/fundlisting/overview/etfs/"
    response = client.get(url)
    response.raise_for_status()
    page = html.fromstring(response.content)
    match = re.search(r"window\.config\.currentPageId\s*=\s*(\d+)", response.text)
    if not match:
        raise ValueError("VanEck catalogue schema changed")
    payload = {
        "InvType": "etf",
        "TableType": "ov",
        "CurrentPageId": match[1],
        "CountryIso": "uk",
        "LanguageIso": "en",
        "InvestorType": "",
        "AssetClass": [
            value for value in page.xpath('//*[@id="dropSectionAssetClass"]//input/@value') if value
        ],
        "Funds": [],
        "ShareClass": [],
        "FilterFunds": [""],
        "SortCol": "ticker",
        "isasc": True,
    }
    response = client.post(
        origin + "/Main/FundListingUcits/GetFundData/",
        data={"filterJson": json.dumps(payload)},
        headers={"X-Requested-With": "XMLHttpRequest", "Referer": url},
    )
    response.raise_for_status()
    data = response.json()
    if not data.get("Success"):
        raise ValueError("VanEck catalogue request failed")
    result = []
    for row in data["Result"]["FundSet"]:
        columns = {item["Header"]: item for item in row["RowData"]}
        if not isin(row.get("ISIN")):
            continue
        result.append(
            FundSpec(
                # Display ticker may collide with a US fund; dynamic matching here
                # requires an ISIN, never the unqualified catalogue ticker.
                ticker="",
                isin=row["ISIN"],
                name=row["FundName"],
                issuer="VanEck",
                source_url=issuer_url(columns["name"]["Link"], origin),
                product_id=row["FundID"],
            )
        )
    return result


def catalog_spdr(client: httpx.Client) -> list[FundSpec]:
    origin = "https://www.ssga.com"
    result = []
    for country, language, role, group in (
        ("uk", "en_gb", "institutional", "uk-etfs"),
        ("us", "en", "intermediary", "etfs"),
    ):
        response = client.get(
            origin + "/bin/v1/ssmp/fund/fundfinder",
            params={
                "country": country,
                "language": language,
                "role": role,
                "product": "",
                "ui": "fund-finder",
            },
        )
        response.raise_for_status()
        for row in response.json()["data"]["funds"][group]["datas"]:
            tokens = [value.strip() for value in row["keywords"].split(",")]
            identifiers = {isin(value) for value in tokens} - {""}
            if len(identifiers) != 1:
                continue
            downloads = [
                doc["path"]
                for kind in row.get("documentPdf", [])
                if kind["docType"] == "Holdings-daily"
                for doc in kind["docs"]
            ]
            if len(downloads) != 1:
                continue
            ticker = row["fundTicker"] if country == "us" else ""
            aliases = tuple(
                value.removesuffix(" LN") + ".L" for value in tokens if value.endswith(" LN")
            )
            asset = (
                "Fixed Income"
                if "Fixed Income" in tokens
                else "Equity"
                if "Equity" in tokens
                else "Other"
            )
            result.append(
                FundSpec(
                    ticker=ticker,
                    isin=next(iter(identifiers)),
                    name=row["fundName"],
                    issuer="State Street",
                    source_url=issuer_url(row["fundUri"], origin),
                    product_id=row["fundFilter"],
                    holdings_url=issuer_url(downloads[0], origin),
                    aliases=aliases,
                    asset_class=asset,
                )
            )
    return result


CATALOGS = {
    "iShares": catalog_ishares,
    "Vanguard": catalog_vanguard,
    "VanEck": catalog_vaneck,
    "State Street": catalog_spdr,
}
ISSUER_NAMES = {
    "iShares": ("ishares", "blackrock"),
    "Vanguard": ("vanguard",),
    "VanEck": ("vaneck", "van eck"),
    "State Street": ("state street", "spdr"),
    "Invesco": ("invesco",),
    "Xtrackers": ("xtrackers", "x trackers", "dws"),
    "Amundi": ("amundi", "lyxor"),
    "JPMorgan": ("jpmorgan", "jp morgan", "jpm "),
}


class FundCatalog:
    """Weekly catalogue cache; an issuer outage never overwrites good discovery."""

    def __init__(self, root: Path):
        self.root = root / "reference" / "fund-catalogs"

    def _catalog(self, issuer: str, client: httpx.Client) -> list[FundSpec]:
        from .fund_holdings import _atomic_json

        path = self.root / (issuer.lower().replace(" ", "-") + ".json")
        cached = []
        if path.is_file():
            try:
                data = json.loads(path.read_text())
                cached = [FundSpec(**row) for row in data["funds"]]
                if datetime.now(UTC) - datetime.fromisoformat(data["fetchedAt"]) < timedelta(
                    days=7
                ):
                    return cached
            except (ValueError, TypeError, KeyError):
                cached = []
        try:
            found = CATALOGS[issuer](client)
            if not found:
                raise ValueError(f"{issuer}: empty official fund catalogue")
            _atomic_json(
                path,
                {
                    "fetchedAt": datetime.now(UTC).isoformat(),
                    "funds": [asdict(row) for row in found],
                },
            )
            return found
        except Exception:
            if cached:
                return cached
            raise

    def resolve(self, security: SecurityDescriptor, client: httpx.Client) -> FundSpec | None:
        ticker = security.ticker.strip().upper()
        fund_isin = isin(security.isin)
        if security.isin and not fund_isin:
            raise ValueError("invalid fund ISIN")
        if fund_isin:
            matches = [row for row in BUILTIN_FUND_ADAPTERS.values() if row.isin == fund_isin]
        else:
            row = BUILTIN_FUND_ADAPTERS.get(ticker.removesuffix(".L"))
            matches = [row] if row else []
        if matches:
            return replace(matches[0], ticker=ticker)
        name = security.name.lower().replace("-", " ")
        issuer = next(
            (key for key, names in ISSUER_NAMES.items() if any(alias in name for alias in names)),
            None,
        )
        if issuer is None:
            return None
        if issuer not in CATALOGS:
            from .fund_isin_issuers import discover_by_isin

            return discover_by_isin(issuer, security) if fund_isin else None
        candidates = self._catalog(issuer, client)
        matches = (
            [row for row in candidates if row.isin == fund_isin]
            if fund_isin
            else [row for row in candidates if ticker and ticker in (row.ticker, *row.aliases)]
        )
        identities = {(row.isin, row.product_id) for row in matches}
        if len(identities) > 1:
            raise ValueError(f"{ticker}: ambiguous official fund identity")
        return replace(matches[0], ticker=ticker) if matches else None
