from __future__ import annotations

from pathlib import Path

from trading_max.analytics.lookthrough import (
    FundHolding,
    FundSnapshot,
    LookthroughService,
)
from trading_max.application import StageContext
from trading_max.application.lookthrough_stages import PortfolioLookthroughStage
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.reference import (
    CatalogSecurityMaster,
    SecurityEntityRecord,
    SecurityMasterCatalog,
    classification_for_code,
)


def _master_with_funds(*tickers: str) -> CatalogSecurityMaster:
    return CatalogSecurityMaster(
        SecurityMasterCatalog(
            records=[
                SecurityEntityRecord(
                    entity_id=f"fund:{ticker.lower()}",
                    canonical_ticker=ticker,
                    entity_name=ticker,
                    security_type="ETF",
                    ticker_aliases=[ticker],
                    source="test-profile",
                )
                for ticker in tickers
            ]
        )
    )


class _FixtureProvider:
    def fetch(self, ticker: str) -> FundSnapshot | None:
        if ticker != "XUSE":
            return None
        return FundSnapshot(
            ticker="XUSE",
            as_of="2026-08-07",
            holdings=[
                FundHolding(
                    isin="US0378331005",
                    ticker="AAPL",
                    name="Apple Inc.",
                    country="United States",
                    industry="Information Technology",
                    weight_pct=50,
                ),
                FundHolding(
                    isin="US67066G1040",
                    ticker="NVDA",
                    name="NVIDIA Corp.",
                    country="United States",
                    industry="Information Technology",
                    weight_pct=50,
                ),
            ],
            country_weights={"United States": 100},
            industry_weights={"Information Technology": 100},
            source_url="https://example.test/xuse",
        )


def test_lookthrough_merges_direct_and_fund_exposure() -> None:
    service = LookthroughService(_FixtureProvider(), _master_with_funds("XUSE"))
    accounts = {
        "invest": {
            "fetched_at": "2026-08-07T20:00:00Z",
            "total_value_gbp": 100,
            "cash_gbp": 10,
            "investments_value_gbp": 90,
            "positions": [
                {
                    "ticker": "BE",
                    "name": "Bloom Energy",
                    "isin": "US0937121079",
                    "current_value_gbp": 50,
                },
                {
                    "ticker": "XUSE",
                    "name": "World ex-USA",
                    "isin": "IE000R4ZNTN3",
                    "current_value_gbp": 40,
                },
            ],
        },
        "isa": {
            "fetched_at": "2026-08-07T20:00:00Z",
            "total_value_gbp": 0,
            "cash_gbp": 0,
            "investments_value_gbp": 0,
            "positions": [],
        },
    }

    result = service.run(accounts)

    assert result["investedValueGbp"] == 90.0
    assert result["directValueGbp"] == 50.0
    assert result["etfValueGbp"] == 40.0
    assert result["lookthroughCoveragePct"] == 1.0
    by_ticker = {row["ticker"]: row for row in result["positions"]}
    assert by_ticker["BE"]["directValueGbp"] == 50.0
    assert by_ticker["AAPL"]["indirectValueGbp"] == 20.0
    assert by_ticker["NVDA"]["indirectValueGbp"] == 20.0
    assert result["countryAllocation"][0]["country"] == "United States"
    assert result["schemaVersion"] == 5
    assert result["gicsCoveragePct"] == 0.0
    assert result["gicsPendingValueGbp"] == 90.0
    assert result["gicsNotApplicableValueGbp"] == 0.0
    assert result["gicsSubIndustryAllocation"] == [
        {
            "subIndustryCode": None,
            "subIndustry": "Pending classification",
            "valueGbp": 90.0,
            "allocationPct": 1.0,
            "isNonGics": True,
            "classificationStatus": "pending-identity",
        }
    ]


def test_lookthrough_reports_missing_fund_source_without_fabricating_coverage() -> None:
    service = LookthroughService(
        lambda _ticker: None,
        _master_with_funds("XUSE"),
    )
    accounts = {
        "invest": {
            "total_value_gbp": 100,
            "cash_gbp": 0,
            "investments_value_gbp": 100,
            "positions": [
                {
                    "ticker": "XUSE",
                    "name": "World ex-USA",
                    "isin": "IE000R4ZNTN3",
                    "current_value_gbp": 100,
                }
            ],
        },
        "isa": {
            "total_value_gbp": 0,
            "cash_gbp": 0,
            "investments_value_gbp": 0,
            "positions": [],
        },
    }

    result = service.run(accounts)

    assert result["lookthroughCoveragePct"] == 0.0
    assert result["warnings"]
    assert result["positions"][0]["ticker"] == "XUSE"
    assert result["positions"][0]["gicsStatus"] == "not-applicable"
    assert result["gicsEligibleValueGbp"] == 0.0
    assert result["gicsNotApplicableValueGbp"] == 100.0
    assert result["sources"] == [
        {
            "ticker": "XUSE",
            "status": "unavailable",
            "asOf": "",
            "sourceUrl": "",
            "issuer": "",
            "holdingsCount": 0,
            "weightTotalPct": 0.0,
            "positionValueGbp": 100.0,
        }
    ]


def test_fund_holdings_only_treat_confirmed_company_instruments_as_equity() -> None:
    assert FundHolding(
        isin="US0378331005",
        name="Apple Inc",
        weight_pct=1,
        asset_class="Common Stock",
    ).is_equity
    assert (
        FundHolding(
            isin="US74347G3747",
            name="ProShares Treasury ETF",
            weight_pct=1,
            asset_class="Exchange Traded Fund",
        ).is_equity
        is False
    )
    assert (
        FundHolding(
            isin="US912810TM09",
            name="US Treasury",
            weight_pct=1,
            asset_class="Fixed Income",
        ).is_equity
        is False
    )


def test_lookthrough_sums_the_same_etf_across_accounts() -> None:
    service = LookthroughService(_FixtureProvider(), _master_with_funds("XUSE"))
    accounts = {
        "invest": {
            "investments_value_gbp": 40,
            "cash_gbp": 0,
            "positions": [
                {
                    "ticker": "XUSE",
                    "isin": "IE000R4ZNTN3",
                    "current_value_gbp": 25,
                }
            ],
        },
        "isa": {
            "investments_value_gbp": 15,
            "cash_gbp": 0,
            "positions": [
                {
                    "ticker": "XUSE",
                    "isin": "IE000R4ZNTN3",
                    "current_value_gbp": 15,
                }
            ],
        },
    }

    result = service.run(accounts)

    assert result["etfValueGbp"] == 40.0
    assert result["positions"][0]["valueGbp"] == 20.0
    assert result["positions"][1]["valueGbp"] == 20.0


def test_lookthrough_merges_alphabet_share_classes_as_company_exposure() -> None:
    alphabet_fund = FundSnapshot(
        ticker="XUSE",
        as_of="2026-08-07",
        holdings=[
            FundHolding(
                isin="US02079K3059",
                ticker="GOOGL",
                name="Alphabet Inc. Class A",
                country="United States",
                industry="Communication Services",
                weight_pct=40,
            ),
            FundHolding(
                isin="US02079K1079",
                ticker="GOOG",
                name="Alphabet Inc. Class C",
                country="United States",
                industry="Communication Services",
                weight_pct=60,
            ),
        ],
        country_weights={"United States": 100},
        industry_weights={"Communication Services": 100},
    )
    service = LookthroughService(
        lambda _ticker: alphabet_fund,
        CatalogSecurityMaster(
            SecurityMasterCatalog(
                records=[
                    SecurityEntityRecord(
                        entity_id="fund:xuse",
                        canonical_ticker="XUSE",
                        entity_name="World ex-USA",
                        security_type="ETF",
                        ticker_aliases=["XUSE"],
                        isins=["IE000R4ZNTN3"],
                        source="test-profile",
                    ),
                    SecurityEntityRecord(
                        entity_id="issuer:alphabet-inc",
                        canonical_ticker="GOOG",
                        entity_name="Alphabet Inc.",
                        country_of_risk="United States",
                        ticker_aliases=["GOOG", "GOOGL"],
                        name_aliases=[
                            "Alphabet Inc.",
                            "Alphabet Inc. Class A",
                            "Alphabet Inc. Class C",
                        ],
                        isins=["US02079K1079", "US02079K3059"],
                        gics=classification_for_code(
                            "50203010",
                            source="test-profile",
                        ),
                        source="test-profile",
                    ),
                ]
            )
        ),
    )
    accounts = {
        "invest": {
            "investments_value_gbp": 20,
            "cash_gbp": 0,
            "positions": [
                {
                    "ticker": "GOOGL",
                    "name": "Alphabet Inc. Class A",
                    "isin": "US02079K3059",
                    "current_value_gbp": 20,
                }
            ],
        },
        "isa": {
            "investments_value_gbp": 30,
            "cash_gbp": 0,
            "positions": [
                {
                    "ticker": "XUSE",
                    "isin": "IE000R4ZNTN3",
                    "current_value_gbp": 30,
                }
            ],
        },
    }

    result = service.run(accounts)

    assert result["underlyingCount"] == 1
    assert len(result["positions"]) == 1
    alphabet = result["positions"][0]
    assert alphabet["entityId"] == "issuer:alphabet-inc"
    assert alphabet["isin"] is None
    assert alphabet["ticker"] == "GOOG"
    assert alphabet["name"] == "Alphabet Inc."
    assert alphabet["country"] == "United States"
    assert alphabet["valueGbp"] == 50.0
    assert alphabet["allocationPct"] == 1.0
    assert alphabet["directValueGbp"] == 20.0
    assert alphabet["indirectValueGbp"] == 30.0
    assert alphabet["resolutionMethod"] in {"isin", "ticker"}
    assert alphabet["resolutionConfidence"] == 1.0
    assert alphabet["gics"]["subIndustryCode"] == "50203010"
    assert alphabet["etfContributors"] == [{"ticker": "XUSE", "valueGbp": 30.0}]
    assert result["gicsCoveragePct"] == 1.0
    assert result["gicsSubIndustryAllocation"] == [
        {
            "subIndustryCode": "50203010",
            "subIndustry": "Interactive Media & Services",
            "valueGbp": 50.0,
            "allocationPct": 1.0,
            "isNonGics": False,
            "classificationStatus": "classified",
        }
    ]


def test_lookthrough_keeps_partial_fund_as_unverified_direct_exposure() -> None:
    partial = FundSnapshot(
        ticker="XUSE",
        as_of="2026-08-07",
        holdings=[
            FundHolding(
                ticker="AAPL",
                name="Apple Inc.",
                country="United States",
                industry="Information Technology",
                weight_pct=40,
            )
        ],
    )
    service = LookthroughService(
        lambda _ticker: partial,
        _master_with_funds("XUSE"),
    )
    accounts = {
        "invest": {
            "investments_value_gbp": 100,
            "cash_gbp": 0,
            "positions": [
                {
                    "ticker": "XUSE",
                    "isin": "IE000R4ZNTN3",
                    "current_value_gbp": 100,
                }
            ],
        },
        "isa": {"investments_value_gbp": 0, "cash_gbp": 0, "positions": []},
    }

    result = service.run(accounts)

    assert result["lookthroughCoveragePct"] == 0.0
    assert result["positions"][0]["ticker"] == "XUSE"
    assert result["positions"][0]["directValueGbp"] == 100.0


def test_lookthrough_stage_reads_account_artifacts_and_publishes_dependencies(
    tmp_path: Path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    invest = artifacts.put_json(
        key="account/invest.json",
        payload={
            "fetched_at": "2026-08-07T20:00:00Z",
            "investments_value_gbp": 90,
            "cash_gbp": 10,
            "positions": [
                {
                    "ticker": "BE",
                    "name": "Bloom Energy",
                    "isin": "US0937121079",
                    "current_value_gbp": 50,
                },
                {
                    "ticker": "XUSE",
                    "name": "World ex-USA",
                    "isin": "IE000R4ZNTN3",
                    "current_value_gbp": 40,
                },
            ],
        },
        kind="account",
        producer_version="accounts-v1",
    )
    isa = artifacts.put_json(
        key="account/isa.json",
        payload={
            "fetched_at": "2026-08-07T20:00:00Z",
            "investments_value_gbp": 0,
            "cash_gbp": 0,
            "positions": [],
        },
        kind="account",
        producer_version="accounts-v1",
    )

    stage = PortfolioLookthroughStage(
        tmp_path,
        artifacts,
        LookthroughService(_FixtureProvider(), _master_with_funds("XUSE")),
    )
    result = stage.run(
        StageContext(
            job_id="lookthrough-test",
            scope="accounts",
            upstream_artifact_ids=(
                invest.ref.artifact_id,
                isa.ref.artifact_id,
            ),
        )
    )

    assert len(result.artifacts) == 1
    stored = artifacts.get_json(result.artifacts[0].artifact_id)
    assert stored.ref.key == "account/lookthrough_metrics.json"
    assert stored.ref.dependency_artifact_ids == [
        invest.ref.artifact_id,
        isa.ref.artifact_id,
    ]
    assert stored.payload["lookthroughCoveragePct"] == 1.0
