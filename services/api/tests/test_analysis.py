from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.config import Settings


def _decoded_analysis() -> dict:
    return {
        "headline": {"zh": "结论", "en": "Conclusion"},
        "summary": {"zh": "摘要", "en": "Summary"},
        "evidence": [
            {
                "label": {"zh": "证据", "en": "Evidence"},
                "detail": {"zh": "细节", "en": "Detail"},
                "metric": "42",
                "source_refs": ["snapshot:test"],
            }
        ],
        "counterpoints": [{"zh": "反方", "en": "Counterpoint"}],
        "risks": [{"zh": "风险", "en": "Risk"}],
        "invalidation_conditions": [{"zh": "失效", "en": "Invalidation"}],
        "next_observations": [{"zh": "观察", "en": "Watch"}],
        "confidence": 0.8,
        "source_refs": ["snapshot:test"],
    }


def _wait_for_analysis(client: TestClient, run_id: str) -> dict:
    deadline = time.monotonic() + 5
    payload: dict = {}
    while time.monotonic() < deadline:
        payload = client.get(f"/v1/analysis/runs/{run_id}").json()
        if payload["status"] in {"succeeded", "partial", "failed", "interrupted"}:
            return payload
        time.sleep(0.02)
    raise AssertionError(f"analysis run did not finish: {payload}")


def test_fake_provider_smoke_runs_portfolio_and_ticker_analysis(
    research_root: Path,
    tmp_path: Path,
    typed_fixture,
) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    typed_fixture(research_root, store)
    app = create_app(
        Settings(
            data_root=tmp_path / "runtime",
            api_token="secret",
            llm_provider="fake",
            embedded_worker=True,
        )
    )
    with TestClient(app) as client:
        deadline = time.monotonic() + 5
        response = client.get("/v1/analysis/latest?lens=daily_cio_brief")
        while response.status_code == 404 and time.monotonic() < deadline:
            time.sleep(0.02)
            response = client.get("/v1/analysis/latest?lens=daily_cio_brief")
        assert response.status_code == 200
        overview = response.json()
        assert overview["fake"] is True
        assert overview["analysisId"] == "daily_cio_brief"
        assert overview["content"]["evidence"]
        legacy_overview = client.get("/v1/analysis/latest?page=overview")
        assert legacy_overview.status_code == 200
        assert legacy_overview.json()["artifactId"] == overview["artifactId"]

        submitted = client.post(
            "/v1/analysis/runs",
            headers={"Authorization": "Bearer secret"},
            json={"lenses": ["technical_regime"], "ticker": "BE", "force": True},
        )
        assert submitted.status_code == 202
        assert submitted.json()["lenses"] == ["technical_regime"]
        run = _wait_for_analysis(client, submitted.json()["runId"])
        assert run["status"] == "succeeded"
        technical = client.get("/v1/analysis/latest?lens=technical_regime&ticker=BE").json()
        assert technical["ticker"] == "BE"
        assert technical["analysisId"] == "technical_regime"


def test_deepseek_configuration_can_use_os_credential_store(tmp_path: Path) -> None:
    settings = Settings(
        data_root=tmp_path,
        llm_provider="deepseek",
        llm_model="deepseek-v4-flash",
    )
    settings.validate()
