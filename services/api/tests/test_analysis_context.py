from services.api.trading_max_api.analysis_context import _compact_account_review


def test_compact_account_review_bounds_investable_evidence_without_dropping_warnings() -> None:
    review = {
        "schema_version": 1,
        "calculation_version": "account-review-v1",
        "account": {"code": "A"},
        "coverage": {"status": "partial"},
        "money_outcome": {"status": "available"},
        "strategy_risk": {"status": "partial"},
        "phases": {"status": "available", "items": [{"phase_id": index} for index in range(40)]},
        "realised_trade_quality": {
            "status": "available",
            "best_trades": [{"ticker": f"W{index}"} for index in range(10)],
            "worst_trades": [{"ticker": f"L{index}"} for index in range(10)],
        },
        "attribution": {
            "status": "available",
            "by_instrument": {"buckets": [{"label": str(index)} for index in range(30)]},
            "by_industry": {"buckets": []},
            "by_country": {"buckets": []},
            "by_direction": {"buckets": []},
            "by_holding_bucket": {"buckets": []},
            "by_calendar": {"month": [{"label": str(index)} for index in range(30)]},
        },
        "structural_diagnostics": {"observable_only": True},
        "ending_risk": {"holdings": [{"ticker": str(index)} for index in range(30)]},
        "warnings": ["coverage is partial"],
    }

    compact = _compact_account_review(review)

    assert len(compact["phases"]["items"]) == 24
    assert len(compact["realised_trade_quality"]["best_trades"]) == 5
    assert len(compact["attribution"]["by_instrument"]["buckets"]) == 12
    assert len(compact["attribution"]["by_calendar"]["month"]) == 12
    assert len(compact["ending_risk"]["holdings"]) == 20
    assert compact["warnings"] == ["coverage is partial"]


def test_compact_cfd_review_keeps_proxy_boundary_and_replaces_full_series_with_summary() -> None:
    review = {
        "currency": "GBP",
        "coverage": {"status": "available"},
        "money_outcome": {"source": "realised_cash_equity_proxy"},
        "strategy_risk": {"status": "unavailable", "twr_total_return": None},
        "phases": {"status": "available", "items": [{"phase_id": index} for index in range(40)]},
        "cash_flows": {"account_cash_flow": "100"},
        "realised_pnl": {"net_realised_pnl": "-10"},
        "trade_quality": {"trade_count": 2},
        "attribution": {"by_instrument": [{"key": str(index)} for index in range(20)]},
        "realised_series": [
            {"event_id": "one", "realised_pnl_drawdown": "0"},
            {"event_id": "two", "realised_pnl_drawdown": "-10"},
        ],
        "notional": {"total_closed_notional": "200"},
        "structural_diagnostics": {"observable_only": True},
        "ending_risk": {"status": "unavailable"},
        "unmatched_executed_orders": [{"event_id": "open"}],
        "warnings": ["true NAV is unavailable"],
    }

    compact = _compact_account_review(review)

    assert len(compact["phases"]["items"]) == 24
    assert len(compact["attribution"]["by_instrument"]) == 12
    assert compact["strategy_risk"]["status"] == "unavailable"
    assert compact["realised_series_summary"]["ending"]["event_id"] == "two"
    assert compact["realised_series_summary"]["max_drawdown_point"]["event_id"] == "two"
    assert compact["unmatched_executed_order_count"] == 1
    assert "realised_series" not in compact
    assert compact["warnings"] == ["true NAV is unavailable"]
