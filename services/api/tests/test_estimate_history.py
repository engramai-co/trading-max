from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from trading_max.research.estimate_history import ConsensusEstimate, EstimateObservation

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import Settings


def test_estimate_history_endpoint_is_bounded_and_independent_of_snapshots(tmp_path):
    app = create_app(Settings(data_root=tmp_path))
    now = datetime(2026, 10, 20, 10, tzinfo=UTC)
    history = app.state.estimate_history
    history.append(
        EstimateObservation(
            ticker="TEST.L",
            listing="LSE:TEST",
            currency="GBP",
            observed_at=now + timedelta(hours=hour),
            forwardPE=value,
            consensus=[ConsensusEstimate(period="+1y", mean_eps=2.25)],
        )
        for hour, value in enumerate((18, 21, 22))
    )

    with TestClient(app) as client:
        response = client.get("/v1/research/test.l/estimate-history", params={"limit": 2})
        assert response.status_code == 200
        rows = response.json()
        assert [row["forwardPE"] for row in rows] == [21, 22]
        assert [row["observedAt"] for row in rows] == [
            "2026-10-20T11:00:00Z",
            "2026-10-20T12:00:00Z",
        ]
        assert rows[0]["ticker"] == "TEST.L" and rows[0]["listing"] == "LSE:TEST"
        assert rows[0]["trailingPE"] is None and rows[0]["forwardEps"] is None
        assert rows[0]["consensus"] == [
            {
                "period": "+1y",
                "periodEnd": None,
                "currency": None,
                "meanEps": 2.25,
                "lowEps": None,
                "highEps": None,
                "analystCount": None,
                "growth": None,
            }
        ]
        assert client.get("/v1/research/test/estimate-history").json() == []
        assert client.get("/v1/research/test.l/estimate-history?limit=2001").status_code == 422
