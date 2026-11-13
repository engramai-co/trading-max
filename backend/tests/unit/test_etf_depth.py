import json
from datetime import UTC, datetime
from types import SimpleNamespace

from trading_max.analytics.etf_details import etf_holdings_key
from trading_max.analytics.etf_journal import update_etf_journal
from trading_max.analytics.etf_peers import project_peers
from trading_max.analytics.etf_projection import (
    ETF_SUMMARY_KEY,
    ETFOverlap,
    ETFPortfolio,
    ETFReading,
    ETFTracking,
)
from trading_max.analytics.lookthrough import FundSnapshot
from trading_max.application.etf_depth_stage import ETFDepthStage
from trading_max.application.stages import StageContext
from trading_max.domain.etf import FundEvidence, FundReturnPair, FundShareClass, FundSize
from trading_max.domain.etf_depth import (
    ETF_PEERS_KEY,
    HMRC_REPORTING_KEY,
    ReportingPeriod,
    ReportingRegister,
)
from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore

A = "ZZ0000000011"
B = "ZZ0000000022"
C = "ZZ0000000033"
D = "ZZ0000000044"
E = "ZZ0000000055"
F = "ZZ0000000066"
NOW = datetime(2026, 11, 13, 10, tzinfo=UTC)
DATE = NOW.date().isoformat()
STAMP = NOW.isoformat()


def profile(
    isin,
    *,
    fee=0.002,
    income="Accumulating",
    index="MSCI World Index (Net)",
    period=DATE,
    expense_basis="TER",
):
    source = FundEvidence(
        source_url=f"https://issuer.example/{isin}",
        effective_at=DATE,
        fetched_at=STAMP,
        parser_version="fixture",
        coverage="available",
    )
    return FundShareClass(
        isin=isin,
        issuer="iShares",
        name="Synthetic " + isin,
        index_name=index,
        domicile="Ireland",
        hedging="unhedged",
        income_use=income,
        expense_ratio=fee,
        fee_basis=expense_basis,
        share_class_size=FundSize(amount=100, currency="USD"),
        one_year=FundReturnPair(
            period_end=period,
            nav_return=0.10,
            benchmark_return=0.11,
            nav_currency="USD",
            benchmark_currency="USD",
            nav_hedging="unhedged",
            benchmark_hedging="unhedged",
            evidence=source,
        ),
        evidence=dict.fromkeys(
            (
                "index_name",
                "hedging",
                "income_use",
                "domicile",
                "expense_ratio",
                "share_class_size",
            ),
            source,
        ),
    )


def reading(p, overlap=0.2):
    return ETFReading(
        isin=p.isin,
        tickers=["FUND" + p.isin[-1] + ".L"],
        index_name=p.index_name,
        holdings_state="available",
        evidence=p.evidence,
        tracking=ETFTracking(state="missing"),
        overlap=ETFOverlap(
            state="available",
            value=overlap,
            fund_coverage=0.99,
            rest_coverage=0.99,
            dates_valid=True,
            portfolio_as_of=STAMP,
            fund_holdings_date=DATE,
        ),
    )


def test_peers_require_exact_share_class_and_comparable_metric_basis():
    profiles = {
        A: profile(A),
        B: profile(B),
        C: profile(C, fee=0.001, period="2026-10-31", expense_basis="OCF"),
        D: profile(D, income="Distributing"),
        E: profile(E, index="MSCI World"),
        F: profile(F, fee=0.001),
    }
    portfolio = ETFPortfolio(funds=[reading(profiles[A]), reading(profiles[C], overlap=0.4)])
    rows = project_peers(portfolio, profiles, {B, C, D, E}, NOW)[A]
    assert [row.isin for row in rows.funds] == [A, B, C]
    assert rows.ranks["fee"].percentile == 50  # one equal fee, one different fee basis
    assert rows.ranks["fee"].comparable_isins == [A, B]
    assert rows.ranks["shareClassSize"].count == 3
    assert rows.ranks["tracking"].comparable_isins == [A, B]  # different period end for C
    assert rows.ranks["overlap"].comparable_isins == [A, C]  # B has no portfolio overlap
    assert rows.ranks["overlap"].percentile == 0


def test_benchmark_log_survives_missing_or_removed_fund_and_preserves_evidence():
    base = profile(A)
    before = ETFPortfolio(funds=[reading(base)])
    benchmarks = {}
    assert update_etf_journal({}, ETFPortfolio(), before, STAMP, benchmarks=benchmarks) == {}
    assert benchmarks[A].value == base.index_name

    unavailable = before.funds[0].model_copy(update={"index_name": "Unverified", "evidence": {}})
    assert (
        update_etf_journal(
            {}, before, ETFPortfolio(funds=[unavailable]), STAMP, benchmarks=benchmarks
        )
        == {}
    )
    assert (
        update_etf_journal(
            {}, ETFPortfolio(funds=[unavailable]), ETFPortfolio(), STAMP, benchmarks=benchmarks
        )
        == {}
    )

    next_fund = reading(profile(A, index="MSCI World Index (Gross)"))
    changed = update_etf_journal(
        {}, ETFPortfolio(), ETFPortfolio(funds=[next_fund]), STAMP, benchmarks=benchmarks
    )
    (event,) = changed[A]
    assert event["previousValue"] == base.index_name
    assert event["evidence"]["sourceUrl"] == next_fund.evidence["index_name"].source_url
    assert event["previousEvidence"]["fetchedAt"] == STAMP
    assert (
        update_etf_journal(
            changed, before, ETFPortfolio(funds=[next_fund]), STAMP, benchmarks=benchmarks
        )
        == changed
    )


def test_stage_projects_only_from_published_and_already_cached_evidence(tmp_path):
    state = tmp_path
    artifacts = ContentAddressedArtifactStore(state / "artifacts")
    snapshots = SnapshotStore(state)
    a, b = profile(A), profile(B)
    summary = artifacts.put_json(
        key=ETF_SUMMARY_KEY,
        payload=ETFPortfolio(funds=[reading(a)]).model_dump(),
    ).ref
    held = artifacts.put_json(
        key=etf_holdings_key(A),
        payload=FundSnapshot(ticker=A, fund_isin=A, as_of=DATE, profile=a).model_dump(),
    ).ref
    snapshots.publish(scope="accounts", source="fixture", artifacts=[summary, held])
    catalogue = state / "reference" / "fund-catalogs"
    catalogue.mkdir(parents=True)
    (catalogue / "ishares.json").write_text(
        json.dumps({"funds": [{"isin": B, "issuer": "iShares"}]})
    )
    cache = state / "raw" / "fund-holdings" / "v4"
    cache.mkdir(parents=True)
    (cache / f"{B}.json").write_text(
        FundSnapshot(ticker=B, fund_isin=B, as_of=DATE, profile=b).model_dump_json()
    )
    register = ReportingRegister(
        source_url="https://www.gov.uk/example",
        attachment_url="https://assets.publishing.service.gov.uk/example.ods",
        publication_date=NOW.date(),
        fetched_at=NOW,
        parser_version="fixture",
        periods={A: [ReportingPeriod(effective_from=NOW.date())]},
    )
    stage = ETFDepthStage(
        state, artifacts, snapshots, SimpleNamespace(refresh=lambda now: register)
    )
    result = stage.run(StageContext(job_id="fixture", scope="research"))
    outputs = {ref.key: artifacts.get_json(ref.artifact_id).payload for ref in result.artifacts}
    assert set(outputs) == {ETF_PEERS_KEY, HMRC_REPORTING_KEY}
    assert outputs[HMRC_REPORTING_KEY][A]["state"] == "reporting"
    assert [row["isin"] for row in outputs[ETF_PEERS_KEY][A]["funds"]] == [A, B]
