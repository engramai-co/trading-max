"""VanEck UCITS and State Street official full-holdings downloads."""

from __future__ import annotations

import json
from io import BytesIO

import httpx
from lxml import html
from openpyxl import load_workbook

from trading_max.analytics.lookthrough import FundHolding, FundSnapshot

from .fund_downloads import as_of_date, isin, issuer_url, make_snapshot, percentage, text
from .fund_specs import FundSpec

VANECK_ORIGIN = "https://www.vaneck.com"
SPDR_ORIGIN = "https://www.ssga.com"


def fetch_vaneck(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    response = client.get(issuer_url(spec.source_url, VANECK_ORIGIN))
    response.raise_for_status()
    page = html.fromstring(response.content)
    identities = []
    for script in page.xpath('//script[@type="application/ld+json"]/text()'):
        data = json.loads(script)
        nodes = data.get("@graph", [data]) if isinstance(data, dict) else data
        identities.extend(node.get("identifier") for node in nodes if isinstance(node, dict))
    if spec.isin not in identities:
        raise ValueError(f"{spec.ticker}: VanEck product ISIN mismatch")
    blocks = page.xpath("//ve-holdingsblock")
    tickers = page.xpath("//ve-fundticker/text()")
    if len(blocks) != 1 or len(tickers) != 1:
        raise ValueError(f"{spec.ticker}: VanEck full holdings block is unavailable")
    block = blocks[0]
    response = client.get(
        VANECK_ORIGIN + "/Main/HoldingsBlock/GetContent/",
        params={
            "blockid": block.attrib["data-blockid"],
            "pageid": block.attrib["data-pageid"],
            "ticker": tickers[0].strip(),
        },
    )
    response.raise_for_status()
    data = response.json()["data"]
    if data.get("IsTopTen") is not False or data.get("Ticker") != tickers[0].strip():
        raise ValueError(f"{spec.ticker}: VanEck returned a partial or different fund")
    holdings = []
    date = as_of_date(data.get("AsOfDate"))
    for row in data["Holdings"]:
        if row.get("Ticker") != data["Ticker"]:
            raise ValueError(f"{spec.ticker}: mixed VanEck fund holdings")
        if row.get("AsOfDate") and as_of_date(row["AsOfDate"]) != date:
            raise ValueError(f"{spec.ticker}: mixed VanEck holdings dates")
        asset = text(row.get("AssetClass"))
        asset = {"Stock": "Equity", "Bond": "Fixed Income"}.get(asset, asset)
        if not asset:
            raise ValueError(f"{spec.ticker}: constituent asset class is missing")
        holdings.append(
            FundHolding(
                isin=isin(row.get("ISIN")),
                figi=text(row.get("FIGI")),
                ticker=text(row.get("Label")).split(" ")[0],
                name=text(row.get("HoldingName")),
                country=text(row.get("Country")) or None,
                industry=text(row.get("Sector")) or None,
                weight_pct=percentage(row.get("Weight")),
                asset_class=asset,
            )
        )
    # VanEck reports the security count separately from its cash row.
    securities = sum(1 for row in holdings if row.normalized_asset_class != "CASH")
    if securities != int(data["TotalAmount"]):
        raise ValueError(f"{spec.ticker}: incomplete VanEck holdings")
    return make_snapshot(spec, holdings, date)


def parse_spdr_workbook(content: bytes, spec: FundSpec) -> FundSnapshot:
    workbook = load_workbook(BytesIO(content), read_only=True, data_only=True)
    try:
        rows = list(workbook["holdings"].values)
    finally:
        workbook.close()
    metadata = {text(row[0]).rstrip(":"): text(row[1]) for row in rows[:5] if len(row) > 1}
    ucits = "ISIN" in metadata
    if ucits:
        if metadata["ISIN"] != spec.isin:
            raise ValueError(f"{spec.ticker}: State Street workbook ISIN mismatch")
        date = metadata.get("Holdings As Of")
        name_key, weight_key = "Security Name", "Percent of Fund"
    else:
        if metadata.get("Ticker Symbol") != spec.product_id:
            raise ValueError(f"{spec.ticker}: State Street workbook ticker mismatch")
        date = metadata.get("Holdings")
        name_key, weight_key = "Name", "Weight"
    header_index = next(
        (index for index, row in enumerate(rows[:20]) if name_key in row and weight_key in row),
        None,
    )
    if header_index is None:
        raise ValueError(f"{spec.ticker}: State Street workbook schema changed")
    headers = [text(value) for value in rows[header_index]]
    holdings, unweighted = [], 0
    for cells in rows[header_index + 1 :]:
        row = dict(zip(headers, cells, strict=True))
        name = text(row.get(name_key))
        if not name:
            continue
        security_isin = isin(row.get("ISIN"))
        weight = text(row.get(weight_key))
        # Disclaimers are not data rows. A table row has a share quantity or an
        # identifier, even when the issuer supplies '-' instead of a weight.
        quantity = row.get("Number of Shares" if ucits else "Shares Held")
        if not weight and quantity is None:
            continue
        if not weight:
            unweighted += 1
            continue
        sector = text(row.get("Sector Classification" if ucits else "Sector"))
        non_security = not security_isin and (
            (not ucits and not text(row.get("Ticker")))
            or any(part in name.upper() for part in ("CASH", "CURRENCY", "FUTURE", "DOLLAR"))
        )
        holdings.append(
            FundHolding(
                isin=security_isin,
                ticker=text(row.get("Ticker")),
                name=name,
                country=text(row.get("Trade Country Name")) or None,
                industry=sector or None,
                weight_pct=percentage(weight),
                asset_class="Cash & derivatives" if non_security else spec.asset_class,
            )
        )
    return make_snapshot(spec, holdings, date, unweighted=unweighted)


def fetch_spdr(client: httpx.Client, spec: FundSpec) -> FundSnapshot:
    if spec.holdings_url:
        response = client.get(issuer_url(spec.holdings_url, SPDR_ORIGIN))
        response.raise_for_status()
        return parse_spdr_workbook(response.content, spec)
    response = client.get(issuer_url(spec.source_url, SPDR_ORIGIN))
    response.raise_for_status()
    page = html.fromstring(response.content)
    links = page.xpath('//a[contains(@href, "/holdings-daily-")]/@href')
    links = list(dict.fromkeys(links))
    if len(links) != 1:
        raise ValueError(f"{spec.ticker}: State Street full holdings download is unavailable")
    response = client.get(issuer_url(links[0], SPDR_ORIGIN))
    response.raise_for_status()
    return parse_spdr_workbook(response.content, spec)
