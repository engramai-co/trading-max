"""Synthetic official-response contracts; live account/source data stays outside Git."""

from __future__ import annotations

from io import BytesIO

import httpx
import pytest
from openpyxl import Workbook
from trading_max.infrastructure.fund_downloads import issuer_url
from trading_max.infrastructure.fund_isin_issuers import (
    fetch_amundi,
    fetch_jpmorgan,
    fetch_xtrackers,
)
from trading_max.infrastructure.fund_specs import FundSpec
from trading_max.infrastructure.fund_vaneck_spdr import fetch_vaneck, parse_spdr_workbook

FUND_ISIN = "IE0000000001"
STOCK_ISIN = "US0000000001"


def spec(issuer: str) -> FundSpec:
    origins = {"VanEck": "https://www.vaneck.com", "State Street": "https://www.ssga.com"}
    return FundSpec(
        "TEST",
        FUND_ISIN,
        "Synthetic fund",
        issuer,
        origins.get(issuer, "https://issuer.example") + "/fund",
        "TEST",
    )


def client_for(payload: dict) -> httpx.Client:
    return httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    )


def vaneck_payload() -> dict:
    return {
        "data": {
            "Ticker": "TEST",
            "IsTopTen": False,
            "TotalAmount": "1",
            "AsOfDate": "22 Sep 2026",
            "Holdings": [
                {
                    "Ticker": "TEST",
                    "ISIN": STOCK_ISIN,
                    "FIGI": "BBG000000001",
                    "Label": "FIXT US",
                    "HoldingName": "Fixture Equity",
                    "Weight": "98.5",
                    "Country": "United States",
                    "Sector": "Industrials",
                    "AssetClass": "Stock",
                    "AsOfDate": "2026-09-22",
                },
                {
                    "Ticker": "TEST",
                    "Label": "USD",
                    "HoldingName": "Cash",
                    "Weight": "1.5",
                    "AssetClass": "Cash",
                },
            ],
        }
    }


def vaneck_client(payload: dict, identity: str = FUND_ISIN) -> httpx.Client:
    def handler(request):
        if request.url.path == "/fund":
            return httpx.Response(
                200,
                text=f'''<script type="application/ld+json">{{"@graph":[{{"identifier":"{identity}"}}]}}</script>
                <ve-fundticker>TEST</ve-fundticker><ve-holdingsblock data-blockid="4" data-pageid="5"></ve-holdingsblock>''',
            )
        assert request.url.params["ticker"] == "TEST"
        assert request.url.params["blockid"] == "4"
        return httpx.Response(200, json=payload)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_vaneck_uses_full_issuer_holdings_and_preserves_cash_country_and_date():
    with vaneck_client(vaneck_payload()) as client:
        result = fetch_vaneck(client, spec("VanEck"))
    assert result.fund_isin == FUND_ISIN
    assert result.as_of == "2026-09-22"
    assert result.weight_total_pct() == 100
    assert result.holdings[0].is_equity
    assert not result.holdings[1].is_security
    assert result.country_weights == {"United States": 98.5, "Cash & derivatives": 1.5}


@pytest.mark.parametrize("defect", ["top-ten", "count", "identity", "date", "weight"])
def test_vaneck_rejects_partial_or_conflicting_downloads(defect):
    data = vaneck_payload()
    identity = FUND_ISIN
    if defect == "top-ten":
        data["data"]["IsTopTen"] = True
    if defect == "count":
        data["data"]["TotalAmount"] = 2
    if defect == "identity":
        identity = "IE0000000002"
    if defect == "date":
        data["data"]["Holdings"][0]["AsOfDate"] = "2026-09-21"
    if defect == "weight":
        data["data"]["Holdings"][0]["Weight"] = "NaN"
    with vaneck_client(data, identity) as client, pytest.raises(ValueError):
        fetch_vaneck(client, spec("VanEck"))


def spdr_workbook(*, fund_isin=FUND_ISIN, weight=100, missing=True) -> bytes:
    book = Workbook()
    sheet = book.active
    sheet.title = "holdings"
    for row in [
        ["Fund Name:", "Synthetic ETF"],
        ["ISIN:", fund_isin],
        ["Ticker Symbol:", "TEST GY"],
        ["Holdings As Of:", "22-Sep-2026"],
        [],
        [
            "ISIN",
            "Security Name",
            "Percent of Fund",
            "Number of Shares",
            "Trade Country Name",
            "Sector Classification",
        ],
        [STOCK_ISIN, "Fixture Equity", weight, 123, "United States", "Industrials"],
    ]:
        sheet.append(row)
    if missing:
        sheet.append(["Unassigned", "USD", "-", 42, "-", "-"])
    sheet.append(["Issuer legal disclaimer"])
    result = BytesIO()
    book.save(result)
    return result.getvalue()


def test_spdr_keeps_unweighted_cash_explicit_without_imputing_or_normalizing():
    result = parse_spdr_workbook(spdr_workbook(), spec("State Street"))
    assert len(result.holdings) == 1
    assert result.unweighted_holdings_count == 1
    assert result.weight_total_pct() == 100
    assert result.as_of == "2026-09-22"


@pytest.mark.parametrize("kwargs", [{"fund_isin": "IE0000000002"}, {"weight": 30}])
def test_spdr_rejects_wrong_share_class_and_partial_equity_list(kwargs):
    with pytest.raises(ValueError):
        parse_spdr_workbook(spdr_workbook(**kwargs), spec("State Street"))


def amundi_payload() -> dict:
    return {
        "products": [
            {
                "productId": FUND_ISIN,
                "characteristics": {
                    "ISIN": FUND_ISIN,
                    "FUND_REPLICATION_METHODOLOGY": "Direct(Physical)",
                    "POSITION_AS_OF_DATE": "2026-09-21",
                },
                "composition": {
                    "totalNumberOfInstruments": 2,
                    "compositionData": [
                        {
                            "weight": 1.01,
                            "compositionCharacteristics": {
                                "date": "2026-09-21",
                                "isin": STOCK_ISIN,
                                "name": "Fixture",
                                "type": "EQUITY_ORDINARY",
                                "countryOfRisk": "Japan",
                            },
                        },
                        {
                            "weight": -0.01,
                            "compositionCharacteristics": {
                                "date": "2026-09-21",
                                "name": "Cash",
                                "type": "CASH",
                            },
                        },
                    ],
                },
            }
        ]
    }


def test_amundi_converts_fractional_units_and_preserves_signed_cash():
    with client_for(amundi_payload()) as client:
        result = fetch_amundi(client, spec("Amundi"))
    assert [row.weight_pct for row in result.holdings] == [101, -1]
    assert result.country_weights == {"Japan": 101, "Cash & derivatives": -1}


@pytest.mark.parametrize("defect", ["swap", "count", "identity", "date"])
def test_amundi_rejects_substitute_baskets_and_incomplete_or_wrong_share_classes(defect):
    payload = amundi_payload()
    fund = payload["products"][0]
    if defect == "swap":
        fund["characteristics"]["FUND_REPLICATION_METHODOLOGY"] = "Indirect(Swap Based)"
    if defect == "count":
        fund["composition"]["totalNumberOfInstruments"] = 12
    if defect == "identity":
        fund["productId"] = "IE0000000002"
    if defect == "date":
        fund["composition"]["compositionData"][0]["compositionCharacteristics"]["date"] = (
            "2026-09-20"
        )
    with client_for(payload) as client, pytest.raises(ValueError):
        fetch_amundi(client, spec("Amundi"))


def jpm_payload() -> dict:
    return {
        "fundData": {
            "shareClass": {"cusip": FUND_ISIN},
            "fundTypeCode": "N_ETF",
            "numberOfHoldings": 2,
            "dailyHoldings": {"data": [{"marketValuePercent": 25}]},
            "dailyHoldingsAll": {
                "effectiveDate": "2026-09-22",
                "data": [
                    {
                        "securityIsin": STOCK_ISIN,
                        "securityType": "Common Stock",
                        "securityDescription": "Fixture",
                        "marketValuePercent": 101,
                        "navDate": "2026-09-22",
                    },
                    {
                        "securityType": "Option - Index",
                        "securityDescription": "Index option",
                        "marketValuePercent": -1,
                        "navDate": "2026-09-22",
                    },
                ],
            },
        }
    }


def test_jpm_uses_full_table_not_preview_and_options_are_not_company_equity():
    with client_for(jpm_payload()) as client:
        result = fetch_jpmorgan(client, spec("JPMorgan"))
    assert result.weight_total_pct() == 100
    assert result.holdings[0].is_equity
    assert not result.holdings[1].is_security


@pytest.mark.parametrize("defect", ["count", "identity", "date", "top-ten-only"])
def test_jpm_rejects_invalid_full_holdings(defect):
    payload = jpm_payload()
    fund = payload["fundData"]
    if defect == "count":
        fund["numberOfHoldings"] = 10
    if defect == "identity":
        fund["shareClass"]["cusip"] = "IE0000000002"
    if defect == "date":
        fund["dailyHoldingsAll"]["data"][0]["navDate"] = "2026-09-21"
    if defect == "top-ten-only":
        del fund["dailyHoldingsAll"]
    with client_for(payload) as client, pytest.raises((ValueError, KeyError)):
        fetch_jpmorgan(client, spec("JPMorgan"))


def dws_client(*, method="Direct Replication (physically)", identity=FUND_ISIN) -> httpx.Client:
    def handler(request):
        if request.url.path.endswith("pdpMetaTagsTealium"):
            return httpx.Response(
                200,
                json={
                    "metaTags": {"canonical": f"https://etf.dws.com/en-gb/{FUND_ISIN}-fixture"},
                    "pdpResult": {
                        "pageFrame": {
                            "productHeader": {"identifier": [{"key": "ISIN", "value": identity}]}
                        },
                        "pageSections": {
                            "keyFacts": {
                                "accordionItems": [
                                    {
                                        "listBundle": [
                                            {
                                                "id": "fundinformation-indexreplication",
                                                "items": [
                                                    {
                                                        "key": "Investment methodology",
                                                        "value": method,
                                                    }
                                                ],
                                            }
                                        ]
                                    }
                                ]
                            }
                        },
                    },
                },
            )
        names = ["Asset class", "Name", "% Weight", "ISIN", "Industry", "Country"]
        return httpx.Response(
            200,
            json={
                "tables": [
                    {
                        "id": "securitiesheldtable-securitiesholding",
                        "columns": [
                            {"key": f"x{i}", "value": name} for i, name in enumerate(names)
                        ],
                        "downloadLinks": [
                            {"url": f"https://etf.dws.com/export/constituent/{FUND_ISIN}/"}
                        ],
                        "disclaimers": [{"text": "<p>Source: DWS 21/09/2026</p>"}],
                        "values": [
                            {
                                "x0": {"value": "Equities"},
                                "x1": {"value": "Fixture"},
                                "x2": {"value": "100.0%", "sortValue": 100.0},
                                "x3": {"value": STOCK_ISIN},
                                "x4": {"value": "Industrials"},
                                "x5": {"value": "Japan"},
                            }
                        ],
                    }
                ]
            },
        )

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_xtrackers_maps_named_columns_and_uses_portfolio_date_and_percentage_units():
    with dws_client() as client:
        result = fetch_xtrackers(client, spec("Xtrackers"))
    assert result.as_of == "2026-09-21"
    assert result.holdings[0].weight_pct == 100
    assert result.holdings[0].country == "Japan"


@pytest.mark.parametrize(
    "kwargs", [{"method": "Indirect Replication (Swap)"}, {"identity": "IE0000000002"}]
)
def test_xtrackers_rejects_swap_baskets_and_different_identity(kwargs):
    with dws_client(**kwargs) as client, pytest.raises(ValueError):
        fetch_xtrackers(client, spec("Xtrackers"))


@pytest.mark.parametrize(
    "url",
    [
        "https://attacker.example/fund",
        "http://www.ssga.com/fund",
        "https://user@www.ssga.com/fund",
        "https://www.ssga.com:8421/fund",
    ],
)
def test_catalog_links_cannot_select_another_origin(url):
    with pytest.raises(ValueError):
        issuer_url(url, "https://www.ssga.com")
