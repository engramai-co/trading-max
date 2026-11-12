from datetime import date

import pytest
from trading_max.analytics.etf_projection import ETFExposure, tracking
from trading_max.analytics.lookthrough import FundHolding, FundSnapshot
from trading_max.domain.etf import FundEvidence, FundReturnPair, FundShareClass
from trading_max.reference import CatalogSecurityMaster, SecurityDescriptor

STAMP = "2026-11-11"
TODAY = date(2026, 11, 12)
X, Y, Z, W = (f"US000000000{i}" for i in range(1, 5))
A, B = "IE0000000001", "IE0000000002"


def holding(isin, weight):
    return FundHolding(isin=isin, name=isin, ticker="SAME", weight_pct=weight)


def test_project_exact_overlap_excludes_every_listing_of_the_same_share_class():
    exposure = ETFExposure(CatalogSecurityMaster.default().exact_security_id)
    target = FundSnapshot(
        ticker="A",
        fund_isin=A,
        as_of=STAMP,
        holdings=[
            holding(X, 50),
            holding(Y, 30),
            holding(Z, 20),
        ],
    )
    other = FundSnapshot(
        ticker="B",
        fund_isin=B,
        as_of=STAMP,
        holdings=[
            holding(Y, 60),
            holding(W, 40),
        ],
    )
    exposure.add_fund(A, "A.L", 100, target, failed=False)
    exposure.add_fund(A, "A.DE", 200, target, failed=False)
    exposure.add_fund(B, "B", 50, other, failed=False)
    exposure.add_direct(SecurityDescriptor(isin=X, ticker="SAME"), 20)
    exposure.add_direct(SecurityDescriptor(isin=W, ticker="SAME"), 30)
    funds = {
        summary.isin: (summary, matches) for summary, matches, _ in exposure.project(TODAY, STAMP)
    }
    summary, matches = funds[A]
    assert summary.tickers == ["A.DE", "A.L"]
    assert summary.overlap.value == pytest.approx(0.50)
    assert summary.overlap.fund_coverage == summary.overlap.rest_coverage == 1
    assert summary.overlap.dates_valid
    assert summary.overlap.fund_holdings_date == STAMP
    assert summary.overlap.rest_holdings_dates == [STAMP]
    assert matches[0].rest_via_fund == {B: 0.30}
    assert matches[1].rest_direct_weight == 0.20


def test_unidentified_constituents_stay_in_the_denominator_and_do_not_match_ticker():
    exposure = ETFExposure(CatalogSecurityMaster.default().exact_security_id)
    target = FundSnapshot(
        ticker="A",
        fund_isin=A,
        as_of=STAMP,
        holdings=[
            holding(X, 50),
            holding("", 50),
        ],
    )
    exposure.add_fund(A, "A.L", 100, target, failed=False)
    exposure.add_direct(SecurityDescriptor(isin=X, ticker="SAME"), 20)
    exposure.add_direct(SecurityDescriptor(ticker="SAME"), 80)
    summary, matches, _ = next(exposure.project(TODAY, STAMP))
    assert summary.overlap.value == pytest.approx(0.20)
    assert summary.overlap.fund_coverage == 0.50
    assert summary.overlap.rest_coverage == 0.20
    assert len(matches) == 1


def test_tracking_uses_published_period_and_comparable_hedging_only():
    pair = FundReturnPair(
        period_end="2026-10-31",
        nav_return=0.1245,
        benchmark_return=0.124,
        nav_currency="USD",
        benchmark_currency="USD",
        nav_hedging="unhedged",
        benchmark_hedging="unhedged",
        evidence=FundEvidence(
            source_url="https://issuer.example",
            effective_at="2026-10-31",
            fetched_at=STAMP,
            parser_version="test",
            coverage="available",
        ),
    )
    profile = FundShareClass(isin=A, issuer="Test", one_year=pair)
    assert tracking(profile, TODAY).difference_pp == pytest.approx(0.05)
    assert tracking(profile, date(2027, 11, 12)).state == "stale"
    pair.nav_hedging = "GBP"
    assert tracking(profile, TODAY).state == "incomparable"
    assert tracking(profile, TODAY).difference_pp is None
    pair.nav_hedging = None
    assert tracking(profile, TODAY).state == "missing"
    eqgb = FundShareClass(
        isin="IE00BYVTMW98",
        issuer="Invesco",
        hedging="GBP",
        share_currency="GBP",
        benchmark_currency="USD",
        benchmark_hedging="unhedged",
    )
    assert tracking(eqgb, TODAY).state == "incomparable"


def test_journal_records_only_observed_disclosures_and_real_index_changes():
    from trading_max.analytics.etf_journal import update_etf_journal
    from trading_max.analytics.etf_projection import (
        ETFOverlap,
        ETFPortfolio,
        ETFReading,
        ETFTracking,
    )

    source = FundEvidence(
        source_url="https://issuer.example",
        effective_at=STAMP,
        fetched_at=STAMP,
        parser_version="test",
        coverage="available",
    )
    fund = ETFReading(
        isin=A,
        tickers=["A"],
        index_name="Index A",
        holdings_state="available",
        overlap=ETFOverlap(state="missing", fund_holdings_date=STAMP),
        tracking=ETFTracking(state="missing"),
        evidence={"index_name": source, "holdings_date": source},
    )
    first = ETFPortfolio(funds=[fund])
    journal = update_etf_journal({}, ETFPortfolio(), first, STAMP)
    assert [row["kind"] for row in journal[A]] == ["holdings"]
    assert update_etf_journal(journal, first, first, STAMP) == journal
    after = ETFPortfolio(funds=[fund.model_copy(update={"index_name": "Index B"})])
    changed = update_etf_journal(journal, first, after, STAMP)
    assert changed[A][-1]["kind"] == "index-change"
    assert changed[A][-1]["previousValue"] == "Index A"
    assert changed[A][-1]["sourceUrl"] == source.source_url
