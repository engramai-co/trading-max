import json
import subprocess
from types import SimpleNamespace

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
from trading_max.synthesis.providers import pi
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


@pytest.mark.parametrize(
    "provider_cls, name",
    [
        (DeepSeekProvider, "deepseek"),
        (OpenCodeProvider, "opencode"),
        (OpenAIResponsesProvider, "openai"),
    ],
)
def test_provider_uses_pi_and_preserves_domain_contract(monkeypatch, provider_cls, name) -> None:
    captured = {}

    def invoke(request, timeout):
        captured.update(request)
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

    monkeypatch.setattr(pi, "_invoke", invoke)
    result = provider_cls(api_key="synthetic-key", model="saved-model").analyze(
        definition(), {"snapshotRunId": "synthetic-run"}
    )
    assert captured["provider"] == name
    assert captured["model"] == "saved-model"
    assert "schema" in captured["context"]["systemPrompt"]
    assert captured["json"] is True
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
    monkeypatch.setattr(pi, "_invoke", lambda *_: {"text": text, "usage": {}})
    provider = DeepSeekProvider(api_key="synthetic-key", model="saved-model")
    with pytest.raises(ProviderError, match="provider_invalid_output"):
        provider.analyze(definition(), {})


def test_bridge_uses_stdin_not_arguments_env_or_logs(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-key")
    monkeypatch.setenv("NODE_OPTIONS", "untrusted-option")

    def run(command, **kwargs):
        assert "synthetic-key" not in repr(command)
        assert "OPENAI_API_KEY" not in kwargs["env"]
        assert "NODE_OPTIONS" not in kwargs["env"]
        assert json.loads(kwargs["input"])["apiKey"] == "synthetic-key"
        assert kwargs["timeout"] == 25
        return SimpleNamespace(returncode=0, stdout='{"text":"OK"}', stderr="")

    monkeypatch.setattr(pi.subprocess, "run", run)
    assert pi._invoke({"provider": "deepseek", "apiKey": "synthetic-key"}, 20)["text"] == "OK"


@pytest.mark.parametrize(
    "output, returncode, expected",
    [
        ('{"error":"provider_auth_failed"}', 0, "provider_auth_failed"),
        ('{"error":"synthetic-key must not leak"}', 0, "provider_unavailable"),
        ("not-json-with-synthetic-key", 1, "provider_runtime_unavailable"),
    ],
)
def test_bridge_errors_never_include_child_output(monkeypatch, output, returncode, expected):
    monkeypatch.setattr(
        pi.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(
            returncode=returncode, stdout=output, stderr="synthetic-key"
        ),
    )
    with pytest.raises(ProviderError, match=expected) as error:
        pi._invoke({"provider": "deepseek"}, 1)
    assert "synthetic-key" not in str(error.value)


def test_bridge_timeout_is_safe(monkeypatch):
    def run(*args, **kwargs):
        raise subprocess.TimeoutExpired("node synthetic-key", 1, output="private context")

    monkeypatch.setattr(pi.subprocess, "run", run)
    with pytest.raises(ProviderError, match="provider_unavailable") as error:
        pi._invoke({"provider": "deepseek"}, 1)
    assert error.value.__suppress_context__


def test_installed_bridge_imports_pi_without_ambient_auth():
    with pytest.raises(ProviderError, match="provider_not_configured"):
        pi._invoke({"provider": "deepseek", "apiKey": ""}, 5)


def test_provider_factory_rejects_missing_credentials_and_unknown_provider() -> None:
    with pytest.raises(RuntimeError, match="deepseek credential"):
        create_provider(provider="deepseek", model="flash")
    with pytest.raises(ValueError, match="unsupported"):
        create_provider(provider="unknown", model="test")
