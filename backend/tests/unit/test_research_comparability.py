from trading_max.research.comparability import ComparisonSample, compare_samples


def sample(**updates):
    return ComparisonSample.model_validate(
        {
            "securityId": "fixture:common-share",
            "metric": "eps",
            "provider": "primary",
            "asOf": "2026-06-30",
            "period": "Q2 FY2026",
            "currency": "USD",
            "basis": "GAAP",
            "unit": "perShare",
            "value": 2,
            **updates,
        }
    )


def test_only_aligned_observations_receive_a_numeric_difference():
    a = sample()
    assert compare_samples(a, sample(provider="secondary", value=2.01)).state == "comparable"
    for delta in (
        {"basis": "adjusted"},
        {"asOf": "2026-07-01"},
        {"currency": "EUR"},
        {"securityId": "fixture:adr"},
    ):
        result = compare_samples(a, sample(**delta))
        assert result.state == "different-definition"
        assert result.difference is None


def test_unknown_analyst_population_and_missing_values_are_not_zero():
    a = sample(sampleCount=30)
    assert compare_samples(a, a).state == "insufficient-context"
    assert compare_samples(sample(value=None), sample()).difference is None
    assert compare_samples(sample(value=0), sample(value=0)).difference == 0
