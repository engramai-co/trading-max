from services.api.trading_max_api.dashboard_models import (
    ReviewAttributionBucket,
    ReviewSection,
    ReviewTradeQuality,
)


def test_missing_fee_conversion_keeps_known_net_results_in_review_contract():
    quality = ReviewTradeQuality.model_validate(
        {
            "status": "available",
            "trade_count": 1,
            "net_result_gbp": 18,
            "best_trades": [
                {
                    "ticker": "SYNTH",
                    "name": "Synthetic security",
                    "holding_bucket": "short",
                    "direction": "long",
                    "buy_notional_gbp": None,
                    "sell_notional_gbp": None,
                    "gross_result_gbp": None,
                    "fees_gbp": None,
                    "net_result_gbp": 18,
                    "fee_status": "unavailable",
                    "fee_unavailable_reason": "fee_breakdown_unavailable",
                }
            ],
        }
    )
    payload = quality.model_dump(mode="json", by_alias=True)
    assert payload["status"] == "available"
    assert payload["net_result_gbp"] == 18
    trade = payload["best_trades"][0]
    assert trade["netResultGbp"] == 18
    for field in ("buyNotionalGbp", "sellNotionalGbp", "grossResultGbp", "feesGbp"):
        assert trade[field] is None
    assert trade["feeStatus"] == "unavailable"

    bucket = ReviewAttributionBucket.model_validate(
        {"label": "SYNTH", "trade_count": 1, "net_result_gbp": 18, "fees_gbp": None}
    )
    assert bucket.model_dump(by_alias=True)["feesGbp"] is None
    assert bucket.model_dump(by_alias=True)["netResultGbp"] == 18

    components = ReviewSection.model_validate(
        {
            "status": "unavailable",
            "unavailable_reason": "fee_breakdown_unavailable",
            "buckets": [
                {"label": "gross_trade_result", "contribution_gbp": None},
                {"label": "transaction_fees", "contribution_gbp": None},
                {"label": "net_realised_result", "contribution_gbp": 18},
            ],
            "conservation_difference_gbp": None,
        }
    )
    assert components.model_dump()["buckets"][-1]["contribution_gbp"] == 18
    assert components.model_dump()["conservation_difference_gbp"] is None
