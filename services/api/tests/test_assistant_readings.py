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

    service = AssistantService(None, None, bind, factory.for_run, check_ready=status)
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
    assert result["version"] == deps.snapshot_id
    assert result["lines"][0]["section"] == "market"
    assert "VOO" in result["lines"][0]["en"]
    assert "QQQ" in result["lines"][0]["variants"]["QQQ"]["en"]
    assert all(row["evidence"]["evidenceId"].startswith("ev_") for row in result["lines"])
    assert events({"cachedOnly": True, "latest": True}) == [first[-1]]
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
    assert service.cached(role_registry()["weekly"], OverviewContext(), deps.snapshot_id)
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
    assert service.cached(role_registry()["weekly"], OverviewContext(), deps.snapshot_id)
    assert not service.cached(role_registry()["daily"], OverviewContext(), deps.snapshot_id)
