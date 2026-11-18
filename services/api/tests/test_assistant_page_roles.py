"""Selection readings use one observed object and only evidence the server can verify."""

import asyncio
from dataclasses import replace
from datetime import UTC, date, datetime

import pytest
from pydantic import ValidationError
from pydantic_ai.models.test import TestModel
from trading_max.infrastructure.acwi_weights import METHOD, AcwiWeights

from services.api.tests.assistant_fixture import DATES
from services.api.tests.test_assistant_readings import sample
from services.api.trading_max_api.agent.attribution_role import AttributionContext, matches
from services.api.trading_max_api.agent.page_sources import PageSources
from services.api.trading_max_api.agent.roles import RoleTools, role_registry
from services.api.trading_max_api.agent.service import BoundModel
from services.api.trading_max_api.global_sector_models import GlobalSectorBoard
from services.api.trading_max_api.index_models import GlobalMarketContribution
from services.api.trading_max_api.models import JobRecord

STAMP = "2026-02-03T17:00:00Z"


def inputs():
    weights = AcwiWeights(
        as_of=date(2026, 2, 2),
        fetched_at=datetime(2026, 2, 3, tzinfo=UTC),
        locations={"United States": 0.61},
        method=METHOD,
    )
    world = GlobalSectorBoard.model_validate(
        {
            "reference_date": "2026-02-03",
            "phase": "completed",
            "as_of": STAMP,
            "acwi_move": 0.001,
            "acwi_level": 1,
            "weights_as_of": "2026-02-02",
            "weights_stale": False,
            "rank_sessions": [],
            "sectors": [
                {
                    "gics": "45",
                    "name": "Information Technology",
                    "index_code": 1,
                    "move": 0.02,
                    "weight": 0.15,
                    "contribution": 0.003,
                    "intraday": [],
                    "ranks": [],
                    "groups": [],
                    "holdings": [],
                }
            ],
        }
    )
    regions = GlobalMarketContribution.model_validate(
        {
            "reference_date": "2026-02-03",
            "phase": "completed",
            "as_of": STAMP,
            "acwi_move": 0.001,
            "acwi_level": 1,
            "weights_as_of": "2026-02-02",
            "weights_stale": False,
            "state": "partial",
            "residual": None,
            "rows": [],
            "markets": [
                {"market": "uk", "move": 0.0, "not_open": True},
                {"market": "us", "move": -0.01, "not_open": False},
            ],
        }
    )
    failed = JobRecord(
        job_id="example",
        scope="all",
        skip_sync=False,
        status="failed",
        created_at=STAMP,
        finished_at=STAMP,
        error="broker snapshot reconciliation failed: {'positions_match_investments': False}; PRIVATE-MESSAGE",
    )
    return PageSources(
        lambda dim: weights if dim == "country" else None,
        lambda market: None,
        lambda: world,
        lambda: regions,
        lambda job_id: failed,
    )


@pytest.mark.parametrize(
    ("name", "context", "indices", "expected"),
    [
        ("exposure", {"dimension": "country", "category": "United States"}, [0, 1, 2], "61.00%"),
        (
            "attribution",
            {"scope": "invest", "start": DATES[0], "end": DATES[-1], "benchmark": "VOO"},
            [0, 1, 2, 3],
            "8.00%",
        ),
        (
            "market-sector",
            {"market": "global", "grouping": "gics", "sector": "45", "observed": STAMP},
            [0, 1, 2],
            "+0.30 pp",
        ),
        ("market-map", {"observed": STAMP}, [0, 1], "Contribution"),
        ("diagnosis", {"issue": "job", "job": "example"}, [0, 1, 2, 3], "Possible explanations"),
    ],
)
def test_verified_selections_are_cached_in_both_languages(
    tmp_path, name, context, indices, expected
):
    service, deps, calls, _ = sample(tmp_path)
    deps = replace(deps, page_sources=inputs())

    async def bind():
        calls.append(True)
        return BoundModel(TestModel(custom_output_args={"indices": indices}), {})

    service.assistant.bind_model = bind
    role = role_registry()[name]
    selected = role.context_schema.model_validate(context)

    async def run():
        return [event async for event in service.events(role, selected, deps)]

    result = asyncio.run(run())[-1]
    assert result.type == "result", result
    assert expected in " ".join(row.en for row in result.reading.lines)
    assert all(row.zh and row.en and row.evidence.evidence_id for row in result.reading.lines)
    assert "PRIVATE-MESSAGE" not in result.model_dump_json()
    if name == "market-map":
        assert "not opened" in result.reading.lines[0].variants["uk"].en
        assert "-1.00%" in result.reading.lines[1].variants["us"].en
    if name == "diagnosis":
        assert result.reading.lines[-1].evidence.source == "inference"
    if name == "exposure":
        assert "No comparable weight" in result.reading.lines[1].en
    assert asyncio.run(run()) == [result]
    assert len(calls) == 1


def test_sector_version_scope_and_map_freshness(tmp_path):
    _, deps, *_ = sample(tmp_path)
    sources = inputs()
    deps = replace(deps, page_sources=sources)
    role = role_registry()["market-sector"]
    context = role.context_schema(
        market="global", grouping="gics", sector="45", observed="2026-02-02T17:00:00Z"
    )
    assert not role.facts(RoleTools.pinned(deps, role.allowed_tools), context)
    role = role_registry()["market-map"]
    stale = replace(
        sources, regions=lambda: sources.regions().model_copy(update={"prices_stale": True})
    )
    assert not role.facts(
        RoleTools.pinned(replace(deps, page_sources=stale), role.allowed_tools),
        role.context_schema(observed=STAMP),
    )


def test_currency_effect_requires_matching_chart_endpoints():
    context = AttributionContext(
        scope="isa",
        benchmark="QQQ",
        start="2026-07-15T10:00:00+01:00",
        end="2026-07-15T13:00:00+01:00",
    )
    assert matches("2026-07-15T09:00:00Z", "2026-07-15T12:00:00Z", context)
    assert not matches("2026-07-15T08:00:00Z", "2026-07-15T12:00:00Z", context)
    with pytest.raises(ValidationError):
        AttributionContext(scope="isa", benchmark="QQQ", start="2026-07-15T10:00:00", end=STAMP)


def test_money_range_pins_full_cadence_gbp_and_missing_endpoints(tmp_path):
    _, deps, *_ = sample(tmp_path)
    role = role_registry()["attribution"]
    context = AttributionContext(
        scope="isa",
        range="1D",
        view="money",
        benchmark="QQQ",
        start="2026-02-03T12:00:00Z",
        end=STAMP,
    )
    read = RoleTools.pinned(deps, role.allowed_tools)
    facts = role.facts(read, context)
    pnl = next(f for f in facts if f.section == "return")
    assert "£-80.00" in pnl.en and pnl.evidence.tool == "selected_money"
    assert pnl.evidence.arguments == {
        **context.model_dump(),
        "snapshotId": deps.snapshot_id,
        "metric": "return",
    }
    assert all("unavailable" in f.en or "No QQQ comparison" in f.en for f in facts if f != pnl)
    no_opening = context.model_copy(update={"start": "2026-02-03T11:59:00Z"})
    assert not any(f.section == "return" for f in role.facts(read, no_opening))
    with pytest.raises(ValidationError):
        AttributionContext(**{**context.model_dump(), "start": "2026-W06-2"})


def test_sidebar_validates_page_scope_range_benchmark_and_snapshot(tmp_path):
    from fastapi import HTTPException
    from starlette.requests import Request

    from services.api.trading_max_api.agent.service import _context

    _, deps, *_ = sample(tmp_path)
    selected = {
        "scope": "isa",
        "range": "1W",
        "view": "returns",
        "benchmark": "QQQ",
        "start": DATES[0],
        "end": DATES[-1],
    }
    origin = {
        "role": "attribution",
        "page": "analytics",
        "scope": "isa",
        "range": "1W",
        "benchmark": "QQQ",
        "snapshotId": deps.snapshot_id,
        "object": selected,
    }
    request = Request({"type": "http", "query_string": b""})
    assert _context({"context": origin}, request).object == selected
    for mismatch in (
        {"scope": "invest"},
        {"range": "1M"},
        {"benchmark": "VOO"},
        {"page": "health"},
        {"snapshotId": None},
    ):
        with pytest.raises(HTTPException, match="assistant_context_invalid"):
            _context({"context": {**origin, **mismatch}}, request)
