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


def test_forward_pe_lens_reads_the_exact_listing_at_publication_and_refreshes_after_append(
    tmp_path,
):
    app = create_app(Settings(data_root=tmp_path))
    store = app.state.store
    ref = store.immutable_artifacts.put_json(
        key="research/fundamentals.json",
        payload={
            "rows": [
                {
                    "ticker": "TEST",
                    "currency": "USD",
                    "metrics": {"quoteType": "EQUITY", "fullExchangeName": "NASDAQ"},
                },
                {
                    "ticker": "^INDEX",
                    "currency": "USD",
                    "metrics": {"quoteType": "INDEX", "fullExchangeName": "NASDAQ"},
                },
            ],
        },
    ).ref
    first = store.immutable_snapshots.publish(
        scope="research", source="synthetic", artifacts=[ref]
    ).manifest
    history = app.state.estimate_history

    def obs(ticker="TEST", listing="US:TEST", *, offset=0, multiple=17):
        return EstimateObservation(
            ticker=ticker,
            listing=listing,
            currency="USD",
            observed_at=first.created_at + timedelta(seconds=offset),
            forwardPE=multiple,
        )

    history.append(
        [obs(listing="LSE:TEST", offset=-1), obs(offset=86_400), obs("^INDEX", "US:^INDEX")]
    )

    with TestClient(app) as client:

        def lens(ticker="TEST", view="valuation"):
            response = client.get(f"/v1/research/{ticker}/lens/{view}")
            assert response.status_code == 200
            return response.json()

        before = lens()
        assert before["forwardPeHistory"] is None

        # The worker may append after the lens was first read for the same run.
        history.append([obs(multiple=19)])
        after = lens()
        assert after["dataRevision"] != before["dataRevision"]
        assert [(p["pe"], p["source"]) for p in after["forwardPeHistory"]["points"]] == [
            (19, "yahoo-forward-pe")
        ]
        assert lens(view="overview")["forwardPeHistory"] is None
        assert lens("^INDEX")["forwardPeHistory"] is None
        assert lens("TEST.L")["forwardPeHistory"] is None

        store.immutable_snapshots.publish(scope="live", source="synthetic", artifacts=[ref])
        assert lens()["dataRevision"] == after["dataRevision"]
