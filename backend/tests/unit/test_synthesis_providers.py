import json

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
from trading_max.synthesis.providers import model as transport
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


def test_decision_review_prompt_asks_for_readable_dates() -> None:
    instructions = _instructions(
        AnalysisDefinition(analysis_id="decision_review", title="Decision review")
    )

    assert "2025年8月21日 in Chinese" in instructions
    assert "never as ISO dates" in instructions
    assert "2025年8月21日" not in _instructions(definition())


@pytest.mark.parametrize(
    "provider_cls, name",
    [
        (DeepSeekProvider, "deepseek"),
        (OpenCodeProvider, "opencode"),
        (OpenAIResponsesProvider, "openai"),
    ],
)
def test_provider_preserves_domain_contract(monkeypatch, provider_cls, name) -> None:
    captured = {}

    async def request_completion(connection, **options):
        captured.update(connection=connection, **options)
        return {
            "text": json.dumps(response_payload()),
            "usage": {
                "input": 7,
                "cacheRead": 2,
                "cacheWrite": 1,
                "output": 4,
                "totalTokens": 14,
            },
        }

    monkeypatch.setattr(transport, "request_completion", request_completion)
    result = provider_cls(api_key="synthetic-key", model="saved-model").analyze(
        definition(), {"snapshotRunId": "synthetic-run"}
    )
    assert captured["connection"].provider == name
    assert captured["connection"].model == "saved-model"
    assert "schema" in captured["system"]
    assert captured["json_output"] is True
    if name == "openai":
        for item in [captured["schema"], *captured["schema"]["$defs"].values()]:
            assert set(item["required"]) == set(item["properties"])
            assert item["additionalProperties"] is False
    assert result.provider == name
    assert result.usage.input_tokens == 10
    assert result.usage.total_tokens == 14
    assert result.response.confidence == 0.8


@pytest.mark.parametrize("text", ["", "[]", '{"headline":{}}', "not JSON"])
def test_invalid_domain_output_is_not_persistable(monkeypatch, text) -> None:
    async def request_completion(*_args, **_kwargs):
        return {"text": text, "usage": {}}

    monkeypatch.setattr(transport, "request_completion", request_completion)
    provider = DeepSeekProvider(api_key="synthetic-key", model="saved-model")
    with pytest.raises(ProviderError, match="provider_invalid_output"):
        provider.analyze(definition(), {})


def test_provider_factory_rejects_missing_credentials_and_unknown_provider() -> None:
    with pytest.raises(ProviderError, match="provider_not_configured"):
        create_provider(provider="deepseek", model="flash")
    with pytest.raises(ValueError, match="unsupported"):
        create_provider(provider="unknown", model="test")
