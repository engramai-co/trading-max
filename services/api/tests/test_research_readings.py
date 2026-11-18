"""Research readings select verified facts from the exact security and data revision."""

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime
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
        listing_markers=ledger.trade_markers,
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
        date="2026-02-02",
    )
    role = role_registry()["key-moment"]
    reader = role.reader(deps, selection)
    facts = role.facts(reader, selection)
    news = next(fact for fact in facts if fact.evidence.source == "publisher")
    assert news.en.startswith(stamp) and news.evidence.arguments["url"] == STORY["url"]
    assert (
        news.evidence.arguments["date"] == "2026-02-02"
        and news.evidence.arguments["role"] == "lead"
    )
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


def test_price_basis_and_matched_session_period(tmp_path):
    import pandas as pd
    from trading_max.research.technical import _relative_stats

    days = pd.bdate_range("2026-01-01", periods=66)
    prices = pd.Series(range(100, 166), index=days)
    stats = _relative_stats(prices, prices.iloc[:-1], 63)
    assert (stats["start"], stats["end"]) == (
        days[1].date().isoformat(),
        days[-2].date().isoformat(),
    )
    _, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run()
    chart = deps.price_series("TEST", deps.manifest, limit=2000)
    selection = PriceContext(ticker="TEST", published_series_id=chart.published_series_id)
    role = role_registry()["your-position"]
    assert any(
        "split- and dividend-adjusted" in fact.en
        for fact in role.facts(role.reader(deps, selection), selection)
    )


def test_writer_reads_newly_requested_equity_without_prior_news(tmp_path):
    store = ArtifactStore(tmp_path)
    batch = analyst()
    batch["rows"][0]["ticker"] = "NEW"
    publication(
        store, extra_artifacts={tools.ANALYST: batch, NEWS_KEY: {"securities": {"OLD": {}}}}
    )
    deps = AssistantDepsFactory(store).for_run()
    record = job(deps.manifest.created_at, deps.snapshot_id, "on_demand").model_copy(
        update={"scope": "research", "tickers": ["NEW"]}
    )
    role = role_registry()["earnings-brief"]
    targets = role.publication_targets(record, RoleTools.pinned(deps, role.allowed_tools))
    assert [target.context.ticker for target in targets] == ["NEW"]


def test_moment_reports_subsequent_sessions_outside_selected_window(tmp_path):
    _, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run()
    series = deps.price_series("TEST", deps.manifest, limit=2000)
    args = insights.MomentsArgs(
        ticker="TEST",
        scope="broker_total",
        date=DATES[2],
        start=DATES[0],
        end=DATES[2],
        published_series_id=series.published_series_id,
    )
    data = insights.moments_data(deps, args)["data"]
    trajectory = data["following"]
    assert [(r["date"], r["sessions"]) for r in trajectory] == [(DATES[3], 1), (DATES[-1], 2)]
    assert [r["return_fraction"] for r in trajectory] == pytest.approx([33 / 34 - 1, 30 / 34 - 1])


@pytest.mark.parametrize(
    ("zone", "venue"), [("America/New_York", "NYQ"), ("America/New_York", None), (None, None)]
)
def test_published_technical_zone_and_venue_determine_timed_headline_coverage(
    tmp_path, zone, venue
):
    _, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run()
    batch = deps.store.read_json(deps.snapshot_id, tools.TECHNICAL)
    batch["rows"][0].update(timezone=zone, exchange=venue)
    story = {**STORY, "date": "2026-01-31", "instant": "2026-01-31T01:00:00Z"}
    publication(
        factory.store,
        extra_artifacts={
            tools.TECHNICAL: batch,
            tools.FUNDAMENTALS: {"rows": []},
            NEWS_KEY: {"securities": {"TEST": {"items": [story]}}},
        },
    )
    deps = factory.for_run()
    series = deps.price_series("TEST", deps.manifest, limit=2000)
    args = insights.MomentsArgs(
        ticker="TEST",
        scope="broker_total",
        start=DATES[0],
        end=DATES[-1],
        published_series_id=series.published_series_id,
    )
    result = insights.moments_data(deps, args)
    assert series.timezone == zone
    if venue:
        assert any(
            e["kind"] == "news" and e["date"] == DATES[3]
            for m in result["data"]["items"]
            for e in m["events"]
        )
    else:
        assert "listing_calendar_unavailable" in result["quality"]["issues"]


def test_catalogue_index_candidate_uses_scheduled_news_publication(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from unittest.mock import Mock

    from trading_max.application import event_stages
    from trading_max.application.event_stages import SecurityNewsStage
    from trading_max.application.stages import StageContext
    from trading_max.reference.indices import INDEX_REGISTRY
    from trading_max.research import news

    spec = INDEX_REGISTRY["sp-500"]
    store = ArtifactStore(tmp_path)
    stage = SecurityNewsStage(
        store.immutable_artifacts,
        store.immutable_snapshots,
        SimpleNamespace(prices=SimpleNamespace(yahoo_request=nullcontext)),
    )
    monkeypatch.setattr(
        news,
        "verified_news",
        lambda proxy: (
            [
                {
                    "title": "Index bulletin",
                    "pubDate": DATES[2],
                    "publisher": "Test wire",
                    "link": STORY["url"],
                }
            ]
            if proxy.ticker == spec.symbol
            else []
        ),
    )
    monkeypatch.setattr(
        event_stages, "datetime", Mock(now=lambda tz: datetime(2026, 2, 3, 17, tzinfo=UTC))
    )
    result = stage.run(
        StageContext(job_id="synthetic", scope="research", trigger="research", tickers=("OTHER",))
    )
    stories = store.immutable_artifacts.get_json(result.artifacts[0].artifact_id).payload
    assert spec.symbol in stories["securities"]
    publication(
        store,
        extra_artifacts={
            ref.key: store.immutable_artifacts.get_json(ref.artifact_id).payload
            for ref in result.artifacts
        },
    )
    history = SimpleNamespace(
        index=spec,
        range="3M",
        state="available",
        display_interval="1d",
        points=[
            SimpleNamespace(at=datetime.fromisoformat(d), value=v)
            for d, v in zip(DATES, [10, 10, 12, 12, 12], strict=True)
        ],
    )
    deps = replace(AssistantDepsFactory(store).for_run(), index_history=lambda *_: history)
    args = insights.MomentsArgs(
        ticker=spec.symbol,
        index_id=spec.id,
        published_series_id="f" * 20,
        scope="broker_total",
        start=DATES[0],
        end=DATES[-1],
    )
    reading = insights.moments_data(deps, args)
    assert [m["date"] for m in reading["data"]["items"]] == [DATES[2]]
    assert "security_news_unavailable" not in reading["quality"]["issues"]


def test_published_consensus_delta_keeps_both_dates_and_fiscal_identity(tmp_path):
    from trading_max.research.earnings_changes import bind_estimate_changes

    previous = analyst(1.25, "2026-01-15T10:00:00Z")
    current = analyst(1.50, "2026-01-25T10:00:00Z")
    current["rows"][0]["analyst"]["earningsEstimate"].append(
        {"period": "+1q", "endDate": "2026-06-30", "avg": 2.0, "currency": "USD"}
    )
    bound = bind_estimate_changes(previous, current, ("TEST",))
    store = ArtifactStore(tmp_path)
    publication(store, extra_artifacts={tools.ANALYST: bound})
    deps = AssistantDepsFactory(store).for_run()
    role = role_registry()["earnings-brief"]
    ctx = SecurityContext(ticker="TEST")
    (delta,) = role.reader(deps, ctx).read(research.research_earnings, {})["data"]["changes"]
    assert delta == {
        "metric": "eps",
        "end": "2026-03-31",
        "period": "0q",
        "currency": "USD",
        "previous": 1.25,
        "current": 1.5,
        "change": 0.25,
        "previous_as_of": "2026-01-15T10:00:00Z",
        "current_as_of": "2026-01-25T10:00:00Z",
    }
    assert bind_estimate_changes(bound, analyst(1.5, "2026-01-26T10:00:00Z"), ("TEST",))["rows"][0][
        "estimateChanges"
    ] == [delta]
    current["rows"][0]["analyst"]["earningsEstimate"][0]["currency"] = "EUR"
    assert not bind_estimate_changes(previous, current, ("TEST",))["rows"][0]["estimateChanges"]


@pytest.mark.parametrize(
    "sector,industry,gics",
    [
        ("Financial Services", "Banks - Diversified", "40"),
        ("Energy", "Oil & Gas Integrated", "10"),
    ],
)
def test_gics_sector_comparison_uses_the_published_world_sector(tmp_path, sector, industry, gics):
    import pandas as pd
    from trading_max.reference.msci_world_sectors import WORLD_INDUSTRY_INDICES
    from trading_max.research.technical import _relative_stats

    _, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run()
    tech = deps.store.read_json(deps.snapshot_id, tools.TECHNICAL)
    tech["rows"][0]["as_of"] = DATES[-1]
    spec = next(s for s in WORLD_INDUSTRY_INDICES if s.gics == gics)
    symbol = spec.symbol
    dates = pd.bdate_range(end=DATES[-1], periods=64)
    prices = pd.Series(range(100, 164), index=dates)
    tech["rows"][0]["relative_strength"] = {symbol: _relative_stats(prices, prices, 63)}
    fundamentals = deps.store.read_json(deps.snapshot_id, tools.FUNDAMENTALS)
    fundamentals["rows"][0].update(sector=sector, industry=industry)
    publication(
        factory.store, extra_artifacts={tools.TECHNICAL: tech, tools.FUNDAMENTALS: fundamentals}
    )
    deps = factory.for_run()
    chart = deps.price_series("TEST", deps.manifest, limit=2000)
    selected = PriceContext(ticker="TEST", published_series_id=chart.published_series_id)
    role = role_registry()["your-position"]
    reader = role.reader(deps, selected)
    result = reader.read(research.research_position, {})["data"]
    assert result["benchmarks"][0]["symbol"] == symbol
    assert any(f"MSCI World {spec.name}" in fact.en for fact in role.facts(reader, selected))


def test_reopened_research_citation_rechecks_retention_and_event_identity(tmp_path):
    from pathlib import Path

    from fastapi import FastAPI

    from services.api.trading_max_api.routes.research import router

    publish, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run()
    role = role_registry()["earnings-brief"]
    selection = SecurityContext(ticker="TEST")
    result = role.reader(deps, selection).read(research.research_earnings, {})
    app = FastAPI()
    app.include_router(router)
    app.state.store = factory.store
    app.state.assistant = SimpleNamespace(deps_for_run=factory.for_run)
    client = TestClient(app)
    path = "/v1/research/TEST/citation"
    params = {
        "tool": "research_earnings",
        "snapshotId": deps.snapshot_id,
        "evidenceId": result["evidence_id"],
        "eventId": "report",
        "event": "earnings",
    }
    publish(eps=9)
    old = client.get(path, params=params)
    assert old.status_code == 200
    fact = role.facts(role.reader(deps, selection), selection)[0]
    single = client.get(
        path, params={**params, "observation": fact.evidence.arguments["observation"]}
    )
    assert [line["en"] for line in single.json()["lines"]] == [fact.en]
    assert old.json()["output"]["data"]["estimates"][0]["mean"] == 1.25
    assert client.get(path, params={**params, "eventId": "absent"}).status_code == 404
    root = factory.store.immutable_snapshots.snapshots_root
    Path(root / deps.snapshot_id).rename(tmp_path / "expired")
    assert client.get(path, params=params).status_code == 404


def test_generic_event_citation_reopens_the_same_page_and_time_zone(tmp_path):
    from fastapi import FastAPI

    from services.api.trading_max_api.agent.events import EventArgs, event_data
    from services.api.trading_max_api.routes.research import router

    publish, _, factory, _, _ = setup(tmp_path)
    deps = factory.for_run("research", "America/New_York")
    args = EventArgs(ticker="TEST", scope="isa", start=DATES[0], end=DATES[-1], limit=20)
    result = event_data(deps, args, upcoming=False)
    event = next(row for row in result["data"]["items"] if row["kind"] == "earnings")
    app = FastAPI()
    app.include_router(router)
    app.state.store = factory.store
    app.state.assistant = SimpleNamespace(deps_for_run=factory.for_run)
    client = TestClient(app)
    params = {
        **args.model_dump(exclude={"ticker"}),
        "tool": "news_and_events",
        "timezone": "America/New_York",
        "snapshotId": deps.snapshot_id,
        "evidenceId": result["evidence_id"],
        "eventId": event["evidence_id"],
        "eventTicker": "TEST",
    }
    publish(eps=9)
    path = "/v1/research/TEST/citation"
    reopened = client.get(path, params=params)
    assert reopened.status_code == 200
    assert event in reopened.json()["output"]["data"]["items"]
    assert client.get(path, params={**params, "timezone": "Europe/London"}).status_code == 404
    assert client.get(path, params={**params, "eventId": "ev_unknown"}).status_code == 404
