from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from services.api.trading_max_api.alert_monitor import AlertMonitor, LiveAlertStore
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.watchlist import WatchlistStore


class FakeQuotes:
    def __init__(self, prices: dict[str, float]) -> None:
        self.prices = prices
        self.requests: list[list[str]] = []

    def fetch(self, tickers: list[str]) -> dict[str, float]:
        requested = list(tickers)
        self.requests.append(requested)
        return {ticker: self.prices[ticker] for ticker in requested if ticker in self.prices}


def test_alert_monitor_refreshes_live_price_and_persists_alert_state(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    seed_watchlist,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    manifest = typed_fixture(research_root, store)
    live = LiveAlertStore(tmp_path / "runtime")
    watchlist = WatchlistStore(tmp_path / "runtime")
    seed_watchlist(watchlist, "BE")
    ledger = ResearchLedger(
        store,
        watchlist,
        live,
    )
    quotes = FakeQuotes({"BE": 175.0})
    monitor = AlertMonitor(
        store,
        ledger,
        live,
        enabled=True,
        quote_provider=quotes,
        now=lambda: datetime(2026, 8, 3, 15, tzinfo=UTC),
    )

    state = monitor.run_once()

    assert quotes.requests
    assert state["snapshotRunId"] == manifest.run_id
    assert state["quotes"]["BE"]["price"] == 175.0
    assert "BE:position:support-breach" in state["alerts"]
    assert state["alerts"]["BE:position:support-breach"]["firstSeenAt"]
    assert live.quote("BE", snapshot_run_id=manifest.run_id) == (
        175.0,
        "2026-08-03T15:00:00+00:00",
    )


def test_alert_monitor_uses_separate_held_and_watchlist_intervals(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
    seed_watchlist,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    live = LiveAlertStore(tmp_path / "runtime")
    watchlist = WatchlistStore(tmp_path / "runtime")
    seed_watchlist(watchlist, "BE")
    ledger = ResearchLedger(
        store,
        watchlist,
        live,
    )
    quotes = FakeQuotes({"BE": 200.0})
    monitor = AlertMonitor(
        store,
        ledger,
        live,
        enabled=True,
        held_interval_seconds=300,
        watchlist_interval_seconds=900,
        quote_provider=quotes,
        now=lambda: datetime(2026, 8, 3, 15, 6, tzinfo=UTC),
    )
    monitor.run_once(force=True)
    state = live.load()
    state["heldUpdatedAt"] = "2026-08-03T15:00:00+00:00"
    state["watchlistUpdatedAt"] = "2026-08-03T15:05:00+00:00"
    live.save(state)
    quotes.requests.clear()

    monitor.run_once()

    assert quotes.requests == [["BE"]]
