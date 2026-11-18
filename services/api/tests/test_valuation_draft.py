from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel

from services.api.tests.test_valuation_evidence import MATURE, _publish
from services.api.trading_max_api.agent.service import BoundModel
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.research_journal import ResearchJournalStore
from services.api.trading_max_api.routes import research, valuation_draft
from services.api.trading_max_api.valuation_assumptions import ValuationAssumptionsStore
from services.api.trading_max_api.valuation_drafts import ValuationDraftStore
from services.api.trading_max_api.watchlist import WatchlistStore

PATH = "/v1/research/SYNM"
HEADERS = {"Authorization": "Bearer synthetic"}


def selecting(transcript):
    def step(messages, info):
        transcript[:] = [
            p.content for m in messages for p in m.parts if isinstance(p, ToolReturnPart)
        ]
        if not transcript:
            calls = [
                ToolCallPart(name, {})
                for name in (
                    "get_valuation_basis",
                    "get_expectations_and_changes",
                    "get_operating_evidence",
                    "get_market_references",
                )
            ]
        elif "evaluation_id" not in transcript[-1]:
            calls = [
                ToolCallPart(
                    "evaluate_valuation",
                    {
                        "selection": {
                            "candidate_ids": [
                                "base.revenue_cagr.consensus-growth",
                                "bull.target_fcf_margin.statement-margin",
                            ]
                        }
                    },
                )
            ]
        else:
            calls = [
                ToolCallPart(
                    "propose_valuation", {"evaluation_id": transcript[-1]["evaluation_id"]}
                )
            ]
        return ModelResponse(parts=calls)

    return FunctionModel(step)


@pytest.fixture
def desk(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(research.router)
    app.include_router(valuation_draft.router)
    state = app.state
    state.store = ArtifactStore(tmp_path)
    _publish(state.store, MATURE)
    state.settings = SimpleNamespace(api_token="synthetic")
    state.research = ResearchLedger(state.store, WatchlistStore(tmp_path))
    state.research_journal = ResearchJournalStore(tmp_path)
    state.valuation_drafts = ValuationDraftStore(tmp_path)
    state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    state.estimate_history = SimpleNamespace(valuation_window=lambda *_a, **_kw: [])
    prefs = SimpleNamespace(
        revision=1, enabled=True, accepted_consent_revision=2, share_valuation_assumptions=True
    )
    monkeypatch.setattr(valuation_draft, "ASSISTANT_CONSENT_REVISION", 2)
    state.settings_repository = SimpleNamespace(get_assistant_preferences=lambda: prefs)
    transcript = []
    model = selecting(transcript)

    async def bind():
        return BoundModel(model, {})

    state.assistant = SimpleNamespace(bind_model=bind)
    with TestClient(app, headers=HEADERS) as client:
        yield client, state, prefs, transcript


def inputs(client):
    res = client.get(PATH + "/valuation-preview")
    assert res.is_success, res.text
    view = res.json()
    scenarios = {s: v["inputs"] for s, v in view["scenarios"].items()}
    return view, {"previewId": view["id"], "horizon": 5, "scenarios": scenarios}


def post(client, body):
    response = client.post(PATH + "/valuation-draft", json=body)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines()]


def test_draft_review_saves_only_accepted_fields_and_retries_once(desk):
    client, state, _, transcript = desk
    view, body = inputs(client)
    body["scenarios"]["bear"]["discountRate"] = 0.538945
    events = post(client, body)
    assert events[-1]["phase"] == "complete", events
    assert len(transcript) == 5
    assert "0.538945" not in json.dumps(transcript)
    result = events[-1]["result"]
    assert len(result["proposals"]) == 18
    chosen = next(
        p for p in result["proposals"] if p["scenario"] == "base" and p["field"] == "revenue_cagr"
    )
    assert chosen["category"] == "consensus" and chosen["evidenceIds"][0] in result["evidence"]
    assert client.get(PATH + "/journal").json()["models"] == []
    decisions = {k: {} for k in body["scenarios"]}
    for p in result["proposals"]:
        decisions[p["scenario"]][p["field"]] = "accepted" if p == chosen else "rejected"
    save = {
        "family": "cash-flow",
        "horizon": 5,
        "scenarios": body["scenarios"],
        "formulaVersion": view["formulaVersion"],
        "draftReview": {"id": result["id"], "decisions": decisions},
    }
    save["scenarios"]["base"]["revenueCagr"] = chosen["value"]
    # A new process can still validate the private pending record.
    state.valuation_drafts = ValuationDraftStore(state.store.data_root)
    for _ in range(2):
        response = client.post(PATH + "/models", json=save)
        assert response.status_code == 200, response.text
        journal = response.json()
        assert journal["baselineModelId"] is None
        assert len(journal["models"]) == 1
        model = journal["models"][0]
        assert model["draftAudit"]["review"]["decisions"] == decisions
        assert model["preview"]["scenarios"]["base"]["inputs"]["revenueCagr"] == chosen["value"]
        assert model["preview"]["scenarios"]["bear"]["inputs"]["discountRate"] == 0.538945
    save["reason"] = "changed after save"
    assert client.post(PATH + "/models", json=save).status_code == 409


def test_recheck_parent_and_actual_broker_quote_at_save(desk, monkeypatch):
    client, state, _, _ = desk
    held = {
        "listing": MATURE.listing,
        "price": 965.543,
        "currency": "USD",
        "asOf": "2026-02-13T14:00:00Z",
    }
    monkeypatch.setattr(state.research, "held_position", lambda *_: held)
    view, body = inputs(client)
    result = post(client, body)[-1]["result"]
    decisions = {s: {} for s in body["scenarios"]}
    for p in result["proposals"]:
        decisions[p["scenario"]][p["field"]] = "unreviewed"
    save = {
        "family": "cash-flow",
        "scenarios": body["scenarios"],
        "formulaVersion": view["formulaVersion"],
        "draftReview": {"id": result["id"], "decisions": decisions},
    }
    assert "965.543" not in json.dumps(desk[3])
    held["price"] += 1
    assert (
        client.post(PATH + "/models", json=save).json()["detail"]
        == "valuation-draft-review-required"
    )
    held["price"] -= 1
    manual = client.post(
        PATH + "/models", json={k: v for k, v in save.items() if k != "draftReview"}
    )
    assert manual.is_success
    assert (
        client.post(PATH + "/models", json=save).json()["detail"]
        == "valuation-draft-review-required"
    )


@pytest.mark.parametrize("sharing", [False, True])
def test_share_only_saved_numeric_assumptions(desk, sharing):
    client, _, prefs, transcript = desk
    view, body = inputs(client)
    body["scenarios"]["base"]["discountRate"] = 0.456789
    assert client.post(
        PATH + "/models",
        json={
            "scenarios": body["scenarios"],
            "formulaVersion": view["formulaVersion"],
            "reason": "sensitive private note",
        },
    ).is_success
    _, body = inputs(client)
    prefs.share_valuation_assumptions = sharing
    assert post(client, body)[-1]["phase"] == "complete"
    outbound = json.dumps(transcript)
    assert ("0.456789" in outbound) == sharing
    assert "sensitive private note" not in outbound


def test_gates_limits_timeout_and_stale_editor(desk, monkeypatch):
    client, state, prefs, transcript = desk
    _, body = inputs(client)
    assert (
        client.post(
            PATH + "/valuation-draft", json=body, headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )
    prefs.enabled = False
    assert client.post(PATH + "/valuation-draft", json=body).status_code == 403
    prefs.enabled = True
    with state.valuation_drafts.running:
        assert post(client, body)[-1]["code"] == "assistant_busy"
    assert (
        post(client, {**body, "previewId": "older"})[-1]["code"]
        == "valuation-draft-review-required"
    )
    assert not transcript

    async def slow():
        await asyncio.sleep(5)

    state.assistant.bind_model = slow
    monkeypatch.setattr(valuation_draft, "TIMEOUT", 0.025)
    assert post(client, body)[-1]["code"] == "assistant_timeout"
    assert not state.valuation_drafts.running.locked()
    assert not state.valuation_drafts.root.exists()
