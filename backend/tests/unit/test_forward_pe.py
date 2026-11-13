from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from trading_max.research.estimate_history import ConsensusEstimate, EstimateObservation
from trading_max.research.forward_pe import forward_pe_history

ZONE = ZoneInfo("America/New_York")
OBSERVED = datetime(2026, 7, 2, 1, tzinfo=UTC)


def observation(at=OBSERVED, **overrides):
    return EstimateObservation.model_validate(
        {
            "ticker": "SYNTH",
            "listing": "US:SYNTH",
            "currency": "USD",
            "observed_at": at,
            "price": 100,
            "price_as_of": at - timedelta(hours=3),
            "forwardPE": 20,
            "forward_eps": 5,
            "consensus": [
                ConsensusEstimate(
                    period="0y", period_end=date(2026, 12, 31), mean_eps=4, currency="USD"
                ),
                ConsensusEstimate(
                    period="+1y", period_end=date(2027, 12, 31), mean_eps=8, currency="USD"
                ),
            ],
        }
        | overrides
    )


def series(rows):
    result = forward_pe_history(rows, currency="USD", timezone=ZONE)
    assert result is not None
    return result


def test_weights_fiscal_years_on_exchange_local_observation_date():
    point = series([observation()]).points[0]
    assert point.date == date(2026, 7, 1)
    assert point.observed_at == OBSERVED
    assert point.price_as_of == OBSERVED - timedelta(hours=3)
    w = (date(2026, 12, 31) - point.date).days / 365
    assert point.source == "yahoo-consensus"
    assert point.eps == pytest.approx(w * 4 + (1 - w) * 8)
    assert point.pe == pytest.approx(100 / point.eps)


def test_fiscal_rollover_rejects_expired_period_and_accepts_a_53_week_year():
    consensus = [
        ConsensusEstimate(period="0y", period_end=date(2026, 9, 26), mean_eps=2, currency="USD"),
        ConsensusEstimate(period="+1y", period_end=date(2027, 10, 2), mean_eps=6, currency="USD"),
    ]
    midnight_utc = datetime(2026, 9, 27, 1, tzinfo=UTC)
    first, second = series(
        [
            observation(midnight_utc, consensus=consensus),
            observation(midnight_utc + timedelta(days=1), consensus=consensus),
        ]
    ).points
    assert (first.date, first.eps, first.source) == (date(2026, 9, 26), 6, "yahoo-consensus")
    assert (second.pe, second.eps, second.source) == (20, 5, "yahoo-forward-pe")


def test_mismatched_currency_can_use_vendor_but_nonpositive_consensus_keeps_gap():
    fy1, fy2 = observation().consensus
    days = series(
        [
            observation(consensus=[fy1, fy2.model_copy(update={"currency": "EUR"})]),
            observation(
                OBSERVED + timedelta(days=1),
                consensus=[fy1, fy2.model_copy(update={"period_end": None})],
            ),
            observation(
                OBSERVED + timedelta(days=2),
                consensus=[
                    fy1.model_copy(update={"mean_eps": -1}),
                    fy2.model_copy(update={"mean_eps": 0}),
                ],
            ),
            observation(OBSERVED + timedelta(days=3), price_as_of=OBSERVED + timedelta(days=4)),
            observation(OBSERVED + timedelta(days=4), consensus=[], forwardPE=-5),
        ]
    ).points
    assert [point.source for point in days] == [
        "yahoo-forward-pe",
        "yahoo-forward-pe",
        "yahoo-consensus",
        "yahoo-consensus",
        None,
    ]
    assert [point.pe for point in days] == [20, 20, None, None, None]
    assert days[2].eps < 0
    assert days[3].price is None and days[3].price_as_of is None


def test_distribution_uses_last_vintage_per_day_on_the_latest_basis_only():
    days = [
        observation(OBSERVED + timedelta(days=i), forwardPE=i + 1, consensus=[]) for i in range(29)
    ]
    same_day = observation(OBSERVED + timedelta(days=28, hours=1), forwardPE=35, consensus=[])
    short = series([*days, same_day])
    assert len(short.points) == 29
    assert short.points[-1].pe == 35
    assert short.distribution is None
    enough = observation(OBSERVED + timedelta(days=31), forwardPE=15, consensus=[])
    history = series([*days, same_day, enough])
    stats = history.distribution
    assert stats is not None and stats.samples == 30
    assert stats.median == 15
    assert stats.latest_percentile == pytest.approx(16 / 30)
    # Another quote currency cannot replace a reading. A change in horizon
    # basis cannot borrow those 30 readings to produce a percentile.
    assert (
        series([*days, enough, observation(OBSERVED + timedelta(days=33), currency="GBP")])
        .points[-1]
        .date
        == enough.observed_at.astimezone(ZONE).date()
    )
    derived = series([*days, enough, observation(OBSERVED + timedelta(days=33))])
    assert derived.distribution is None
    assert len(derived.points) == 31
