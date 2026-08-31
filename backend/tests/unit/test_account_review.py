from __future__ import annotations

import json

import pandas as pd
import pytest
from trading_max.analytics.account_review import build_account_review


def _transactions() -> pd.DataFrame:
    rows = [
        {
            "Action": "Market buy",
            "Time": pd.Timestamp("2026-08-01T10:00:00Z"),
            "Ticker": "AAA",
            "Shares": 1.0,
            "TotalN": 100.0,
            "FeeN": 1.0,
            "ResultN": 0.0,
        },
        {
            "Action": "Market sell",
            "Time": pd.Timestamp("2026-08-02T10:00:00Z"),
            "Ticker": "AAA",
            "Shares": 1.0,
            "TotalN": 150.0,
            "FeeN": 1.0,
            "ResultN": 50.0,
        },
        {
            "Action": "Market buy",
            "Time": pd.Timestamp("2026-08-02T11:00:00Z"),
            "Ticker": "BBB",
            "Shares": 2.0,
            "TotalN": 100.0,
            "FeeN": 0.5,
            "ResultN": 0.0,
        },
        {
            "Action": "Market sell",
            "Time": pd.Timestamp("2026-08-03T11:00:00Z"),
            "Ticker": "BBB",
            "Shares": 2.0,
            "TotalN": 70.0,
            "FeeN": 0.5,
            "ResultN": -30.0,
        },
    ]
    return pd.DataFrame(rows)


def _nav() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "Date": "2026-08-01",
                "SyntheticNAVGBP": 1000.0,
                "ExternalFlowGBP": 1000.0,
                "CashGBP": 100.0,
            },
            {"Date": "2026-08-02", "SyntheticNAVGBP": 1100.0, "ExternalFlowGBP": 0.0},
            {"Date": "2026-08-03", "SyntheticNAVGBP": 1020.0, "ExternalFlowGBP": 0.0},
            {"Date": "2026-08-04", "SyntheticNAVGBP": 1070.0, "ExternalFlowGBP": 0.0},
            {
                "Date": "2026-08-05",
                "SyntheticNAVGBP": 1570.0,
                "ExternalFlowGBP": 500.0,
            },
            {
                "Date": "2026-08-06",
                "SyntheticNAVGBP": 1650.0,
                "ExternalFlowGBP": 0.0,
                "CashGBP": 150.0,
            },
        ]
    )


def _holdings() -> list[dict[str, object]]:
    return [
        {
            "ticker": "AAA",
            "name": "Alpha",
            "quantity": 3,
            "current_value_gbp": 900.0,
            "total_cost_gbp": 700.0,
            "unrealized_profit_loss_gbp": 200.0,
            "industry": "Software",
            "country": "US",
            "price_currency": "USD",
        },
        {
            "ticker": "BBB",
            "name": "Beta",
            "quantity": 5,
            "current_value_gbp": 300.0,
            "total_cost_gbp": 330.0,
            "unrealized_profit_loss_gbp": -30.0,
            "industry": "Banks",
            "country": "GB",
            "price_currency": "GBP",
        },
    ]


def _campaign(
    ticker: str,
    start: str,
    end: str,
    result: float,
    *,
    fees: float = 1.0,
    direction: str = "long",
    industry: str | None = None,
    country: str | None = None,
) -> dict[str, object]:
    start_at = pd.Timestamp(start)
    end_at = pd.Timestamp(end)
    result_row: dict[str, object] = {
        "Ticker": ticker,
        "Name": ticker,
        "Start": start_at,
        "End": end_at,
        "DurationDays": (end_at - start_at).total_seconds() / 86_400,
        "BuyOrders": 1,
        "SellOrders": 1,
        "BuyNotional": 100.0,
        "SellNotional": 100.0 + result,
        "GrossResult": result + fees,
        "Fees": fees,
        "NetResult": result,
        "Direction": direction,
    }
    if industry is not None:
        result_row["Industry"] = industry
    if country is not None:
        result_row["Country"] = country
    return result_row


def test_account_review_separates_money_flows_and_segments_reproducible_phases() -> None:
    strategy = {
        "twr_total_return": 0.15,
        "sharpe_sonia": 1.2,
        "sortino_sonia": 1.8,
        "calmar_ratio": 0.9,
    }

    first = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=_transactions(),
        nav_money_series=_nav(),
        ending_holdings=_holdings(),
        strategy_risk=strategy,
        provenance={"transaction_artifact_id": "tx-a", "nav_artifact_id": "nav-a"},
    )
    second = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=_transactions(),
        nav_money_series=_nav(),
        ending_holdings=_holdings(),
        strategy_risk=strategy,
        provenance={"transaction_artifact_id": "tx-a", "nav_artifact_id": "nav-a"},
    )

    assert first == second
    assert first["money_outcome"]["opening_value_gbp"] == 0.0
    assert first["money_outcome"]["deposits_gbp"] == 1500.0
    assert first["money_outcome"]["net_external_flows_gbp"] == 1500.0
    assert first["money_outcome"]["net_pnl_gbp"] == 150.0
    assert first["money_outcome"]["max_pnl_drawdown_gbp"] == -80.0
    assert first["strategy_risk"]["metrics"] == strategy
    classifications = [phase["classification"] for phase in first["phases"]["items"]]
    assert classifications == [
        "large_cash_flow",
        "profit_phase",
        "drawdown_formation",
        "drawdown_recovery",
        "large_cash_flow",
        "drawdown_recovery",
    ]
    assert all(phase["evidence_events"] for phase in first["phases"]["items"])
    json.dumps(first, allow_nan=False)


def test_account_review_uses_authoritative_money_lens_without_recomputing_it() -> None:
    supplied = {
        "opening_value_gbp": 10.0,
        "ending_value_gbp": 777.0,
        "net_external_flows_gbp": 20.0,
        "net_pnl_gbp": 747.0,
    }

    result = build_account_review(
        account_code="B",
        account_kind="isa",
        transactions=_transactions(),
        nav_money_series=_nav(),
        ending_holdings=_holdings(),
        money_outcome=supplied,
    )

    assert result["money_outcome"] == {
        "status": "available",
        "unavailable_reason": None,
        "source": "authoritative_money_lens",
        **supplied,
    }
    assert result["strategy_risk"]["status"] == "unavailable"
    assert "pre-calculated" in result["strategy_risk"]["unavailable_reason"]


def test_money_outcome_keeps_withdrawals_separate_from_investment_profit() -> None:
    result = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=None,
        nav_money_series=[
            {"Date": "2026-01-01", "SyntheticNAVGBP": 1000, "ExternalFlowGBP": 1000},
            {"Date": "2026-01-02", "SyntheticNAVGBP": 900, "ExternalFlowGBP": -200},
        ],
        ending_holdings=None,
    )

    money = result["money_outcome"]
    assert money["deposits_gbp"] == 1000.0
    assert money["withdrawals_gbp"] == 200.0
    assert money["signed_withdrawal_flows_gbp"] == -200.0
    assert money["net_external_flows_gbp"] == 800.0
    assert money["net_pnl_gbp"] == 100.0


def test_trade_quality_attribution_and_counterfactuals_conserve_realised_results() -> None:
    campaigns = [
        _campaign(
            "WIN1",
            "2025-12-01T10:00:00Z",
            "2026-01-01T10:00:00Z",
            100.0,
            industry="Software",
            country="US",
        ),
        _campaign(
            "WIN2",
            "2026-01-01T10:00:00Z",
            "2026-01-02T10:00:00Z",
            40.0,
            industry="Software",
            country="US",
        ),
        _campaign(
            "LOSS1",
            "2026-01-02T10:00:00Z",
            "2026-01-02T15:00:00Z",
            -20.0,
            industry="Banks",
            country="GB",
        ),
        _campaign(
            "LOSS2",
            "2025-09-01T10:00:00Z",
            "2026-01-03T10:00:00Z",
            -30.0,
            direction="short",
            industry="Banks",
        ),
    ]

    result = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=_transactions(),
        campaigns=campaigns,
        nav_money_series=_nav(),
        ending_holdings=_holdings(),
    )
    quality = result["realised_trade_quality"]
    attribution = result["attribution"]

    assert quality["trade_count"] == 4
    assert quality["win_rate"] == 0.5
    assert quality["profit_factor"] == pytest.approx(2.8)
    assert quality["expectancy_gbp"] == pytest.approx(22.5)
    assert quality["same_day_count"] == 1
    assert quality["long_holding_count"] == 1
    assert quality["longest_winning_streak"] == 2
    assert quality["longest_losing_streak"] == 2
    assert quality["best_trade"]["ticker"] == "WIN1"
    assert quality["worst_trade"]["ticker"] == "LOSS2"
    assert quality["top_n_counterfactuals"][0] == {
        "remove_top_n": 1,
        "removed_trade_count": 1,
        "removed_result_gbp": 100.0,
        "remaining_net_result_gbp": -10.0,
        "remaining_profitable": False,
    }
    assert attribution["realised_net_result_gbp"] == 90.0
    assert all(value == pytest.approx(0.0) for value in attribution["conservation"].values())
    assert attribution["components"]["conservation_difference_gbp"] == pytest.approx(0.0)
    assert {row["label"] for row in attribution["by_direction"]["buckets"]} == {
        "long",
        "short",
    }
    assert attribution["by_calendar"]["month"][0]["label"] == "2026-01"
    assert attribution["by_industry"]["status"] == "available"
    assert {row["label"] for row in attribution["by_industry"]["buckets"]} == {
        "Banks",
        "Software",
    }
    assert attribution["by_country"]["status"] == "partial"
    assert attribution["by_country"]["missing_trade_count"] == 1


def test_structural_and_ending_risk_use_only_observable_evidence() -> None:
    result = build_account_review(
        account_code="B",
        account_kind="isa",
        transactions=_transactions(),
        nav_money_series=_nav(),
        ending_holdings=_holdings(),
    )
    structural = result["structural_diagnostics"]
    ending = result["ending_risk"]

    assert structural["observable_only"] is True
    assert structural["psychology_inferred"] is False
    assert structural["gross_traded_notional_gbp"] == 420.0
    assert structural["buy_orders"] == 2
    assert structural["sell_orders"] == 2
    assert ending["invested_value_gbp"] == 1200.0
    assert ending["cash_gbp"] == 150.0
    assert ending["unrealized_pnl_gbp"] == 170.0
    assert ending["concentration"]["hhi"] == pytest.approx(0.625)
    assert ending["concentration"]["effective_positions"] == pytest.approx(1.6)
    assert ending["concentration"]["largest_weight"] == pytest.approx(0.75)
    assert ending["exposures"]["direction"]["buckets"] == [
        {"label": "long", "value_gbp": 1200.0, "weight": 1.0}
    ]


def test_missing_inputs_produce_explicit_unavailable_reasons() -> None:
    result = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=None,
        nav_money_series=None,
        ending_holdings=None,
    )

    assert result["coverage"]["status"] == "partial"
    assert result["coverage"]["inputs"]["transactions"]["unavailable_reason"]
    for section in (
        "money_outcome",
        "strategy_risk",
        "phases",
        "realised_trade_quality",
        "attribution",
        "structural_diagnostics",
        "ending_risk",
    ):
        assert result[section]["status"] == "unavailable"
        assert result[section]["unavailable_reason"]
    assert result["attribution"]["by_instrument"]["unavailable_reason"]
    json.dumps(result, allow_nan=False)
