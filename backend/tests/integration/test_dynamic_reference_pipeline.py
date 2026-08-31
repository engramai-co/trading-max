from __future__ import annotations

from pathlib import Path

from trading_max.analytics.lookthrough import FundHolding, FundSnapshot, LookthroughService
from trading_max.application import (
    PortfolioLookthroughStage,
    SecurityMasterEnrichmentStage,
    StageContext,
)
from trading_max.infrastructure import ContentAddressedArtifactStore
from trading_max.reference import CatalogSecurityMaster, SecurityDescriptor
from trading_max.reference.enrichment import (
    MarketSecurityProfile,
    SecurityMasterEnricher,
)


class _ProfileProvider:
    def resolve(self, security: SecurityDescriptor) -> MarketSecurityProfile:
        profiles = {
            "XUSE": MarketSecurityProfile(
                symbol="IXUA.DE",
                name="iShares MSCI World ex-USA UCITS ETF",
                quote_type="ETF",
                exchange="GER",
                as_of="2026-08-13",
            ),
            "BE": MarketSecurityProfile(
                symbol="BE",
                name="Bloom Energy Corporation",
                quote_type="EQUITY",
                exchange="NYSE",
                country="United States",
                sector="Industrials",
                industry="Electrical Equipment & Parts",
                as_of="2026-08-13",
            ),
            "AAPL": MarketSecurityProfile(
                symbol="AAPL",
                name="Apple Inc.",
                quote_type="EQUITY",
                exchange="NASDAQ",
                country="United States",
                sector="Technology",
                industry="Consumer Electronics",
                as_of="2026-08-13",
            ),
            "PST": MarketSecurityProfile(
                symbol="PST",
                name="ProShares UltraShort 7-10 Year Treasury",
                quote_type="ETF",
                provider_security_type="Open-End Fund",
                provider_security_type2="Exchange Traded Fund",
                market_sector="Equity",
                exchange="NYSE",
                as_of="2026-08-13",
            ),
        }
        return profiles[security.ticker]


class _FundProvider:
    @staticmethod
    def fetch(ticker: str) -> FundSnapshot | None:
        if ticker != "XUSE":
            return None
        return FundSnapshot(
            ticker="XUSE",
            as_of="2026-08-12",
            fetched_at="2026-08-13T08:00:00+00:00",
            cache_schema_version=2,
            holdings=[
                FundHolding(
                    ticker="AAPL",
                    isin="US0378331005",
                    name="Apple Inc.",
                    country="United States",
                    weight_pct=95,
                ),
                FundHolding(
                    ticker="PST",
                    isin="US74347G3747",
                    name="ProShares UltraShort 7-10 Year Treasury",
                    country="United States",
                    weight_pct=5,
                    asset_class="Exchange Traded Fund",
                ),
            ],
            country_weights={"United States": 100},
            industry_weights={"Information Technology": 100},
            source_url="https://example.test/xuse",
            issuer="Example",
        )


def _account_artifacts(
    artifacts: ContentAddressedArtifactStore,
) -> tuple[str, ...]:
    values = {
        "invest": {
            "fetched_at": "2026-08-13T08:00:00+00:00",
            "investments_value_gbp": 40,
            "cash_gbp": 0,
            "positions": [
                {
                    "ticker": "BE",
                    "name": "Bloom Energy Corporation",
                    "isin": "US0937121079",
                    "current_value_gbp": 40,
                }
            ],
        },
        "isa": {
            "fetched_at": "2026-08-13T08:00:00+00:00",
            "investments_value_gbp": 60,
            "cash_gbp": 0,
            "positions": [
                {
                    "ticker": "XUSE",
                    "name": "World ex-USA",
                    "isin": "IE000R4ZNTN3",
                    "current_value_gbp": 60,
                }
            ],
        },
    }
    return tuple(
        artifacts.put_json(
            key=f"account/{profile}.json",
            payload=payload,
            kind="account",
            producer_version="test",
        ).ref.artifact_id
        for profile, payload in values.items()
    )


def test_reference_stage_classifies_fund_constituents_before_lookthrough(
    tmp_path: Path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    account_ids = _account_artifacts(artifacts)
    fund_provider = _FundProvider()
    stage = SecurityMasterEnrichmentStage(
        tmp_path,
        artifacts,
        enricher=SecurityMasterEnricher(
            tmp_path,
            provider=_ProfileProvider(),
            target_coverage=1.0,
            max_workers=1,
        ),
        fund_provider=fund_provider,
    )

    reference_result = stage.run(
        StageContext(
            job_id="reference",
            scope="accounts",
            upstream_artifact_ids=account_ids,
        )
    )
    by_key = {
        artifact.key: artifacts.get_json(artifact.artifact_id)
        for artifact in reference_result.artifacts
    }
    report = by_key["reference/security_master_report.json"]
    catalog = by_key["reference/security_master.json"]

    assert report.payload["classificationCoveragePct"] == 1.0
    assert report.payload["gicsEligibleExposureGbp"] == 97.0
    assert report.payload["gicsNotApplicableExposureGbp"] == 3.0
    assert report.ref.quality.coverage == "100.00%"
    assert len(catalog.payload["records"]) == 4
    master = CatalogSecurityMaster.from_state_root(tmp_path)
    assert master.resolve(SecurityDescriptor(ticker="XUSE")).security_type == "ETF"
    bloom = master.resolve(SecurityDescriptor(ticker="BE"))
    apple = master.resolve(SecurityDescriptor(ticker="AAPL"))
    nested_fund = master.resolve(SecurityDescriptor(ticker="PST"))
    assert bloom.gics is not None
    assert bloom.gics.sub_industry_code == "20104010"
    assert apple.gics is not None
    assert apple.gics.sub_industry_code == "45202030"
    assert nested_fund.gics is None
    assert nested_fund.gics_eligibility == "not-applicable"

    lookthrough = PortfolioLookthroughStage(
        tmp_path,
        artifacts,
        LookthroughService(fund_provider, master),
    )
    lookthrough_result = lookthrough.run(
        StageContext(
            job_id="lookthrough",
            scope="accounts",
            upstream_artifact_ids=(
                *account_ids,
                *(artifact.artifact_id for artifact in reference_result.artifacts),
            ),
        )
    )
    payload = artifacts.get_json(lookthrough_result.artifacts[0].artifact_id).payload
    assert catalog.ref.artifact_id in lookthrough_result.artifacts[0].dependency_artifact_ids
    assert payload["gicsCoveragePct"] == 1.0
    assert payload["gicsPortfolioCoveragePct"] == 0.97
    assert payload["gicsNotApplicableValueGbp"] == 3.0
    assert {
        (row["subIndustryCode"], row["classificationStatus"])
        for row in payload["gicsSubIndustryAllocation"]
    } == {
        ("20104010", "classified"),
        ("45202030", "classified"),
        (None, "not-applicable"),
    }
