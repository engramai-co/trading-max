"""Synthetic decision-time evidence, material habit changes and pinned cache reuse."""

import asyncio
from dataclasses import replace
from datetime import UTC, datetime

from pydantic_ai.models.test import TestModel
from trading_max.analytics.decision_review import CALCULATION_VERSION
from trading_max.research.news import NEWS_KEY

from services.api.tests.test_assistant_insights import republish
from services.api.tests.test_assistant_readings import job, sample
from services.api.trading_max_api.agent import tools
from services.api.trading_max_api.agent.review_patterns import EVIDENCE
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
