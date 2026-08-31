import json

import httpx
import pytest
from trading_max.synthesis import (
    AnalysisDefinition,
    DeepSeekProvider,
    FakeProvider,
    OpenAIResponsesProvider,
    OpenCodeProvider,
    ProviderError,
    SynthesisResponse,
    create_provider,
)
from trading_max.synthesis.providers.openai import _instructions


def response_payload() -> dict:
    return {
        "schemaVersion": 1,
        "headline": {"zh": "结论", "en": "Conclusion"},
        "summary": {"zh": "摘要", "en": "Summary"},
        "evidence": [],
        "counterpoints": [],
        "risks": [],
        "invalidationConditions": [],
        "nextObservations": [],
        "taxonomyAssignments": [],
        "confidence": 0.8,
        "sourceRefs": ["snapshot:test"],
    }


def definition() -> AnalysisDefinition:
    return AnalysisDefinition(
        analysis_id="technical_regime",
        title="Technical regime",
    )


def test_fake_provider_returns_valid_bilingual_schema() -> None:
    result = FakeProvider().analyze(
        definition(),
        {"snapshotRunId": "run-1", "ticker": "BE", "dashboard": {"totalValueGbp": 100}},
    )

    assert result.fake is True
    assert result.response.headline.zh
    assert result.response.headline.en
    assert SynthesisResponse.model_validate(result.response.model_dump())


def test_prompt_requires_change_first_non_repetitive_analysis() -> None:
    instructions = _instructions(definition())

    assert "what changed" in instructions
    assert "Mention a metric once" in instructions
    assert "must not restate the headline" in instructions


def test_openai_responses_provider_uses_strict_schema_and_redacts_nothing_into_errors() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert request.url.path == "/v1/responses"
        assert request.headers["authorization"] == "Bearer test-secret"
        body = json.loads(request.content)
        assert body["store"] is False
        assert body["text"]["format"]["strict"] is True
        return httpx.Response(
            200,
            json={"output_text": json.dumps(response_payload()), "usage": {"total_tokens": 12}},
        )

    provider = OpenAIResponsesProvider(
        api_key="test-secret",
        model="test-model",
        base_url="https://api.example.test/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = provider.analyze(definition(), {"snapshotRunId": "run-1"})

    assert result.provider == "openai"
    assert result.usage.total_tokens == 12
    assert len(seen) == 1


def test_deepseek_provider_accepts_openai_compatible_json_object() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/chat/completions"
        body = json.loads(request.content)
        assert body["response_format"] == {"type": "json_object"}
        assert body["thinking"] == {"type": "disabled"}
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": json.dumps(response_payload())}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 8, "total_tokens": 12},
            },
        )

    provider = DeepSeekProvider(
        api_key="test-secret",
        model="deepseek-v4-flash",
        base_url="https://api.example.test",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = provider.analyze(definition(), {"snapshotRunId": "run-1"})

    assert result.provider == "deepseek"
    assert result.usage.input_tokens == 4
    assert result.response.confidence == 0.8


def test_opencode_provider_uses_go_route_and_preserves_provider_identity() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/zen/go/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-secret"
        body = json.loads(request.content)
        assert body["model"] == "deepseek-v4-flash"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(response_payload())}}]},
        )

    provider = OpenCodeProvider(
        api_key="test-secret",
        model="deepseek-v4-flash",
        base_url="https://api.example.test/zen/go/v1",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = provider.analyze(definition(), {"snapshotRunId": "run-1"})

    assert result.provider == "opencode"
    assert result.model == "deepseek-v4-flash"


def test_network_provider_exposes_stable_auth_error_without_response_body() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "secret must not leak"}})

    provider = OpenCodeProvider(
        api_key="test-secret",
        model="deepseek-v4-flash",
        base_url="https://api.example.test/v1",
        max_attempts=1,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(ProviderError, match="provider_auth_failed") as error:
        provider.analyze(definition(), {"snapshotRunId": "run-1"})
    assert "secret must not leak" not in str(error.value)


def test_provider_factory_rejects_missing_credentials_and_unknown_provider() -> None:
    with pytest.raises(RuntimeError, match="DeepSeek credential"):
        create_provider(provider="deepseek", model="flash")
    with pytest.raises(ValueError, match="unsupported"):
        create_provider(provider="unknown", model="test")
