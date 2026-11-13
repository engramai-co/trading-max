from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from trading_max.infrastructure.sector_prices import SparkSeries
from trading_max.infrastructure.sector_universe import SectorConstituent, SectorUniverse
from trading_max.infrastructure.shared_market_prices import (
    MarketPriceBudgetExhausted,
    SharedMarketPrices,
)
from trading_max.reference.indices import INDEX_REGISTRY

from services.api.trading_max_api.index_depth import (
    BreadthCloses,
    IndexDepth,
    _breadth,
    _vix,
)
from services.api.trading_max_api.sector_sessions import sessions_between

NOW = datetime(2026, 11, 13, 22, tzinfo=UTC)
SOURCE_URL = "https://example.invalid/fund"
SP = INDEX_REGISTRY["sp-500"]
NDX = INDEX_REGISTRY["nasdaq-100"]


def _universe(symbols: list[str], *, ticker: str = "TEST") -> SectorUniverse:
    return SectorUniverse(
        market="us",
        universe="Synthetic index",
        fund="Synthetic tracking fund",
        fund_ticker=ticker,
        source_url=SOURCE_URL,
        as_of="2026-11-12",
        fetched_at="2026-11-13T12:00:00Z",
        constituents=[
            SectorConstituent(
                symbol=symbol,
                ticker=symbol,
                name=f"Synthetic {symbol}",
                sector_code="45",
                sector_name="Information Technology",
                weight=(0.75 if i == 0 else 0.25 / max(1, len(symbols) - 1)),
            )
            for i, symbol in enumerate(symbols)
        ],
    )


def _series(symbol: str, days: dict[str, float], *, retrieved: datetime = NOW) -> SparkSeries:
    zone = ZoneInfo("America/New_York")
    return SparkSeries(
        symbol,
        tuple(
            int(datetime.fromisoformat(day).replace(hour=10, tzinfo=zone).timestamp())
            for day in days
        ),
        tuple(days.values()),
        fetched_at=retrieved,
    )


def test_breadth_counts_listings_equally_and_does_not_fill_missing_sessions() -> None:
    dates = [window.date for window in sessions_between("us", date(2025, 1, 1), NOW.date())]
    basket = _universe(["UP", "DOWN", "FLAT", "YOUNG", "GAP"])
    closes = {
        "UP": {day: 100.0 + i for i, day in enumerate(dates)},
        "DOWN": {day: 700.0 - i for i, day in enumerate(dates)},
        "FLAT": dict.fromkeys(dates, 13.1),
        "YOUNG": {day: 200.0 + i for i, day in enumerate(dates[-110:])},
        "GAP": {day: 200.0 - i * 0.1 for i, day in enumerate(dates) if day != dates[-2]},
    }
    result = _breadth(
        basket,
        dates,
        {key: BreadthCloses(values=values, fetched_at=NOW) for key, values in closes.items()},
        NOW,
    )
    assert result and result.members == 5
    assert result.holdings_url == SOURCE_URL
    assert result.holdings_as_of == date(2026, 11, 12)
    assert result.prices_fetched_at == NOW
    last = result.points[-1]
    assert last.eligible_50 == 5
    assert last.eligible_200 == 4
    assert last.above_50 == 0.4
    assert last.above_200 == 0.25
    assert result.points[-2].eligible_200 == 3
    assert result.points[-2].above_200 is None
    assert result.points[-3].above_200 == 0.25
    assert all(row.date.weekday() < 5 for row in result.points)
    assert len(result.points) <= 252


class _Universes:
    def get(self, market: str) -> SectorUniverse:
        return _universe(["SYNA", "SYNB"] if market == "us" else ["SYNA", "SYNC"])


class _Prices:
    def __init__(self) -> None:
        self.now = NOW
        self.full: list[list[str]] = []
        self.short: list[list[str]] = []
        self.revised = False
        self.paused = False

    def _dates(self) -> list[str]:
        return [w.date for w in sessions_between("us", date(2024, 10, 1), self.now.date())]

    def _closes(self, symbol: str, limit: int) -> dict[str, float]:
        scale = 0.5 if self.revised and symbol == "SYNC" else 1.0
        return {
            day: (120.0 + i) * scale
            for i, day in enumerate(self._dates())
            if i >= len(self._dates()) - limit
        }

    def breadth_history(self, symbols: list[str]) -> dict[str, SparkSeries]:
        self.full.append(symbols)
        if self.paused:
            raise MarketPriceBudgetExhausted
        return {
            symbol: _series(symbol, self._closes(symbol, 500), retrieved=self.now)
            for symbol in symbols
        }

    def daily(self, symbols: list[str], **_) -> dict[str, SparkSeries]:
        self.short.append(symbols)
        if self.paused:
            raise MarketPriceBudgetExhausted
        return {
            symbol: _series(symbol, self._closes(symbol, 22), retrieved=self.now)
            for symbol in symbols
        }

    def history(self, _symbol: str, **_) -> None:
        return None


def test_depth_reuses_settlement_and_refreshes_only_revised_long_series(tmp_path: Path) -> None:
    prices = _Prices()
    depth = IndexDepth(tmp_path, prices, _Universes())

    def refresh() -> None:
        depth.refresh(
            "us",
            prices.now,
            settled=lambda _: {
                symbol: BreadthCloses(values=prices._closes(symbol, 22), fetched_at=prices.now)
                for symbol in ("SYNA", "SYNB")
            },
            check_active=lambda: None,
        )

    assert depth.breadth(SP) is None
    refresh()
    assert prices.full == [["SYNA", "SYNB", "SYNC"]]
    assert prices.short == []
    assert depth.breadth(SP).as_of == NOW.date()
    refresh()
    assert len(prices.full) == 1
    prices.now += timedelta(days=3)
    prices.revised = True
    # Simulate a restart: the daily source bars and computed snapshots survive.
    depth = IndexDepth(tmp_path, prices, _Universes())
    refresh()
    assert prices.full[-1] == ["SYNC"]
    assert prices.short == [["SYNC"]]
    assert depth.breadth(NDX).as_of == prices.now.date()
    assert depth.breadth(NDX).points[-1].eligible_200 == 2
    latest = depth.breadth(NDX)
    prices.now += timedelta(days=1)
    prices.paused = True
    refresh()
    assert depth.breadth(NDX) == latest
    assert depth.breadth_stale(NDX, latest, prices.now)


def test_vix_uses_completed_points_and_discloses_sample() -> None:
    days = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]
    vix = _vix(
        _series(
            "^VIX",
            dict(zip([*days, "2026-11-13", "2026-11-08"], [10, 20, 30, 25, 999, 999], strict=True)),
        ),
        days,
        NOW,
    )
    assert vix and vix.close == 25
    assert vix.percentile == 2 / 3
    assert vix.p10 == 10
    assert vix.p90 == 30
    assert vix.sample_size == 3
    assert vix.as_of == date(2026, 11, 12)


def test_valuation_is_a_validated_local_snapshot_and_never_infers_forward_pe(
    tmp_path: Path,
) -> None:
    depth = IndexDepth(tmp_path, SharedMarketPrices())
    assert depth.valuation(SP, NOW)[0] is None
    depth.valuation_root.mkdir(parents=True)
    path = depth.valuation_root / f"{SP.id}.json"
    path.write_text('{"asOf":"2026-11-01","fetchedAt":"2026-11-02T22:00:00Z","pe":25}')
    value, ref = depth.valuation(SP, NOW)
    assert value and value.pe == 25 and value.forward_pe is None and value.basis == "etf"
    assert ref and value.source_url == ref.source_url
    path.write_text('{"asOf":"2027-11-01","fetchedAt":"2027-11-02T22:00:00Z","pe":25}')
    assert depth.valuation(SP, NOW)[0] is None
    assert depth.valuation(INDEX_REGISTRY["dow-jones"], NOW) == (None, None)


def test_long_daily_reads_share_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    from trading_max.infrastructure import shared_market_prices as shared

    monkeypatch.setattr(shared, "REQUEST_BUDGET", ((60, 1, 2),))

    class Source:
        def breadth_history(self, symbols: list[str]) -> dict[str, SparkSeries]:
            return {symbol: _series(symbol, {"2026-11-12": 25}) for symbol in symbols}

        def daily(self, symbols: list[str]) -> dict[str, SparkSeries]:
            pytest.fail("An exhausted budget must stop the provider read")

    prices = SharedMarketPrices(Source())
    assert len(prices.breadth_history(["SYNA", "SYNB"])) == 2
    assert prices.breadth_history(["SYNA"])
    with pytest.raises(MarketPriceBudgetExhausted):
        prices.daily(["SYNC"])
