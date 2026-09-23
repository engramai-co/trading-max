"""Full-holdings interfaces addressed by issuer-validated fund ISINs."""

from __future__ import annotations

import re
from dataclasses import replace

import httpx

from trading_max.analytics.lookthrough import FundHolding, FundSnapshot
from trading_max.reference import SecurityDescriptor

from .fund_downloads import as_of_date, isin, issuer_url, make_snapshot, percentage, text
from .fund_specs import FundSpec

AMUNDI_API = "https://www.amundietf.com/mapi/ProductAPI/getProductsData"
JPM_API = "https://am.jpmorgan.com/FundsMarketingHandler/product-data"
DWS_ORIGIN = "https://etf.dws.com"


def discover_by_isin(issuer: str, security: SecurityDescriptor) -> FundSpec | None:
    """Construct fixed-origin requests; each adapter validates returned identity."""
    fund_isin = isin(security.isin)
    if not fund_isin:
        return None
    urls = {
        "Amundi": f"https://www.amundietf.com/amundi/lux/en/instit/{fund_isin}",
        "JPMorgan": f"{JPM_API}?cusip={fund_isin}&country=gb&role=adv&locale=en-GB",
        "Xtrackers": f"{DWS_ORIGIN}/api/pdp/en-gb/etf/{fund_isin}/holdings",
        "Invesco": f"https://dng-api.invesco.com/cache/v1/accounts/en_GB/shareclasses/{fund_isin}?idType=isin",
    }
    if issuer not in urls:
        return None
    return FundSpec(
        ticker=security.ticker,
        isin=fund_isin,
        name=security.name,
        issuer=issuer,
        source_url=urls[issuer],
        data_isin=fund_isin,
    )


def fetch_amundi(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    response = client.post(
        AMUNDI_API,
        json={
            "productIds": [spec.isin],
            "productType": "PRODUCT",
            "context": {"countryCode": "LUX", "languageCode": "en", "userProfileName": "INSTIT"},
            "characteristics": [
                "ISIN",
                "SHARE_MARKETING_NAME",
                "FUND_REPLICATION_METHODOLOGY",
                "POSITION_AS_OF_DATE",
            ],
            "composition": {
                "compositionFields": [
                    "date",
                    "type",
                    "bbg",
                    "isin",
                    "name",
                    "weight",
                    "sector",
                    "countryOfRisk",
                ]
            },
        },
    )
    response.raise_for_status()
    products = response.json()["products"]
    if len(products) != 1 or products[0].get("productId") != spec.isin:
        raise ValueError(f"{spec.ticker}: Amundi product ISIN mismatch")
    product = products[0]
    facts = product["characteristics"]
    if facts.get("ISIN") != spec.isin:
        raise ValueError(f"{spec.ticker}: Amundi share-class ISIN mismatch")
    if facts.get("FUND_REPLICATION_METHODOLOGY") != "Direct(Physical)":
        raise ValueError(f"{spec.ticker}: a swap/substitute basket is not economic look-through")
    composition = product["composition"]
    rows = composition["compositionData"]
    if len(rows) != int(composition["totalNumberOfInstruments"]):
        raise ValueError(f"{spec.ticker}: incomplete Amundi holdings")
    date = as_of_date(facts["POSITION_AS_OF_DATE"])
    holdings = []
    for row in rows:
        fields = row["compositionCharacteristics"]
        if as_of_date(fields["date"]) != date:
            raise ValueError(f"{spec.ticker}: mixed Amundi holdings dates")
        asset = {
            "EQUITY_ORDINARY": "Equity",
            "PREFERENCE_SHARES": "Preferred Stock",
            "DEPOSITORY_RECEIPT": "Depositary Receipt",
        }.get(fields["type"], fields["type"])
        holdings.append(
            FundHolding(
                isin=isin(fields.get("isin")),
                ticker=text(fields.get("bbg")).split(" ")[0],
                name=text(fields.get("name")),
                country=text(fields.get("countryOfRisk")) or None,
                industry=text(fields.get("sector")) or None,
                weight_pct=percentage(row["weight"]) * 100,
                asset_class=asset,
            )
        )
    return make_snapshot(spec, holdings, date)


def fetch_jpmorgan(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    response = client.get(
        JPM_API,
        params={
            "cusip": spec.isin,
            "country": "gb",
            "role": "adv",
            "locale": "en-GB",
        },
    )
    response.raise_for_status()
    data = response.json()["fundData"]
    share = data["shareClass"]
    if (
        spec.isin not in (share.get("isin"), share.get("cusip"))
        or data.get("fundTypeCode") != "N_ETF"
    ):
        raise ValueError(f"{spec.ticker}: JPMorgan fund identity mismatch")
    table = data["dailyHoldingsAll"]
    rows = table["data"]
    if len(rows) != int(data["numberOfHoldings"]):
        raise ValueError(f"{spec.ticker}: incomplete JPMorgan holdings")
    date = as_of_date(table["effectiveDate"])
    holdings = []
    for row in rows:
        if as_of_date(row["navDate"]) != date:
            raise ValueError(f"{spec.ticker}: mixed JPMorgan holdings dates")
        asset = text(row.get("securityType"))
        if asset.startswith("Depository Receipt"):
            asset = "Depositary Receipt"
        elif asset == "Fund - Real Estate Investment Trust":
            asset = "REIT"
        if not asset:
            raise ValueError(f"{spec.ticker}: missing JPMorgan asset type")
        holdings.append(
            FundHolding(
                isin=isin(row.get("securityIsin")),
                ticker=text(row.get("securityTicker")),
                name=text(row.get("securityDescription")),
                country=text(row.get("country")) or None,
                industry=text(row.get("sector")) or None,
                weight_pct=percentage(row["marketValuePercent"]),
                asset_class=asset,
            )
        )
    return make_snapshot(spec, holdings, date)


def fetch_xtrackers(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    base = f"{DWS_ORIGIN}/api/pdp/en-gb/etf/{spec.isin}"
    headers = {"Accept": "application/json", "client-id": "passive-frontend"}
    response = client.get(base + "/pdpMetaTagsTealium", headers=headers)
    response.raise_for_status()
    data = response.json()
    product = data["pdpResult"]
    identity = {
        item["key"]: item["value"] for item in product["pageFrame"]["productHeader"]["identifier"]
    }
    if identity.get("ISIN") != spec.isin:
        raise ValueError(f"{spec.ticker}: Xtrackers product ISIN mismatch")
    methodology = [
        item["value"]
        for accordion in product["pageSections"]["keyFacts"]["accordionItems"]
        for bundle in accordion.get("listBundle", [])
        if bundle.get("id") == "fundinformation-indexreplication"
        for item in bundle["items"]
        if item["key"] == "Investment methodology"
    ]
    if len(methodology) != 1 or "physically" not in methodology[0].lower():
        raise ValueError(f"{spec.ticker}: a swap/substitute basket is not economic look-through")
    canonical = issuer_url(data["metaTags"]["canonical"], DWS_ORIGIN)
    spec = replace(spec, source_url=canonical)
    response = client.get(base + "/holdings", headers=headers)
    response.raise_for_status()
    tables = [
        table
        for table in response.json()["tables"]
        if table.get("id") == "securitiesheldtable-securitiesholding"
    ]
    if len(tables) != 1:
        raise ValueError(f"{spec.ticker}: Xtrackers full holdings table is unavailable")
    table = tables[0]
    if not any(f"/constituent/{spec.isin}/" in link["url"] for link in table["downloadLinks"]):
        raise ValueError(f"{spec.ticker}: Xtrackers holdings download identity mismatch")
    columns = {column["value"]: column["key"] for column in table["columns"]}
    required = {"ISIN", "Name", "% Weight", "Country", "Industry", "Asset class"}
    if not required.issubset(columns):
        raise ValueError(f"{spec.ticker}: Xtrackers holdings columns changed")
    dates = {
        match
        for note in table["disclaimers"]
        for match in re.findall(r"\b\d{2}/\d{2}/\d{4}\b", note["text"])
    }
    if len(dates) != 1:
        raise ValueError(f"{spec.ticker}: Xtrackers holdings date is unavailable")
    holdings = []
    for row in table["values"]:
        holdings.append(
            FundHolding(
                isin=isin(row[columns["ISIN"]]["value"]),
                name=text(row[columns["Name"]]["value"]),
                country=text(row[columns["Country"]]["value"]) or None,
                industry=text(row[columns["Industry"]]["value"]) or None,
                weight_pct=percentage(row[columns["% Weight"]]["sortValue"]),
                asset_class=text(row[columns["Asset class"]]["value"]),
            )
        )
    return make_snapshot(spec, holdings, next(iter(dates)))


ISIN_ADAPTERS = {"Amundi": fetch_amundi, "JPMorgan": fetch_jpmorgan, "Xtrackers": fetch_xtrackers}
