from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from trading_max.synthesis import (
    AnalysisDefinition,
    DeepSeekProvider,
    OpenAIResponsesProvider,
)

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


def test_openai_responses_provider_uses_strict_schema(monkeypatch) -> None:
    captured: dict = {}

    def fake_post(_client, url: str, *, headers: dict, json: dict) -> httpx.Response:
        captured.update({"url": url, "headers": headers, "json": json})
        request = httpx.Request("POST", url)
        return httpx.Response(
            200,
            request=request,
            json={
                "output_text": json_module.dumps(_decoded_analysis()),
                "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30},
            },
        )

    json_module = json
    monkeypatch.setattr(httpx.Client, "post", fake_post)
    provider = OpenAIResponsesProvider(api_key="test-key", model="test-model")
    result = provider.analyze(
        AnalysisDefinition(analysis_id="test", title="Test"),
        {"snapshotRunId": "test"},
    )

    assert captured["url"].endswith("/responses")
    assert captured["json"]["store"] is False
    assert captured["json"]["text"]["format"]["strict"] is True
    assert result.response.headline.en == "Conclusion"
    assert result.usage.total_tokens == 30


def test_deepseek_provider_retries_and_validates_json_mode(monkeypatch) -> None:
    captured: list[dict] = []
    contents = ["", '{"headline": {}}', json.dumps(_decoded_analysis())]

    def fake_post(_client, url: str, *, headers: dict, json: dict) -> httpx.Response:
        captured.append({"url": url, "headers": headers, "json": json})
        request = httpx.Request("POST", url)
        return httpx.Response(
            200,
            request=request,
            json={
                "choices": [{"message": {"content": contents[len(captured) - 1]}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 22, "total_tokens": 33},
            },
        )

    monkeypatch.setattr(httpx.Client, "post", fake_post)
    provider = DeepSeekProvider(
        api_key="test-key",
        model="deepseek-v4-flash",
        sleep=lambda _seconds: None,
    )
    result = provider.analyze(
        AnalysisDefinition(analysis_id="test", title="Test"),
        {"snapshotRunId": "test"},
    )

    assert len(captured) == 3
    request = captured[-1]
    assert request["url"] == "https://api.deepseek.com/chat/completions"
    assert request["json"]["response_format"] == {"type": "json_object"}
    assert request["json"]["thinking"] == {"type": "disabled"}
    assert "schema" in request["json"]["messages"][0]["content"]
    assert result.response.headline.en == "Conclusion"
    assert result.usage.total_tokens == 33


def test_deepseek_configuration_can_use_os_credential_store(tmp_path: Path) -> None:
    settings = Settings(
        data_root=tmp_path,
        llm_provider="deepseek",
        llm_model="deepseek-v4-flash",
    )
    settings.validate()
