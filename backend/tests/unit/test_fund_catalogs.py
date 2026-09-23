from __future__ import annotations

import json
from dataclasses import asdict
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from trading_max.analytics.lookthrough import FundHolding, FundSnapshot
from trading_max.infrastructure.fund_catalogs import (
    FundCatalog,
    catalog_ishares,
    catalog_spdr,
    catalog_vaneck,
    catalog_vanguard,
)
from trading_max.infrastructure.fund_holdings import OfficialFundHoldingsProvider, fetch_invesco
from trading_max.infrastructure.fund_specs import FundSpec
from trading_max.reference import SecurityDescriptor

ISIN = "IE0000000001"


def test_ishares_discovers_unlisted_product_by_exact_isin():
    def handler(request):
        assert request.url.params["siteName"] == "ishares-uk"
        return httpx.Response(
            200,
            json={
                "987": {
                    "isin": ISIN,
                    "portfolioId": 987,
                    "localExchangeTicker": "NEWF",
                    "fundName": "Fixture",
                    "productView": "[etf]",
                    "productPageUrl": "/uk/individual/en/products/987",
                }
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        [fund] = catalog_ishares(client)
    assert fund.isin == ISIN
    assert fund.product_id == "987"
    assert "NEWF.L" in fund.aliases


def test_vanguard_uses_portfolio_identity_not_listing_port_id():
    def handler(request):
        if request.method == "GET":
            state = {
                "_angular_initial_state": {
                    ":items": {"root": {":items": {"site-config": {"portIds": "111,222"}}}}
                }
            }
            return httpx.Response(
                200, text=f'<script id="serverApp-state">{json.dumps(state)}</script>'
            )
        assert json.loads(request.content)["variables"]["portIds"] == ["111", "222"]
        return httpx.Response(
            200,
            json={
                "data": {
                    "funds": [
                        {
                            "profile": {
                                "portId": "111",
                                "fundFullName": "Vanguard Fixture",
                                "polarisPdtTypeIndicator": "ETF",
                                "identifiers": [{"altId": "ISIN", "altIdValue": ISIN}],
                                "listings": [
                                    {
                                        "portId": "L999",
                                        "identifiers": [{"altId": "TIDM", "altIdValue": "FIXT"}],
                                    }
                                ],
                            }
                        }
                    ]
                }
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        [fund] = catalog_vanguard(client)
    assert fund.product_id == "111"
    assert fund.aliases == ("FIXT",)


def test_vaneck_catalogue_requires_isin_not_a_colliding_us_display_ticker():
    def handler(request):
        if request.method == "GET":
            return httpx.Response(
                200,
                text='<script>window.config.currentPageId = 123;</script><div id="dropSectionAssetClass"><input value="eq"></div>',
            )
        return httpx.Response(
            200,
            json={
                "Success": True,
                "Result": {
                    "FundSet": [
                        {
                            "FundID": "UCTFIX",
                            "ISIN": ISIN,
                            "FundName": "Fixture",
                            "RowData": [
                                {"Header": "name", "Link": "/uk/en/investments/fixture/"},
                                {"Header": "ticker", "Value": "SMH"},
                            ],
                        }
                    ]
                },
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        [fund] = catalog_vaneck(client)
    assert fund.isin == ISIN
    assert fund.ticker == ""
    assert fund.aliases == ()


def test_spdr_uses_download_link_and_does_not_conflate_bare_spxl():
    def handler(request):
        uk = request.url.params["country"] == "uk"
        row = {
            "fundName": "Fixture",
            "fundTicker": "SPYL LN",
            "fundFilter": "SPYL-GY",
            "keywords": f"SPYL, SPXL, SPXL LN, {ISIN}, Equity",
            "fundUri": "/uk/en_gb/fund",
            "documentPdf": [
                {
                    "docType": "Holdings-daily",
                    "docs": [{"path": "/library-content/holdings-daily-fixture.xlsx"}],
                }
            ],
        }
        return httpx.Response(
            200,
            json={"data": {"funds": {"uk-etfs" if uk else "etfs": {"datas": [row] if uk else []}}}},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        [fund] = catalog_spdr(client)
    assert fund.ticker == ""
    assert fund.aliases == ("SPXL.L",)
    assert fund.product_id == "SPYL-GY"
    assert fund.holdings_url.endswith("holdings-daily-fixture.xlsx")


def test_exact_isin_can_resolve_new_listing_while_conflicting_ticker_cannot(tmp_path):
    catalog = FundCatalog(tmp_path)
    with httpx.Client(
        transport=httpx.MockTransport(lambda r: pytest.fail("unexpected network"))
    ) as client:
        fund = catalog.resolve(SecurityDescriptor(ticker="SMH.L", isin="IE00BMC38736"), client)
        assert fund.issuer == "VanEck"
        assert fund.ticker == "SMH.L"
        assert (
            catalog.resolve(SecurityDescriptor(ticker="SMGB", isin="US0000000001"), client) is None
        )
        assert catalog.resolve(SecurityDescriptor(ticker="SMH"), client) is None


def test_catalog_outage_uses_prior_verified_isin_discovery(tmp_path):
    root = tmp_path / "reference/fund-catalogs"
    root.mkdir(parents=True)
    fund = FundSpec("FIX", ISIN, "Fixture", "State Street", "https://www.ssga.com/fund", "FIX")
    (root / "state-street.json").write_text(
        json.dumps(
            {
                "fetchedAt": (datetime.now(UTC) - timedelta(days=10)).isoformat(),
                "funds": [asdict(fund)],
            }
        )
    )
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503))) as client:
        result = FundCatalog(tmp_path).resolve(
            SecurityDescriptor(ticker="ALIAS", isin=ISIN, name="SPDR Fixture"), client
        )
    assert result.ticker == "ALIAS"
    assert result.isin == ISIN


def test_cache_cannot_attach_another_isin_to_a_reused_ticker(tmp_path):
    root = tmp_path / "raw/fund-holdings"
    root.mkdir(parents=True)
    snapshot = FundSnapshot(
        ticker="SMGB",
        fund_isin="US0000000001",
        as_of="2026-09-22",
        fetched_at=datetime.now(UTC).isoformat(),
        cache_schema_version=3,
        holdings=[FundHolding(name="Wrong company", weight_pct=100)],
    )
    (root / "SMGB.json").write_text(snapshot.model_dump_json())
    calls = []
    provider = OfficialFundHoldingsProvider(
        tmp_path, fetcher=lambda ticker: calls.append(ticker) or snapshot
    )
    with pytest.raises(ValueError, match="ISIN mismatch"):
        provider.fetch_security(SecurityDescriptor(ticker="SMGB", isin="IE00BMC38736"))
    assert calls == ["SMGB"]


def test_failed_download_is_backed_off_between_stages(tmp_path):
    calls = []

    def fail(ticker):
        calls.append(ticker)
        raise httpx.ReadTimeout("issuer temporarily unavailable")

    provider = OfficialFundHoldingsProvider(tmp_path, fetcher=fail)
    with pytest.raises(httpx.ReadTimeout):
        provider.fetch("SMGB")
    assert provider.fetch("SMGB") is None
    assert calls == ["SMGB"]


def test_invesco_reads_fund_not_index_and_preserves_cash_and_share_class():
    requests = []

    def handler(request):
        requests.append(str(request.url))
        assert ISIN in request.url.path
        if request.url.path.endswith(ISIN):
            payload = {
                "aliases": {"isin": ISIN},
                "replicationMethod": "Physical",
                "investmentStrategy": {"assetType": "Equity"},
            }
        elif "/holdings/" in request.url.path:
            assert request.url.path.endswith("/holdings/fund")
            payload = {
                "effectiveDate": "2026-09-22",
                "numberOfHoldings": 1,
                "holdings": [
                    {"isin": "US0000000001", "name": "Fixture", "weight": 99},
                    {"name": "Cash and/or Derivatives", "weight": 1},
                ],
            }
        else:
            payload = {"holdingWeights": [{"name": "Fixture", "value": 100}]}
        return httpx.Response(200, json=payload)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = fetch_invesco(
            client,
            FundSpec(
                "TEST",
                ISIN,
                "Fixture",
                "Invesco",
                "https://www.invesco.com",
                data_isin="IE0000000002",
            ),
        )
    assert result.weight_total_pct() == 100
    assert not result.holdings[-1].is_security
    assert len(requests) == 4
