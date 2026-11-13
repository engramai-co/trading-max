"""Synthetic observations and holdings for the World industry board."""

from datetime import date, timedelta

import pytest
from trading_max.infrastructure.world_sector_weights import (
    WorldSectorWeightsProvider,
    aggregate_world_sector_weights,
)

from services.api.trading_max_api.global_markets import read_global_reference
from services.api.trading_max_api.global_sectors import read_global_sectors

from .test_global_markets import FRIDAY, THURSDAY, Prices, at, series

ENERGY = "^106796-USD-STRD"
IT = "^106803-USD-STRD"
REAL_ESTATE = "^132085-USD-STRD"


def holdings():
    fields = {
        "sectorName": [
            "Energy",
            "Energy",
            "Communication",
            "Real Estate",
            "Information Technology",
            "Cash",
        ],
        "holdingPercent": [20, 10, 10, 5, 53, 2],
        "assetClass": ["Equity"] * 5 + ["Cash"],
        "issueName": [
            "Synthetic large",
            "Synthetic small",
            "Synthetic media",
            "Synthetic REIT",
            "Synthetic tech",
            "",
        ],
        "isin": ["SYN" + str(i) for i in range(6)],
        "asOfDate": "20261112",
    }
    return {key: {"value": value} for key, value in fields.items()}


def test_weights_preserve_nav_and_holdings_date(tmp_path):
    now = at(FRIDAY, "13:00")
    weights = aggregate_world_sector_weights(holdings(), now)
    assert weights.as_of == date.fromisoformat(THURSDAY)
    assert weights.sectors["10"].weight == pytest.approx(0.30)
    assert weights.sectors["50"].weight == 0.1
    assert sum(row.weight for row in weights.sectors.values()) == pytest.approx(0.98)
    assert [(x.name, x.weight) for x in weights.sectors["10"].holdings] == [
        ("Synthetic large", 0.20),
        ("Synthetic small", 0.10),
    ]
    broken = holdings()
    broken["holdingPercent"]["value"][-1] = 0
    with pytest.raises(ValueError, match="fund NAV"):
        aggregate_world_sector_weights(broken, now)

    def fail(_):
        raise ValueError("Synthetic unavailable holdings")

    provider = WorldSectorWeightsProvider(tmp_path, lambda _: weights)
    assert provider.get(now) == (weights, False)
    restored = WorldSectorWeightsProvider(tmp_path, fail)
    assert restored.get(now + timedelta(days=6)) == (weights, False)
    assert restored.get(now + timedelta(days=8)) == (weights, True)


class WorldPrices(Prices):
    def daily(self, symbols):
        result = super().daily(symbols)
        for symbol, latest in [(ENERGY, 100), (IT, 200)]:
            if symbol in symbols:
                result[symbol] = series(
                    symbol,
                    [
                        (at("2026-11-11", "05:00"), latest * 0.98),
                        (at(THURSDAY, "05:00"), latest),
                        (at(FRIDAY, "05:00"), latest * 1.2),  # Indicative, never a completed mark.
                    ],
                )
        return {key: value for key, value in result.items() if value.timestamps}

    def benchmark_intraday_batch(self, symbols):
        assert len(symbols) == 34
        now = self.now
        return {
            ENERGY: series(
                ENERGY,
                [
                    (at(THURSDAY, "21:00"), 100),
                    (now - timedelta(minutes=5), 103),
                    (now, 105),
                    (now + timedelta(minutes=5), 150),
                ],
            ),
            IT: series(IT, [(now - timedelta(minutes=5), 201), (now, 202)]),
        }

    def benchmark_intraday(self, symbol, *, extended=False):
        if symbol in (ENERGY, IT):
            return self.benchmark_intraday_batch([symbol] * 34)[symbol]
        return super().benchmark_intraday(symbol)


def test_board_uses_reference_and_prior_close_for_contribution():
    now = at(FRIDAY, "10:00")
    prices = WorldPrices(now)
    clock = read_global_reference(prices, now)
    weights = aggregate_world_sector_weights(holdings(), now)
    board = read_global_sectors(prices, weights, False, now, clock)
    assert board.phase == "live"
    assert board.reference_date == date.fromisoformat(FRIDAY)
    assert board.as_of == now
    assert board.rank_sessions == [date.fromisoformat(THURSDAY)]
    energy, it, estate = (
        next(row for row in board.sectors if row.gics == code) for code in ("10", "45", "60")
    )
    assert energy.move == pytest.approx(0.05)
    assert energy.contribution == pytest.approx(0.015)
    assert energy.intraday[-1].at == now
    assert it.move == pytest.approx(0.01)
    assert estate.weight == pytest.approx(0.05)
    assert estate.move is estate.contribution is None
    assert estate.ranks == [None]
    assert estate.intraday == []
    assert all(group.move is None for group in estate.groups)


def test_before_next_market_open_keeps_the_completed_date():
    now = at(THURSDAY, "21:45")
    prices = Prices(now)
    clock = read_global_reference(prices, now)
    board = read_global_sectors(prices, None, False, now, clock)
    assert board.reference_date == date.fromisoformat(THURSDAY)
    assert board.phase == "completed"
    assert board.as_of == at(THURSDAY, "21:03")


def test_board_uses_the_canonical_gics_sector_and_group_names():
    from trading_max.reference.taxonomy import standard_gics_names

    from services.api.trading_max_api.global_markets import GlobalReference

    now = at(FRIDAY, "10:00")
    board = read_global_sectors(Prices(now), None, False, now, GlobalReference(None, {}, None))
    assert len(board.sectors) == 11
    assert sum(len(sector.groups) for sector in board.sectors) == 25
    labels = {sector.gics: sector.name for sector in board.sectors}
    labels.update({group.gics: group.name for sector in board.sectors for group in sector.groups})
    assert labels == standard_gics_names()
