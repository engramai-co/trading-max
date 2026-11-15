"""Use synthetic publications and a real Pydantic AI tool loop."""

from __future__ import annotations

import hashlib
import json
import socket
from dataclasses import FrozenInstanceError, replace
from datetime import UTC, datetime
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

from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.deps import AssistantDepsFactory
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.history_reader import HistoryReader, load_history
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.research_funds import FundResearchService
from services.api.trading_max_api.research_prices import SecurityPriceHistory
from services.api.trading_max_api.watchlist import SecuritySearchService, WatchlistStore

DATES = ["2026-01-28", "2026-01-29", "2026-01-30", "2026-02-02", "2026-02-03"]
AS_OF = "2026-02-03T17:00:00Z"
STALE_NOW = datetime(2026, 3, 21, tzinfo=UTC)


def _publication(store, *, invest_total=1000, long_research=False, with_cfd=True):
    def account(code, total, ticker):
        return {
            "fetched_at": "2026-02-03T16:00:00Z",
            "total_value_gbp": total,
            "cash_gbp": 100,
            "investments_value_gbp": total - 100,
            "realized_profit_loss_gbp": 20,
            "unrealized_profit_loss_gbp": 10,
            "positions": [
                {
                    "ticker": ticker,
                    "name": "Synthetic " + code,
                    "quantity": 10,
                    "current_price": 90,
                    "price_currency": "GBP",
                    "current_value_gbp": total - 100,
                    "total_cost_gbp": total - 110,
                    "unrealized_profit_loss_gbp": 10,
                }
            ],
        }

    invest, isa = account("Invest", invest_total, "TEST"), account("ISA", 420, "FICT")
    fund = {
        "ticker": "TEST",
        "currency": "USD",
        "name": "Synthetic issuer",
        "sector": "Technology",
        "metrics": {
            "fullExchangeName": "NYSE",
            "exchangeTimezoneName": "America/New_York",
            "quoteType": "EQUITY",
            "regularMarketPrice": 30,
            "regularMarketTime": datetime(2026, 2, 3, 16, tzinfo=UTC).timestamp(),
            "targetMedianPrice": 40,
        },
    }
    if long_research:
        fund["metrics"]["longSyntheticStatements"] = [
            {"date": f"synthetic-{i}", "description": "synthetic-character-测试" * 240}
            for i in range(28)
        ]
    payloads = {
        tools.BROKER: {
            "generated_at_utc": "2026-02-03T16:00:00Z",
            "accounts": {"A": invest, "B": isa},
        },
        tools.LIVE: {
            "generated_at_utc": AS_OF,
            "accounts": {
                "A": {
                    "fetched_at": AS_OF,
                    "total_value_gbp": invest_total + 5,
                    "positions_status": "unverified",
                    "positions": [{"ticker": "NEVER", "current_value_gbp": 9999}],
                },
                "B": {
                    "fetched_at": AS_OF,
                    "investments_value_gbp": 320,
                    "positions_status": "verified",
                    "checks": {"positions_match_investments": True},
                    "positions": [{**isa["positions"][0], "current_price": 32}],
                },
            },
        },
        tools.LOOKTHROUGH: {
            "available": True,
            "lookthroughCoveragePct": 1,
            "investedValueGbp": 1220,
            "nonSecurityValueGbp": 0,
            "brokerAsOf": AS_OF,
            "countryAllocation": [
                {"country": "United States", "valueGbp": 1220, "allocationPct": 1}
            ],
            "industryAllocation": [
                {"industry": "Technology", "valueGbp": 1220, "allocationPct": 1}
            ],
            "positions": [
                {"name": "Issuer", "ticker": "TEST", "valueGbp": 1220, "allocationPct": 1}
            ],
        },
        tools.TECHNICAL: {
            "rows": [{"ticker": "TEST", "price": 30, "currency": "USD", "technical_score": 71}],
            "benchmark_currency": "GBP",
            "benchmark_return_basis": "adjusted_price_gbp",
            "benchmark_series": {
                "VOO": [{"date": day, "close": 100 + i * 2} for i, day in enumerate(DATES)]
            },
        },
        tools.FUNDAMENTALS: {"rows": [fund]},
        tools.VALUATION: {
            "rows": [
                {
                    "ticker": "TEST",
                    "currency": "USD",
                    "method": "dcf",
                    "assumptions": {"secret_private_scenario": "synthetic-never-output"},
                }
            ],
        },
        tools.COVERAGE: {
            "rows": [
                {
                    "ticker": "TEST",
                    "datasets": {
                        "technical": {"state": "stale", "lastSuccessfulAt": AS_OF},
                        "valuation": {"state": "available", "lastSuccessfulAt": AS_OF},
                        "options": {"state": "failed", "reason": "synthetic-no-output"},
                    },
                }
            ],
        },
        tools.OPTIONS: {"rows": [{"ticker": "OTHER", "expiry_count": 1}]},
        tools.DECISIONS: {
            "accounts": {
                "A": {
                    "status": "available",
                    "as_of": AS_OF,
                    "decisions": [
                        {
                            "ticker": "TEST",
                            "date": DATES[-1],
                            "side": "buy",
                            "kind": "B",
                            "quantity": 3,
                            "amount_gbp": 33,
                        }
                    ],
                },
                "B": {"status": "unavailable", "reason": "synthetic-no-output"},
            },
        },
    }
    payloads[tools.HISTORY_KEYS[3]] = {
        "points": [
            {
                "observed_at": "2025-12-01T12:00:00Z",
                "source": "reconstructed",
                "total_value_gbp": 800,
                "isa_value_gbp": 800,
            },
            {"observed_at": "2026-01-09T12:00:00Z", "total_value_gbp": 900, "isa_value_gbp": 900},
            {
                "observed_at": "2026-02-03T12:00:00Z",
                "total_value_gbp": 1500,
                "invest_value_gbp": 1000,
                "isa_value_gbp": 500,
            },
            {
                "observed_at": AS_OF,
                "total_value_gbp": 1420,
                "invest_value_gbp": 1000,
                "isa_value_gbp": 420,
            },
        ]
    }
    for key in tools.HISTORY_KEYS[5:]:
        payloads[key] = {
            "verified": True,
            "covered_from": "2025-12-01T00:00:00Z",
            "covered_until": AS_OF,
            "events": [],
        }
    if with_cfd:
        payloads.update(
            {
                tools.CFD: {
                    "ending_nav_gbp": 20,
                    "realized_profit_loss_gbp": -80,
                    "end": DATES[-1],
                },
                tools.CFD_LEDGER: {
                    "coverage_start": DATES[0],
                    "coverage_end": DATES[-1],
                    "latest_event_at": AS_OF,
                    "events": [
                        {
                            "symbol": "TEST",
                            "record_type": "closed_position",
                            "occurred_at": AS_OF,
                            "account_currency": "GBP",
                            "gross_result": "-1.23",
                            "provenance": [{"source_name": "synthetic-upload-never-output.csv"}],
                        }
                    ],
                },
            }
        )

    def nav(values):
        return "Date,SyntheticNAVGBP,ExternalFlowGBP,TWRWealth\n" + "".join(
            f"{day},{value},{100 if i == 3 else 0},{wealth}\n"
            for i, (day, (value, wealth)) in enumerate(zip(DATES, values, strict=True))
        )

    files = {
        tools.HISTORY_KEYS[0]: nav(
            [(900, 1), (950, 1.05), (950, 1.05), (1100, 1.10), (1000, 1.02)]
        ),
        tools.HISTORY_KEYS[1]: nav([(400, 1), (405, 1.01), (400, 1), (500, 1), (420, 0.84)]),
    }
    if with_cfd:
        files[tools.HISTORY_KEYS[2]] = (
            "Date,RealisedCashEquityProxyGBP,CumulativeAccountCashFlowGBP,"
            "CumulativeHouseholdExternalFlowGBP,CumulativeRealisedPnLGBP\n"
            + "".join(f"{day},{100 - i * 20},100,100,{-i * 20}\n" for i, day in enumerate(DATES))
        )
    backing = store.immutable_artifacts
    refs = [
        backing.put_json(key=key, payload=payload, as_of=AS_OF) for key, payload in payloads.items()
    ]
    refs.extend(
        backing.put_bytes(key=key, content=content.encode(), media_type="text/csv", as_of=AS_OF)
        for key, content in files.items()
    )
    return store.publish_typed(scope="all", source="synthetic", artifacts=refs)


@pytest.fixture
def publication(tmp_path):
    store = ArtifactStore(tmp_path)
    manifest = _publication(store)
    deps = replace(AssistantDepsFactory(store).for_run(), captured_at=STALE_NOW)
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
    assert len(result["evidence_id"]) == 67
    assert result["evidence_id"] == _call(deps, function, args)["evidence_id"]
    assert result["sources"]
    assert all(set(source) == {"source_id", "as_of"} for source in result["sources"])
    assert len(json.dumps(result).encode()) <= tools.MAX_RESULT_BYTES


def test_scope_pin_and_broker_position_reconciliation(publication):
    store, manifest, deps = publication
    next_manifest = _publication(store, invest_total=2000, with_cfd=False)
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
    _publication(store, long_research=True)
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
    before = _hash_state(store.data_root)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("assistant attempted a network or mutable reader")

    for cls, method in (
        (socket.socket, "connect"),
        (socket.socket, "connect_ex"),
        (socket, "getaddrinfo"),
        (HistoryReader, "read"),
        (WatchlistStore, "load"),
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
