"""Synthetic decision-time evidence, material habit changes and pinned cache reuse."""

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic_ai import ModelRetry
from pydantic_ai.models.test import TestModel
from trading_max.analytics.decision_review import CALCULATION_VERSION
from trading_max.research.news import NEWS_KEY

from services.api.tests.test_assistant_insights import republish
from services.api.tests.test_assistant_readings import job, sample
from services.api.tests.test_assistant_runtime import answer_after_tool, events, make_app, user_turn
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.insights import decision_timing_and_habits
from services.api.trading_max_api.agent.review_patterns import EVIDENCE, review_patterns
from services.api.trading_max_api.agent.review_roles import DecisionContext, HabitsContext, targets
from services.api.trading_max_api.agent.roles import RoleTools, role_registry
from services.api.trading_max_api.agent.runtime import build_assistant_agent
from services.api.trading_max_api.agent.service import BoundModel


def setup_review(tmp_path):
    service, deps, calls, _ready = sample(tmp_path)
    store = deps.store
    row = {
        "date": "2026-02-03",
        "ticker": "TEST",
        "listing": "TEST",
        "side": "buy",
        "kind": "B",
        "first_fill_at": "2026-02-03T14:00:00+00:00",
        "settled_per_share_gbp": 40.0,
        "before_earnings": True,
        "basket_buy": True,
        "horizon_complete": True,
        "observed_days": 22,
        "effect_horizon_gbp": 18,
        "effect_to_date_gbp": 9,
        "return_horizon": 0.09,
        "return_to_date": 0.045,
        "market_return_horizon": 0.03,
        "market_return_to_date": 0.02,
        "hindsight_horizon": {
            "best_date": "2026-02-04",
            "window_end": "2026-03-04",
            "average_order_gbp": 200,
            "missed_gbp": 12,
        },
    }
    accounts = {
        "A": {
            "status": "available",
            "calculation_version": CALCULATION_VERSION,
            "as_of": "2026-03-06",
            "decisions": [row],
        }
    }

    def publish():
        payloads = {
            tools.DECISIONS: {"accounts": accounts},
            tools.ANALYST: {
                "rows": [
                    {
                        "ticker": "TEST",
                        "analyst": {
                            "earningsEvents": [{"date": "2026-01-29", "status": "reported"}],
                            "upgradesDowngrades": [
                                {
                                    "GradeDate": "2026-01-30",
                                    "Firm": "Synthetic Research",
                                    "ToGrade": "Neutral",
                                }
                            ],
                        },
                    }
                ]
            },
            EVIDENCE: {
                "accounts": {
                    "A": {
                        "coverage": "complete",
                        "holdingMoves": [
                            {
                                "date": "2026-02-02",
                                "ticker": "TEST",
                                "change": -0.1,
                                "hypotheticalHorizonGbp": 15,
                                "hypotheticalToDateGbp": -7,
                            }
                        ],
                    }
                }
            },
            NEWS_KEY: {
                "securities": {
                    "TEST": {
                        "as_of": "2026-03-06",
                        "items": [
                            {
                                "date": day,
                                "title": title,
                                "publisher": "Synthetic Wire",
                                "url": "https://example.org/" + day,
                            }
                            for day, title in (
                                ("2026-02-02", "Prior headline"),
                                ("2026-02-03", "Later same-day headline"),
                            )
                        ],
                    }
                }
            },
        }
        refs = {
            key: store.immutable_artifacts.put_json(key=key, payload=value).ref
            for key, value in payloads.items()
        }
        return replace(deps, manifest=republish(store, refs))

    return service, publish, row, calls


def test_sidebar_fixture_matches_the_completed_review_tools(tmp_path):
    _, publish, row, _ = setup_review(tmp_path)
    deps = publish()
    context = DecisionContext(
        scope="invest",
        page_scope="invest",
        ticker="TEST",
        decision_date=row["date"],
        side="buy",
        horizon="20_sessions",
    )
    decision = role_registry()["decision"].reader(deps, context)
    habits = role_registry()["habits"].reader(
        deps, HabitsContext(scope="invest", horizon="to_date")
    )
    expected = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "apps/web/workspace/assistant/__fixtures__/review-tools.json"
        ).read_text()
    )
    results = {
        "decision": decision.read(decision_timing_and_habits, {}),
        "habits": habits.read(review_patterns, {}),
    }
    for name, result in results.items():
        assert result["bound_arguments"] == {
            **expected[name]["bound_arguments"],
            "snapshotId": deps.snapshot_id,
        }
        if name == "decision":
            for i, event in enumerate(result["data"]["items"][0]["prior_events"]):
                if event["kind"] != "news":
                    assert event["record_id"].startswith("ev_")
                    # Row IDs include this test run's immutable publication ID.
                    event["record_id"] = f"ev_{i + 1:016x}"
        assert all(
            result[key] == expected[name][key] for key in ("status", "scope", "data", "quality")
        )


def test_decision_uses_dated_lead_and_hindsight_label_through_test_model(tmp_path):
    service, publish, _, _ = setup_review(tmp_path)
    deps = publish()
    role = role_registry()["decision"]
    context = DecisionContext(
        scope="invest",
        page_scope="broker_total",
        horizon="20_sessions",
        ticker="TEST",
        side="buy",
        decision_date="2026-02-03",
    )
    facts = role.facts(role.reader(deps, context), context)

    async def bind():
        return BoundModel(TestModel(custom_output_args={"indices": list(range(len(facts)))}), {})

    service.assistant.bind_model = bind

    async def run():
        return [e async for e in service.events(role, context, deps)]

    result = asyncio.run(run())[-1]
    assert result.type == "result"
    lines = {line.section: line for line in result.reading.lines}
    assert (
        "£40.00" in lines["outcome"].en
        and "+9.0%" in lines["outcome"].en
        and "+3.0%" in lines["outcome"].en
    )
    assert (
        "2026-01-29" in lines["earnings"].en and "Synthetic Research" in lines["rating_change"].en
    )
    assert "In hindsight" in lines["outcome"].en and "£12.00" in lines["outcome"].en
    assert (
        lines["headline"].evidence.publisher == "Synthetic Wire"
        and "Prior headline" in lines["headline"].en
    )
    assert all(
        "Later same-day" not in line.en and line.evidence.evidence_id.startswith("ev_")
        for line in lines.values()
    )
    assert (
        role.facts(
            role.reader(deps, context.model_copy(update={"scope": "isa"})),
            context.model_copy(update={"scope": "isa"}),
        )
        == []
    )


def test_habit_cache_reprices_running_outcome_and_waits_for_material_changes(tmp_path):
    service, publish, row, calls = setup_review(tmp_path)
    role = role_registry()["habits"]
    context = HabitsContext(scope="invest")

    async def bind():
        calls.append(True)
        return BoundModel(TestModel(custom_output_args={"indices": [2, 0, 1]}), {})

    service.assistant.bind_background_model = bind

    async def run(deps, **options):
        return [e async for e in service.events(role, context, deps, **options)]

    deps = publish()
    reader = RoleTools.pinned(deps, role.allowed_tools)
    record = job(datetime.now(UTC), deps.snapshot_id)
    assert {target.context.scope for target in targets(record, reader)} == {
        "invest",
        "broker_total",
    }
    assert not targets(record.model_copy(update={"trigger": "live"}), reader)
    assert not targets(record.model_copy(update={"trigger": "on_demand", "scope": "live"}), reader)
    result = asyncio.run(run(deps, scheduled=True))[-1].reading
    assert [line.section for line in result.lines] == [
        "basket_buy",
        "before_earnings",
        "untraded_fall",
    ]
    assert "£15.00" in result.lines[2].en
    assert "£7.00" in result.lines[2].variants["to_date"].en
    assert len(calls) == 1
    row["effect_to_date_gbp"] = 12
    changed = publish()
    cached = asyncio.run(run(changed, cached_only=True))[-1].reading
    assert cached.snapshot_id == changed.snapshot_id and cached.version == result.version
    assert "£12.00" in cached.lines[0].variants["to_date"].en and len(calls) == 1
    assert cached.lines[0].evidence.arguments["snapshotId"] == changed.snapshot_id
    assert cached.lines[0].variants["to_date"].evidence.arguments["horizon"] == "to_date"
    row["horizon_complete"] = False
    assert asyncio.run(run(publish(), cached_only=True))[-1].type == "empty"


def test_pre_trade_leads_respect_the_earliest_fill_in_utc(tmp_path):
    from zoneinfo import ZoneInfo

    _, publish, row, _ = setup_review(tmp_path)
    row["first_fill_at"] = "2026-02-03T14:00:00Z"
    deps = publish()
    items = [
        {"date": "2026-02-02", "title": "Date only, order uncertain"},
        {"instant": "2026-02-02T22:00:00Z", "title": "Verified before the fill"},
        {"instant": "2026-02-03T01:00:00Z", "title": "Earlier on the recorded trade date"},
        {"instant": "2026-02-03T15:00:00Z", "title": "Later than the fill"},
        {"instant": "2026-02-02T23:30:00-05:00", "title": "Trade day in UTC"},
    ]
    for i, item in enumerate(items):
        item.update(publisher="Synthetic", url=f"https://example.org/synthetic/{i}")
    artifact = deps.store.immutable_artifacts.put_json(
        key=NEWS_KEY, payload={"securities": {"TEST": {"items": items}}}
    ).ref
    deps = replace(deps, manifest=republish(deps.store, {NEWS_KEY: artifact}))
    role = role_registry()["decision"]
    context = DecisionContext(
        scope="invest",
        page_scope="invest",
        ticker="TEST",
        side="buy",
        decision_date=row["date"],
        horizon="20_sessions",
    )
    for zone in ("Europe/London", "America/New_York"):
        pinned = role.reader(replace(deps, timezone=ZoneInfo(zone)), context)
        lines = role.facts(pinned, context)
        assert any("Verified before the fill" in line.en for line in lines)
        assert all(
            "Later than the fill" not in line.en and "order uncertain" not in line.en
            for line in lines
        )


def test_mixed_untraded_falls_are_labelled_as_a_net_hypothetical_result(tmp_path):
    _, publish, _, _ = setup_review(tmp_path)
    deps = publish()
    moves = [
        {
            "change": -0.12,
            "ticker": "TEST",
            "date": f"2026-02-0{i}",
            "hypotheticalHorizonGbp": value,
        }
        for i, value in enumerate((15, -7), 1)
    ]
    ref = deps.store.immutable_artifacts.put_json(
        key=EVIDENCE, payload={"accounts": {"A": {"coverage": "complete", "holdingMoves": moves}}}
    ).ref
    deps = replace(deps, manifest=republish(deps.store, {EVIDENCE: ref}))
    role = role_registry()["habits"]
    context = HabitsContext(scope="invest")
    facts = role.facts(role.reader(deps, context), context)
    line = next(f for f in facts if f.section == "untraded_fall")
    assert "In hindsight" in line.en and "net hypothetical" in line.en and "£8.00" in line.en
    assert "事后" in line.zh and "净" in line.zh and "£8.00" in line.zh


def test_earnings_and_ratings_each_cite_their_research_section(tmp_path):
    _, publish, row, _ = setup_review(tmp_path)
    role = role_registry()["decision"]
    context = DecisionContext(
        scope="invest",
        page_scope="invest",
        ticker="TEST",
        side="buy",
        decision_date=row["date"],
        horizon="20_sessions",
    )
    facts = role.facts(role.reader(publish(), context), context)
    assert len(facts) <= 4
    by_section = {line.section: line for line in facts}
    for kind, source, target in (
        ("earnings", "financials", "events"),
        ("rating_change", "analysts", "actions"),
    ):
        ref = by_section[kind].evidence
        assert ref.source == source and ref.arguments.get("analystView") == target
        assert ref.arguments["calendarEventId"].startswith("ev_")

    assert by_section["headline"].evidence.source == "publisher"


def test_legacy_decision_withholds_unverified_prior_close_and_hindsight(tmp_path):
    _, publish, row, _ = setup_review(tmp_path)
    deps = publish()
    legacy = {**row, "prior_close_date": "2026-02-02", "prior_close_gbp": 102}
    artifact = {
        "accounts": {
            "A": {
                "status": "available",
                "calculation_version": "decisions-v6",
                "as_of": "2026-03-06",
                "decisions": [legacy],
            }
        }
    }
    ref = deps.store.immutable_artifacts.put_json(key=tools.DECISIONS, payload=artifact).ref
    deps = replace(deps, manifest=republish(deps.store, {tools.DECISIONS: ref}))
    selection = DecisionContext(
        scope="invest",
        page_scope="invest",
        ticker="TEST",
        side="buy",
        decision_date=row["date"],
        horizon="20_sessions",
    )
    reader = role_registry()["decision"].reader(deps, selection)
    (selected,) = reader.read(decision_timing_and_habits, {})["data"]["items"]
    assert selected["prior_close_date"] is None and selected["prior_close_gbp"] is None
    assert selected["hindsight"] is None
    assert selected["settled_per_share_gbp"] == 40
    habits = role_registry()["habits"].reader(
        deps, HabitsContext(scope="invest", habit="basket_buy")
    )
    basket = habits.read(review_patterns, {})["data"]["groups"]["basket_buy"]
    assert (basket["count"], basket["evaluated"], basket["effect_gbp"]) == (1, 1, 18)


def test_decision_and_habit_followups_can_only_read_the_selected_object(tmp_path):
    _, publish, row, _ = setup_review(tmp_path)
    deps = publish()
    data = {
        "accounts": {
            "A": {
                "status": "available",
                "calculation_version": CALCULATION_VERSION,
                "decisions": [row, {**row, "listing": "SECOND", "settled_per_share_gbp": 80}],
                "unpriced_basket_buys": [
                    {
                        **{k: row[k] for k in ("ticker", "date", "side")},
                        "unpriced": True,
                        "basket_buy": True,
                    }
                ],
            }
        }
    }
    ref = deps.store.immutable_artifacts.put_json(key=tools.DECISIONS, payload=data).ref
    deps = replace(deps, manifest=republish(deps.store, {tools.DECISIONS: ref}))
    selection = DecisionContext(
        scope="invest",
        page_scope="broker_total",
        ticker="TEST",
        decision_date=row["date"],
        side="buy",
        ordinal=1,
        horizon="20_sessions",
    )
    reader = role_registry()["decision"].reader(deps, selection)
    (selected,) = reader.read(decision_timing_and_habits, {})["data"]["items"]
    assert selected["listing"] == "SECOND" and selected["settled_per_share_gbp"] == 80
    assert selected["prior_events"] == []
    for override in [
        {"ordinal": 0},
        {"scope": "isa"},
        {"horizon": "to_date"},
        {"ticker": "SECOND"},
        {"decision_date": "2026-02-04"},
        {"side": "sell"},
        {"since": row["date"]},
    ]:
        with pytest.raises(ModelRetry):
            reader.read(decision_timing_and_habits, override)
    habits = role_registry()["habits"].reader(
        deps, HabitsContext(scope="invest", horizon="to_date", habit="basket_buy")
    )
    groups = habits.read(review_patterns, {})["data"]["groups"]
    assert set(groups) == {"basket_buy"}
    assert groups["basket_buy"]["count"] == 3 and groups["basket_buy"]["evaluated"] == 2
    with pytest.raises(ModelRetry):
        habits.read(review_patterns, {"habit": "untraded_fall"})
    with pytest.raises(ModelRetry):
        habits.read(review_patterns, {"horizon": "20_sessions"})
    with pytest.raises(ValueError):
        reader.read(review_patterns, {})


@pytest.mark.parametrize("role_id", ["decision", "habits"])
@pytest.mark.parametrize("substitute", [False, True])
def test_review_chat_applies_its_registered_tool_selection(tmp_path, role_id, substitute):
    _, publish, row, _ = setup_review(tmp_path)
    deps = publish()
    role = role_registry()[role_id]
    context = (
        DecisionContext(
            scope="invest",
            page_scope="invest",
            ticker="TEST",
            side="buy",
            decision_date=row["date"],
            horizon="20_sessions",
        )
        if role_id == "decision"
        else HabitsContext(scope="invest", habit="basket_buy")
    )
    bindings = role.bind(deps, context)
    assert bindings.role_bindings.keys() == role.allowed_tools
    (tool,) = role.allowed_tools
    stream, _ = answer_after_tool(
        tool, json.dumps({"args": {"scope": "isa"} if substitute else {}})
    )

    async def check_tools(messages, info):
        assert [spec.name for spec in info.function_tools] == [tool]
        properties = info.function_tools[0].parameters_json_schema["properties"]
        assert not properties.keys() & bindings.role_bindings[tool].keys()
        async for chunk in stream(messages, info):
            yield chunk

    app, service = make_app(tmp_path, check_tools)
    service.agent = build_assistant_agent([tools.build_assistant_toolset()])
    service.deps_for_run = lambda page, tz: deps
    body = user_turn("review", "question", "Continue the selected reading")
    body["context"] = {
        "role": role_id,
        "page": "review",
        "scope": "invest",
        "object": context.model_dump(),
        "snapshotId": deps.snapshot_id,
    }
    response = TestClient(app).post("/v1/assistant/chat", json=body)
    assert response.status_code == 200
    outputs = [e["output"] for e in events(response.text) if e["type"] == "tool-output-available"]
    assert [r["bound_arguments"] for r in outputs] == (
        [] if substitute else [bindings.bound_evidence(tool)]
    )


def test_habit_comparison_keeps_both_horizons_on_one_selection(tmp_path):
    _, publish, _, _ = setup_review(tmp_path)
    reader = role_registry()["habits"].reader(
        publish(), HabitsContext(scope="invest", habit="basket_buy")
    )
    result = reader.read(review_patterns, {"compare_horizons": True})
    primary, other = result["data"], result["data"]["comparison"]
    assert set(primary["groups"]) == set(other["groups"]) == {"basket_buy"}
    assert (primary["horizon"], primary["groups"]["basket_buy"]["effect_gbp"]) == (
        "20_sessions",
        18,
    )
    assert (other["horizon"], other["groups"]["basket_buy"]["effect_gbp"]) == ("to_date", 9)
    assert result["bound_arguments"]["snapshotId"] == reader.deps.snapshot_id
