"""Research readings select verified facts from the exact security and data revision."""

import asyncio
import json
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic_ai import ModelRetry
from pydantic_ai.models.test import TestModel
from trading_max.infrastructure import SqliteDatabase
from trading_max.research.news import NEWS_KEY

from services.api.tests.assistant_fixture import AS_OF, DATES, publication
from services.api.tests.test_assistant_readings import job
from services.api.tests.test_assistant_runtime import answer_after_tool, events, make_app, user_turn
from services.api.trading_max_api.agent import insights, tools
from services.api.trading_max_api.agent import research_tools as research
from services.api.trading_max_api.agent.background import BriefWriter
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.agent.readings import ReadingService
from services.api.trading_max_api.agent.research_roles import (
    MomentContext,
    PriceContext,
    SecurityContext,
)
from services.api.trading_max_api.agent.roles import RoleTools, role_registry
from services.api.trading_max_api.agent.runtime import build_assistant_agent
from services.api.trading_max_api.agent.service import AssistantService, BoundModel
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.watchlist import WatchlistStore

STORY = {
    "id": "article",
    "title": "Issuer publishes outlook",
    "publisher": "Example Wire",
    "date": DATES[2],
    "url": "https://example.invalid/outlook",
}


def analyst(eps=1.25, stamp=AS_OF):
    return {
        "rows": [
            {
                "ticker": "TEST",
                "analyst": {
                    "asOf": stamp,
                    "earningsEvents": [
                        {
                            "date": DATES[1],
                            "id": "report",
                            "status": "reported",
                            "currency": "USD",
                            "actualEps": 1.2,
                            "estimatedEps": 1.15,
                            "surprisePct": 1.2 / 1.15 - 1,
                        },
                    ],
                    "earningsEstimate": [
                        {"period": "0q", "endDate": "2026-03-31", "avg": eps, "currency": "USD"}
                    ],
                },
            }
        ]
    }


def setup(tmp_path):
    store = ArtifactStore(tmp_path)

    def publish(eps=1.25, stamp=AS_OF, *, story=STORY):
        return publication(
            store,
            extra_artifacts={
                NEWS_KEY: {"securities": {"TEST": {"items": [story]}}},
                tools.ANALYST: analyst(eps, stamp),
                insights.TRADE_MARKERS: {
                    "rows": [
                        {
                            "date": DATES[0],
                            "ticker": "TEST",
                            "kind": "B",
                            "accounts": ["isa"],
                            "buyOrders": 1,
                            "sellOrders": 0,
                            "buyQuantity": 1,
                            "sellQuantity": 0,
                            "buyAveragePrice": None,
                            "sellAveragePrice": None,
                            "fills": [
                                {
                                    "at": DATES[0] + "T15:00:00Z",
                                    "account": "isa",
                                    "side": "buy",
                                    "quantity": 1,
                                    "amount": 32,
                                    "currency": "USD",
                                    "broker_ticker": "TEST_US_EQ",
                                }
                            ],
                        },
                        {
                            "date": DATES[1],
                            "ticker": "TEST.L",
                            "kind": "S",
                            "accounts": ["isa"],
                            "buyOrders": 0,
                            "sellOrders": 1,
                            "buyQuantity": 0,
                            "sellQuantity": 1,
                            "buyAveragePrice": None,
                            "sellAveragePrice": None,
                            "fills": [
                                {
                                    "at": DATES[1] + "T12:00:00Z",
                                    "account": "isa",
                                    "side": "sell",
                                    "quantity": 1,
                                    "amount": 123,
                                    "currency": "GBP",
                                    "broker_ticker": "TESTl_EQ",
                                }
                            ],
                        },
                    ]
                },
            },
        )

    publish()
    ledger = ResearchLedger(store, WatchlistStore(tmp_path))
    factory = AssistantDepsFactory(
        store,
        bind_price_series=ledger.bind_price_series,
        observed_prices=ledger.observed_prices,
        listing_markers=ledger.listing_trade_markers,
    )
    bindings = []

    async def bind():
        bindings.append(1)
        return BoundModel(TestModel(custom_output_args={"indices": [0, 1]}), {})

    async def ready():
        return {"ready": True}

    service = ReadingService(
        AssistantService(
            None, None, bind, factory.for_run, check_ready=ready, bind_background_model=bind
        ),
        SqliteDatabase(tmp_path / "test.db"),
    )
    return publish, ledger, factory, service, bindings


def test_moments_require_selected_rule_candidate_and_exact_chart(tmp_path):
    _, ledger, factory, service, bindings = setup(tmp_path)
    deps = factory.for_run()
    series = deps.price_series("TEST", deps.manifest, limit=2000)
    args = {
        "ticker": "TEST",
        "start": DATES[0],
        "end": DATES[-1],
        "published_series_id": series.published_series_id,
    }
    result = insights.moments_data(deps, insights.MomentsArgs(scope="broker_total", **args))
    assert len(result["data"]["items"]) <= 3 and not bindings
    assert any(
        r["date"] == DATES[2] and r["events"][0]["kind"] == "news" for r in result["data"]["items"]
    )
    for day in (DATES[2], DATES[3]):
        selection = insights.MomentsArgs(scope="broker_total", date=day, **args)
        selected = insights.moments_data(deps, selection)
        assert selected["data"]["items"] == [r for r in result["data"]["items"] if r["date"] == day]
        assert selected["evidence_id"] != result["evidence_id"]
    role = role_registry()["key-moment"]

    async def run(day):
        return [e async for e in service.events(role, MomentContext(**args, date=day), deps)]

    assert asyncio.run(run(DATES[3]))[-1].type == "empty" and not bindings
    reading = asyncio.run(run(DATES[2]))[-1].reading
    assert reading.snapshot_id == deps.snapshot_id and len(bindings) == 1
    assert reading.lines[0].evidence.source == "market" and "+6.25%" in reading.lines[0].en
    assert (
        reading.lines[1].evidence.publisher == STORY["publisher"]
        and reading.lines[1].evidence.arguments["url"] == STORY["url"]
    )
    assert asyncio.run(run(DATES[2]))[-1].reading == reading and len(bindings) == 1
    # A provider chart has a separate identity, tied to the observed bars and publication.
    external = ledger.observe_prices(
        series.model_copy(update={"published_series_id": None, "ticker": "TEST"}), deps.snapshot_id
    )
    args.update(published_series_id=external.observed_series_id)
    assert (
        insights.moments_data(deps, insights.MomentsArgs(scope="broker_total", **args))["data"][
            "basis"
        ]
        == "observed_daily_closes"
    )
    assert ledger.observed_prices("other", "TEST", external.observed_series_id) is None
    assert (
        insights.moments_data(
            deps,
            insights.MomentsArgs(
                scope="broker_total", **(args | {"published_series_id": "0" * 20})
            ),
        )["data"]
        is None
    )


def test_timed_news_is_attached_to_the_exchange_day_and_opens_the_original_headline(tmp_path):
    publish, _, factory, _, _ = setup(tmp_path)
    stamp = "2026-01-31T01:00:00+00:00"  # Friday evening in New York.
    publish(story={**STORY, "date": "2026-01-31", "instant": stamp})
    deps = factory.for_run()
    series = deps.price_series("TEST", deps.manifest, limit=2000)
    selection = MomentContext(
        ticker="TEST",
        published_series_id=series.published_series_id,
        start=DATES[0],
        end=DATES[-1],
        date="2026-01-30",
    )
    role = role_registry()["key-moment"]
    reader = role.reader(deps, selection)
    facts = role.facts(reader, selection)
    news = next(fact for fact in facts if fact.evidence.source == "publisher")
    assert news.en.startswith("2026-01-30") and news.evidence.arguments["url"] == STORY["url"]
    assert (
        reader.read(
            research.research_headline,
            {"reference": STORY["id"]},
        )["data"]["date"]
        == stamp
    )


def test_position_baseline_is_the_last_matching_trade_session_not_an_execution_price(tmp_path):
    _, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run()
    series = deps.price_series("TEST", deps.manifest, limit=2000)
    role = role_registry()["your-position"]
    selection = PriceContext(ticker="TEST", published_series_id=series.published_series_id)
    reader = role.reader(deps, selection)
    reading = reader.read(research.research_position, {})["data"]
    assert (reading["trade_date"], reading["start"], reading["side"]) == (DATES[0], DATES[0], "buy")
    assert reading["change"] == 30 / 32 - 1
    assert all(line.evidence.evidence_id for line in role.facts(reader, selection))


def test_earnings_publications_follow_material_changes_and_exclude_retained_results(tmp_path):
    publish, _, factory, service, bindings = setup(tmp_path)
    deps = factory.for_run()
    when = deps.manifest.created_at
    role = role_registry()["earnings-brief"]
    context = SecurityContext(ticker="TEST")

    def target(deps, trigger="research"):
        record = job(when, deps.snapshot_id, trigger).model_copy(update={"scope": "research"})
        return record, role.publication_targets(record, RoleTools.pinned(deps, role.allowed_tools))

    record, targets = target(deps)
    assert len(targets) == 1 and not target(deps, "live")[1]
    writer = BriefWriter(service, lambda: True, lambda: [], lambda: when)
    asyncio.run(writer.write(record, role, targets[0]))

    async def cached(deps):
        return [
            e
            async for e in service.events(
                role, context, deps, cached_only=True, latest=True, match_data_version=True
            )
        ]

    assert asyncio.run(cached(deps))[-1].reading.snapshot_id == deps.snapshot_id
    publish(stamp="2026-02-04T00:00:00Z")
    same = factory.for_run()
    assert target(same)[1][0].slot == targets[0].slot
    asyncio.run(writer.write(target(same)[0], role, target(same)[1][0]))
    assert len(bindings) == 1
    publish(eps=1.3)
    changed = factory.for_run()
    assert target(changed)[1][0].slot != targets[0].slot
    assert asyncio.run(cached(changed))[-1].type == "empty"
    asyncio.run(writer.write(target(changed)[0], role, target(changed)[1][0]))
    assert (
        len(bindings) == 2
        and asyncio.run(cached(changed))[-1].reading.snapshot_id == changed.snapshot_id
    )


def test_index_uses_observed_levels_and_only_its_own_dated_news(tmp_path):
    _, _, factory, _, _ = setup(tmp_path)
    key = "f" * 20
    history = SimpleNamespace(
        index=SimpleNamespace(id="example", symbol="TEST", kind="index", calendar="XNYS"),
        range="3M",
        state="available",
        display_interval="1d",
        currency="USD",
        points=[
            SimpleNamespace(at=datetime.fromisoformat(d), value=v)
            for d, v in zip(DATES, [20, 21, 22, 23, 26], strict=True)
        ],
    )
    deps = replace(
        factory.for_run(),
        index_history=lambda index, identity: (
            history if (index, identity) == ("example", key) else None
        ),
    )
    args = insights.MomentsArgs(
        scope="broker_total",
        index_id="example",
        ticker="TEST",
        published_series_id=key,
        start=DATES[0],
        end=DATES[-1],
    )
    data = insights.moments_data(deps, args)["data"]
    assert [r["date"] for r in data["items"]] == [STORY["date"]]
    ctx = PriceContext(ticker="TEST", index_id="example", published_series_id=key)
    role = role_registry()["your-position"]
    facts = role.facts(role.reader(deps, ctx), ctx)
    assert any("index points" in f.en for f in facts) and all(
        f.evidence.arguments["index"] == "example" for f in facts
    )
    assert insights.moments_data(deps, args.model_copy(update={"ticker": "OTHER"}))["data"] is None

    history.index.kind = "etf-price"
    history.points.insert(0, SimpleNamespace(at=datetime.fromisoformat("2026-01-27"), value=10))
    args = args.model_copy(update={"start": "2026-01-27"})
    etf = insights.moments_data(deps, args)
    assert any(
        event["kind"] == "own_trade" and event["reference"] == "B"
        for row in etf["data"]["items"]
        for event in row["events"]
    )
    reading = role.reader(deps, ctx).read(research.research_position, {})["data"]
    assert (reading["trade_date"], reading["side"], reading["change"]) == (
        DATES[0],
        "buy",
        26 / 20 - 1,
    )


def test_follow_up_tools_only_read_the_selected_chart_security_and_event(tmp_path):
    _, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run()
    series = deps.price_series("TEST", deps.manifest, limit=2000)
    price = PriceContext(ticker="TEST", published_series_id=series.published_series_id)
    moment = MomentContext(**price.model_dump(), start=DATES[0], end=DATES[-1], date=DATES[2])
    roles = role_registry()
    reader = roles["key-moment"].reader(deps, moment)
    result = reader.read(insights.price_key_moments, {})
    assert [item["date"] for item in result["data"]["items"]] == [moment.date]
    selection = {**moment.model_dump(), "scope": "broker_total", "snapshotId": deps.snapshot_id}
    assert result["bound_arguments"] == selection
    assert (
        reader.read(research.research_headline, {"reference": "different article"})["data"] is None
    )
    assert (
        reader.read(research.research_headline, {"reference": STORY["id"]})["bound_arguments"]
        == selection
    )
    for field, value in {
        "scope": "isa",
        "ticker": "OTHER",
        "start": DATES[1],
        "end": DATES[2],
        "date": DATES[1],
        "published_series_id": "0" * 20,
        "index_id": "other",
    }.items():
        with pytest.raises(ModelRetry):
            reader.read(insights.price_key_moments, {field: value})
    position = roles["your-position"].reader(deps, price)
    with pytest.raises(ModelRetry):
        position.read(research.research_position, {"ticker": "OTHER"})
    assert position.read(research.research_position, {})["data"]["event"]["kind"] == "earnings"
    earnings = roles["earnings-brief"].reader(deps, SecurityContext(ticker="TEST"))
    with pytest.raises(ModelRetry):
        earnings.read(research.research_earnings, {"ticker": "OTHER"})
    with pytest.raises(ValueError, match="outside"):
        earnings.read(research.earnings_universe, {})


@pytest.mark.parametrize("extra", [{}, {"ticker": "OTHER"}, {"date": DATES[1]}])
def test_chat_cannot_retarget_a_research_moment(tmp_path, extra):
    _, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run()
    series = deps.price_series("TEST", deps.manifest, limit=2000)
    selected = MomentContext(
        ticker="TEST",
        start=DATES[0],
        end=DATES[-1],
        date=DATES[2],
        published_series_id=series.published_series_id,
    )
    stream, seen = answer_after_tool(
        "research_headline", json.dumps({"reference": STORY["id"], **extra})
    )

    async def reply(messages, info):
        free = {
            tool.name: set(tool.parameters_json_schema["properties"])
            for tool in info.function_tools
        }
        assert free == {"price_key_moments": set(), "research_headline": {"reference"}}
        async for chunk in stream(messages, info):
            yield chunk

    app, service = make_app(tmp_path, reply)
    service.agent = build_assistant_agent([tools.build_assistant_toolset()])
    service.deps_for_run = lambda page, tz: deps
    body = user_turn("moment-binding", "question", "Which headline was reported?")
    body["context"] = {
        "page": "research",
        "role": "key-moment",
        "lens": "technical",
        "scope": "broker_total",
        "ticker": "TEST",
        "snapshotId": deps.snapshot_id,
        "object": selected.model_dump(),
    }
    response = TestClient(app).post("/v1/assistant/chat?format=references", json=body)
    assert seen and response.status_code == 200
    outputs = [e["output"] for e in events(response.text) if e["type"] == "tool-output-available"]
    if extra:
        assert not outputs
    else:
        assert outputs[0]["data"]["url"] == STORY["url"]
        assert outputs[0]["bound_arguments"] == {
            **selected.model_dump(),
            "scope": "broker_total",
            "snapshotId": deps.snapshot_id,
        }
