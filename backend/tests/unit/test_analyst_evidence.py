from trading_max.research.analyst_evidence import attach_forecast_periods, earnings_events


def test_earnings_time_is_not_invented_from_date_and_zero_actual_is_reported():
    rows = earnings_events(
        [
            {
                "index": "2026-05-01T16:30:00-04:00",
                "Reported EPS": 0,
                "EPS Estimate": 0.1,
                "Surprise(%)": -100,
            },
            {"index": "2026-08-01T00:00:00-04:00", "EPS Estimate": 1.5},
            {"index": "2026-11-01", "EPS Estimate": 1.6},
        ],
        timezone="America/New_York",
    )
    assert rows[-1]["status"] == "reported"
    assert rows[-1]["session"] == "post"
    assert rows[-1]["surprisePct"] == -1
    assert all(r["instant"] is None for r in rows[:2])
    assert all(r["status"] == "provider-estimate" for r in rows[:2])


def test_forecasts_keep_actual_provider_fiscal_end_and_unknown_currency():
    result = {
        "asOf": "2026-07-01",
        "revenueEstimate": [{"index": "0y", "avg": 100}],
        "earningsEstimate": [{"index": "+1y", "avg": 2}],
    }
    attach_forecast_periods(
        result, [{"period": "0y", "endDate": "2026-09-30", "revenueCurrency": "EUR"}]
    )
    assert result["revenueEstimate"][0]["endDate"] == "2026-09-30"
    assert result["revenueEstimate"][0]["currency"] == "EUR"
    assert result["earningsEstimate"][0]["currency"] is None
