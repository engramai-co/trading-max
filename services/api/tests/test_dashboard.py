from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.dashboard import (
    _nav_series,
    _option_rows,
    _technical_rows,
    _valuation_rows,
    build_dashboard_data,
)
from services.api.trading_max_api.dashboard_models import ValuationScenario


def test_analyst_fallback_valuation_scenario_allows_missing_dcf_inputs() -> None:
    scenario = ValuationScenario.model_validate(
        {
            "method": "analyst-fallback",
            "value": 300.0,
            "value10": 300.0,
        }
    )

    assert scenario.value == 300.0
    assert scenario.value10 == 300.0
    assert scenario.revenue_cagr is None
    assert scenario.target_fcf_margin is None
    assert scenario.discount_rate is None
    assert scenario.exit_fcf_multiple is None
    assert scenario.share_cagr is None
    assert scenario.gordon_multiple is None


def test_dashboard_contract_is_built_from_snapshot(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    manifest = typed_fixture(research_root, store)
    payload = build_dashboard_data(store, manifest)

    assert payload["totalValueGbp"] == 2000
    assert payload["holdings"][0]["ticker"] == "BE"
    assert payload["holdings"][0]["dilutedCostGbp"] == 321.85
    assert payload["holdings"][0]["dilutedCostPerShareGbp"] == 64.37
    assert payload["holdings"][0]["dilutedCostPerShareNative"] == pytest.approx(83.681)
    assert payload["holdings"][0]["dilutedCostCurrency"] == "USD"
    assert payload["holdings"][0]["snapshotFxRateNativePerGbp"] == pytest.approx(1.3)
    assert payload["holdings"][0]["fxImpactGbp"] == -7.5
    assert payload["holdings"][0]["allocationPct"] == 0.5
    assert payload["accounts"][0]["twr"] == pytest.approx(0.02)
    assert payload["accountAnalysis"]["A"]["period_net"] == 42.0
    assert payload["accountReport"]["policy"]["a_campaign"]["win_rate"] == 0.5
    assert payload["accountReport"]["capitalRecovery"] is None
    assert payload["technical"][0]["ticker"] == "BE"
    assert "priceSeries" not in payload["technical"][0]
    assert payload["valuations"][0]["ev5Upside"] == pytest.approx(0.1)
    assert payload["lookthrough"]["available"] is True
    assert payload["lookthrough"]["positions"][0]["ticker"] == "BE"
    assert payload["lookthrough"]["industryAllocation"][0]["industry"] == "Industrials"
    assert payload["lookthrough"]["gicsCoveragePct"] == 0.0
    assert payload["lookthrough"]["gicsSubIndustryAllocation"] == []
    assert payload["nav"][-1]["totalTwr"] is not None
    assert payload["intradayNav"] == []
    assert "archive" not in payload
    assert "artifacts" not in payload


def test_dashboard_exposes_intraday_value_anchors_separately_without_fake_twr(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    previous = store.immutable_snapshots.latest()
    assert previous is not None
    anchor = store.immutable_artifacts.put_json(
        key="account/nav/intraday_anchors.json",
        payload={
            "schema_version": 1,
            "generated_at": "2026-08-01T20:20:00Z",
            "interval_seconds": 600,
            "retention_days": 14,
            "points": [
                {
                    "observed_at": "2026-08-01T20:10:00Z",
                    "bucket_at": "2026-08-01T20:10:00Z",
                    "invest_value_gbp": 1210,
                    "isa_value_gbp": 805,
                    "total_value_gbp": 2015,
                    "invest_cash_gbp": 200,
                    "isa_cash_gbp": 100,
                    "external_flow_gbp": None,
                    "flow_status": "unverified",
                    "source_artifact_ids": [],
                },
                {
                    "observed_at": "2026-08-01T20:20:00Z",
                    "bucket_at": "2026-08-01T20:20:00Z",
                    "invest_value_gbp": 1220,
                    "isa_value_gbp": 810,
                    "total_value_gbp": 2030,
                    "invest_cash_gbp": 200,
                    "isa_cash_gbp": 100,
                    "external_flow_gbp": None,
                    "flow_status": "unverified",
                    "source_artifact_ids": [],
                },
            ],
        },
        kind="intraday_nav",
        producer_version="test",
    )
    store.immutable_snapshots.publish(
        scope="intraday",
        source="test",
        artifacts=[*previous.manifest.artifacts, anchor],
    )

    payload = build_dashboard_data(store)
    assert all(point["intraday"] is False for point in payload["nav"])
    intraday = payload["intradayNav"]
    assert len(intraday) == 2
    assert intraday[-1]["total"] == 2030
    assert intraday[-1]["totalTwr"] is None
    assert intraday[-1]["flowStatus"] == "unverified"


def test_dashboard_overlays_live_totals_and_only_reconciled_positions(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    previous = store.immutable_snapshots.latest()
    assert previous is not None
    live = store.immutable_artifacts.put_json(
        key="account/intraday/broker_values.json",
        payload={
            "schema_version": 1,
            "generated_at_utc": "2026-08-01T20:10:00Z",
            "accounts": {
                "A": {
                    "profile": "invest",
                    "fetched_at": "2026-08-01T20:10:00Z",
                    "total_value_gbp": 1300,
                    "cash_gbp": 200,
                    "investments_value_gbp": 1100,
                    "position_value_gbp": 1100,
                    "position_delta_gbp": 0,
                    "position_tolerance_gbp": 0.55,
                    "positions_status": "verified",
                    "checks": {"positions_match_investments": True},
                    "positions": [
                        {
                            "ticker": "BE",
                            "name": "Bloom Energy",
                            "quantity": 5,
                            "current_price": 286,
                            "price_currency": "USD",
                            "current_value_gbp": 1100,
                            "total_cost_gbp": 900,
                            "unrealized_profit_loss_gbp": 200,
                            "fx_impact_gbp": -6,
                        }
                    ],
                },
                "B": {
                    "profile": "isa",
                    "fetched_at": "2026-08-01T20:10:00Z",
                    "total_value_gbp": 850,
                    "cash_gbp": 100,
                    "investments_value_gbp": 750,
                    "position_value_gbp": 0,
                    "position_delta_gbp": -750,
                    "position_tolerance_gbp": 0.375,
                    # Even a malformed payload that claims verification must
                    # not let an incorrect empty live list erase the last
                    # verified canonical holding.
                    "positions_status": "verified",
                    "checks": {"positions_match_investments": True},
                    "positions": [],
                },
            },
        },
        kind="account_intraday_value",
        producer_version="test",
    )
    store.immutable_snapshots.publish(
        scope="intraday",
        source="test",
        artifacts=[*previous.manifest.artifacts, live],
    )

    payload = build_dashboard_data(store)

    assert payload["brokerAsOf"] == "2026-08-01T20:10:00Z"
    assert payload["totalValueGbp"] == 2150
    assert payload["totalInvestedGbp"] == 1850
    assert payload["totalCashGbp"] == 300
    by_account = {account["code"]: account for account in payload["accounts"]}
    assert by_account["A"]["totalValueGbp"] == 1300
    assert by_account["B"]["totalValueGbp"] == 850
    assert by_account["A"]["asOf"] == "2026-08-01T20:10:00Z"
    by_holding = {holding["ticker"]: holding for holding in payload["holdings"]}
    assert by_holding["BE"]["currentValueGbp"] == 1100
    assert by_holding["BE"]["pnlGbp"] == 200
    assert by_holding["XUSE"]["currentValueGbp"] == 700


def test_combined_twr_is_unchanged_by_an_internal_account_transfer() -> None:
    header = (
        "Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP,"
        "DailyReturn,TWRWealth,Drawdown\n"
    )
    invest = header + "2026-01-02,1000,1000,1000,,1,0\n" + "2026-01-05,500,-500,-250,0,1,0\n"
    isa = header + "2026-01-02,1000,1000,1000,,1,0\n" + "2026-01-05,1500,500,250,0,1,0\n"

    series = _nav_series(invest, isa)

    assert series[-1]["invest"] == 500
    assert series[-1]["isa"] == 1500
    assert series[-1]["total"] == 2000
    assert series[-1]["investTwr"] == 0
    assert series[-1]["isaTwr"] == 0
    assert series[-1]["totalTwr"] == 0
    assert series[-1]["totalDrawdown"] == 0
    assert series[-1]["totalNetContributionsGbp"] == 2000
    assert series[-1]["totalNetPnlGbp"] == 0
    assert series[-1]["totalPnlDrawdownGbp"] == 0


def test_cash_deposit_changes_nav_but_not_net_pnl_or_combined_twr() -> None:
    header = (
        "Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP,"
        "DailyReturn,TWRWealth,Drawdown\n"
    )
    invest = (
        header
        + "2026-01-02,1000,1000,1000,,1,0\n"
        + "2026-01-05,1100,0,0,0.1,1.1,0\n"
        + "2026-01-06,1600,500,500,0,1.1,0\n"
    )

    series = _nav_series(invest, header)

    assert series[-1]["invest"] == 1600
    assert series[-1]["investNetContributionsGbp"] == 1500
    assert series[-1]["investNetPnlGbp"] == 100
    assert series[-1]["investPnlDrawdownGbp"] == 0
    assert series[-1]["totalNetPnlGbp"] == 100
    assert series[-1]["totalTwr"] == pytest.approx(0.1)


def test_money_drawdown_is_measured_from_peak_net_pnl_in_gbp() -> None:
    header = (
        "Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP,"
        "DailyReturn,TWRWealth,Drawdown\n"
    )
    invest = (
        header
        + "2026-01-02,1000,1000,1000,,1,0\n"
        + "2026-01-05,1100,0,0,0.1,1.1,0\n"
        + "2026-01-06,1050,0,0,-0.0454545,1.05,-0.0454545\n"
    )

    series = _nav_series(invest, header)

    assert series[-1]["totalNetPnlGbp"] == 50
    assert series[-1]["totalPnlDrawdownGbp"] == -50


def test_new_account_funding_is_neutral_at_the_combined_portfolio_boundary() -> None:
    header = (
        "Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP,"
        "DailyReturn,TWRWealth,Drawdown\n"
    )
    invest = header + "2026-01-02,1000,1000,1000,,1,0\n" + "2026-01-05,1100,0,0,0.1,1.1,0\n"
    isa = header + "2026-01-05,1000,1000,0,,1,0\n"

    series = _nav_series(invest, isa)

    assert series[-1]["total"] == 2100
    assert series[-1]["totalNetContributionsGbp"] == 2000
    assert series[-1]["totalNetPnlGbp"] == 100
    assert series[-1]["totalTwr"] == pytest.approx(0.1)


def test_imported_cfd_is_exposed_in_all_account_nav_but_not_holdings(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    report = research_root / "accounts" / "outputs" / "three-account-report"
    yahoo = report / "yahoo_nav"
    synthetic_path = yahoo / "synthetic_nav_metrics.json"
    synthetic = json.loads(synthetic_path.read_text(encoding="utf-8"))
    synthetic["C"] = {
        "account": "C",
        "end": "2026-08-01",
        "ending_nav_gbp": 70.0,
        "net_external_flows_gbp": 100.0,
        "realized_profit_loss_gbp": -30.0,
        "reconciliation_gap_gbp": 70.0,
        "reconciliation_status": "warning",
        "closed_positions": 1,
        "overnight_charges_gbp": -5.0,
        "pnl_sharpe_proxy": -1.2,
        "max_drawdown_gbp": -30.0,
        "nav_quality": "realized_cash_equity_proxy",
        "true_nav_available": False,
        "source": "fixture.csv",
        "warning": "proxy",
    }
    synthetic_path.write_text(
        json.dumps(synthetic),
        encoding="utf-8",
    )
    (yahoo / "daily_nav_c.csv").write_text(
        "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
        "WeightedExternalFlowGBP,RealizedPnLGBP,DailyReturn,TWRWealth,"
        "Drawdown,CFDProxyDrawdownGBP\n"
        "2026-07-31,70,0,70,100,100,-30,,,,-30\n"
        "2026-08-01,70,0,70,0,0,0,,,,\n",
        encoding="utf-8",
    )
    store = ArtifactStore(tmp_path / "runtime")
    manifest = typed_fixture(research_root, store)
    payload = build_dashboard_data(store, manifest)

    assert payload["totalValueGbp"] == 2000
    assert payload["householdTotalValueGbp"] == 2070
    assert payload["cfd"]["endingValueGbp"] == 70
    assert payload["cfd"]["staleAfterDays"] == 14
    assert payload["cfd"]["isStale"] is False
    assert payload["accounts"][-1]["code"] == "C"
    assert payload["accounts"][-1]["name"] == "CFD"
    assert payload["accounts"][-1]["accountType"] == "cfd-imported"
    assert payload["accounts"][-1]["isInvestable"] is False
    assert all(row["account"] in {"A", "B"} for row in payload["holdings"])
    assert payload["nav"][-1]["cfd"] == 70
    assert payload["nav"][-1]["household"] == 2110


def test_cfd_and_household_money_lenses_keep_internal_transfers_out_of_household_flow() -> None:
    account_header = (
        "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
        "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
    )
    invest = (
        account_header
        + "2026-01-01,0,100,100,100,100,,,\n"
        + "2026-01-02,0,110,110,0,0,0.1,1.1,0\n"
    )
    isa = account_header + "2026-01-01,0,100,100,100,100,,,\n" + "2026-01-02,0,100,100,0,0,0,1,0\n"
    cfd = (
        "Date,SyntheticNAVGBP,RealisedCashEquityProxyGBP,"
        "CumulativeAccountCashFlowGBP,CumulativeHouseholdExternalFlowGBP,"
        "CumulativeRealisedPnLGBP,RealisedPnLDrawdownGBP,"
        "CumulativeClosedAfterFXGBP,CumulativeOvernightInterestGBP,"
        "CumulativeDividendAdjustmentGBP\n"
        "2026-01-01,50,50,70,50,-20,-20,-10,-12,2\n"
        "2026-01-02,55,55,70,50,-15,-15,-5,-12,2\n"
    )

    series = _nav_series(invest, isa, cfd)
    latest = series[-1]

    assert latest["cfd"] == 55
    assert latest["cfdNetContributionsGbp"] == 70
    assert latest["cfdNetPnlGbp"] == -15
    assert latest["cfdPnlDrawdownGbp"] == -15
    assert latest["cfdOvernightInterestGbp"] == -12
    assert latest["household"] == 265
    # The CFD account contains a £20 internal transfer, but only its true £50
    # external deposit contributes to the household capital base.
    assert latest["householdNetContributionsGbp"] == 250
    assert latest["householdNetPnlGbp"] == 15


def test_household_money_lens_cancels_a_verified_invest_to_cfd_transfer() -> None:
    header = (
        "Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP,"
        "DailyReturn,TWRWealth,Drawdown\n"
    )
    invest = header + "2026-01-01,100,100,100,,1,0\n" + "2026-01-02,80,-20,-20,0,1,0\n"
    isa = header + "2026-01-01,100,100,100,,1,0\n" + "2026-01-02,100,0,0,0,1,0\n"
    cfd = (
        "Date,RealisedCashEquityProxyGBP,CumulativeAccountCashFlowGBP,"
        "CumulativeHouseholdExternalFlowGBP,"
        "CumulativeInternalTransferCounterflowGBP,"
        "CumulativeMatchedInternalTransferCounterflowGBP,"
        "CumulativeUnmatchedInternalTransferGBP,HouseholdTransferMatchStatus,"
        "CumulativeRealisedPnLGBP,RealisedPnLDrawdownGBP\n"
        "2026-01-01,50,50,50,0,0,0,verified,0,0\n"
        "2026-01-02,70,70,50,20,20,0,verified,0,0\n"
    )

    latest = _nav_series(invest, isa, cfd)[-1]

    assert latest["household"] == 250
    assert latest["householdInternalTransferCounterflowGbp"] == 20
    assert latest["householdUnmatchedInternalTransferGbp"] == 0
    assert latest["householdTransferMatchStatus"] == "verified"
    assert latest["householdNetContributionsGbp"] == 250
    assert latest["householdNetPnlGbp"] == 0


def test_household_money_lens_uses_labelled_counterflow_when_verification_is_partial() -> None:
    header = (
        "Date,SyntheticNAVGBP,ExternalFlowGBP,WeightedExternalFlowGBP,"
        "DailyReturn,TWRWealth,Drawdown\n"
    )
    invest = header + "2026-01-01,100,100,100,,1,0\n" + "2026-01-02,50,-50,-50,0,1,0\n"
    isa = header + "2026-01-01,100,100,100,,1,0\n" + "2026-01-02,100,0,0,0,1,0\n"
    cfd = (
        "Date,RealisedCashEquityProxyGBP,CumulativeAccountCashFlowGBP,"
        "CumulativeHouseholdExternalFlowGBP,"
        "CumulativeInternalTransferCounterflowGBP,"
        "CumulativeMatchedInternalTransferCounterflowGBP,"
        "CumulativeUnmatchedInternalTransferGBP,HouseholdTransferMatchStatus,"
        "CumulativeRealisedPnLGBP,RealisedPnLDrawdownGBP\n"
        "2026-01-01,100,100,100,0,0,0,verified,0,0\n"
        "2026-01-02,160,160,100,60,0,60,partial,0,0\n"
    )

    latest = _nav_series(invest, isa, cfd)[-1]

    assert latest["household"] == 310
    assert latest["householdInternalTransferCounterflowGbp"] == 60
    assert latest["householdUnmatchedInternalTransferGbp"] == 60
    assert latest["householdTransferMatchStatus"] == "partial"
    assert latest["householdNetContributionsGbp"] == 310
    assert latest["householdNetPnlGbp"] == 0


def test_technical_contract_preserves_adr_coverage_and_parity() -> None:
    rows = _technical_rows(
        {
            "as_of": "2026-08-04",
            "rows": [
                {
                    "ticker": "SKHY",
                    "currency": "USD",
                    "price": 154.38,
                    "history_coverage": {
                        "requested_period": "3y",
                        "available_sessions": 18,
                        "first_session": "2026-07-10",
                        "last_session": "2026-08-04",
                        "complete": False,
                        "warning": "No synthetic backfill was used.",
                    },
                    "adr_research": {
                        "security_type": "ADR",
                        "adr_ticker": "SKHY",
                        "primary_ticker": "000660.KS",
                        "depositary": "Citibank",
                        "ordinary_shares_per_adr": 0.1,
                        "adr_per_ordinary_share": 10,
                        "adr_spot_usd": 154.38,
                        "primary_spot": 1_567_000,
                        "primary_currency": "KRW",
                        "fx_local_per_usd": 1429.6,
                        "parity_usd": 109.61,
                        "premium_to_parity": 0.4084,
                        "available_sessions": 18,
                        "first_trade_session": "2026-07-10",
                        "average_volume_20d": 1_000_000,
                        "average_dollar_volume_20d": 154_000_000,
                        "arbitrage_assumption": "none",
                        "warning": "Do not assume convergence.",
                        "ratio_source": "https://example.com",
                    },
                }
            ],
        }
    )

    assert rows[0]["currency"] == "USD"
    assert rows[0]["historyCoverage"]["availableSessions"] == 18
    assert rows[0]["historyCoverage"]["complete"] is False
    assert rows[0]["adrResearch"]["primaryTicker"] == "000660.KS"
    assert rows[0]["adrResearch"]["premiumToParity"] == pytest.approx(0.4084)


def test_typed_research_adapters_preserve_options_and_valuation_fields() -> None:
    options = _option_rows(
        {
            "rows": [
                {
                    "ticker": "BE",
                    "spot": 25.0,
                    "captured_at": "2026-08-07T20:00:00+00:00",
                    "expiry_count": 2,
                    "aggregate": {
                        "put_call_oi_ratio": 0.8,
                        "call_oi_wall": {"strike": 30},
                        "put_oi_wall": {"strike": 20},
                        "max_pain_proxy": 25,
                        "net_gex_1pct_proxy": 1000,
                    },
                    "gamma_proxy": {"gamma_regime": "positive"},
                    "expiries": [
                        {
                            "expiry": "2026-09-18",
                            "days_to_expiry": 42,
                            "call_open_interest": 1200,
                            "put_open_interest": 960,
                            "put_call_oi_ratio": 0.8,
                            "call_oi_wall": {"strike": 30},
                            "put_oi_wall": {"strike": 20},
                            "max_pain_proxy": 25,
                        }
                    ],
                    "contracts": [
                        {
                            "expiry": "2026-09-18",
                            "side": "call",
                            "contract_symbol": "BE260918C00025000",
                            "strike": 25,
                            "last_price": 2.1,
                            "bid": 2.0,
                            "ask": 2.2,
                            "open_interest": 500,
                            "volume": 80,
                            "iv": 0.55,
                            "in_the_money": False,
                        }
                    ],
                }
            ]
        }
    )
    valuations = _valuation_rows(
        {
            "as_of": "2026-08-07",
            "rows": [
                {
                    "ticker": "BE",
                    "price": 25.0,
                    "currency": "USD",
                    "lenses": {"forwardPE": 18.5, "priceToBook": 2.2},
                    "verdict": "lower-multiple",
                }
            ],
        }
    )

    assert options[0]["capturedAt"].startswith("2026-08-07")
    assert options[0]["callWall"] == 30
    assert options[0]["gammaRegime"] == "positive"
    assert options[0]["expiries"][0]["daysToExpiry"] == 42
    assert options[0]["contracts"][0]["bid"] == 2.0
    assert valuations[0]["ticker"] == "BE"
    assert valuations[0]["spot"] == 25.0
    assert valuations[0]["forwardPe"] == 18.5
    assert valuations[0]["priceToBook"] == 2.2
