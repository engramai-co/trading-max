"""Synthetic decision-time evidence, material habit changes and pinned cache reuse."""

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from pydantic_ai.models.test import TestModel
from trading_max.analytics.decision_review import CALCULATION_VERSION
from trading_max.research.news import NEWS_KEY

from services.api.tests.test_assistant_insights import republish
from services.api.tests.test_assistant_readings import job, sample
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.insights import ReviewArgs, decision_timing_and_habits
from services.api.trading_max_api.agent.review_patterns import EVIDENCE, HabitArgs, review_patterns
from services.api.trading_max_api.agent.review_roles import DecisionContext, HabitsContext, targets
from services.api.trading_max_api.agent.roles import RoleTools, role_registry
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
    read = RoleTools.pinned(publish(), frozenset({"decision_timing_and_habits", "review_patterns"}))
    expected = json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "apps/web/workspace/assistant/__fixtures__/review-tools.json"
        ).read_text()
    )
    results = {
        "decision": read.read(
            decision_timing_and_habits,
            ReviewArgs(
                scope="invest",
                ticker="TEST",
                decision_date=row["date"],
                side="buy",
                horizon="20_sessions",
            ),
        ),
        "habits": read.read(review_patterns, HabitArgs(scope="invest", horizon="to_date")),
    }
    for name, result in results.items():
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
    facts = role.facts(RoleTools.pinned(deps, role.allowed_tools), context)

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
    assert "2026-01-29" in lines["earnings"].en and "Synthetic Research" in lines["earnings"].en
    assert "In hindsight" in lines["hindsight"].en and "£12.00" in lines["hindsight"].en
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
            RoleTools.pinned(deps, role.allowed_tools), context.model_copy(update={"scope": "isa"})
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
    row["horizon_complete"] = False
    assert asyncio.run(run(publish(), cached_only=True))[-1].type == "empty"


def test_pre_trade_leads_respect_the_earliest_fill_in_utc(tmp_path):
    from zoneinfo import ZoneInfo

    _, publish, row, _ = setup_review(tmp_path)
    row["first_fill_at"] = "2026-02-03T02:00:00Z"
    deps = publish()
    items = [
        {"date": "2026-02-02", "title": "Date only, order uncertain"},
        {"instant": "2026-02-03T01:00:00Z", "title": "Verified before the fill"},
        {"instant": "2026-02-03T03:00:00Z", "title": "Later than the fill"},
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
        pinned = RoleTools.pinned(replace(deps, timezone=ZoneInfo(zone)), role.allowed_tools)
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
    facts = role.facts(RoleTools.pinned(deps, role.allowed_tools), HabitsContext(scope="invest"))
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
    facts = role.facts(RoleTools.pinned(publish(), role.allowed_tools), context)
    assert len(facts) <= 4
    by_section = {line.section: line for line in facts}
    for kind, source, target in (
        ("earnings", "financials", "events"),
        ("rating_change", "analysts", "ratings"),
    ):
        ref = by_section[kind].evidence
        assert ref.source == source and ref.arguments.get("analystView") == target
    assert by_section["headline"].evidence.source == "publisher"
