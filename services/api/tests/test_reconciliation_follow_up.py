"""Research summary publication must not clear a failed ledger reconciliation."""

from copy import deepcopy
from types import SimpleNamespace

from trading_max.analytics.cash_flow_history import account_state_digest

from services.api.trading_max_api.typed_jobs import performance_refresh_needed


def test_research_summary_cannot_hide_changed_unreconciled_account():
    reconciled = {
        "cash_gbp": 10,
        "positions": [
            {"isin": "US0000000001", "ticker": "TEST", "quantity": 2, "total_cost_gbp": 20}
        ],
    }
    current = {
        "cash_gbp": 20,
        "positions": [
            {"isin": "US0000000001", "ticker": "TEST", "quantity": 1, "total_cost_gbp": 10}
        ],
    }
    payloads = {
        "account/intraday/broker_values.json": {"accounts": {"B": current}},
        "account/broker_snapshot_metrics.json": {"accounts": {"B": deepcopy(current)}},
        "account/nav/cash_flows_b.json": {
            "verified": True,
            "account_state_digest": account_state_digest(reconciled),
        },
    }
    store = SimpleNamespace(
        latest_manifest=lambda: SimpleNamespace(run_id="synthetic"),
        read_json=lambda _run, key: payloads[key],
    )
    assert performance_refresh_needed(store)
    payloads["account/nav/cash_flows_b.json"]["account_state_digest"] = account_state_digest(
        current
    )
    assert not performance_refresh_needed(store)
    current["positions"][0]["current_price"] = 30
    assert not performance_refresh_needed(store)
