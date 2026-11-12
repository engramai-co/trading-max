from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

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
        empty = client.get("/v1/sectors")
        assert empty.status_code == 200
        payload = empty.json()
        assert payload["board"] is None
        assert [market["market"] for market in payload["markets"]] == ["us", "uk", "hk", "kr", "jp"]
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
