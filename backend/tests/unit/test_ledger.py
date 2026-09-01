from __future__ import annotations

from pathlib import Path

import pytest
from trading_max.analytics.ledger import (
    capital_recovery_rows,
    diluted_cost_rows,
    is_buy,
    is_dividend,
    is_sell,
    is_stock_split_close,
    is_stock_split_open,
    load_transactions,
    policy_metrics,
    reconstruct_campaigns,
    transaction_marker_rows,
)


def _write_export(path: Path, rows: list[str]) -> None:
    path.write_text(
        "ID,Action,Time (UTC),Ticker,Name,No. of shares,Price / share,Total,"
        "Currency conversion fee,Result\n" + "\n".join(rows) + "\n",
        encoding="utf-8",
    )


def _write_export_with_isin(path: Path, rows: list[str]) -> None:
    path.write_text(
        "ID,Action,Time (UTC),ISIN,Ticker,Name,No. of shares,Price / share,Total,"
        "Currency conversion fee,Result\n" + "\n".join(rows) + "\n",
        encoding="utf-8",
    )


def test_ledger_predicates_preserve_broker_action_semantics() -> None:
    assert is_buy("Market buy")
    assert is_sell("Market sell")
    assert is_dividend("Dividend (Dividend)")
    assert is_stock_split_close("Stock split close")
    assert is_stock_split_open("Stock split open")
    assert not is_buy("Interest on cash")


def test_load_transactions_deduplicates_ids_and_normalizes_numbers(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first.csv"
    second = tmp_path / "second.csv"
    row = "tx-1,Market buy,2026-08-01T10:00:00Z,BE,Bloom,1,100,100,0.05,"
    _write_export(first, [row])
    _write_export(
        second, [row, "tx-2,Dividend (Dividend),2026-08-02T10:00:00Z,BE,Bloom,1,0,0.12,,"]
    )

    result = load_transactions([first, second])

    assert list(result["ID"]) == ["tx-1", "tx-2"]
    assert result["Shares"].tolist() == [1.0, 1.0]
    assert result["FeeN"].tolist() == [0.05, 0.0]
    assert result["Time"].dt.tz is not None


def test_load_transactions_rejects_conflicting_duplicate_id(tmp_path: Path) -> None:
    first = tmp_path / "first.csv"
    second = tmp_path / "second.csv"
    _write_export(first, ["tx-1,Market buy,2026-08-01T10:00:00Z,BE,Bloom,1,100,100,0.05,"])
    _write_export(second, ["tx-1,Market buy,2026-08-01T10:00:00Z,BE,Bloom,2,100,200,0.05,"])

    with pytest.raises(ValueError, match="conflicting rows"):
        load_transactions([first, second])


def test_transaction_markers_aggregate_real_fills_and_resolve_current_isin(
    tmp_path: Path,
) -> None:
    invest = tmp_path / "invest.csv"
    isa = tmp_path / "isa.csv"
    isin = "US0000000001"
    _write_export_with_isin(
        invest,
        [
            f"b1,Market buy,2026-08-01T10:00:00Z,{isin},OLD,Example,1,100,100,0,",
            f"b2,Market buy,2026-08-01T11:00:00Z,{isin},OLD,Example,3,110,330,0,",
            f"s1,Market sell,2026-08-02T12:00:00Z,{isin},OLD,Example,2,120,240,0,20",
            "d1,Dividend (Dividend),2026-08-03T12:00:00Z,,OTHER,Other,1,0,1,0,",
        ],
    )
    _write_export_with_isin(
        isa,
        [
            f"b3,Market buy,2026-08-02T09:00:00Z,{isin},OLD,Example,1,118,118,0,",
            "x1,Market buy,2026-08-02T09:00:00Z,US9999999999,SOLD,Sold,1,10,10,0,",
        ],
    )

    markers = transaction_marker_rows(
        {
            "invest": load_transactions([invest]),
            "isa": load_transactions([isa]),
        },
        [
            {
                "ticker": "NEW",
                "broker_ticker": "NEW_US_EQ",
                "isin": isin,
            }
        ],
    )

    assert markers == [
        {
            "ticker": "NEW",
            "date": "2026-08-01",
            "accounts": ["invest"],
            "buy_orders": 2,
            "sell_orders": 0,
            "buy_quantity": 4.0,
            "sell_quantity": 0.0,
            "kind": "B",
            "buy_average_price": 107.5,
            "sell_average_price": None,
        },
        {
            "ticker": "NEW",
            "date": "2026-08-02",
            "accounts": ["invest", "isa"],
            "buy_orders": 1,
            "sell_orders": 1,
            "buy_quantity": 1.0,
            "sell_quantity": 2.0,
            "kind": "T",
            "buy_average_price": 118.0,
            "sell_average_price": 120.0,
        },
        {
            "ticker": "SOLD",
            "date": "2026-08-02",
            "accounts": ["isa"],
            "buy_orders": 1,
            "sell_orders": 0,
            "buy_quantity": 1.0,
            "sell_quantity": 0.0,
            "kind": "B",
            "buy_average_price": 10.0,
            "sell_average_price": None,
        },
    ]


def test_reconstruct_campaigns_keeps_split_legs_and_dividends_in_open_campaign(
    tmp_path: Path,
) -> None:
    export = tmp_path / "ledger.csv"
    _write_export(
        export,
        [
            "1,Market buy,2026-01-01T10:00:00Z,BE,Bloom,2,10,20,0,",
            "2,Dividend (Dividend),2026-01-02T10:00:00Z,BE,Bloom,2,0,1,0,",
            "3,Stock split close,2026-01-03T10:00:00Z,BE,Bloom,2,0,0,0,",
            "4,Stock split open,2026-01-03T10:00:01Z,BE,Bloom,4,0,0,0,",
        ],
    )
    closed, opened = reconstruct_campaigns(load_transactions([export]))

    assert closed == []
    campaign, quantity = opened["BE"]
    assert quantity == 4
    assert campaign.corporate_actions == 2
    assert campaign.recovered_cash == 1
    assert campaign.buy_cash_out == 20


def test_reconstruct_campaigns_skips_closed_pre_window_opening_position(
    tmp_path: Path,
) -> None:
    export = tmp_path / "ledger.csv"
    _write_export(
        export,
        ["1,Market sell,2026-01-01T10:00:00Z,BE,Bloom,1,10,10,0,0"],
    )

    closed, opened = reconstruct_campaigns(load_transactions([export]))

    assert closed == []
    assert opened == {}


def test_policy_metrics_has_stable_account_and_isa_shapes(tmp_path: Path) -> None:
    export = tmp_path / "ledger.csv"
    _write_export(
        export,
        [
            "1,Market buy,2026-01-01T10:00:00Z,BE,Bloom,1,10,10,0,",
            "2,Market sell,2026-01-02T10:00:00Z,BE,Bloom,1,12,12,0,2",
        ],
    )
    transactions = load_transactions([export])

    result = policy_metrics({"A": transactions, "B": transactions})

    assert result["a_campaign"]["closed_campaigns"] == 1
    assert result["a_campaign"]["win_rate"] == 1.0
    assert result["a_campaign"]["profit_factor"] is None
    assert result["b_policy"][0]["Bucket"] == "All ISA trades"


def test_diluted_cost_can_be_negative_and_recovery_is_explicit(tmp_path: Path) -> None:
    export = tmp_path / "ledger.csv"
    _write_export(
        export,
        [
            "1,Market buy,2026-01-01T10:00:00Z,BE,Bloom,2,10,20,0,",
            "2,Market sell,2026-01-02T10:00:00Z,BE,Bloom,1,25,25,0,5",
        ],
    )
    transactions = load_transactions([export])
    position = {
        "ticker": "BE",
        "name": "Bloom Energy",
        "quantity": 1,
        "current_value_gbp": 30,
    }

    diluted = diluted_cost_rows("A", transactions, [position])[0]
    recovery, checks = capital_recovery_rows("A", transactions, [position])

    assert diluted["diluted_cost_gbp"] == -5
    assert diluted["diluted_cost_per_share_gbp"] == -5
    assert recovery[0]["CapitalGapGBP"] == 0
    assert recovery[0]["CapitalRecoveryStatus"] == "本金已收回（现金回收口径）"
    assert all(check["status"] == "OK" for check in checks)


def test_open_campaign_follows_isin_across_ticker_rename(tmp_path: Path) -> None:
    export = tmp_path / "ledger.csv"
    isin = "US19247G1076"
    _write_export_with_isin(
        export,
        [
            f"1,Market buy,2026-01-01T10:00:00Z,{isin},COHR,Coherent,3,100,300,0,",
            f"2,Dividend (Dividend),2026-02-01T10:00:00Z,{isin},COHR,Coherent,3,0,3,0,",
        ],
    )
    transactions = load_transactions([export])
    position = {
        "ticker": "IIVI",
        "isin": isin,
        "name": "Coherent Corp",
        "quantity": 3,
        "current_value_gbp": 360,
    }

    diluted = diluted_cost_rows("B", transactions, [position])[0]
    recovery, checks = capital_recovery_rows("B", transactions, [position])

    assert diluted["ticker"] == "IIVI"
    assert diluted["diluted_cost_gbp"] == 297
    assert recovery[0]["Ticker"] == "IIVI"
    assert recovery[0]["DistributionsGBP"] == 3
    assert checks[0]["check"] == "open_security_set"
    assert all(check["status"] == "OK" for check in checks)
