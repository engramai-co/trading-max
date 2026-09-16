from trading_max.research.coverage import merge_rows, row_clocks


def test_partial_failure_keeps_old_values_and_old_observation_clock():
    previous = {
        "as_of": "2026-06-01",
        "generated_at": "2026-06-01T10:00:00Z",
        "tickers": ["ONE", "TWO"],
        "rows": [{"ticker": "ONE", "price": 10}, {"ticker": "TWO", "price": 20}],
    }
    current = {
        "as_of": "2026-06-04",
        "generated_at": "2026-06-04T10:00:00Z",
        "tickers": ["ONE"],
        "rows": [],
    }
    merged = merge_rows(previous, current, ("ONE",))
    assert merged["rows"] == previous["rows"]
    assert merged["rowClocks"]["ONE"]["state"] == "stale"
    assert merged["rowClocks"]["ONE"]["lastSuccessfulAt"] == "2026-06-01T10:00:00Z"
    assert merged["rowClocks"]["TWO"] == row_clocks(previous)["TWO"]
    recovered = merge_rows(merged, {**current, "rows": [{"ticker": "ONE", "price": 30}]}, ("ONE",))
    assert recovered["rowClocks"]["ONE"]["state"] == "available"
    assert recovered["rowClocks"]["TWO"]["asOf"] == "2026-06-01"


def test_an_explicit_empty_result_replaces_old_result_and_exchange_suffixes_remain_distinct():
    previous = {
        "rows": [{"ticker": "ABC", "contracts": [1]}, {"ticker": "ABC.L", "contracts": [2]}]
    }
    result = merge_rows(previous, {"rows": [{"ticker": "ABC.L", "contracts": []}]}, ("ABC.L",))
    assert result["rows"] == [
        {"ticker": "ABC", "contracts": [1]},
        {"ticker": "ABC.L", "contracts": []},
    ]
