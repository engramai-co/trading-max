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
from services.api.trading_max_api.agent.roles import role_registry
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
    assert not role.facts(role.reader(deps, context), context)
    role = role_registry()["market-map"]
    stale = replace(
        sources, regions=lambda: sources.regions().model_copy(update={"prices_stale": True})
    )
    context = role.context_schema(observed=STAMP)
    assert not role.facts(role.reader(replace(deps, page_sources=stale), context), context)


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
    facts = role.facts(role.reader(deps, context), context)
    pnl = next(f for f in facts if f.section == "return")
    assert "£-80.00" in pnl.en and pnl.evidence.tool == "selected_money"
    assert pnl.evidence.arguments == {
        **context.model_dump(),
        "snapshotId": deps.snapshot_id,
        "metric": "return",
    }
    assert all("unavailable" in f.en or "No QQQ comparison" in f.en for f in facts if f != pnl)
    no_opening = context.model_copy(update={"start": "2026-02-03T11:59:00Z"})
    assert "could be verified" in next(
        f.en for f in role.facts(role.reader(deps, no_opening), no_opening) if f.section == "return"
    )
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


def test_grouped_allocations_use_complete_members_and_dated_comparison(tmp_path):
    from services.api.tests.assistant_fixture import publication
    from services.api.trading_max_api.agent import tools
    from services.api.trading_max_api.agent.deps import AssistantDepsFactory
    from services.api.trading_max_api.artifacts import ArtifactStore

    store = ArtifactStore(tmp_path)
    names = [f"Region {n}" for n in range(14)]
    rows = [{"country": name, "valueGbp": 100, "allocationPct": 0.05} for name in names]
    data = {
        "available": True,
        "brokerAsOf": STAMP,
        "countryAllocation": rows,
        "countryBasis": "country of risk",
        "positions": [
            {"name": "Holding", "ticker": "TEST", "allocationPct": 0.9, "valueGbp": 1800}
        ],
        "investedValueGbp": 2000,
        "nonSecurityValueGbp": 200,
    }
    prior = {
        **data,
        "brokerAsOf": "2026-01-01T16:00:00Z",
        "countryAllocation": [{**row, "allocationPct": 0.04, "valueGbp": 80} for row in rows],
    }
    publication(
        store,
        extra_artifacts={
            tools.LOOKTHROUGH: data,
            "account/exposure_history/2026-01-01.json": prior,
        },
    )
    weights = AcwiWeights(
        as_of=date(2026, 2, 2),
        fetched_at=datetime(2026, 2, 3, tzinfo=UTC),
        locations=dict.fromkeys(names, 0.02),
        method=METHOD,
    )
    deps = replace(
        AssistantDepsFactory(store).for_run(),
        page_sources=replace(inputs(), weights=lambda dimension: weights),
    )
    role = role_registry()["exposure"]
    context = role.context_schema(dimension="country", category="tail", group="tail")
    facts = {line.section: line for line in role.facts(role.reader(deps, context), context)}
    assert "10.00%" in facts["current"].en
    assert "8.00%" in facts["history"].en and "+2.00 pp" in facts["history"].en
    assert "4.00%" in facts["benchmark"].en and "+6.00 pp" in facts["benchmark"].en
    assert facts["history"].evidence.arguments["group"] == "tail"
    context = role.context_schema(dimension="company", category="unresolved", group="unresolved")
    facts = {line.section: line for line in role.facts(role.reader(deps, context), context)}
    assert "10.00%" in facts["current"].en
    assert "10.00%" in facts["history"].en
    assert "benchmark" not in facts


def test_benchmark_published_after_the_portfolio_observation_is_unavailable(tmp_path):
    _, deps, *_ = sample(tmp_path)
    sources = inputs()
    later = sources.weights("country").model_copy(update={"as_of": date(2026, 2, 4)})
    role = role_registry()["exposure"]
    context = role.context_schema(dimension="country", category="United States")
    deps = replace(deps, page_sources=replace(sources, weights=lambda dim: later))
    facts = role.facts(role.reader(deps, context), context)
    assert "No comparable MSCI ACWI" in next(f.en for f in facts if f.section == "benchmark")


def test_daily_close_selection_rejects_intraday_fx_on_the_same_dates():
    context = AttributionContext(scope="isa", benchmark="QQQ", start=DATES[0], end=DATES[-1])
    assert not matches(f"{DATES[0]}T09:00:00Z", f"{DATES[-1]}T09:00:00Z", context)


@pytest.mark.parametrize("compatible", [True, False])
def test_exposure_history_requires_comparable_basis_and_denominator(tmp_path, compatible):
    from services.api.tests.assistant_fixture import publication
    from services.api.trading_max_api.agent import tools
    from services.api.trading_max_api.agent.deps import AssistantDepsFactory
    from services.api.trading_max_api.artifacts import ArtifactStore

    def data(day, basis, fraction, value):
        return {
            "available": True,
            "brokerAsOf": day + "T16:00:00Z",
            "countryBasis": basis,
            "investedValueGbp": 1000,
            "countryAllocation": [
                {"country": "United States", "allocationPct": fraction, "valueGbp": value}
            ],
        }

    store = ArtifactStore(tmp_path)
    history = {
        tools.LOOKTHROUGH: data(DATES[-1], "risk", 0.5, 500),
        "account/exposure_history/2026-01-04.json": data("2026-01-04", "venue", 0.2, 200),
        "account/exposure_history/2026-01-03.json": data("2026-01-03", "risk", 0.3, 150),
    }
    if compatible:
        history["account/exposure_history/2026-01-02.json"] = data("2026-01-02", "risk", 0.48, 480)
    publication(store, extra_artifacts=history)
    role = role_registry()["exposure"]
    deps = AssistantDepsFactory(store).for_run()
    context = role.context_schema(dimension="country", category="United States")
    previous = next(
        f for f in role.facts(role.reader(deps, context), context) if f.section == "history"
    )
    if compatible:
        assert "48.00%" in previous.en and "+2.00 pp" in previous.en
        assert previous.evidence.arguments["start"] == "2026-01-02"
    else:
        assert "No comparable" in previous.en


@pytest.mark.parametrize("with_publication", [False, True])
def test_failed_refresh_is_diagnosed_from_its_terminal_record(tmp_path, with_publication):
    from services.api.trading_max_api.models import JobStageRecord

    service, deps, *_ = sample(tmp_path)
    job = (
        inputs()
        .job("example")
        .model_copy(
            update={
                "error": None,
                "attempts": 2,
                "finished_at": datetime(2026, 2, 5, 13, tzinfo=UTC),
                "stages": [
                    JobStageRecord(
                        name="research.fundamentals",
                        label="PRIVATE",
                        status="failed",
                        error="PRIVATE",
                    )
                ],
            }
        )
    )
    deps = replace(
        deps,
        manifest=deps.manifest if with_publication else None,
        page_sources=replace(inputs(), job=lambda job_id: job),
    )

    async def bind():
        return BoundModel(TestModel(custom_output_args={"indices": [0, 1]}), {})

    service.assistant.bind_model = bind
    role = role_registry()["diagnosis"]
    context = role.context_schema(issue="job", job="example")

    async def run():
        return [e async for e in service.events(role, context, deps)]

    event = asyncio.run(run())[-1]
    assert event.type == "result", event
    assert event.reading.as_of == job.finished_at
    assert (
        "Fundamentals" in event.reading.model_dump_json()
        and "PRIVATE" not in event.reading.model_dump_json()
    )
    assert "基本面" in event.reading.model_dump_json()
    assert "2 attempts" in event.reading.model_dump_json()
    assert event.reading.version != deps.snapshot_id


def test_benchmark_basis_is_localized_and_original_is_cited(tmp_path):
    _, deps, *_ = sample(tmp_path)
    role = role_registry()["attribution"]
    context = AttributionContext(scope="invest", start=DATES[0], end=DATES[-1], benchmark="VOO")
    facts = role.facts(role.reader(deps, context), context)
    benchmark = next(f for f in facts if f.section == "benchmark")
    assert "adjusted prices" in benchmark.en and "复权价格" in benchmark.zh
    assert benchmark.evidence.arguments["benchmark_basis"] == "adjusted_price_gbp"


@pytest.mark.parametrize("called_scope", ["invest", "isa"])
def test_follow_up_cannot_read_money_for_another_selection(tmp_path, called_scope):
    import json

    from fastapi.testclient import TestClient

    from services.api.tests.test_assistant_runtime import (
        answer_after_tool,
        events,
        make_app,
        user_turn,
    )
    from services.api.trading_max_api.agent.runtime import build_assistant_agent
    from services.api.trading_max_api.agent.tools import build_assistant_toolset

    _, deps, *_ = sample(tmp_path)
    selected = {
        "scope": "isa",
        "range": "1D",
        "view": "money",
        "benchmark": "QQQ",
        "start": "2026-02-03T12:00:00Z",
        "end": STAMP,
    }
    stream, _ = answer_after_tool("selected_money", json.dumps({**selected, "scope": called_scope}))
    app, service = make_app(tmp_path, stream)
    service.agent = build_assistant_agent([build_assistant_toolset()])
    service.deps_for_run = lambda page, tz: replace(deps, page_sources=inputs(), page_hint=page)
    body = user_turn("money-followup", "u", "What was my net P&L?")
    body["context"] = {
        "role": "attribution",
        "page": "analytics",
        "scope": "isa",
        "range": "1D",
        "benchmark": "QQQ",
        "object": selected,
        "snapshotId": deps.snapshot_id,
    }
    response = TestClient(app).post("/v1/assistant/chat?format=references", json=body)
    outputs = [e["output"] for e in events(response.text) if e["type"] == "tool-output-available"]
    if called_scope == "isa":
        assert outputs and outputs[0]["data"]["pnl"] == -80
    else:
        assert not any(
            isinstance(o, dict) and (o.get("data") or {}).get("pnl") is not None for o in outputs
        )


def page_figure_outputs(tmp_path):
    from trading_max.research.news import NEWS_KEY

    from services.api.tests.assistant_fixture import publication
    from services.api.trading_max_api.agent import (
        attribution_role,
        diagnosis_role,
        exposure_role,
        market_roles,
    )
    from services.api.trading_max_api.agent.deps import AssistantDepsFactory
    from services.api.trading_max_api.artifacts import ArtifactStore
    from services.api.trading_max_api.models import JobStageRecord
    from services.api.trading_max_api.sector_models import SectorBoard

    store = ArtifactStore(tmp_path)
    morning, close = "2026-02-03T12:00:00Z", STAMP
    publication(
        store,
        extra_artifacts={
            "account/attribution/window.json": {
                "day": DATES[-1],
                "start_day": DATES[0],
                "accounts": {
                    "B": {
                        "since": morning,
                        "as_of": close,
                        "contributions": [
                            {
                                "ticker": "TEST",
                                "contribution_gbp": -24,
                                "local_price_effect_gbp": 10,
                                "fx_effect_gbp": -34,
                            }
                        ],
                    }
                },
            },
            NEWS_KEY: {
                "securities": {
                    "TEST": {
                        "as_of": STAMP,
                        "items": [
                            {
                                "title": "Synthetic issuer update",
                                "publisher": "Fixture Press",
                                "url": "https://example.org/article",
                                "instant": STAMP,
                            }
                        ],
                    }
                }
            },
        },
    )
    board = SectorBoard.model_validate(
        {
            "market": "us",
            "session_date": DATES[-1],
            "complete": True,
            "fetched_at": STAMP,
            "source": {
                "universe": "test",
                "fund": "test",
                "fund_ticker": "TEST",
                "url": "https://example.org",
                "as_of": DATES[-1],
            },
            "groupings": [
                {
                    "kind": "gics",
                    "groups": [
                        {
                            "key": "45",
                            "name": "Technology",
                            "leader": {"symbol": "TEST", "name": "Test", "change": 0.01},
                            "members": [
                                {"symbol": "TEST", "name": "Test", "research_ticker": "TEST"}
                            ],
                        }
                    ],
                }
            ],
        }
    )
    job = (
        inputs()
        .job("example")
        .model_copy(
            update={
                "error": None,
                "attempts": 2,
                "stages": [
                    JobStageRecord(name="research.fundamentals", label="Private", status="failed")
                ],
            }
        )
    )
    sources = replace(inputs(), board=lambda market: board, job=lambda job_id: job)
    deps = replace(AssistantDepsFactory(store).for_run(), page_sources=sources)
    cases = [
        (
            "attribution",
            attribution_role.selected_fx,
            {
                "scope": "isa",
                "range": "1D",
                "view": "money",
                "benchmark": "QQQ",
                "start": morning,
                "end": close,
            },
        ),
        (
            "attribution",
            attribution_role.selected_daily,
            {"scope": "invest", "benchmark": "VOO", "start": DATES[0], "end": DATES[-1]},
        ),
        (
            "exposure",
            exposure_role.selected_exposure,
            {"dimension": "country", "category": "United States"},
        ),
        (
            "market-sector",
            market_roles.sector_headline,
            {"market": "us", "grouping": "gics", "sector": "45", "observed": STAMP},
        ),
        ("market-map", market_roles.global_map, {"market": "us", "observed": STAMP}),
        ("diagnosis", diagnosis_role.update_issue, {"issue": "job", "job": "example"}),
    ]
    outputs = {}
    for name, tool, args in cases:
        role = role_registry()[name]
        context = role.context_schema.model_validate(args)
        from pydantic_ai import ModelRetry

        reader = role.reader(deps, context)
        for field in context.model_dump():
            with pytest.raises(ModelRetry, match="conflicts with the selected object"):
                reader.read(tool, {field: "substituted"})
        result = reader.read(tool, {})
        assert result["data"], (name, result)
        if tool is market_roles.sector_headline:
            result["data"]["items"][0]["evidence_id"] = "ev_synthetic_headline"
        # Keep the fixture independent of temporary manifest IDs and source hashes.
        outputs[tool.__name__] = {
            k: v
            for k, v in result.items()
            if k not in {"sources", "evidence_id", "snapshot_id", "bound_arguments"}
        }
        outputs[tool.__name__].update(
            evidence_id="ev_" + tool.__name__,
            snapshot_id="synthetic-figures",
            bound_arguments={**context.model_dump(), "snapshotId": "synthetic-figures"},
        )
    return outputs


def test_role_figure_fixture_matches_bound_tool_outputs(tmp_path):
    import json
    from pathlib import Path

    captured = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "apps/web/workspace/assistant/page-figures.fixture.json"
        ).read_text()
    )
    for tool, output in page_figure_outputs(tmp_path).items():
        assert captured[tool] == output
    assert [row["market"] for row in captured["global_map"]["data"]["markets"]] == ["us"]
