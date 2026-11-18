"""Use synthetic publications and a real Pydantic AI tool loop."""

from __future__ import annotations

import hashlib
import json
import socket
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

import pytest
from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.messages import (
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RunUsage
from trading_max.portfolio_math import (
    benchmark_comparison,
    in_range,
    prepare_history,
    return_periods,
)

from services.api.tests.assistant_fixture import AS_OF, STALE_NOW
from services.api.tests.assistant_fixture import publication as publish_fixture
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.history_reader import HistoryReader, load_history
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.research_funds import FundResearchService
from services.api.trading_max_api.research_prices import SecurityPriceHistory
from services.api.trading_max_api.watchlist import SecuritySearchService, WatchlistStore


@pytest.fixture
def publication(tmp_path):
    store = ArtifactStore(tmp_path)
    manifest = publish_fixture(store)
    research = ResearchLedger(store, WatchlistStore(tmp_path))
    deps = replace(
        AssistantDepsFactory(store, bind_price_series=research.bind_price_series).for_run(),
        captured_at=STALE_NOW,
    )
    return store, manifest, deps


def _call(deps, function, args):
    # Direct calls let the assertions inspect projected data without involving
    # the model; separate tests drive the same functions through the toolset.
    return function(
        RunContext(
            deps=deps,
            model=FunctionModel(lambda _messages, _info: ModelResponse(parts=[])),
            usage=RunUsage(),
        ),
        args,
    )


@pytest.mark.parametrize(
    ("function", "args", "field"),
    [
        (tools.portfolio_overview, tools.Scoped(scope="household"), "components"),
        (tools.list_holdings, tools.HoldingsArgs(scope="broker_total"), "items"),
        (tools.position_detail, tools.PositionArgs(scope="isa", ticker="fict"), "items"),
        (
            tools.lookthrough_exposure,
            tools.ExposureArgs(scope="broker_total", dimension="country"),
            "items",
        ),
        (
            tools.lookthrough_exposure,
            tools.ExposureArgs(scope="broker_total", dimension="sector"),
            "items",
        ),
        (
            tools.lookthrough_exposure,
            tools.ExposureArgs(scope="broker_total", dimension="company"),
            "items",
        ),
        (tools.period_performance, tools.PeriodArgs(scope="broker_total", range="ALL"), "twr"),
        (
            tools.compare_benchmarks,
            tools.BenchmarkArgs(scope="broker_total", range="ALL", benchmark="VOO"),
            "benchmarks",
        ),
        (tools.read_research_lens, tools.ResearchArgs(ticker="TEST", lens="technical"), "items"),
        (
            tools.read_valuation_evidence,
            tools.ValuationArgs(ticker="TEST", listing="US:TEST", group="market"),
            "items",
        ),
        (
            tools.data_freshness,
            tools.FreshnessArgs(scope="invest", domain="research", ticker="TEST"),
            "items",
        ),
        (tools.recent_decisions, tools.DecisionsArgs(scope="household"), "items"),
    ],
)
def test_envelope_and_evidence_id(publication, function, args, field):
    _, manifest, deps = publication
    result = _call(deps, function, args)
    assert result.keys() == {
        "status",
        "data",
        "snapshot_id",
        "scope",
        "sources",
        "quality",
        "evidence_id",
    }
    assert result["status"] in {"ok", "partial"}, result
    assert result["data"][field]
    assert result["snapshot_id"] == manifest.run_id
    assert len(result["evidence_id"]) == 19
    assert result["evidence_id"] == _call(deps, function, args)["evidence_id"]
    assert result["sources"]
    assert all(set(source) == {"source_id", "as_of"} for source in result["sources"])
    assert len(json.dumps(result).encode()) <= tools.MAX_RESULT_BYTES


def test_isa_attribution_reads_its_own_ledger_from_a_retained_publication(publication, monkeypatch):
    from services.api.trading_max_api.agent.attribution_role import (
        AttributionContext,
        selected_money,
    )

    store, manifest, deps = publication
    publish_fixture(store, invest_total=1100)
    args = AttributionContext(
        scope="isa",
        benchmark="VOO",
        view="money",
        range="ALL",
        start="2026-02-03T12:00:00Z",
        end=AS_OF,
    )
    expected = _call(deps, selected_money, args)
    assert expected["status"] == "ok" and expected["data"]["pnl"] == -80
    raw = store.read_text

    def missing_invest(run_id, key):
        if run_id == manifest.run_id and key.endswith("daily_nav_a.csv"):
            raise FileNotFoundError(key)
        return raw(run_id, key)

    monkeypatch.setattr(store, "read_text", missing_invest)
    assert _call(deps, selected_money, args) == expected
    assert (
        _call(deps, tools.period_performance, tools.PeriodArgs(scope="broker_total", range="ALL"))[
            "status"
        ]
        == "unavailable"
    )


def test_isa_money_citation_keeps_its_carried_opening_after_archiving(tmp_path):
    from fastapi.testclient import TestClient

    from services.api.trading_max_api.agent.attribution_role import (
        AttributionContext,
        selected_money,
    )
    from services.api.trading_max_api.app import create_app
    from services.api.trading_max_api.config import Settings

    store = ArtifactStore(tmp_path)
    columns = "Date,SyntheticNAVGBP,ExternalFlowGBP,TWRWealth\n"
    manifest = publish_fixture(
        store,
        with_cfd=False,
        extra_files={
            tools.HISTORY_KEYS[0]: columns + "2026-01-27,800,800,1\n2026-01-29,875,0,1.09\n",
            tools.HISTORY_KEYS[1]: columns + "2026-01-28,100,100,1\n2026-01-30,125,10,1.15\n",
        },
        extra_artifacts={tools.HISTORY_KEYS[3]: {"points": []}},
    )
    deps = AssistantDepsFactory(store).for_run()
    selection = {"runId": manifest.run_id, "scope": "isa", "range": "ALL"}
    params = {"run_id": manifest.run_id, "scope": "isa", "range": "ALL"}
    endpoint = "/v1/dashboard/history"
    app = create_app(Settings(data_root=tmp_path, embedded_worker=False))
    with TestClient(app) as client:
        live = client.get(endpoint, params=params)
        assert live.is_success and "X-History-Retained" not in live.headers
        opening, closing = prepare_history(live.json(), selection)["history"]["points"][-2:]
        assert (opening["date"], opening["isa"], opening["isaNetContributionsGbp"]) == (
            "2026-01-29",
            100,
            100,
        )
        assert (closing["date"], closing["isa"], closing["isaNetContributionsGbp"]) == (
            "2026-01-30",
            125,
            110,
        )
        citation = AttributionContext(
            scope="isa",
            view="money",
            benchmark="VOO",
            range="ALL",
            start=opening["date"],
            end=closing["date"],
        )
        live_reading = _call(deps, selected_money, citation)
        store.immutable_snapshots.publish(
            scope="all",
            source="synthetic",
            artifacts=store.immutable_snapshots.latest().manifest.artifacts,
        )
        archived = client.get(endpoint, params=params)
        assert archived.is_success and archived.headers["X-History-Retained"] == "1"
        exact = prepare_history(archived.json(), selection)["history"]["points"]
        assert [row["date"] for row in exact] == ["2026-01-28", "2026-01-29", "2026-01-30"]
        assert exact[-2:] == [opening, closing]
        assert archived.json() == live.json()
        assert live_reading["status"] == "ok" and live_reading["data"]["pnl"] == 15
        assert _call(deps, selected_money, citation) == live_reading


def test_scope_pin_and_broker_position_reconciliation(publication):
    store, manifest, deps = publication
    next_manifest = publish_fixture(store, invest_total=2000, with_cfd=False)
    other_deps = AssistantDepsFactory(store).for_run("holdings", "America/New_York")
    assert next_manifest.run_id == other_deps.snapshot_id != manifest.run_id == deps.snapshot_id
    assert (other_deps.page_hint, other_deps.timezone.key) == ("holdings", "America/New_York")
    assert (
        AssistantDepsFactory(store).for_run(timezone="invalid-zone").timezone.key == "Europe/London"
    )
    with pytest.raises(FrozenInstanceError):
        deps.page_hint = "changed"
    overview = _call(deps, tools.portfolio_overview, tools.Scoped(scope="household"))
    assert overview["data"]["total_value_gbp"] == 1445
    no_cfd = _call(other_deps, tools.portfolio_overview, tools.Scoped(scope="household"))
    assert no_cfd["status"] == "unavailable"
    assert no_cfd["quality"]["reason_code"] == "cfd_cash_equity_proxy_unavailable"
    holdings = _call(deps, tools.list_holdings, tools.HoldingsArgs(scope="broker_total", limit=1))
    assert holdings["status"] == "partial"
    assert holdings["data"]["items"][0]["ticker"] == "TEST"
    assert holdings["data"]["items"][0]["observed_at"] == "2026-02-03T16:00:00Z"

    next_page = _call(
        deps,
        tools.list_holdings,
        tools.HoldingsArgs(scope="broker_total", cursor=holdings["data"]["next_cursor"]),
    )
    assert next_page["data"]["items"][0]["ticker"] == "FICT"
    assert next_page["data"]["items"][0]["current_price"] == 32
    assert next_page["data"]["next_cursor"] is None
    assert holdings["evidence_id"] != next_page["evidence_id"]
    restricted = replace(deps, allowed_scopes=frozenset({"invest", "broker_total"}))
    for denied in ("isa", "broker_total", "household", "cfd"):
        with pytest.raises(ModelRetry, match="account scope"):
            _call(restricted, tools.list_holdings, tools.HoldingsArgs(scope=denied))


def test_published_decimal_strings_are_read_as_amounts(tmp_path):
    # The worker publishes broker money as decimal strings, e.g. "116686.0631".
    store = ArtifactStore(tmp_path)
    account = {
        "fetched_at": "2026-02-03T16:00:00Z",
        "total_value_gbp": "1000.25",
        "cash_gbp": "100.0",
        "investments_value_gbp": "900.25",
        "realized_profit_loss_gbp": "-20.5",
        "unrealized_profit_loss_gbp": "10",
        "positions": [
            {
                "ticker": "TEST",
                "quantity": "10.5",
                "current_price": "85.738",
                "price_currency": "GBP",
                "current_value_gbp": "900.25",
                "total_cost_gbp": "890.25",
                "unrealized_profit_loss_gbp": "10",
            }
        ],
    }
    ref = store.immutable_artifacts.put_json(
        key=tools.BROKER,
        payload={"generated_at_utc": AS_OF, "accounts": {"A": account}},
        as_of=AS_OF,
    )
    store.publish_typed(scope="all", source="synthetic", artifacts=[ref])
    deps = AssistantDepsFactory(store).for_run()
    overview = _call(deps, tools.portfolio_overview, tools.Scoped(scope="invest"))
    assert overview["status"] == "ok"
    assert overview["data"]["total_value_gbp"] == 1000.25
    assert overview["data"]["realized_pnl_gbp"] == -20.5
    holdings = _call(deps, tools.list_holdings, tools.HoldingsArgs(scope="invest"))
    item = holdings["data"]["items"][0]
    assert (item["quantity"], item["current_value_gbp"]) == (10.5, 900.25)
    assert overview["evidence_id"].startswith("ev_") and len(overview["evidence_id"]) == 19
    for bad in ("nan", "inf", "1e999", "12 GBP", ""):
        assert tools._number(bad) is None  # noqa: SLF001


def test_market_history_and_calendar_parity(publication):
    store, manifest, deps = publication
    daily, intraday = load_history(store, manifest)

    def wire(points):
        return [p.model_dump(mode="json", exclude_none=True, exclude_defaults=True) for p in points]

    reference = {
        "runId": manifest.run_id,
        "brokerAsOf": AS_OF,
        "dataRevision": "synthetic",
        "nav": wire(daily),
        "intradayNav": wire(intraday),
    }
    for tool_scope, math_scope in (("broker_total", "total"), ("household", "household")):
        args = tools.PeriodArgs(scope=tool_scope, range="ALL", calendar="month")
        result = _call(deps, tools.period_performance, args)["data"]
        prepared = prepare_history(reference, {"range": "ALL", "scope": math_scope})
        expected = prepared["money"]
        assert result["period_pnl_gbp"] == expected["pnl"]
        assert result["max_money_drawdown_gbp"] == expected["maxDrawdown"]
        assert result["money_drawdown_episode"] == expected["drawdownEpisode"]
        assert result["observation_count"] == prepared["sourceCount"]
        if tool_scope == "household":
            assert result["twr"]["status"] == "not_applicable"
            assert result["ending_value_gbp"] == 1440
        else:
            grid = return_periods(reference["nav"], math_scope, AS_OF)
            assert result["items"] == grid["months"][::-1]
    points = in_range(reference["nav"], "ALL")
    benchmark_args = tools.BenchmarkArgs(scope="broker_total", range="ALL", benchmark="VOO")
    result = _call(deps, tools.compare_benchmarks, benchmark_args)["data"]
    raw = store.read_json(manifest.run_id, tools.TECHNICAL)
    expected = benchmark_comparison(points, "total", raw["benchmark_series"], ["VOO"])
    assert result["benchmarks"][0]["return_fraction"] == expected["comparisons"][0]["values"][-1]
    assert result["start"] == expected["points"][0]["date"]
    assert result["end"] == expected["points"][-1]["date"]


@pytest.mark.parametrize("window", ["1D", "1W", "1M", "ALL"])
@pytest.mark.parametrize("scope", ["invest", "isa", "total", "household", "cfd"])
def test_intraday_transport_matches_web_index(publication, window, scope):
    store, manifest, deps = publication
    web = HistoryReader(store).read(manifest, window, scope)
    query = tools.PeriodArgs(scope="broker_total" if scope == "total" else scope, range=window)
    result = _call(deps, tools.period_performance, query)
    prepared = prepare_history(
        web.model_dump(mode="json", exclude_defaults=True, exclude_none=True),
        {"range": window, "scope": scope},
    )
    if prepared["sourceCount"] == 0:
        assert result["status"] == "unavailable" or result["data"]["observation_count"] == 0
    else:
        assert result["data"]["observation_count"] == prepared["sourceCount"]
        assert result["data"]["period_pnl_gbp"] == prepared["money"]["pnl"]
        assert result["data"]["max_money_drawdown_gbp"] == prepared["money"]["maxDrawdown"]


def test_research_pagination_val_evidence_and_freshness(tmp_path):
    store = ArtifactStore(tmp_path)
    publish_fixture(store, long_research=True)
    deps = replace(AssistantDepsFactory(store).for_run(), captured_at=STALE_NOW)
    query = tools.ResearchArgs(ticker="test", lens="fundamentals", limit=20)
    reply = _call(deps, tools.read_research_lens, query)
    assert reply["status"] == "partial"
    assert "result_byte_limit" in reply["quality"]["issues"]
    count = 0
    while True:
        assert len(json.dumps(reply).encode()) <= tools.MAX_RESULT_BYTES
        assert len(reply["data"]["items"]) <= tools.MAX_PAGE_ITEMS
        count += len(reply["data"]["items"])
        cursor = reply["data"]["next_cursor"]
        if cursor is None:
            break
        reply = _call(deps, tools.read_research_lens, query.model_copy(update={"cursor": cursor}))
    assert count == reply["data"]["total_items"]
    lens_list = _call(deps, tools.read_research_lens, tools.ResearchArgs(ticker="TEST"))
    assert lens_list["data"]["available_lenses"] == [
        "overview",
        "fundamentals",
        "technical",
        "analyst",
        "valuation",
    ]
    valuation = _call(
        deps, tools.read_research_lens, tools.ResearchArgs(ticker="TEST", lens="valuation")
    )
    assert "synthetic-never-output" not in str(valuation)
    fresh = _call(
        deps,
        tools.data_freshness,
        tools.FreshnessArgs(scope="invest", domain="research", ticker="TEST"),
    )
    states = {row["dataset"]: row["state"] for row in fresh["data"]["items"]}
    assert states["technical"] == "stale"
    assert states["options"] == "failed"
    decisions = _call(deps, tools.recent_decisions, tools.DecisionsArgs(scope="household"))
    assert {item["kind"] for item in decisions["data"]["items"]} == {
        "broker_daily_decision",
        "imported_cfd_event",
    }
    assert "synthetic-upload-never-output" not in str(decisions)


@pytest.mark.parametrize(
    ("function", "args"),
    [
        (tools.portfolio_overview, tools.Scoped(scope="invest")),
        (tools.list_holdings, tools.HoldingsArgs(scope="invest")),
        (tools.position_detail, tools.PositionArgs(scope="invest", ticker="TEST")),
        (tools.lookthrough_exposure, tools.ExposureArgs(scope="broker_total", dimension="company")),
        (tools.period_performance, tools.PeriodArgs(scope="broker_total", range="ALL")),
        (
            tools.compare_benchmarks,
            tools.BenchmarkArgs(scope="broker_total", range="ALL", benchmark="VOO"),
        ),
        (tools.read_research_lens, tools.ResearchArgs(ticker="TEST")),
        (tools.read_valuation_evidence, tools.ValuationArgs(ticker="TEST", listing="US:TEST")),
        (tools.data_freshness, tools.FreshnessArgs(scope="broker_total", domain="history")),
        (tools.recent_decisions, tools.DecisionsArgs(scope="household")),
    ],
)
def test_missing_publications_are_unavailable(tmp_path, function, args):
    deps = AssistantDepsFactory(ArtifactStore(tmp_path)).for_run()
    result = _call(deps, function, args)
    assert result["status"] == "unavailable"
    assert result["quality"]["reason_code"]
    assert result["data"] is None


def _hash_state(root: Path):
    return {
        str(path.relative_to(root)): (
            hashlib.sha256(path.read_bytes()).hexdigest(),
            path.stat().st_mtime_ns,
        )
        for path in root.rglob("*")
        if path.is_file()
    }


def test_real_agent_reads_every_tool_without_network_or_refresh(publication, monkeypatch):
    store, _, deps = publication
    # The older publication can still answer a decision reading, but predates
    # habit membership. Give this tool-loop fixture a published habit projection.
    from services.api.tests.test_assistant_insights import republish

    decisions = store.read_json(deps.snapshot_id, tools.DECISIONS)
    decisions["accounts"]["A"]["decisions"][0].update(before_earnings=False, basket_buy=False)
    updated = store.immutable_artifacts.put_json(key=tools.DECISIONS, payload=decisions).ref
    deps = replace(deps, manifest=republish(store, {tools.DECISIONS: updated}))
    before = _hash_state(store.data_root)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("assistant attempted a network or mutable reader")

    for cls, method in (
        (socket.socket, "connect"),
        (socket.socket, "connect_ex"),
        (socket, "getaddrinfo"),
        (HistoryReader, "read"),
        (WatchlistStore, "load"),
        (WatchlistStore, "listing_exchanges"),
        (ResearchLedger, "lens_snapshot"),
        (SecurityPriceHistory, "get"),
        (FundResearchService, "get"),
        (SecuritySearchService, "search"),
        (ArtifactStore, "latest_manifest"),
    ):
        monkeypatch.setattr(cls, method, forbidden)

    calls = {
        "portfolio_overview": {"scope": "invest"},
        "list_holdings": {"scope": "broker_total"},
        "position_detail": {"scope": "invest", "ticker": "TEST"},
        "lookthrough_exposure": {"scope": "broker_total", "dimension": "country"},
        "period_performance": {"scope": "household", "range": "ALL"},
        "compare_benchmarks": {"scope": "broker_total", "range": "ALL", "benchmark": "VOO"},
        "read_research_lens": {"ticker": "TEST", "lens": "fundamentals"},
        "read_valuation_evidence": {"ticker": "TEST", "listing": "US:TEST", "group": "market"},
        "data_freshness": {"scope": "invest", "domain": "portfolio"},
        "recent_decisions": {"scope": "cfd"},
        "daily_returns": {"scope": "invest", "range": "3M"},
        "dated_exposure": {
            "scope": "broker_total",
            "dimension": "country",
            "on_or_before": "2026-02-03",
        },
        "holding_fx_split": {"scope": "invest", "period": "open_position"},
        "review_patterns": {"scope": "invest"},
        "decision_timing_and_habits": {"scope": "invest"},
        "price_key_moments": {
            "scope": "invest",
            "ticker": "TEST",
            "start": "2026-01-28",
            "end": "2026-02-03",
        },
        "news_and_events": {"scope": "invest", "start": "2026-01-01", "end": "2026-02-03"},
        "upcoming_events": {"scope": "invest", "start": "2026-02-03", "end": "2026-02-10"},
    }
    seen = []

    def model(messages, info):
        results = [part for part in messages[-1].parts if isinstance(part, ToolReturnPart)]
        if results:
            seen.extend(results)
            return ModelResponse(parts=[TextPart("Done")])
        assert {tool.name for tool in info.function_tools} == set(calls)
        assert all(
            tool.parameters_json_schema["additionalProperties"] is False
            and tool.timeout is not None
            for tool in info.function_tools
        )
        return ModelResponse(parts=[ToolCallPart(name, args) for name, args in calls.items()])

    agent = Agent(FunctionModel(model), toolsets=[tools.build_assistant_toolset()])
    result = agent.run_sync("Read synthetic evidence", deps=deps)
    assert result.output == "Done"
    assert {part.tool_name for part in seen} == set(calls)
    assert all(part.content["status"] in {"ok", "partial"} for part in seen)
    assert all(part.content["snapshot_id"] == deps.snapshot_id for part in seen)
    assert _hash_state(store.data_root) == before


@pytest.mark.parametrize(
    "invalid",
    [
        {"scope": "invest", "limit": "2"},
        {"scope": "invest", "path": "/must-not-be-read"},
        {"scope": "invest", "limit": 21},
        '{"scope":"invest"}' + " " * tools.MAX_ARGUMENT_BYTES,
        {"scope": "isa"},
    ],
    ids=["wrong-type", "extra-key", "page-limit", "byte-limit", "scope-denied"],
)
def test_real_agent_retries_invalid_or_out_of_scope_args(publication, invalid):
    _, _, deps = publication
    deps = replace(deps, allowed_scopes=frozenset({"invest"}))

    def model(messages, _info):
        returns = [part for part in messages[-1].parts if isinstance(part, ToolReturnPart)]
        if returns and returns[0].outcome == "retried":
            return ModelResponse(
                parts=[ToolCallPart("list_holdings", {"scope": "invest", "limit": 2})]
            )
        if returns:
            return ModelResponse(parts=[TextPart("Done")])
        return ModelResponse(parts=[ToolCallPart("list_holdings", invalid)])

    agent = Agent(FunctionModel(model), toolsets=[tools.build_assistant_toolset()])
    run = agent.run_sync("Read synthetic evidence", deps=deps)
    assert run.output == "Done"
    returns = [
        part
        for message in run.all_messages()
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    retried, valid = returns
    assert retried.outcome == "retried"
    assert valid.outcome == "success"
    if isinstance(invalid, str):
        assert "16 KiB" in str(retried.content)
    assert valid.content["scope"] == "invest"
