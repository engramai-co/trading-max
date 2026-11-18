"""Selections reach registered tools before either type of assistant run can read data."""

import asyncio
import json
from dataclasses import replace
from typing import Literal

import pytest
from fastapi.testclient import TestClient
from pydantic import Field
from pydantic_ai import ModelRetry

from services.api.tests.test_assistant_readings import sample
from services.api.tests.test_assistant_runtime import answer_after_tool, events, make_app, user_turn
from services.api.trading_max_api.agent import roles, tools
from services.api.trading_max_api.agent.overview_roles import line
from services.api.trading_max_api.agent.runtime import build_assistant_agent


class Selection(roles.RoleContext):
    scope: Literal["isa", "invest"]
    start: str
    end: str
    ticker: str


class MetricArgs(tools.Scoped):
    start: str
    end: str
    ticker: str
    limit: int = 5


SELECTED = Selection(scope="isa", start="2026-11-01", end="2026-11-18", ticker="SYNT")


@pytest.fixture
def selected_role(monkeypatch):
    reads = []

    def selected_metric(ctx: tools.Context, args: MetricArgs) -> dict:
        """Read the selected account and security for a published window."""
        reads.append(args)
        return tools._Read(ctx.deps, "selected_metric", args, args.scope).result(
            data={"period_pnl_gbp": -80 if args.scope == "isa" else 0}
        )

    def facts(reader, context):
        result = reader.read(selected_metric, {"limit": 3})
        return [line("", "合计", "Total", result, "account", "selected_metric") for _ in range(4)]

    role = roles.PageRole(
        "selection",
        "analytics",
        frozenset({"selected_metric", "list_holdings"}),
        Selection,
        "Select observations.",
        facts,
        tool_bindings=lambda selection, snapshot_id: {"selected_metric": selection.model_dump()},
    )
    monkeypatch.setattr(roles, "role_registry", lambda: {role.id: role})
    return role, selected_metric, reads


@pytest.mark.parametrize(
    "conflict", [{"scope": "invest"}, {"end": "2026-11-19"}, {"ticker": "OTHER"}]
)
def test_conflicting_role_arguments_stop_before_reading(tmp_path, selected_role, conflict):
    role, metric, reads = selected_role
    service, deps, _, _ = sample(tmp_path)
    for supplied in (
        SELECTED.model_dump() | conflict,
        MetricArgs(**(SELECTED.model_dump() | conflict)),
    ):

        def conflicting(reader, context, supplied=supplied):
            with pytest.raises(ModelRetry):
                reader.read(metric, supplied)
            return []

        async def run():
            return [
                e.type
                async for e in service.events(replace(role, facts=conflicting), SELECTED, deps)
            ]

        assert asyncio.run(run()) == ["reading", "empty"]
    assert not reads


def test_role_reading_records_injected_arguments_in_stream_and_cache(tmp_path, selected_role):
    role, _, reads = selected_role
    service, deps, _, _ = sample(tmp_path)

    async def read():
        return [e async for e in service.events(role, SELECTED, deps)]

    for _ in range(2):
        stream = asyncio.run(read())
        assert stream[-1].type == "result"
        for row in stream[-1].reading.lines:
            assert row.evidence.arguments == {
                **SELECTED.model_dump(),
                "snapshotId": deps.snapshot_id,
            }
    assert reads == [MetricArgs(**SELECTED.model_dump(), limit=3)]


@pytest.mark.parametrize(
    "supplied",
    [
        SELECTED.model_dump() | {"scope": "invest"},
        {"args": SELECTED.model_dump() | {"end": "2026-12-01"}},
        SELECTED.model_dump() | {"ticker": "OTHER"},
        {"limit": 3},
        {"args": {"limit": 3, "scope": "isa"}},
    ],
)
def test_chat_enforces_selection_and_records_omitted_arguments(tmp_path, selected_role, supplied):
    role, metric, reads = selected_role
    _, deps, _, _ = sample(tmp_path)
    stream, seen = answer_after_tool("selected_metric", json.dumps(supplied))

    async def check_registry(messages, info):
        assert [tool.name for tool in info.function_tools] == ["selected_metric"]
        schema = info.function_tools[0].parameters_json_schema
        assert set(schema["properties"]) == {"limit"}
        async for chunk in stream(messages, info):
            yield chunk

    app, service = make_app(tmp_path, check_registry)
    registry = tools.build_assistant_toolset()
    registry.add_function(metric, takes_ctx=True)
    service.agent = build_assistant_agent([registry])
    service.deps_for_run = lambda page, tz: deps
    body = user_turn("selected", "question", "Continue this reading")
    body["context"] = {
        "role": role.id,
        "page": role.page,
        "object": SELECTED.model_dump(),
        "snapshotId": deps.snapshot_id,
    }
    response = TestClient(app).post("/v1/assistant/chat", json=body)
    assert response.status_code == 200
    chunks = events(response.text)
    outputs = [e["output"] for e in chunks if e["type"] == "tool-output-available"]
    args = supplied.get("args", supplied)
    if "limit" not in args:
        assert not reads
        assert not outputs
    else:
        assert reads == [MetricArgs(**SELECTED.model_dump(), limit=3)]
        assert outputs[0]["data"]["period_pnl_gbp"] == -80
        assert outputs[0]["bound_arguments"] == {
            **SELECTED.model_dump(),
            "snapshotId": deps.snapshot_id,
        }
    assert seen


def test_previous_unbound_readings_do_not_satisfy_a_bound_role(tmp_path, selected_role):
    role, _, _ = selected_role
    service, deps, _, _ = sample(tmp_path)
    old = replace(role, tool_bindings=None)
    with service.database.transaction(immediate=True) as db:
        db.execute(
            "INSERT INTO assistant_readings VALUES (?, ?, ?, ?, ?)",
            (old.id, old.object_key(SELECTED), deps.snapshot_id, "2026-11-18", "{}"),
        )
    assert service.cached(role, SELECTED, deps.snapshot_id) is None


def test_reading_cannot_change_the_selected_ticker_through_a_variant(tmp_path, selected_role):
    role, metric, reads = selected_role
    service, deps, _, _ = sample(tmp_path)

    def misplaced(reader, context):
        variant = reader.for_variant(context.model_copy(update={"ticker": "ALT"}))
        result = variant.read(metric, {})
        return [line("", "合计", "Total", result, "account", "selected_metric")] * 2

    async def run():
        return [
            e.type async for e in service.events(replace(role, facts=misplaced), SELECTED, deps)
        ]

    assert asyncio.run(run()) == ["reading", "error"]
    assert not reads
    assert service.cached(role, SELECTED, deps.snapshot_id) is None


class PublicationArgs(tools.Args):
    snapshot_id: str = Field(alias="snapshotId")


@pytest.mark.parametrize("form", ["typed", "python-name", "wire", "both"])
def test_publication_alias_conflict_is_rejected_before_read(tmp_path, form):
    _, deps, _, _ = sample(tmp_path)
    reads = []

    def get_publication(ctx: tools.Context, args: PublicationArgs) -> dict:
        reads.append(args)
        return {"evidence_id": "ev_test"}

    role = roles.PageRole(
        "p",
        "overview",
        frozenset({"get_publication"}),
        roles.RoleContext,
        "",
        lambda *_: [],
        tool_bindings=lambda _, pin: {"get_publication": {"snapshotId": pin}},
    )
    reader = role.reader(deps, roles.RoleContext())
    arguments = {
        "typed": PublicationArgs(snapshotId="wrong"),
        "python-name": {"snapshot_id": "wrong"},
        "wire": {"snapshotId": "wrong"},
        "both": {"snapshotId": deps.snapshot_id, "snapshot_id": "wrong"},
    }[form]
    with pytest.raises(ModelRetry, match="snapshotId"):
        reader.read(get_publication, arguments)
    assert reads == []


def test_weekly_decisions_apply_both_publication_bounds_before_paging(tmp_path):
    from services.api.tests.assistant_fixture import publication
    from services.api.trading_max_api.agent.deps import AssistantDepsFactory
    from services.api.trading_max_api.agent.overview_roles import OverviewContext
    from services.api.trading_max_api.artifacts import ArtifactStore

    store = ArtifactStore(tmp_path)
    dates = ["2025-11-12", "2026-02-03", "2026-10-15"]
    publication(
        store,
        extra_artifacts={
            tools.DECISIONS: {
                "accounts": {
                    "A": {
                        "status": "available",
                        "decisions": [{"ticker": "TEST", "side": "buy", "date": d} for d in dates],
                    }
                }
            }
        },
    )
    deps = AssistantDepsFactory(store).for_run()
    reader = roles.role_registry()["weekly"].reader(deps, OverviewContext())
    result = reader.read(tools.recent_decisions, {"limit": 1})
    assert [row["date"] for row in result["data"]["items"]] == ["2026-02-03"]
    assert result["data"]["next_cursor"] is None
    with pytest.raises(ModelRetry):
        reader.read(tools.recent_decisions, {"since": "2026-10-01"})


@pytest.mark.parametrize("conflict", [False, True])
def test_chat_normalises_publication_argument_aliases(tmp_path, monkeypatch, conflict):
    reads = []
    _, deps, _, _ = sample(tmp_path)

    def get_publication(ctx: tools.Context, args: PublicationArgs) -> dict:
        """Read the selected publication."""
        reads.append(args.snapshot_id)
        return {"evidence_id": "ev_test", "data": {}}

    role = roles.PageRole(
        "p",
        "overview",
        frozenset({"get_publication"}),
        roles.RoleContext,
        "",
        lambda *_: [],
        tool_bindings=lambda _, pin: {"get_publication": {"snapshotId": pin}},
    )
    monkeypatch.setattr(roles, "role_registry", lambda: {"p": role})
    supplied = {"args": {"snapshot_id": "wrong" if conflict else deps.snapshot_id}}
    stream, _ = answer_after_tool("get_publication", json.dumps(supplied))
    app, service = make_app(tmp_path, stream)
    registry = tools.build_assistant_toolset()
    registry.add_function(get_publication, takes_ctx=True)
    service.agent = build_assistant_agent([registry])
    service.deps_for_run = lambda page, tz: deps
    body = user_turn("p", "u", "Read the selected publication")
    body["context"] = {
        "role": "p",
        "page": "overview",
        "object": {},
        "snapshotId": deps.snapshot_id,
    }
    response = TestClient(app).post("/v1/assistant/chat", json=body)
    assert response.status_code == 200
    assert reads == ([] if conflict else [deps.snapshot_id])
