from datetime import UTC, date, datetime, timedelta

import pytest
from trading_max.infrastructure.acwi_weights import AcwiWeightsProvider, aggregate_acwi_weights

NOW = datetime(2026, 11, 12, tzinfo=UTC)


def payload():
    return {
        "countryOfRisk": {
            "value": ["United States", "UnitedStates", "Korea (South)", "India", "United States"]
        },
        "holdingPercent": {"value": [40, "25", 20, 10, 5]},
        "assetClass": {"value": ["Equity"] * 4 + ["Cash"]},
        "asOfDate": {"value": 20261111},
    }


def test_weights_use_location_and_total_fund_nav():
    result = aggregate_acwi_weights(payload(), NOW)
    assert result.as_of == date(2026, 11, 11)
    assert result.locations == pytest.approx(
        {"United States": 0.65, "South Korea": 0.2, "India": 0.1}
    )


def test_weights_reject_incomplete_holdings():
    data = payload()
    data["countryOfRisk"]["value"].pop()
    with pytest.raises(ValueError, match="different lengths"):
        aggregate_acwi_weights(data, NOW)
    data = payload()
    data["holdingPercent"]["value"][0] = 0
    with pytest.raises(ValueError, match="NAV"):
        aggregate_acwi_weights(data, NOW)


def test_weights_cache_for_a_week_and_hold_last_good_during_backoff(tmp_path):
    calls = []

    def fetch(now):
        calls.append(now)
        if now != NOW:
            raise RuntimeError("issuer offline")
        return aggregate_acwi_weights(payload(), now)

    provider = AcwiWeightsProvider(tmp_path, fetch)
    expected = provider.get(NOW)
    restarted = AcwiWeightsProvider(tmp_path, fetch)
    assert restarted.get(NOW + timedelta(days=6)) == expected
    assert restarted.get(NOW + timedelta(days=8)) == (expected[0], True)
    assert restarted.get(NOW + timedelta(days=8, minutes=1)) == (expected[0], True)
    assert len(calls) == 2
