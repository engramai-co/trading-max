import pytest
from trading_max.analytics.key_moments import key_moments


@pytest.mark.parametrize("prior_closes", [[100], [None], []])
def test_first_visible_session_uses_its_previous_observed_close(prior_closes):
    first, last = "2026-02-02", "2026-02-03"
    bars = [
        *({"date": "2026-01-30", "close": close} for close in prior_closes),
        {"date": first, "close": 125},
        {"date": last, "close": 126},
    ]
    events = [{"date": bar["date"], "kind": "filing", "reference": "synthetic"} for bar in bars]
    moments = key_moments(bars, events, first, last)
    if prior_closes == [100]:
        assert [(row["date"], row["unusual_rank"]) for row in moments] == [(first, 1), (last, 2)]
        assert moments[0]["move_fraction"] == pytest.approx(0.25)
    else:
        assert [row["date"] for row in moments] == [last]
        assert moments[0]["move_fraction"] == pytest.approx(126 / 125 - 1)
