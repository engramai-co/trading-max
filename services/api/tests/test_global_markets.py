"""Synthetic prices around a publisher close and the following exchange opens."""

from datetime import date, datetime, timedelta
from math import fsum

import pytest
from trading_max.infrastructure.acwi_weights import AcwiWeights
from trading_max.infrastructure.sector_prices import SparkSeries

from services.api.trading_max_api.global_markets import (
    ACWI,
    EM,
    benchmark_closes,
    read_global_contribution,
)

THURSDAY = "2026-11-12"
FRIDAY = "2026-11-13"


def at(day, clock):
    return datetime.fromisoformat(f"{day}T{clock}:00+00:00")


def series(symbol, readings, previous=None):
    return SparkSeries(
        symbol,
        tuple(int(time.timestamp()) for time, _ in readings),
        tuple(value for _, value in readings),
        previous_close=previous,
    )


class Prices:
    def __init__(self, now):
        self.now = now

    def benchmark_intraday(self, symbol):
        if symbol == ACWI:
            prior, current, next_level = 100, 99, 98.8
        else:
            prior, current, next_level = 200, 198, 197.8
        readings = [
            (at(THURSDAY, "21:08") - timedelta(days=1), prior),
            (at(THURSDAY, "21:23") - timedelta(days=1), prior),
            (at(THURSDAY, "21:38") - timedelta(days=1), prior),
            (at(THURSDAY, "20:48"), current + 0.5),
            (at(THURSDAY, "21:03"), current),
            (at(THURSDAY, "21:18"), current),
            (at(THURSDAY, "21:33"), current),
            (at(THURSDAY, "22:10"), next_level),
        ]
        if self.now.date().isoformat() == FRIDAY:
            readings.extend(
                [
                    (self.now - timedelta(minutes=4), next_level),
                    (self.now, next_level),
                ]
            )
        if self.now.weekday() >= 5:
            readings.extend(
                [
                    (at(FRIDAY, "21:04"), next_level),
                    (at(FRIDAY, "21:19"), next_level),
                    (at(FRIDAY, "21:34"), next_level),
                    (at("2026-11-15", "10:00"), next_level),
                ]
            )
        return series(
            symbol, readings, previous=current if self.now >= at(THURSDAY, "21:03") else prior
        )

    def daily(self, symbols):
        return {
            symbol: series(
                symbol,
                {
                    ACWI: [
                        (at(THURSDAY, "05:00") - timedelta(days=1), 100),
                        (at(THURSDAY, "05:00"), 99 if self.now.weekday() >= 5 else 98.8),
                    ],
                    EM: [
                        (at(THURSDAY, "05:00") - timedelta(days=1), 200),
                        (at(THURSDAY, "05:00"), 198 if self.now.weekday() >= 5 else 197.8),
                    ],
                    "^GSPC": [
                        (at(THURSDAY, "14:30") - timedelta(days=1), 100),
                        (at(THURSDAY, "14:30"), 99),
                    ],
                    "^N225": [
                        (at(THURSDAY, "00:00") - timedelta(days=1), 100),
                        (at(THURSDAY, "00:00"), 98),
                    ],
                    "^AXJO": [
                        (at(THURSDAY, "23:00") - timedelta(days=2), 100),
                        (at(THURSDAY, "23:00") - timedelta(days=1), 101),
                    ],
                    "^STOXX": [
                        (at(THURSDAY, "08:00") - timedelta(days=1), 100),
                        (at(THURSDAY, "08:00"), 99),
                    ],
                }.get(symbol, []),
            )
            for symbol in symbols
        }

    def intraday(self, symbols):
        return {
            symbol: series(
                symbol,
                {
                    "^N225": [
                        (at(THURSDAY, "06:30"), 98),
                        (at(FRIDAY, "00:50"), 99),
                        (at(FRIDAY, "01:00"), 99.5),
                    ],
                    "^AXJO": [(at(THURSDAY, "23:00"), 101.2), (at(FRIDAY, "00:55"), 101.5)],
                    "^KS11": [(at(FRIDAY, "00:55"), 101.5)],
                    "^GSPC": [(at(THURSDAY, "21:00"), 99)],
                }.get(symbol, []),
                previous=100,
            )
            for symbol in symbols
        }


def contribution(now):
    weights = AcwiWeights(
        as_of=date.fromisoformat(THURSDAY),
        fetched_at=now,
        locations={
            "United States": 0.60,
            "Japan": 0.10,
            "Australia": 0.05,
            "Hong Kong": 0.02,
            "France": 0.05,
            "Sweden": 0.05,
            "India": 0.05,
            "South Korea": 0.05,
        },
    )
    answer = read_global_contribution(Prices(now), weights, False, now)
    rows = {row.market: row for row in answer.rows}
    assert answer.residual + fsum(row.contribution for row in rows.values()) == pytest.approx(
        answer.acwi_move
    )
    return answer, rows


def test_right_after_p_before_next_open_uses_completed_day():
    now = at(THURSDAY, "21:11")
    answer, rows = contribution(now)
    assert answer.reference_date.isoformat() == THURSDAY
    assert answer.as_of == at(THURSDAY, "21:03")
    assert answer.phase == "completed"
    assert answer.acwi_level == 99
    assert answer.acwi_move == pytest.approx(-0.01)
    assert rows["us"].contribution == pytest.approx(-0.006)
    assert rows["eu"].contribution == pytest.approx(-0.001)
    assert rows["jp"].contribution == pytest.approx(-0.002)
    assert answer.state == "partial"


def test_asia_morning_neutralises_europe_and_us_with_zero_rows():
    answer, rows = contribution(at(FRIDAY, "01:00"))
    assert answer.reference_date.isoformat() == FRIDAY
    assert answer.phase == "live"
    assert answer.acwi_move == pytest.approx(98.8 / 99 - 1)
    assert rows["jp"].move == pytest.approx(99.5 / 98 - 1)
    assert rows["au"].move == pytest.approx(101.5 / 101 - 1)
    assert rows["em"].weight == pytest.approx(0.10)
    assert rows["em"].contribution == pytest.approx(0.10 * (197.8 / 198 - 1))
    for market in ("eu", "us", "hk"):
        assert rows[market].not_open
        assert rows[market].move == rows[market].contribution == 0
        reading = next(item for item in answer.markets if item.market == market)
        assert reading.move == 0 and reading.not_open


def test_after_us_close_before_msci_close_uses_all_opened_sessions():
    answer, rows = contribution(at(THURSDAY, "21:02"))
    assert answer.phase == "live"
    assert answer.reference_date.isoformat() == THURSDAY
    assert answer.acwi_move == pytest.approx(-0.005)
    assert rows["us"].contribution == pytest.approx(-0.006)
    assert rows["eu"].contribution == pytest.approx(-0.001)
    assert rows["em"].contribution == pytest.approx(-0.00075)
    assert not rows["us"].not_open


def test_weekend_preserves_completed_day_despite_newer_carry_prints():
    answer, rows = contribution(at("2026-11-15", "15:00"))
    assert answer.phase == "completed"
    assert answer.reference_date.isoformat() == FRIDAY
    assert answer.as_of == at(FRIDAY, "21:04")
    assert answer.acwi_move == pytest.approx(98.8 / 99 - 1)
    assert "us" not in rows  # Thursday's return was not replayed.
    assert rows["em"].contribution == pytest.approx(0.10 * (197.8 / 198 - 1))


def test_yesterdays_previous_close_is_not_a_new_close_if_level_revisits_it():
    now = at(THURSDAY, "16:00")
    tape = series(
        ACWI,
        [
            (at(THURSDAY, "15:15"), 100),
            (at(THURSDAY, "15:20"), 100),
            (at(THURSDAY, "15:25"), 100.02),
        ],
        previous=100,
    )
    daily = series(ACWI, [(at(THURSDAY, "05:00") - timedelta(days=1), 100)])
    assert benchmark_closes(tape, daily, now) == {}
