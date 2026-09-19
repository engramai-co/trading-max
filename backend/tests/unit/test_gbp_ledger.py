from decimal import Decimal

import pandas as pd
import pytest
from trading_max.analytics.account_review import build_account_review
from trading_max.analytics.diluted_cost import calculate_diluted_cost
from trading_max.analytics.fx import FxQuote
from trading_max.analytics.ledger import (
    capital_recovery_rows,
    diluted_cost_rows,
    load_transactions,
    normalize_transactions_gbp,
    policy_metrics,
    reconstruct_campaigns,
)


def ledger_row(
    action="Market buy",
    *,
    day=5,
    ticker="AAA",
    shares=2,
    total=100,
    currency="USD",
    fee=0,
    fee_currency="GBP",
    result=0,
):
    return {
        "Action": action,
        "Time (UTC)": f"2026-01-{day:02d}T12:00:00Z",
        "ID": f"{ticker}-{action}-{day}",
        "Ticker": ticker,
        "Name": ticker,
        "No. of shares": shares,
        "Total": total,
        "Currency (Total)": currency,
        "Currency conversion fee": fee,
        "Currency (Currency conversion fee)": fee_currency,
        "Result": result,
        "Currency (Result)": currency,
        "Price / share": 50,
        "Currency (Price / share)": "USD",
        "Exchange rate": 1,
    }


def export(tmp_path, rows):
    path = tmp_path / "ledger.csv"
    pd.DataFrame(rows).to_csv(path, index=False)
    return load_transactions([path])


def fixture_fx(currency, event):
    rate = {("USD", 5): "1.25", ("USD", 6): "1.2", ("USD", 7): "1.5", ("EUR", 6): "1.2"}.get(
        (currency, event.day)
    )
    return FxQuote(currency, Decimal(rate), event, "synthetic-dated-quote") if rate else None


def test_each_cash_leg_and_mixed_currency_fee_is_converted_before_recovery(tmp_path):
    native = export(
        tmp_path,
        [
            ledger_row(fee=100, fee_currency="GBp"),
            ledger_row(
                "Market sell", day=6, shares=1, total=60, fee=1.2, fee_currency="EUR", result=10
            ),
            ledger_row("Dividend (Dividend)", day=6, shares=None, total=2.4, currency="EUR"),
        ],
    )
    converted = normalize_transactions_gbp(native, fx_resolver=fixture_fx)
    assert native["TotalN"].tolist() == [100, 60, 2.4]
    assert converted["TotalN"].tolist() == native["TotalN"].tolist()
    assert converted["TotalGBP"].tolist() == [80, 50, 2]
    assert converted["FeeGBP"].tolist() == [1, 1, 0]
    assert converted["ResultGBP"].tolist() == pytest.approx([0, 10 / 1.2, 0])
    position = {"ticker": "AAA", "quantity": 1, "current_value_gbp": 48}
    diluted = diluted_cost_rows("A", converted, [position])[0]
    recovery, checks = capital_recovery_rows("A", converted, [position])
    assert diluted["diluted_cost_gbp"] == 28
    assert diluted["recovered_cash_gbp"] == 52
    assert recovery[0]["EconomicPnLGBP"] == 20
    assert recovery[0]["status"] == "available"
    assert all(row["status"] == "OK" for row in checks)
    fees = [row for row in converted.attrs["fx_evidence"] if row["field"] == "FeeN"]
    assert {row["currency"] for row in fees} == {"GBX", "EUR"}


def test_closed_campaign_includes_fx_change_between_buy_and_sell(tmp_path):
    native = export(
        tmp_path,
        [
            ledger_row(fee=100, fee_currency="GBX"),
            ledger_row(
                "Market sell", day=6, shares=1, total=60, fee=1.2, fee_currency="EUR", result=10
            ),
            ledger_row("Market sell", day=7, shares=1, total=60, result=10),
        ],
    )
    converted = normalize_transactions_gbp(native, fx_resolver=fixture_fx)
    closed, opened = reconstruct_campaigns(converted)
    assert not opened
    assert closed[0]["GrossResult"] == 12  # GBP10 net cash outcome plus GBP2 disclosed fees.
    assert closed[0]["Fees"] == 2
    assert closed[0]["NetResult"] == 10  # GBP90 net sales minus GBP80 fee-inclusive acquisition.
    assert sum(converted["ResultGBP"]) == pytest.approx(
        15
    )  # Broker native P&L is different evidence.
    policy = policy_metrics({"A": converted, "B": converted})
    assert policy["a_campaign"]["expectancy"] == 10
    assert policy["b_policy"][0]["realized_net"] == 10
    review = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=converted,
        nav_money_series=None,
        ending_holdings=[],
    )
    assert review["realised_trade_quality"]["expectancy_gbp"] == 10
    assert review["attribution"]["realised_net_result_gbp"] == 10
    assert review["structural_diagnostics"]["gross_traded_notional_gbp"] == 170


@pytest.mark.parametrize(
    "quoted,settled,rate,currency,amount,expected",
    [
        ("GBP", "USD", "0.8", "USD", 100, 80),
        ("GBp", "USD", "80", "USD", 100, 80),
        ("USD", "GBP", "1.25", "USD", 1.25, 1),
    ],
)
def test_broker_conversion_is_used_only_when_gbp_is_one_side(
    tmp_path, quoted, settled, rate, currency, amount, expected
):
    row = ledger_row(currency=settled, fee=amount, fee_currency=currency)
    row.update({"Currency (Price / share)": quoted, "Exchange rate": rate})

    def forbidden(*_args):
        raise AssertionError("broker FX proof should precede provider lookup")

    converted = normalize_transactions_gbp(export(tmp_path, [row]), fx_resolver=forbidden)
    assert converted.iloc[0]["FeeGBP"] == expected
    assert any(item["source"] == "broker-exchange-rate" for item in converted.attrs["fx_evidence"])


def test_missing_fx_only_suppresses_affected_campaign_and_review_lenses(tmp_path):
    native = export(
        tmp_path,
        [
            ledger_row(),
            ledger_row(ticker="BBB", shares=1, total=20, currency="GBP"),
            ledger_row("Market sell", day=6, shares=1, total=60, result=10),
        ],
    )
    converted = normalize_transactions_gbp(native, fx_resolver=lambda *_args: None)
    positions = [
        {"ticker": "AAA", "quantity": 1, "current_value_gbp": 48},
        {"ticker": "BBB", "quantity": 1, "current_value_gbp": 22},
    ]
    diluted = {row["ticker"]: row for row in diluted_cost_rows("A", converted, positions)}
    assert diluted["AAA"]["status"] == "unavailable"
    assert diluted["AAA"]["diluted_cost_gbp"] is None
    assert diluted["BBB"]["status"] == "available"
    assert diluted["BBB"]["diluted_cost_gbp"] == 20
    recovery, checks = capital_recovery_rows("A", converted, positions)
    bad = next(row for row in recovery if row["Ticker"] == "AAA")
    assert bad["EconomicPnLGBP"] is None
    assert bad["MarketValueGBP"] == 48
    assert all(row["status"] == "OK" for row in checks)
    policy = policy_metrics({"A": converted})["a_campaign"]
    assert policy["status"] == "unavailable"
    assert policy["turnover"] is None

    closed_native = export(
        tmp_path, [ledger_row(), ledger_row("Market sell", day=6, shares=2, total=120, result=20)]
    )
    review = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=closed_native,
        nav_money_series=[
            {"Date": "2026-01-05", "SyntheticNAVGBP": 100, "ExternalFlowGBP": 100},
            {"Date": "2026-01-06", "SyntheticNAVGBP": 110, "ExternalFlowGBP": 0},
        ],
        ending_holdings=[],
    )
    assert review["realised_trade_quality"]["status"] == "unavailable"
    assert review["attribution"]["status"] == "unavailable"
    assert review["structural_diagnostics"]["status"] == "unavailable"
    assert review["structural_diagnostics"].get("gross_traded_notional_gbp") is None
    assert review["money_outcome"]["net_pnl_gbp"] == 10


def test_missing_currency_does_not_inherit_gbp_or_quote_currency(tmp_path):
    row = ledger_row(currency="")
    converted = normalize_transactions_gbp(export(tmp_path, [row]), fx_resolver=fixture_fx)
    assert converted.iloc[0]["TotalGBP"] is None
    assert "missing currency" in converted.iloc[0]["GbpIssues"][0]


def test_conflicting_transaction_currency_is_not_deduplicated(tmp_path):
    first = ledger_row(currency="USD")
    second = {**first, "Currency (Total)": "GBP"}
    with pytest.raises(ValueError, match="conflicting rows"):
        export(tmp_path, [first, second])


def test_original_foreign_wallet_regression_has_correct_gbp_cash_basis(tmp_path):
    native = export(
        tmp_path, [ledger_row(), ledger_row("Market sell", day=6, shares=1, total=60, result=10)]
    )
    converted = normalize_transactions_gbp(
        native,
        fx_resolver=lambda currency, event: FxQuote(
            currency, Decimal("1.25"), event, "synthetic-dated-quote"
        ),
    )
    position = {"ticker": "AAA", "quantity": 1, "current_value_gbp": 48}
    assert diluted_cost_rows("A", converted, [position])[0]["diluted_cost_gbp"] == 32
    assert capital_recovery_rows("A", converted, [position])[0][0]["EconomicPnLGBP"] == 16


def test_unpriced_open_position_does_not_erase_verified_closed_campaign(tmp_path):
    transactions = export(
        tmp_path,
        [
            ledger_row(),
            ledger_row(ticker="BBB", shares=1, total=20, currency="GBP"),
            ledger_row(
                "Market sell", ticker="BBB", day=6, shares=1, total=25, currency="GBP", result=5
            ),
        ],
    )
    review = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=transactions,
        nav_money_series=None,
        ending_holdings=[],
    )
    assert review["realised_trade_quality"]["status"] == "available"
    assert review["realised_trade_quality"]["expectancy_gbp"] == 5
    assert review["attribution"]["realised_net_result_gbp"] == 5
    assert review["structural_diagnostics"]["gross_traded_notional_gbp"] is None


@pytest.mark.parametrize("total", ["not-a-number", ""])
def test_unknown_required_total_never_becomes_zero_cost(tmp_path, total):
    native = export(tmp_path, [ledger_row(total=total)])
    converted = normalize_transactions_gbp(native)
    assert converted.iloc[0]["TotalGBP"] is None
    assert "TotalGBP: invalid native amount" in converted.iloc[0]["GbpIssues"]
    position = {"ticker": "AAA", "quantity": 2, "current_value_gbp": 80}
    assert diluted_cost_rows("A", converted, [position])[0]["diluted_cost_gbp"] is None


def test_malformed_fee_is_unknown_but_blank_optional_fee_means_no_fee(tmp_path):
    native = export(
        tmp_path,
        [
            ledger_row(currency="GBP", fee="invalid"),
            ledger_row(ticker="BBB", currency="GBP", fee=""),
        ],
    )
    converted = normalize_transactions_gbp(native)
    assert converted["FeeGBP"].tolist() == [None, 0]
    assert "FeeGBP: invalid native amount" in converted.iloc[0]["GbpIssues"]


@pytest.mark.parametrize("fee_currency", ["GBp", "JPY"])
def test_dividend_total_is_net_and_does_not_require_fee_conversion(tmp_path, fee_currency):
    native = export(
        tmp_path,
        [
            ledger_row(currency="GBP"),
            ledger_row(
                "Dividend (Dividend)",
                day=6,
                shares=None,
                total=2,
                currency="GBP",
                fee=100,
                fee_currency=fee_currency,
            ),
        ],
    )
    converted = normalize_transactions_gbp(native)
    position = {"ticker": "AAA", "quantity": 2, "current_value_gbp": 100}
    recovery = capital_recovery_rows("A", converted, [position])[0][0]
    assert recovery["RecoveredCashGBP"] == 2
    assert recovery["EconomicPnLGBP"] == 2
    assert recovery["status"] == "available"


@pytest.mark.parametrize(
    "currency,buy_total,sell_total", [("GBP", 101, 109), ("USD", 126.25, 130.8)]
)
def test_fee_inclusive_totals_determine_closed_net_once(tmp_path, currency, buy_total, sell_total):
    transactions = normalize_transactions_gbp(
        export(
            tmp_path,
            [
                ledger_row(total=buy_total, currency=currency, fee=100, fee_currency="GBp"),
                ledger_row(
                    "Market sell",
                    day=6,
                    shares=2,
                    total=sell_total,
                    currency=currency,
                    fee=1.2,
                    fee_currency="EUR",
                ),
            ],
        ),
        fx_resolver=fixture_fx,
    )
    closed, opened = reconstruct_campaigns(transactions)
    assert not opened
    assert closed[0]["BuyNotional"] == 100
    assert closed[0]["SellNotional"] == 110
    assert closed[0]["GrossResult"] == 10
    assert closed[0]["Fees"] == 2
    assert closed[0]["NetResult"] == 8
    assert closed[0]["GrossResult"] - closed[0]["Fees"] == closed[0]["NetResult"]
    assert policy_metrics({"B": transactions})["b_policy"][0]["realized_net"] == 8
    review = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=transactions,
        nav_money_series=None,
        ending_holdings=[],
    )
    assert review["realised_trade_quality"]["expectancy_gbp"] == 8
    assert review["attribution"]["components"]["conservation_difference_gbp"] == 0


@pytest.mark.parametrize("fee_currency", ["GBP", "JPY"])
def test_open_partial_recovery_uses_fee_inclusive_cash_even_without_fee_fx(tmp_path, fee_currency):
    transactions = normalize_transactions_gbp(
        export(
            tmp_path,
            [
                ledger_row(total=101, currency="GBP", fee=1, fee_currency=fee_currency),
                ledger_row(
                    "Market sell",
                    day=6,
                    shares=1,
                    total=59,
                    currency="GBP",
                    fee=1,
                    fee_currency=fee_currency,
                ),
            ],
        )
    )
    position = {"ticker": "AAA", "quantity": 1, "current_value_gbp": 60}
    diluted = diluted_cost_rows("A", transactions, [position])[0]
    recovery = capital_recovery_rows("A", transactions, [position])[0][0]
    assert diluted["status"] == "available"
    assert diluted["net_buy_cash_out_gbp"] == 101
    assert diluted["recovered_cash_gbp"] == 59
    assert diluted["diluted_cost_gbp"] == 42
    assert recovery["NetSellCashInGBP"] == 59
    assert recovery["EconomicPnLGBP"] == 18
    _, opened = reconstruct_campaigns(transactions)
    typed = calculate_diluted_cost(opened["AAA"][0], 1)
    assert typed.net_buy_cash_out_gbp == Decimal(101)
    assert typed.recovered_cash_gbp == Decimal(59)
    assert typed.diluted_cost_gbp == Decimal(42)


def test_missing_fee_fx_only_hides_breakdown_not_closed_net_or_attribution(tmp_path):
    transactions = normalize_transactions_gbp(
        export(
            tmp_path,
            [
                ledger_row(total=101, currency="GBP", fee=1, fee_currency="JPY"),
                ledger_row(
                    "Market sell",
                    day=6,
                    shares=2,
                    total=109,
                    currency="GBP",
                    fee=1,
                    fee_currency="JPY",
                ),
            ],
        )
    )
    closed, _ = reconstruct_campaigns(transactions)
    assert closed[0]["status"] == "available"
    assert closed[0]["NetResult"] == 8
    assert closed[0]["GrossResult"] is None
    assert closed[0]["Fees"] is None
    assert closed[0]["fee_unavailable_reason"] == "fee_breakdown_unavailable"
    summary = policy_metrics({"A": transactions})["a_campaign"]
    assert summary["status"] == "available"
    assert summary["expectancy"] == 8
    assert summary["fee_status"] == "unavailable"
    review = build_account_review(
        account_code="A",
        account_kind="invest",
        transactions=transactions,
        nav_money_series=None,
        ending_holdings=[],
    )
    quality = review["realised_trade_quality"]
    assert quality["status"] == "available"
    assert quality["expectancy_gbp"] == 8
    for key in ("buy_notional_gbp", "sell_notional_gbp", "gross_result_gbp", "fees_gbp"):
        assert quality["best_trade"][key] is None
    attribution = review["attribution"]
    assert attribution["status"] == "available"
    assert attribution["realised_net_result_gbp"] == 8
    assert attribution["by_instrument"]["buckets"][0]["fees_gbp"] is None
    assert attribution["components"]["status"] == "unavailable"
    assert attribution["components"]["unavailable_reason"] == "fee_breakdown_unavailable"
    assert attribution["components"]["buckets"][-1]["contribution_gbp"] == 8
    assert attribution["components"]["conservation_difference_gbp"] is None
