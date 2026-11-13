from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import Settings
from services.api.trading_max_api.credentials import InMemoryCredentialStore
from services.api.trading_max_api.sector_models import SectorBoard, SectorSource


def board(market: str) -> SectorBoard:
    return SectorBoard(
        market=market,
        session_date="2026-11-06",
        complete=True,
        as_of=datetime(2026, 11, 6, 8, 5, tzinfo=UTC),
        fetched_at=datetime(2026, 11, 6, 8, 30, tzinfo=UTC),
        member_count=1,
        priced_count=1,
        exposure_gbp=12.5,
        source=SectorSource(
            universe="Synthetic index",
            fund="Synthetic UCITS ETF",
            fund_ticker="SYN",
            url="https://example.invalid/synthetic",
            as_of="2026-11-05",
        ),
    )


def test_sector_route_serves_an_empty_state_then_a_stored_board(tmp_path: Path) -> None:
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    with TestClient(app) as client:
        app.state.sector_monitor._now = lambda: datetime(2026, 11, 13, 19, tzinfo=UTC)
        empty = client.get("/v1/sectors")
        assert empty.status_code == 200
        payload = empty.json()
        assert payload["board"] is None
        assert [market["market"] for market in payload["markets"]] == [
            "us",
            "uk",
            "hk",
            "kr",
            "jp",
            "eu",
            "tw",
            "in",
            "ca",
            "au",
        ]
        assert all(market["sessions"] for market in payload["markets"])
        assert payload["markets"][2]["calendar"] == "XHKG"
        assert payload["markets"][2]["timezone"] == "Asia/Hong_Kong"
        # Test apps never start the monitor; the page can say updates are off.
        assert payload["monitor"]["enabled"] is False
        assert payload["monitor"]["phase"] == "disabled"

        assert client.get("/v1/sectors", params={"market": "hk"}).json()["market"] == "hk"
        assert client.get("/v1/sectors", params={"market": "zz"}).status_code == 422

        app.state.sector_monitor.boards.save(board("hk"))
        stored = client.get("/v1/sectors", params={"market": "hk"}).json()
        assert stored["board"]["sessionDate"] == "2026-11-06"
        assert stored["board"]["exposureGbp"] == 12.5
        hong_kong = stored["markets"][2]
        assert (hong_kong["sessionDate"], hong_kong["complete"]) == ("2026-11-06", True)
        assert hong_kong["asOf"] == "2026-11-06T08:05:00Z"

        refresh = client.get("/v1/refresh-state").json()
        assert refresh["sectors"]["enabled"] is False
        assert refresh["sectors"]["intervalSeconds"] == 600


def test_research_automation_switch_reaches_the_sector_monitor(tmp_path: Path) -> None:
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    with TestClient(app) as client:
        monitor = app.state.sector_monitor
        assert monitor.enabled is False
        current = client.get("/v1/settings/automation").json()
        saved = client.put(
            "/v1/settings/automation",
            json={"researchEnabled": True, "expectedRevision": current["revision"]},
        )
        assert saved.status_code == 200
        assert monitor.enabled is True
        # Unavailable in test apps, so it still never runs.
        assert monitor.status().enabled is False


def test_europe_sector_route_accepts_the_scope_without_changing_default(tmp_path: Path) -> None:
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    with TestClient(app) as client:
        monitor = app.state.sector_monitor
        monitor._now = lambda: datetime(2026, 11, 6, 10, tzinfo=UTC)
        assert client.get("/v1/sectors").json()["market"] == "uk"
        params = {"market": "eu"}
        empty = client.get("/v1/sectors", params=params).json()
        assert empty["market"] == "eu"
        assert empty["board"] is None
        europe = next(m for m in empty["markets"] if m["market"] == "eu")
        assert (europe["calendar"], europe["timezone"]) == ("XETR", "Europe/London")
        assert next(s for s in europe["sessions"] if s["date"] == "2026-11-06") == {
            "date": "2026-11-06",
            "open": "2026-11-06T08:00:00Z",
            "close": "2026-11-06T16:30:00Z",
            "breakStart": None,
            "breakEnd": None,
        }
        monitor.boards.save(board("eu"))
        stored = client.get("/v1/sectors", params=params).json()["board"]
        assert stored["market"] == "eu"
        assert stored["exposureGbp"] == 12.5
        assert client.get("/v1/sectors").json()["market"] == "uk"


@pytest.mark.parametrize(
    ("market", "exchange", "opened", "closed"),
    [
        ("tw", "XTAI", "2026-11-13T01:00:00Z", "2026-11-13T05:30:00Z"),
        ("in", "XNSE", "2026-11-13T03:45:00Z", "2026-11-13T10:00:00Z"),
        ("ca", "XTSE", "2026-11-13T14:30:00Z", "2026-11-13T21:00:00Z"),
        ("au", "XASX", "2026-11-12T23:00:00Z", "2026-11-13T05:00:00Z"),
    ],
)
def test_new_sector_routes_and_exchange_clocks(tmp_path, market, exchange, opened, closed):
    app = create_app(Settings(data_root=tmp_path), credential_store=InMemoryCredentialStore())
    with TestClient(app) as client:
        monitor = app.state.sector_monitor
        monitor._now = lambda: datetime(2026, 11, 13, 19, tzinfo=UTC)
        monitor.boards.save(board(market))
        payload = client.get("/v1/sectors", params={"market": market}).json()
        assert payload["market"] == payload["board"]["market"] == market
        status = next(row for row in payload["markets"] if row["market"] == market)
        assert status["calendar"] == exchange and status["calendarKnown"]
        session = next(row for row in status["sessions"] if row["date"] == "2026-11-13")
        assert (session["open"], session["close"]) == (opened, closed)
        if market == "in":
            monitor._now = lambda: datetime(2027, 1, 1, 6, tzinfo=UTC)
            payload = client.get("/v1/sectors?market=in").json()
            status = next(row for row in payload["markets"] if row["market"] == "in")
            assert status["calendarKnown"] is False
            assert not monitor.due("in", monitor._now())
            assert payload["board"]["sessionDate"] == "2026-11-06"
