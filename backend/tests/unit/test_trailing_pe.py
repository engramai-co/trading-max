from datetime import UTC, date, datetime

import pytest
from trading_max.research.calendar import market_calendar
from trading_max.research.trailing_pe import DailyClose, DilutedEps, EpsFiling, trailing_pe_history


def _date(value):
    return date.fromisoformat(value)


def _filing(accepted, end, *values, annual=False):
    return EpsFiling(
        datetime.fromisoformat(accepted),
        _date(end),
        annual,
        tuple(DilutedEps(_date(start), _date(finish), eps) for start, finish, eps in values),
    )


def _bars(start, end, *, exceptions=None):
    first, last = _date(start), _date(end)
    sessions = market_calendar("XNYS", first.year, last.year).schedule.loc[start:end]
    return [
        DailyClose(label.date(), *(exceptions or {}).get(label.date().isoformat(), (40.0, 0)))
        for label in sessions.index
    ]


def _at(history, day):
    p = next(point for point in history.points if point.date == _date(day))
    return p, history.earnings[p.earnings_index] if p.earnings_index is not None else None


def test_before_close_early_close_exact_close_and_weekend():
    end = "2024-09-28"
    original = _filing("2024-11-27T21:01:00Z", end, ("2023-10-01", end, 4), annual=True)
    before_close = _filing("2024-11-29T17:59:00Z", end, ("2023-10-01", end, 5), annual=True)
    at_close = _filing("2024-11-29T18:00:00Z", end, ("2023-10-01", end, 8), annual=True)
    prices = _bars("2024-11-25", "2024-12-03")
    history = trailing_pe_history(
        [at_close, original, before_close], prices, now=datetime(2024, 12, 3, 20, tzinfo=UTC)
    )
    assert [p.date.isoformat() for p in history.points] == ["2024-11-29", "2024-12-02"]
    assert history.points[0].pe == 8
    assert history.points[1].pe == 5
    assert history.earnings[0].effective_date.isoformat() == "2024-11-29"
    assert history.earnings[1].effective_date.isoformat() == "2024-12-02"


def test_split_adjustment_matches_yahoo_including_post_split_restatement():
    end = "2023-12-31"
    pre_split = _filing("2024-02-08T14:00:00Z", end, ("2023-01-01", end, 16), annual=True)
    post_split = _filing("2024-02-21T14:00:00Z", end, ("2023-01-01", end, 4), annual=True)
    after_reverse = _filing("2024-02-23T14:00:00Z", end, ("2023-01-01", end, 8), annual=True)
    prices = _bars(
        "2024-02-01",
        "2024-02-27",
        exceptions={
            "2024-02-20": (40.0, 4),
            "2024-02-22": (40.0, 0.5),
        },
    )
    history = trailing_pe_history(
        [pre_split, post_split, after_reverse], prices, now=datetime(2024, 2, 27, 22, tzinfo=UTC)
    )
    assert {p.pe for p in history.points} == {5}
    assert len(history.earnings) == 1
    assert history.earnings[0].eps == 8


def test_derived_q4_crosses_a_53_week_fiscal_year_and_replays_restatements():
    fiscal_end = "2023-09-30"
    q1 = ("2022-09-25", "2022-12-31", 1)
    q2 = ("2023-01-01", "2023-04-01", 2)
    q3 = ("2023-04-02", "2023-07-01", 3)
    year = ("2022-09-25", fiscal_end, 10)
    first_new_quarter = ("2023-10-01", "2023-12-30", 5)
    filings = [
        _filing("2023-02-02T22:00:00Z", q1[1], q1),
        _filing("2023-05-04T22:00:00Z", q2[1], q2),
        _filing("2023-08-03T22:00:00Z", q3[1], q3),
        _filing("2023-11-02T22:00:00Z", fiscal_end, year, annual=True),
        _filing("2024-02-01T22:00:00Z", first_new_quarter[1], first_new_quarter),
        _filing("2024-02-09T15:00:00Z", q3[1], (q3[0], q3[1], 2)),
    ]
    history = trailing_pe_history(
        filings, _bars("2023-01-03", "2024-02-12"), now=datetime(2024, 2, 12, 22, tzinfo=UTC)
    )
    _, annual = _at(history, "2023-11-03")
    assert (annual.eps, annual.method) == (10, "annual")
    _, crossing = _at(history, "2024-02-02")
    # 2 + 3 + inferred Q4 (10 - 1 - 2 - 3) + the new Q1 (5).
    assert (crossing.eps, crossing.method) == (14, "derivedFourthQuarter")
    assert _at(history, "2024-02-08")[1].eps == 14
    # Q3 is restated, but neither the annual nor Q4 was amended.
    assert _at(history, "2024-02-09")[1].eps == 13


@pytest.mark.parametrize("eps", [0, -1])
def test_nonpositive_eps_breaks_line_and_missing_quarter_does_not_fill(eps):
    end = "2023-12-31"
    bad_end = "2024-12-31"
    filings = [
        _filing("2024-02-08T14:00:00Z", end, ("2023-01-01", end, 4), annual=True),
        _filing("2024-04-24T14:00:00Z", "2024-03-31"),
        _filing("2025-02-07T14:00:00Z", bad_end, ("2024-01-01", bad_end, eps), annual=True),
    ]
    history = trailing_pe_history(
        filings, _bars("2024-02-01", "2025-02-10"), now=datetime(2025, 2, 10, 22, tzinfo=UTC)
    )
    assert _at(history, "2024-04-23")[0].pe == 10
    p, evidence = _at(history, "2024-04-24")
    assert p.pe is None and evidence is None
    p, evidence = _at(history, "2025-02-07")
    assert p.pe is None and evidence.eps == eps
    assert history.distribution is None


def test_statistics_exclude_missing_prices_and_wait_for_60_valid_closes():
    end = "2023-12-31"
    filings = [_filing("2024-02-08T14:00:00Z", end, ("2023-01-01", end, 4), annual=True)]
    bars = _bars("2024-02-08", "2024-06-28")
    prices = [DailyClose(bar.date, 4 * (index + 1), 0) for index, bar in enumerate(bars)]
    missing = DailyClose(bars[59].date, None, 0)
    short = trailing_pe_history(
        filings,
        [*prices[:59], missing],
        now=datetime.combine(missing.date, datetime.max.time(), UTC),
    )
    assert short.distribution is None and short.points[-1].pe is None
    history = trailing_pe_history(
        filings, prices[:60], now=datetime.combine(bars[59].date, datetime.max.time(), UTC)
    )
    stats = history.distribution
    assert (stats.samples, stats.lower_quartile, stats.median, stats.upper_quartile) == (
        60,
        15.75,
        30.5,
        45.25,
    )
    assert stats.mean == 30.5
    assert stats.standard_deviation == pytest.approx(17.31810228)
    assert stats.latest_percentile == 1
