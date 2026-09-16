import copy

import pandas as pd
import pytest
from trading_max.analytics.ledger import load_transactions, reconstruct_campaigns

from tools.extend_broker_preview import close_and_reopen


def fixture():
    payload = {
        "fetched_at_utc": "2026-01-06T20:00:00Z",
        "account_summary": {
            "cash": {"availableToTrade": 200},
            "investments": {"realizedProfitLoss": 0},
        },
        "positions": [
            {
                "instrument": {"ticker": "TEST", "currency": "USD"},
                "quantity": 2,
                "walletImpact": {"totalCost": 100},
            }
        ],
    }
    fields = {
        "Currency (Total)": "GBP",
        "Currency conversion fee": 0,
        "Result": 0,
        "ISIN": "",
        "Name": "Fixture",
        "Currency (Price / share)": "USD",
        "Exchange rate": 2,
    }
    rows = [
        {
            **fields,
            "ID": "deposit",
            "Action": "Deposit",
            "Time (UTC)": "2026-01-02T08:00:00Z",
            "Ticker": "",
            "No. of shares": None,
            "Price / share": None,
            "Total": 300,
        },
        {
            **fields,
            "ID": "opening",
            "Action": "Market buy",
            "Time (UTC)": "2026-01-05T14:40:00Z",
            "Ticker": "TEST",
            "No. of shares": 2,
            "Price / share": 100,
            "Total": 100,
        },
    ]
    trades = [
        {
            "ticker": "TEST",
            "closed_at": "2026-01-08T14:40:00Z",
            "reopened_at": "2026-01-09T14:40:00Z",
        }
    ]
    markets = {
        "TEST": {
            "symbol": "TEST",
            "name": "Fixture",
            "currency": "USD",
            "daily": {"2026-01-07": 120, "2026-01-08": 80},
            "splits": {},
        },
        "GBPUSD=X": {"symbol": "GBPUSD=X", "daily": {"2026-01-07": 2, "2026-01-08": 2}},
    }
    return payload, rows, trades, markets


def test_new_broker_records_produce_realized_campaigns_without_changing_quantity(tmp_path):
    payload, rows, trades, markets = fixture()
    original = copy.deepcopy((payload, rows))
    updated, events = close_and_reopen(
        payload, rows, trades, markets, batch="test", profile="invest"
    )
    assert (payload, rows) == original
    assert updated["positions"][0]["quantity"] == 2
    assert updated["positions"][0]["walletImpact"]["totalCost"] == 80
    assert updated["account_summary"]["cash"]["availableToTrade"] == 240
    assert updated["account_summary"]["investments"]["realizedProfitLoss"] == 20
    path = tmp_path / "export.csv"
    pd.DataFrame(events).to_csv(path, index=False)
    closed, opened = reconstruct_campaigns(load_transactions([path]))
    assert len(closed) == 1
    assert closed[0]["NetResult"] == 20
    assert opened["TEST"][1] == 2
    # Retrying the installation must not double trades, cash or realized results.
    assert close_and_reopen(updated, events, trades, markets, batch="test", profile="invest") == (
        updated,
        events,
    )


def test_missing_real_prices_or_edits_before_existing_observations_fail_closed():
    payload, rows, trades, markets = fixture()
    markets["TEST"]["daily"] = {}
    with pytest.raises(ValueError, match="no real price"):
        close_and_reopen(payload, rows, trades, markets, batch="test", profile="invest")
    payload, rows, trades, markets = fixture()
    trades[0]["closed_at"] = "2026-01-06T14:40:00Z"
    with pytest.raises(ValueError, match="follow existing observations"):
        close_and_reopen(payload, rows, trades, markets, batch="test", profile="invest")
