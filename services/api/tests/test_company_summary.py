"""A Chinese company summary restates only the company's own English description."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from pydantic_ai import ModelRetry
from pydantic_ai.models.test import TestModel
from trading_max.infrastructure import SqliteDatabase

from services.api.tests.assistant_fixture import publication
from services.api.tests.test_assistant_runtime import answer_after_tool, events, make_app, user_turn
from services.api.trading_max_api.agent import research_tools as research
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.agent.readings import ReadingService
from services.api.trading_max_api.agent.research_roles import SecurityContext, restates
from services.api.trading_max_api.agent.roles import ReadingEvidence, ReadingLine, role_registry
from services.api.trading_max_api.agent.runtime import build_assistant_agent
from services.api.trading_max_api.agent.service import AssistantService, BoundModel
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.watchlist import WatchlistStore

SENTENCES = [
    "Synthetic Issuer Inc. designs and sells synthetic widgets in 12 markets.",
    "The company also offers Widget Cloud, a subscription service.",
    "It was founded in 1999 and is headquartered in Exampleton.",
]
DESCRIPTION = " ".join(SENTENCES)
RESTATED = [
    {"index": 0, "zh": "Synthetic Issuer Inc. 在 12 个市场设计并销售合成小部件。"},
    {"index": 1, "zh": "公司还提供订阅服务 Widget Cloud。"},
]


def fundamentals(summary=DESCRIPTION, **metrics):
    return {
        "rows": [
            {
                "ticker": "TEST",
                "currency": "USD",
                "name": "Synthetic issuer",
                "metrics": {
                    "fullExchangeName": "NYSE",
                    "exchangeTimezoneName": "America/New_York",
                    "quoteType": "EQUITY",
                    "longBusinessSummary": summary,
                    **metrics,
                },
            }
        ]
    }


def workspace(tmp_path, *outputs, ready=True):
    """A synthetic publication and a reading service whose model returns each output in turn."""
    store = ArtifactStore(tmp_path)
    ledger = ResearchLedger(store, WatchlistStore(tmp_path))
    factory = AssistantDepsFactory(store, bind_price_series=ledger.bind_price_series)
    calls = []

    async def bind():
        calls.append(1)
        return BoundModel(TestModel(custom_output_args=outputs[len(calls) - 1]), {})

    async def status():
        return {"ready": True} if ready else {"ready": False, "code": "assistant_disabled"}

    service = ReadingService(
        AssistantService(
            None, None, bind, factory.for_run, check_ready=status, bind_background_model=bind
        ),
        SqliteDatabase(tmp_path / "test.db"),
    )

    def publish(summary=DESCRIPTION, **metrics):
        publication(store, extra_artifacts={tools.FUNDAMENTALS: fundamentals(summary, **metrics)})
        return factory.for_run()

    return publish, service, calls


def read(service, deps):
    role = role_registry()["company-summary"]

    async def run():
        return [e async for e in service.events(role, SecurityContext(ticker="TEST"), deps)]

    return asyncio.run(run())


def test_profile_tool_numbers_the_selected_company_description(tmp_path):
    publish, _, _ = workspace(tmp_path)
    deps = publish()
    role = role_registry()["company-summary"]
    reader = role.reader(deps, SecurityContext(ticker="TEST"))
    result = reader.read(research.company_profile, {})
    assert result["status"] == "ok" and len(result["sources"]) == 1
    assert result["data"]["sentences"] == SENTENCES and result["data"]["language"] == "en"
    assert result["bound_arguments"] == {"ticker": "TEST", "snapshotId": deps.snapshot_id}
    with pytest.raises(ModelRetry):
        reader.read(research.company_profile, {"ticker": "OTHER"})
    facts = role.facts(reader, SecurityContext(ticker="TEST"))
    assert [fact.en for fact in facts] == SENTENCES
    assert {(fact.evidence.source, fact.evidence.tool) for fact in facts} == {
        ("disclosure", "company_profile")
    }


def test_summary_restates_chosen_sentences_once_per_description(tmp_path):
    publish, service, calls = workspace(tmp_path, {"items": RESTATED}, {"items": RESTATED})
    deps = publish()
    reading = read(service, deps)[-1].reading
    assert [line.zh for line in reading.lines] == [item["zh"] for item in RESTATED]
    # The English line stays the company's own sentence.
    assert [line.en for line in reading.lines] == SENTENCES[:2]
    assert reading.lines[1].evidence.source == "disclosure"
    assert reading.lines[1].evidence.arguments == {
        "ticker": "TEST",
        "lens": "overview",
        "sentence": "1",
        "snapshotId": deps.snapshot_id,
    }
    # A later publication that repeats the description reuses the summary.
    later = publish()
    assert later.snapshot_id != deps.snapshot_id
    assert read(service, later)[-1].reading == reading and len(calls) == 1
    # A changed description is summarised again.
    changed = publish(" ".join([SENTENCES[0], "It also sells Widget Cloud subscriptions."]))
    assert read(service, changed)[-1].reading.lines[0].zh == RESTATED[0]["zh"]
    assert len(calls) == 2


@pytest.mark.parametrize(
    "items",
    [
        [{"index": 0, "zh": "公司在 13 个市场销售合成小部件。"}, RESTATED[1]],
        [RESTATED[0], {"index": 1, "zh": "公司还提供 AI 订阅服务 Widget Cloud。"}],
        [RESTATED[0], {"index": 1, "zh": "Widget Cloud is a subscription service."}],
        [RESTATED[0], RESTATED[0]],
        [RESTATED[0], {"index": 3, "zh": "公司成立于 1999 年。"}],
    ],
    ids=["added-figure", "added-name", "not-chinese", "repeated-sentence", "unknown-sentence"],
)
def test_invalid_restatement_is_not_shown_or_saved(tmp_path, items):
    publish, service, calls = workspace(tmp_path, {"items": items}, {"items": RESTATED})
    deps = publish()
    assert read(service, deps)[-1].code == "provider_invalid_output"
    assert read(service, deps)[-1].reading.lines[1].zh == RESTATED[1]["zh"]
    assert len(calls) == 2


@pytest.mark.parametrize(
    ("zh", "sentence", "valid"),
    [
        ("公司还提供订阅服务 Widget Cloud。", 1, True),
        ("公司成立于 1999 年，总部位于 Exampleton。", 2, True),
        ("公司成立于 2001 年。", 2, False),
        ("公司还提供 AI 订阅服务。", 1, False),
        ("公司还提供订阅服务，详见 https://example.invalid", 1, False),
        ("公司还提供**订阅服务**。", 1, False),
        ("公司还提供订阅服务。\n公司很好。", 1, False),
        ("公司" * 101, 1, False),
        ("", 1, False),
    ],
)
def test_restatement_keeps_to_its_own_sentence(zh, sentence, valid):
    evidence = ReadingEvidence(source="disclosure", tool="company_profile", evidence_id="ev_test")
    assert restates(zh, ReadingLine(zh="", en=SENTENCES[sentence], evidence=evidence)) is valid


def test_one_sentence_description_has_one_restatement(tmp_path):
    only = {"index": 0, "zh": "Synthetic Issuer Inc. 设计合成小部件。"}
    publish, service, calls = workspace(tmp_path, {"items": [only]})
    deps = publish("Synthetic Issuer Inc. designs synthetic widgets.")
    lines = read(service, deps)[-1].reading.lines
    assert [line.zh for line in lines] == [only["zh"]] and len(calls) == 1


@pytest.mark.parametrize(
    "metrics",
    [{"summary": ""}, {"summary": "合成公司设计并销售小部件。"}, {"quoteType": "ETF"}],
    ids=["missing", "not-english", "fund"],
)
def test_no_english_company_description_writes_nothing(tmp_path, metrics):
    publish, service, calls = workspace(tmp_path)
    deps = publish(**metrics)
    assert read(service, deps)[-1].type == "empty" and not calls


def test_assistant_off_writes_no_summary(tmp_path):
    publish, service, calls = workspace(tmp_path, ready=False)
    events_ = read(service, publish())
    assert [(e.type, e.code) for e in events_] == [("error", "assistant_disabled")] and not calls


@pytest.mark.parametrize(
    ("lens", "ticker", "valid"),
    [("overview", "TEST", True), ("technical", "TEST", False), ("overview", "OTHER", False)],
)
def test_follow_up_reads_only_the_selected_company_description(tmp_path, lens, ticker, valid):
    publish, _, _ = workspace(tmp_path)
    deps = publish()
    stream, seen = answer_after_tool("company_profile", json.dumps({}))

    async def reply(messages, info):
        free = {
            tool.name: set(tool.parameters_json_schema["properties"])
            for tool in info.function_tools
        }
        assert free == {"company_profile": set()}
        async for chunk in stream(messages, info):
            yield chunk

    app, service = make_app(tmp_path, reply)
    service.agent = build_assistant_agent([tools.build_assistant_toolset()])
    service.deps_for_run = lambda page, tz: deps
    body = user_turn("profile-binding", "question", "What does the company sell?")
    body["context"] = {
        "page": "research",
        "role": "company-summary",
        "lens": lens,
        "scope": "broker_total",
        "ticker": ticker,
        "snapshotId": deps.snapshot_id,
        "object": {"ticker": "TEST"},
    }
    response = TestClient(app).post("/v1/assistant/chat?format=references", json=body)
    if not valid:
        assert response.status_code == 422 and not seen
        return
    assert seen and response.status_code == 200
    outputs = [e["output"] for e in events(response.text) if e["type"] == "tool-output-available"]
    assert outputs[0]["data"]["sentences"] == SENTENCES
    assert outputs[0]["bound_arguments"] == {"ticker": "TEST", "snapshotId": deps.snapshot_id}
