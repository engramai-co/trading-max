"""Role selection, immutable cache keys and consent-aware publication scheduling."""

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic_ai import CancellationToken
from pydantic_ai.models.test import TestModel
from trading_max.infrastructure import SqliteDatabase

from services.api.tests.assistant_fixture import publication
from services.api.trading_max_api.agent.background import BriefWriter
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.agent.overview_roles import OverviewContext, overview_schedule
from services.api.trading_max_api.agent.readings import DAILY_BRIEF_LIMIT, ReadingService
from services.api.trading_max_api.agent.roles import RoleTools, role_registry
from services.api.trading_max_api.agent.service import AssistantService, BoundModel
from services.api.trading_max_api.agent.tools import Scoped, portfolio_overview
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.models import JobRecord
from services.api.trading_max_api.routes.assistant import router


def sample(tmp_path):
    db = SqliteDatabase(tmp_path / "state.db")
    store = ArtifactStore(tmp_path)
    publication(store)
    factory = AssistantDepsFactory(store)
    calls = []
    ready = [True]

    async def bind():
        calls.append(True)
        return BoundModel(TestModel(custom_output_args={"indices": [1, 0, 2, 3]}), {})

    async def status():
        return {"ready": ready[0], "code": None if ready[0] else "assistant_disabled"}

    service = AssistantService(
        None, None, bind, factory.for_run, check_ready=status, bind_background_model=bind
    )
    return ReadingService(service, db), factory.for_run(), calls, ready


def test_role_endpoint_pins_versions_links_and_refuses_scope_expansion(tmp_path):
    service, deps, calls, ready = sample(tmp_path)
    app = FastAPI()
    app.state.settings = type("Settings", (), {"api_token": None})()
    app.state.assistant_readings = service
    app.include_router(router)
    client = TestClient(app)
    route = "/v1/assistant/roles/weekly/reading"
    import json

    def events(body):
        return [json.loads(s) for s in client.post(route, json=body).text.splitlines()]

    assert events({"cachedOnly": True}) == [{"type": "empty"}]
    first = events({"snapshotId": deps.snapshot_id})
    assert first[0]["type"] == "reading" and first[-1]["type"] == "result"
    assert any(event["type"] == "lines" and event["lines"] for event in first)
    result = first[-1]["reading"]
    assert result["version"] == result["snapshotId"] == deps.snapshot_id
    money = next(row for row in result["lines"] if row["section"] == "portfolio")["evidence"][
        "arguments"
    ]
    assert money["metric"] == "period_pnl_gbp" and money["snapshotId"] == deps.snapshot_id
    assert money["start"] <= money["end"]
    assert result["lines"][0]["section"] == "market"
    assert "VOO" in result["lines"][0]["en"]
    variant = result["lines"][0]["variants"]["QQQ"]
    assert "QQQ" in variant["en"]
    assert variant["evidence"]["arguments"]["benchmark"] == "QQQ"
    assert result["lines"][0]["evidence"]["arguments"]["benchmark"] == "VOO"
    assert all(
        row["evidence"]["arguments"]["snapshotId"] == deps.snapshot_id for row in result["lines"]
    )
    assert all(row["evidence"]["evidenceId"].startswith("ev_") for row in result["lines"])
    assert events({"cachedOnly": True, "latest": True}) == [{"type": "empty"}]
    assert events({"cachedOnly": True, "snapshotId": deps.snapshot_id}) == [first[-1]]
    assert len(calls) == 1
    assert client.post(route, json={"context": {"account": "outside"}}).status_code == 422
    assert client.post(route, json={"snapshotId": "../x"}).status_code == 422
    ready[0] = False
    assert events({"cachedOnly": True})[0]["code"] == "assistant_disabled"
    with pytest.raises(ValueError, match="read scope"):
        RoleTools(deps, frozenset()).read(portfolio_overview, Scoped(scope="broker_total"))


def job(at, version, trigger="reconciliation"):
    return JobRecord(
        job_id="job",
        scope="all",
        skip_sync=False,
        trigger=trigger,
        status="succeeded",
        created_at=at,
        scheduled_for=at,
        finished_at=at,
        snapshot_run_id=version,
    )


def test_background_daily_weekly_slots_versions_and_budget(tmp_path):
    service, deps, calls, _ready = sample(tmp_path)
    # British Summer Time: 01:00 UTC is the Saturday 02:00 slot.
    at = datetime(2026, 6, 13, 1, tzinfo=UTC)
    record = job(at, deps.snapshot_id)
    assert not overview_schedule(True, job(at - timedelta(minutes=1), deps.snapshot_id))
    assert not overview_schedule(True, job(at + timedelta(days=1), deps.snapshot_id))
    assert not overview_schedule(False, job(at, deps.snapshot_id, "live"))
    jobs = [job(at, deps.snapshot_id, "intraday"), record]
    allowed = [False]
    writer = BriefWriter(service, lambda: allowed[0], lambda: jobs, lambda: at)
    asyncio.run(writer.tick())
    assert not calls
    allowed[0] = True
    asyncio.run(writer.tick())
    asyncio.run(writer.tick())
    assert len(calls) == 2
    assert service.cached(role_registry()["weekly"], OverviewContext(), None)
    role = role_registry()["daily"]
    assert (
        sum(
            service.reserve(at.date().isoformat(), role, OverviewContext(), str(i))
            for i in range(20)
        )
        == DAILY_BRIEF_LIMIT - 2
    )
    assert service.reserve(
        (at + timedelta(days=1)).date().isoformat(), role, OverviewContext(), "next-day"
    )


def test_role_errors_and_cancellation_leave_no_cached_partial(tmp_path):
    service, deps, _, _ = sample(tmp_path)
    role = role_registry()["weekly"]

    def denied():
        return False

    async def scenario():
        run = service.events(role, OverviewContext(), deps)
        assert (await anext(run)).type == "reading"
        await run.aclose()
        assert not service.assistant._active
        refused = [e async for e in service.events(role, OverviewContext(), deps, permitted=denied)]
        assert refused[-1].code == "assistant_disabled"
        unavailable = [
            e async for e in service.events(role, OverviewContext(), replace(deps, manifest=None))
        ]
        assert unavailable[-1].type == "empty"
        token = CancellationToken()
        token.cancel()

        async def revoked():
            return BoundModel(TestModel(custom_output_args={"indices": [1, 0, 2, 3]}), {}, token)

        service.assistant.bind_model = revoked
        expired = [e async for e in service.events(role, OverviewContext(), deps)]
        assert expired[-1].type == "error"
        assert not any(e.type in {"lines", "result"} for e in expired)
        assert not service.cached(role, OverviewContext(), deps.snapshot_id)

    asyncio.run(scenario())


def test_weekly_fold_uses_friday_publication_without_a_saturday_refresh(tmp_path):
    service, deps, calls, _ = sample(tmp_path)
    saturday = datetime(2026, 6, 13, 1, tzinfo=UTC)
    friday = job(saturday - timedelta(hours=4), deps.snapshot_id)
    writer = BriefWriter(service, lambda: True, lambda: [friday], lambda: saturday)
    asyncio.run(writer.tick())
    asyncio.run(writer.tick())
    assert len(calls) == 1
    assert service.cached(role_registry()["weekly"], OverviewContext(), None)
    assert not service.cached(role_registry()["daily"], OverviewContext(), None)


def test_full_scope_and_midnight_reservation(tmp_path):
    service, deps, _, _ = sample(tmp_path)
    before = datetime(2026, 11, 18, 23, 59, 58, tzinfo=UTC)
    after = before + timedelta(seconds=7)
    full = job(before, deps.snapshot_id, "research").model_copy(update={"scope": "research"})
    single = full.model_copy(update={"tickers": ["TEST"]})
    assert not overview_schedule(False, single)
    times = iter([before, after])
    asyncio.run(
        BriefWriter(service, lambda: True, lambda: [full], lambda: next(times, after)).tick()
    )
    with service.database.read() as db:
        assert db.execute("SELECT day FROM assistant_brief_attempts").fetchone()[0] == "2026-11-19"


def test_background_opt_out_while_model_is_binding(tmp_path):
    service, deps, _, _ = sample(tmp_path)
    allowed = [True]
    model = TestModel(custom_output_args={"indices": [1, 0, 2, 3]})

    async def bind():
        allowed[0] = False
        return BoundModel(model, {})

    service.assistant.bind_model = bind

    async def scenario():
        return [
            e
            async for e in service.events(
                role_registry()["daily"], OverviewContext(), deps, permitted=lambda: allowed[0]
            )
        ]

    result = asyncio.run(scenario())
    assert result[-1].code == "assistant_disabled"
    assert model.last_model_request_parameters is None


def test_weekly_handoff_rejects_wrong_page_scope_and_period():
    from fastapi import HTTPException

    from services.api.trading_max_api.agent.service import _context

    context = {
        "page": "overview",
        "role": "weekly",
        "range": "1W",
        "scope": "broker_total",
        "snapshotId": "synthetic",
        "object": {"benchmark": "VOO"},
    }
    assert _context({"context": context}, None).page == "overview"
    for invalid in (
        {"page": "holdings"},
        {"range": "3M"},
        {"scope": "invest"},
        {"snapshotId": None},
    ):
        with pytest.raises(HTTPException) as error:
            _context({"context": {**context, **invalid}}, None)
        assert error.value.status_code == 422


def test_calendar_windows_and_dated_events_have_distinct_visible_targets(tmp_path):
    from services.api.trading_max_api.agent import tools
    from services.api.trading_max_api.agent.overview_roles import overview_calendar

    store = ArtifactStore(tmp_path)
    artifacts = {
        tools.EARNINGS: {
            "rows": [
                {
                    "ticker": "TEST",
                    "calendar": {
                        "Earnings Date": ["2026-11-23", "2026-11-26"],
                        "Ex-Dividend Date": "2026-11-28",
                    },
                }
            ]
        }
    }

    role = role_registry()["weekly"]

    def facts():
        publication(store, extra_artifacts=artifacts, created_at=datetime(2026, 11, 18, tzinfo=UTC))
        deps = AssistantDepsFactory(store).for_run()
        first = overview_calendar(role.reader(deps, OverviewContext()))
        return (first, *first.related)

    window, ex_div = facts()
    assert "2026-11-23" in window.en and "2026-11-26" in window.en
    assert ex_div.evidence.arguments["event"] == "exDividend"
    artifacts[tools.ANALYST] = {
        "rows": [
            {
                "ticker": "TEST",
                "analyst": {
                    "earningsEvents": [
                        {"date": "2026-11-25", "id": "TEST-report", "status": "provider-estimate"}
                    ]
                },
            }
        ]
    }
    report, ex_div = facts()
    assert "2026-11-25" in report.en and "2026-11-23" not in report.en
    assert report.evidence.arguments["researchEventId"] == "TEST-report"


def test_follow_up_tools_read_the_original_snapshot_after_a_new_publication(tmp_path):
    from pydantic_ai import FunctionToolset, RunContext

    from services.api.tests.test_assistant_runtime import answer_after_tool, make_app, user_turn
    from services.api.trading_max_api.agent.deps import AssistantDeps
    from services.api.trading_max_api.agent.runtime import build_assistant_agent

    store = ArtifactStore(tmp_path)
    original = publication(store)
    newer = publication(store, invest_total=1500)
    assert original.run_id != newer.run_id
    observations = []

    from services.api.trading_max_api.agent.tools import PeriodArgs

    def period_performance(ctx: RunContext[AssistantDeps], args: PeriodArgs) -> dict:
        """Read the current turn's publication."""
        observations.append(ctx.deps.snapshot_id)
        return {"evidence_id": "ev_test", "data": {}}

    stream, _ = answer_after_tool("period_performance")
    app, service = make_app(tmp_path, stream)
    service.agent = build_assistant_agent([FunctionToolset([period_performance])])
    service.deps_for_run = AssistantDepsFactory(store).for_run
    body = user_turn("old-brief", "u", "Continue this weekly reading")
    body["context"] = {
        "page": "overview",
        "scope": "broker_total",
        "range": "1W",
        "role": "weekly",
        "snapshotId": original.run_id,
    }
    response = TestClient(app).post("/v1/assistant/chat", json=body)
    assert response.status_code == 200
    assert observations == [original.run_id]


@pytest.mark.parametrize("role_id", ["daily", "weekly"])
def test_calendar_keeps_the_nearest_dated_event_from_each_source(tmp_path, role_id):
    from pydantic_ai import ModelRetry
    from trading_max.research.calendars.refresh import MACRO_KEY

    from services.api.trading_max_api.agent import events, tools
    from services.api.trading_max_api.agent.overview_roles import overview_calendar

    store = ArtifactStore(tmp_path)
    calendar = {
        "id": "fixture-release",
        "market": "JP",
        "publisher": "Fixture agency",
        "title_en": "Consumer prices",
        "title_zh": "消费者价格",
        "date": "2026-02-05",
        "instant": "2026-02-05T08:30:00+09:00",
        "timezone": "Asia/Tokyo",
        "source_url": "https://example.org/releases/prices",
        "status": "provisional",
    }
    created = datetime(2026, 2, 3, 17, tzinfo=UTC)
    publication(
        store,
        created_at=created,
        extra_artifacts={
            MACRO_KEY: {
                "sources": {
                    "test": {
                        "events": [
                            {
                                **calendar,
                                "id": "cancelled",
                                "date": "2026-02-03",
                                "instant": None,
                                "status": "cancelled",
                            },
                            *[
                                {
                                    **calendar,
                                    "id": status,
                                    "status": status,
                                    "date": "2026-02-03",
                                    "instant": None,
                                }
                                for status in ("postponed", "withdrawn")
                            ],
                            {**calendar, "id": "month", "date": "2026-02", "instant": None},
                            {
                                **calendar,
                                "id": "past",
                                "date": "2026-02-03",
                                "instant": "2026-02-03T10:00:00Z",
                            },
                            calendar,
                        ]
                    }
                }
            },
            tools.EARNINGS: {
                "rows": [
                    {
                        "ticker": "TEST",
                        "calendar": {
                            "Earnings Date": ["2026-02-06", "2026-02-08"],
                            "Ex-Dividend Date": "2026-02-10",
                        },
                    },
                    {"ticker": "UNHELD", "calendar": {"Ex-Dividend Date": "2026-02-04"}},
                ]
            },
        },
    )
    role = role_registry()[role_id]
    deps = AssistantDepsFactory(store).for_run(timezone="Europe/London")
    reader = role.reader(deps, OverviewContext())
    publication(store, created_at=created + timedelta(days=1))
    first = next(item for item in role.facts(reader, OverviewContext()) if item.section == "next")
    reader.attach_evidence([first])
    macro, earnings, ex = (first, *first.related)
    assert role.cache_id.startswith("calendar:")
    assert macro.en == "2026-02-04 · JP · Consumer prices (provisional)"
    assert macro.evidence.arguments["instant"] == calendar["instant"]
    assert macro.evidence.arguments["url"] == calendar["source_url"]
    assert earnings.en == "2026-02-06 – 2026-02-08 · TEST estimated earnings"
    assert ex.en == "2026-02-10 · TEST ex-dividend"
    assert [item.evidence.source for item in (macro, earnings, ex)] == [
        "calendar",
        "financials",
        "disclosure",
    ]
    assert all(
        item.evidence.arguments["snapshotId"] == deps.snapshot_id for item in (macro, earnings, ex)
    )
    assert len({item.evidence.arguments["eventId"] for item in (macro, earnings, ex)}) == 3
    with pytest.raises(ModelRetry):
        reader.read(events.upcoming_events, {"start": "2025-01-01"})

    missing = overview_calendar(
        role.reader(AssistantDepsFactory(store).for_run(), OverviewContext())
    )
    assert (
        missing.related == []
        and "No macro release" in missing.en
        and "instant" not in missing.evidence.arguments
    )


def test_overview_calendar_preserves_a_single_published_earnings_date(tmp_path):
    from services.api.trading_max_api.agent import tools
    from services.api.trading_max_api.agent.overview_roles import overview_calendar

    store = ArtifactStore(tmp_path)
    publication(
        store,
        created_at=datetime(2026, 2, 3, tzinfo=UTC),
        extra_artifacts={
            tools.EARNINGS: {
                "rows": [{"ticker": "TEST", "calendar": {"Earnings Date": "2026-02-05"}}]
            }
        },
    )
    deps = AssistantDepsFactory(store).for_run()
    entry = overview_calendar(role_registry()["daily"].reader(deps, OverviewContext()))
    assert entry.en == "2026-02-05 · TEST estimated earnings"
    assert "instant" not in entry.evidence.arguments
    assert not entry.related


def test_reading_refuses_a_pruned_previously_cached_publication(tmp_path, monkeypatch):
    service, deps, *_ = sample(tmp_path)
    app = FastAPI()
    app.state.settings = type("Settings", (), {"api_token": None})()
    app.state.assistant_readings = service
    app.include_router(router)
    client = TestClient(app)
    external_store = ArtifactStore(deps.store.data_root)
    publication(external_store, invest_total=1500)
    path = "/v1/assistant/roles/weekly/reading"
    body = {"snapshotId": deps.snapshot_id, "cachedOnly": True}
    assert client.post(path, json=body).status_code == 200
    monkeypatch.setenv("TRADING_MAX_SNAPSHOT_KEEP_MONTHLY", "0")
    assert deps.snapshot_id in external_store.prune_snapshots(keep_recent=1)
    assert client.post(path, json=body).status_code == 404
