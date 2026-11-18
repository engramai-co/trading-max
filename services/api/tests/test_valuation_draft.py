from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel as OfflineModel

from services.api.tests.test_assistant_settings import _enable, _register
from services.api.tests.test_valuation_evidence import LONDON, MATURE, _publish
from services.api.trading_max_api.agent.service import BoundModel
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.models import AssistantPreferencesUpdate
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.research_journal import ResearchJournalStore
from services.api.trading_max_api.routes import research, valuation_draft
from services.api.trading_max_api.settings import SettingsRepository
from services.api.trading_max_api.valuation_assumptions import ValuationAssumptionsStore
from services.api.trading_max_api.valuation_drafts import DraftResult, ValuationDraftStore
from services.api.trading_max_api.watchlist import WatchlistStore

PATH = "/v1/research/SYNM"
HEADERS = {"Authorization": "Bearer synthetic"}


def selecting(transcript, choices=None):
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
                            "candidate_ids": choices
                            if choices is not None
                            else [
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


def inputs(client, requested_family=None):
    res = client.get(
        PATH.replace("/v1/", "/v2/") + "/valuation-preview",
        params={"family": requested_family} if requested_family else {},
    )
    assert res.is_success, res.text
    view = res.json()
    scenarios = {s: v["inputs"] for s, v in view["scenarios"].items()}
    return view, {
        "previewId": view["id"],
        "requestedFamily": requested_family,
        "horizon": 5,
        "scenarios": scenarios,
    }


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
    full = json.loads(json.dumps(body["scenarios"]))
    for proposal in result["proposals"]:
        head, *parts = proposal["field"].split("_")
        full[proposal["scenario"]][head + "".join(word.title() for word in parts)] = proposal[
            "value"
        ]
    projected = client.post(
        PATH.replace("/v1/", "/v2/") + "/valuation-preview",
        json={
            "family": result["family"],
            "formulaVersion": view["formulaVersion"],
            "horizon": body["horizon"],
            "scenarios": full,
        },
    ).json()
    assert result["deskReadings"] == {
        key: {field: row[field] for field in ("value", "upside")}
        for key, row in projected["scenarios"].items()
    }
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
    changed = {
        **save,
        "scenarios": {
            **save["scenarios"],
            "bear": {**save["scenarios"]["bear"], "discountRate": 0.33},
        },
    }
    assert (
        client.post(PATH + "/models", json=changed).json()["detail"]
        == "valuation-draft-decisions-invalid"
    )
    assert client.get(PATH + "/journal").json()["models"] == []
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
    assert not list(state.valuation_drafts.root.glob("*.json"))
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


def test_manual_family_choice_is_preserved_even_when_it_matches_the_engine(desk):
    client, _, _, _ = desk
    auto, body = inputs(client)
    assert auto["familySelection"] == "automatic"
    model = {
        "family": "cash-flow",
        "scenarios": body["scenarios"],
        "formulaVersion": auto["formulaVersion"],
    }
    model["scenarios"]["base"]["revenueCagr"] = 0.22
    assert client.post(PATH + "/models", json=model).is_success
    previous, _ = inputs(client)
    view, _ = inputs(client, "cash-flow")
    assert view["defaultSource"] == "saved-model"
    assert view["id"] == previous["id"]
    assert view["scenarios"]["base"]["inputs"]["revenueCagr"] == 0.22
    assert view["familySelection"] == "override"
    saved = client.post(PATH + "/models", json={**model, "familySelection": "override"}).json()
    assert len(saved["models"]) == 2
    assert saved["models"][0]["preview"]["familySelection"] == "override"
    reopened, inherited = inputs(client)
    assert reopened["familySelection"] == "override"
    result = post(client, inherited)[-1]["result"]
    assert result["familySelection"] == "override"
    decisions = {k: {} for k in body["scenarios"]}
    for proposal in result["proposals"]:
        decisions[proposal["scenario"]][proposal["field"]] = "rejected"
    reviewed = client.post(
        PATH + "/models",
        json={**model, "draftReview": {"id": result["id"], "decisions": decisions}},
    ).json()
    assert reviewed["models"][0]["preview"]["familySelection"] == "override"
    assert reviewed["models"][0]["draftAudit"]["draft"]["result"]["familySelection"] == "override"


@pytest.mark.parametrize("override", [False, True])
@pytest.mark.parametrize("family", ["residual-income", "net-income"])
def test_draft_fields_follow_the_selected_engine(desk, family, override):
    client, state, _, transcript = desk

    def add_family(batches):
        row = batches["research/financials.json"]["rows"][0]["financials"]
        dates = row["quarterlyIncomeStatement"][0].keys() - {"index"}
        row["quarterlyIncomeStatement"].append(
            {"index": "Net Income Common Stockholders", **dict.fromkeys(dates, 100)}
        )
        row["quarterlyBalanceSheet"] = [
            {"index": "Common Stock Equity", **dict.fromkeys(dates, 2000)}
        ]
        batches["research/valuation.json"]["rows"][0]["assumptions"]["family"] = (
            "cash-flow" if override else family
        )

    _publish(state.store, MATURE, inject=add_family)
    view, body = inputs(client, family if override else None)
    if override:
        saved = client.post(
            PATH + "/models",
            json={
                "family": family,
                "scenarios": body["scenarios"],
                "formulaVersion": view["formulaVersion"],
            },
        )
        assert saved.is_success
        reopened, inherited = inputs(client)
        assert inherited["requestedFamily"] is None
        assert reopened["familySelection"] == "override" and reopened["basis"]["family"] == family
        body = inherited
    pick = (
        "base.initial_roe.common-roe"
        if family == "residual-income"
        else "base.target_fcf_margin.statement-margin"
    )

    async def bind():
        return BoundModel(selecting(transcript, [pick]), {})

    state.assistant.bind_model = bind
    result = post(client, body)[-1]["result"]
    fields = {p["field"] for p in result["proposals"]}
    expect = (
        {"initial_roe", "discount_rate", "payout", "terminal_pb"}
        if family == "residual-income"
        else {
            "revenue_cagr",
            "target_fcf_margin",
            "discount_rate",
            "exit_fcf_multiple",
            "share_cagr",
            "ramp_years",
        }
    )
    assert result["family"] == family
    assert result["familySelection"] == ("override" if override else "automatic")
    # Reopening a saved version reviews new evidence: only the changed field is proposed.
    assert fields == ({pick.split(".")[1]} if override else expect)
    if family == "residual-income":
        reading = transcript[-1]["scenarios"]["base"]
        assert reading["discountedTerminalPremium"] != reading["discountedTerminalValue"]
        assert reading["terminalFraction"] == pytest.approx(
            reading["discountedTerminalValue"] / reading["perShare"]
        )
    selected = next(
        p for p in result["proposals"] if p["scenario"] == "base" and p["category"] == "derived"
    )
    assert selected["value"] == pytest.approx(
        400 / 2000 if family == "residual-income" else 400 / 4000
    )


def test_only_deferred_evaluated_candidates_can_leave_the_run(desk, monkeypatch):
    client, state, _, _ = desk
    _, body = inputs(client)

    def use_model(model):
        async def bind():
            return BoundModel(model, {})

        state.assistant.bind_model = bind

    def repeating(messages, info):
        return ModelResponse(parts=[ToolCallPart("get_valuation_basis", {})])

    for model in [
        OfflineModel(call_tools=["get_valuation_basis"]),
        selecting([], ["base.discount_rate.invented"]),
        FunctionModel(repeating),
    ]:
        use_model(model)
        assert post(client, body)[-1]["phase"] == "error"
        assert not state.valuation_drafts.root.exists()
    from services.api.trading_max_api.agent import valuation

    monkeypatch.setattr(valuation, "MAX_EVIDENCE_BYTES", 48)
    use_model(selecting([]))
    assert post(client, body)[-1]["code"] == "assistant_limit_reached"
    assert not state.valuation_drafts.root.exists()


@pytest.mark.parametrize("revoke", [True, False])
def test_revocation_or_disconnect_cancels_pending_provider_and_releases_workspace(
    desk, revoke, tmp_path
):

    client, state, _, _ = desk
    _, body = inputs(client)

    preferences = SettingsRepository(tmp_path / "consent")
    _register(preferences, "ollama", "local-model", key=False)
    _enable(preferences, "ollama/local-model")
    state.settings_repository = preferences

    async def exercise():
        started, cancelled = asyncio.Event(), asyncio.Event()
        _, _, token = preferences.assistant_connection_snapshot()

        async def block(messages, info):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def bind():
            return BoundModel(FunctionModel(block), {}, token)

        state.assistant.bind_model = bind

        async def connected():
            return False

        request = SimpleNamespace(app=SimpleNamespace(state=state), is_disconnected=connected)
        response = await valuation_draft.valuation_draft(
            "SYNM", valuation_draft.DraftInput.model_validate(body), request
        )
        assert '"preparing"' in await anext(response.body_iterator)
        await asyncio.wait_for(started.wait(), 3)
        if revoke:
            preferences.save_assistant_preferences(
                AssistantPreferencesUpdate(enabled=False, accepted_consent_revision=None)
            )
            async with asyncio.timeout(3):
                events = [json.loads(event) async for event in response.body_iterator]
            assert events[-1]["code"] == "valuation-draft-settings-changed"
        else:
            await response.body_iterator.aclose()
        assert cancelled.is_set()
        assert not state.valuation_drafts.running.locked()

    try:
        asyncio.run(exercise())
    finally:
        preferences.close()
    assert not state.valuation_drafts.root.exists()


@pytest.mark.parametrize("change", [{"fx": 1.16}, {"share_count": 119}, {"restated": True}])
def test_save_rechecks_fx_shares_and_statements(desk, change):
    client, state, _, _ = desk
    issuer = replace(MATURE, reporting="EUR", fx=1.15)
    _publish(state.store, issuer)
    view, body = inputs(client)
    result = post(client, body)[-1]["result"]
    decisions = {s: {} for s in body["scenarios"]}
    for p in result["proposals"]:
        decisions[p["scenario"]][p["field"]] = "unreviewed"
    _publish(state.store, replace(issuer, **change))
    response = client.post(
        PATH + "/models",
        json={
            "family": "cash-flow",
            "formulaVersion": view["formulaVersion"],
            "scenarios": body["scenarios"],
            "draftReview": {"id": result["id"], "decisions": decisions},
        },
    )
    assert (
        response.status_code == 409
        and response.json()["detail"] == "valuation-draft-review-required"
    )
    assert client.get(PATH + "/journal").json()["models"] == []


def test_every_proposal_resolves_to_a_frozen_source(desk):
    from pydantic import ValidationError

    client, _, _, _ = desk
    _, body = inputs(client)
    result = post(client, body)[-1]["result"]
    for p in result["proposals"]:
        if p["source"] == "sector-template":
            origin = result["origins"][p["originId"]]
            assert origin["source"] == "sector-template" and origin["inputs"]["profile"]
            assert origin["inputs"]["effectiveDiscountRate"] > 0
            assert origin["evidenceIds"] and set(origin["evidenceIds"]) <= result["evidence"].keys()
        else:
            assert p["evidenceIds"] and set(p["evidenceIds"]) <= result["evidence"].keys()
    DraftResult.model_validate(result)
    # A persisted record cannot silently replace the field's frozen value.
    next(p for p in result["proposals"] if p["source"] == "sector-template")["value"] = 0.573232
    with pytest.raises(ValidationError):
        DraftResult.model_validate(result)


def test_saved_source_records_respect_the_privacy_switch(desk):
    client, state, prefs, transcript = desk
    view, body = inputs(client)
    body["scenarios"]["base"]["discountRate"] = 0.345678
    journal = client.post(
        PATH + "/models",
        json={
            "scenarios": body["scenarios"],
            "formulaVersion": view["formulaVersion"],
            "reason": "private reason",
        },
    ).json()
    assert "draftAudit" not in journal["models"][0]
    journal_file = next(state.research_journal.root.glob("*.json"))
    assert "draftAudit" not in json.loads(journal_file.read_text())["models"][0]
    _, body = inputs(client)

    async def bind():
        return BoundModel(selecting(transcript, []), {})

    state.assistant.bind_model = bind
    for shared in (True, False):
        prefs.share_valuation_assumptions = shared
        result = post(client, body)[-1]["result"]
        # The saved version is the starting point, never a proposal of its own.
        assert result["proposals"] == [] and result["origins"] == {}
        assert journal["models"][0]["id"] not in json.dumps(transcript)
        basis = transcript[0]
        saved_origins = [v for v in basis["origins"].values() if v["source"] == "saved-assumption"]
        assert not any(c["source"] == "saved-assumption" for c in basis["candidates"].values())
        if shared:
            assert set(basis) == {
                "family",
                "listing",
                "horizon",
                "asOf",
                "items",
                "origins",
                "candidates",
            }
            assert [set(origin) for origin in saved_origins] == [{"source", "scenarios"}]
            assert saved_origins[0]["scenarios"]["base"]["discountRate"] == 0.345678
        else:
            assert saved_origins == []
        assert ("0.345678" in json.dumps(transcript)) == shared
        assert "private reason" not in json.dumps(result) + json.dumps(transcript)


def test_reopen_exact_hardware_template(desk):
    client, state, _, _ = desk

    def hardware(batches):
        batches["research/valuation.json"]["rows"][0]["assumptions"]["profile"] = "hardware"

    _publish(state.store, replace(MATURE, industry="Computer Hardware"), inject=hardware)
    view, body = inputs(client)
    result = post(client, body)[-1]["result"]
    p = next(
        p
        for p in result["proposals"]
        if p["field"] == "exit_fcf_multiple" and p["scenario"] == "base"
    )
    assert p["value"] == 16
    assert view["scenarios"]["base"]["inputs"]["exitFcfMultiple"] == 16


def test_new_consensus_after_delivery_requires_review_before_save(desk):
    client, state, _, _ = desk
    view, body = inputs(client)
    draft = post(client, body)[-1]["result"]
    original_snapshot = state.store.latest_manifest().run_id
    assert draft["snapshotId"] == original_snapshot

    def new_estimate(batches):
        batches["research/analyst.json"]["rows"][0]["analyst"]["revenueEstimate"][0]["growth"] = (
            0.31
        )

    _publish(state.store, MATURE, inject=new_estimate)
    assert inputs(client)[0]["id"] == view["id"]
    values = body["scenarios"]
    decisions = {key: {} for key in values}
    for p in draft["proposals"]:
        decisions[p["scenario"]][p["field"]] = "unreviewed"
    values["base"]["revenueCagr"] = 0.15
    decisions["base"]["revenue_cagr"] = "accepted"
    saved = client.post(
        PATH + "/models",
        json={
            "family": "cash-flow",
            "formulaVersion": view["formulaVersion"],
            "scenarios": values,
            "draftReview": {"id": draft["id"], "decisions": decisions},
        },
    )
    assert saved.status_code == 409 and saved.json()["detail"] == "valuation-draft-review-required"
    assert client.get(PATH + "/journal").json()["models"] == []


def _reviewed_consensus(client):
    view, body = inputs(client)
    draft = post(client, body)[-1]["result"]
    decisions = {key: {} for key in body["scenarios"]}
    for proposal in draft["proposals"]:
        decisions[proposal["scenario"]][proposal["field"]] = "unreviewed"
    decisions["base"]["revenue_cagr"] = "accepted"
    body["scenarios"]["base"]["revenueCagr"] = 0.15
    return {
        "family": "cash-flow",
        "formulaVersion": view["formulaVersion"],
        "scenarios": body["scenarios"],
        "draftReview": {"id": draft["id"], "decisions": decisions},
    }


def _replace_consensus(store):
    def update(batches):
        batches["research/analyst.json"]["rows"][0]["analyst"]["revenueEstimate"][0]["growth"] = (
            0.31
        )

    _publish(store, MATURE, inject=update)


def test_publication_during_save_calculation_requires_review(desk, monkeypatch):
    client, state, _, _ = desk
    body = _reviewed_consensus(client)
    pinned = state.store.latest_manifest().run_id
    calculate = research.family_valuation_preview
    observed = []

    def interleave(*args, **kwargs):
        _replace_consensus(ArtifactStore(state.store.data_root))
        observed.append(kwargs.get("manifest"))
        return calculate(*args, **kwargs)

    monkeypatch.setattr(research, "family_valuation_preview", interleave)
    response = client.post(PATH + "/models", json=body)
    assert response.status_code == 409
    assert response.json()["detail"] == "valuation-draft-review-required"
    assert [manifest.run_id for manifest in observed] == [pinned]
    assert client.get(PATH + "/journal").json()["models"] == []


@pytest.mark.parametrize("change", ["publication", "parent"])
def test_publication_or_parent_during_final_desk_projection_prevents_delivery(
    desk, monkeypatch, change
):
    from trading_max.research.valuation_preview import ValuationPreview

    client, state, _, _ = desk
    view, body = inputs(client)
    project = valuation_draft.preview
    calls = 0

    def interleave(*args, **kwargs):
        nonlocal calls
        calls += 1
        result = project(*args, **kwargs)
        if calls == 2:
            if change == "publication":
                _replace_consensus(ArtifactStore(state.store.data_root))
            else:
                state.research_journal.save_model(ValuationPreview.model_validate(view))
        return result

    monkeypatch.setattr(valuation_draft, "preview", interleave)
    assert post(client, body)[-1].get("code") == "valuation-draft-review-required"
    assert calls == 2
    assert not list(state.valuation_drafts.root.glob("*.json"))


def test_contended_draft_delivery_allows_a_concurrent_health_probe(desk, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    client, state, _, _ = desk
    _, body = inputs(client)
    journal = state.research_journal
    lock = journal.lock
    projected, held, waiting = Event(), Event(), Event()
    calculate = valuation_draft.family_valuation_preview
    calls = 0

    @client.app.get("/health-probe")
    async def health_probe():
        return {"ready": True}

    def final_projection(*args, **kwargs):
        nonlocal calls
        result = calculate(*args, **kwargs)
        calls += 1
        if calls == 2:
            projected.set()
            assert held.wait(5)
        return result

    class ObservedLock:
        def __enter__(self):
            if held.is_set():
                waiting.set()
            return lock.__enter__()

        def __exit__(self, *exc):
            return lock.__exit__(*exc)

    monkeypatch.setattr(journal, "lock", ObservedLock())
    monkeypatch.setattr(valuation_draft, "family_valuation_preview", final_projection)
    with ThreadPoolExecutor(max_workers=2) as pool:
        delivery = pool.submit(post, client, body)
        assert projected.wait(5)
        with lock:
            held.set()
            assert waiting.wait(5)
            probe = pool.submit(client.get, "/health-probe")
            assert probe.result(timeout=0.4).json() == {"ready": True}
        assert delivery.result(timeout=5)[-1]["phase"] == "complete"


def test_large_review_history_keeps_the_publication_lock_brief(desk, monkeypatch):
    from contextlib import contextmanager
    from time import perf_counter
    from uuid import uuid4

    client, state, _, _ = desk
    first = _reviewed_consensus(client)
    assert client.post(PATH + "/models", json=first).is_success
    journal = state.research_journal
    history = journal.load("SYNM")
    previous = history.models[0]
    for i in range(249):
        older = previous.model_copy(deep=True)
        older.id = f"older-{i}"
        older.draft_audit.review.id = older.draft_audit.draft.result.id = uuid4()
        history.models.append(older)
    journal._save(history)
    body = _reviewed_consensus(client)
    snapshots = state.store.immutable_snapshots
    pointer = snapshots.publication_lock
    durations = []

    @contextmanager
    def timed_lock():
        with pointer():
            start = perf_counter()
            try:
                yield
            finally:
                durations.append(perf_counter() - start)

    monkeypatch.setattr(snapshots, "publication_lock", timed_lock)
    response = client.post(PATH + "/models", json=body)
    assert response.is_success
    assert len(durations) == 1
    # Checks the lock's scope, not runner speed: the whole request with this history takes over a second.
    assert durations[0] < 0.5


def test_pointer_replacement_waits_for_the_reviewed_journal_commit(desk, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import contextmanager
    from threading import Event

    client, state, _, _ = desk
    body = _reviewed_consensus(client)
    writer = ArtifactStore(state.store.data_root)
    pointer = writer.immutable_snapshots.publication_lock
    from pathlib import Path

    target = state.research_journal._path("SYNM")
    replace_file = Path.replace
    attempting = Event()
    finished = Event()

    @contextmanager
    def writer_lock():
        attempting.set()
        with pointer():
            yield

    def publish():
        _replace_consensus(writer)
        finished.set()

    with ThreadPoolExecutor(max_workers=1) as pool:

        def commit(source, destination):
            if destination == target:
                pool.submit(publish)
                assert attempting.wait(5)
                assert not finished.wait(0.1)
            return replace_file(source, destination)

        monkeypatch.setattr(writer.immutable_snapshots, "publication_lock", writer_lock)
        monkeypatch.setattr(Path, "replace", commit)
        assert client.post(PATH + "/models", json=body).is_success
    assert finished.is_set()
    saved = client.get(PATH + "/journal").json()["models"][0]
    assert saved["draftAudit"]["draft"]["result"]["snapshotId"] != writer.latest_manifest().run_id


def test_new_publication_discards_the_draft_even_if_the_desk_basis_is_unchanged(desk):
    client, state, _, _ = desk
    _, body = inputs(client)
    bind = state.assistant.bind_model

    async def republish():
        _publish(state.store, MATURE)
        return await bind()

    state.assistant.bind_model = republish
    assert post(client, body)[-1]["code"] == "valuation-draft-review-required"
    assert not state.valuation_drafts.root.exists()


def test_permission_revocation_during_final_basis_read(desk, monkeypatch):
    client, state, prefs, _ = desk
    _, body = inputs(client)
    reader = state.research.held_position
    count = 0

    def revoke(*args):
        nonlocal count
        count += 1
        if count == 2:
            state.settings_repository.get_assistant_preferences = lambda: SimpleNamespace(
                **{**vars(prefs), "revision": 2, "share_valuation_assumptions": False}
            )
        return reader(*args)

    monkeypatch.setattr(state.research, "held_position", revoke)
    assert post(client, body)[-1].get("code") == "valuation-draft-settings-changed"
    assert not list(state.valuation_drafts.root.glob("*.json"))


def test_withheld_reverse_reading_discards_the_proposal(desk, monkeypatch):
    from trading_max.research.valuation_evidence import ValuationEvidenceTools

    client, state, _, _ = desk
    _, body = inputs(client)
    evaluate = ValuationEvidenceTools.evaluate_valuation
    monkeypatch.setattr(
        ValuationEvidenceTools,
        "evaluate_valuation",
        lambda self, req: evaluate(self, req).model_copy(update={"reverse_dcf": None}),
    )
    assert post(client, body)[-1]["code"] == "valuation-reverse-withheld"
    assert not state.valuation_drafts.root.exists()


def test_family_aware_contract_without_revenue_and_explicit_override(desk):
    client, state, _, transcript = desk

    def bank(batches):
        raw = batches["research/financials.json"]["rows"][0]["financials"]
        dates = raw["quarterlyIncomeStatement"][0].keys() - {"index"}
        raw.pop("incomeStatement", None)
        raw["quarterlyIncomeStatement"] = [
            {"index": "Net Income Common Stockholders", **dict.fromkeys(dates, 100)}
        ]
        raw["quarterlyBalanceSheet"] = [
            {"index": "Common Stock Equity", **dict.fromkeys(dates, 2000)}
        ]
        batches["research/valuation.json"]["rows"][0]["assumptions"]["family"] = "residual-income"

    _publish(state.store, MATURE, inject=bank)

    async def bind():
        return BoundModel(selecting(transcript, []), {})

    state.assistant.bind_model = bind
    view, body = inputs(client)
    assert view["basis"]["revenue"] is None and view["basis"]["family"] == "residual-income"
    result = post(client, body)[-1]["result"]
    DraftResult.model_validate(result)
    # Requesting a family that needs revenue must fail before contacting the model.
    assert (
        client.get(
            "/v2/research/SYNM/valuation-preview", params={"family": "cash-flow"}
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    ("is_adr", "reason"),
    [(True, "receipt-ratio-unverified"), (False, "listed-share-unit-unverified")],
)
def test_unverified_shares_block_the_desk_and_draft_for_the_same_reason(desk, is_adr, reason):
    client, state, _, transcript = desk
    _, body = inputs(client)

    def ambiguous(batches):
        stored = batches["research/valuation.json"]["rows"][0]["assumptions"]
        stored.pop("shareUnit")
        stored["isAdr"] = is_adr

    _publish(state.store, MATURE, inject=ambiguous)
    response = client.get("/v2/research/SYNM/valuation-preview")
    assert response.status_code == 422 and response.json()["detail"] == reason
    assert post(client, body)[-1]["code"] == reason
    assert not transcript and not list(state.valuation_drafts.root.glob("*.json"))


@pytest.mark.parametrize(
    ("issuer", "shares", "ratio", "spot"),
    [
        (replace(LONDON, reporting="EUR", fx=0.85), 100, None, 24.65),
        (replace(MATURE, ticker="BABA", reporting="EUR", fx=1.25, share_count=800), 100, 8, 25),
    ],
    ids=["pence-with-fx", "ordinary-shares-per-ads"],
)
def test_draft_uses_the_verified_desk_listing_basis(desk, issuer, shares, ratio, spot):
    client, state, _, _ = desk

    def statement_shares(batches):
        if ratio is None:
            return
        raw = batches["research/financials.json"]["rows"][0]["financials"]
        dates = raw["quarterlyIncomeStatement"][0].keys() - {"index"}
        raw["quarterlyBalanceSheet"] = [
            {"index": "Ordinary Shares Number", **dict.fromkeys(dates, issuer.share_count)}
        ]

    _publish(state.store, issuer, inject=statement_shares)
    view = client.get(f"/v2/research/{issuer.ticker}/valuation-preview").json()
    body = {
        "previewId": view["id"],
        "horizon": 5,
        "scenarios": {key: p["inputs"] for key, p in view["scenarios"].items()},
    }
    response = client.post(f"/v1/research/{issuer.ticker}/valuation-draft", json=body)
    event = json.loads(response.text.splitlines()[-1])
    assert event["phase"] == "complete", event
    basis = next(iter(event["result"]["origins"].values()))["inputs"]["basis"]
    for field, expected in {
        "currency": issuer.quote_currency,
        "reportingCurrency": issuer.reporting,
        "spot": spot,
        "fxRate": issuer.fx,
        "shares": shares,
        "ordinaryPerReceipt": ratio,
    }.items():
        assert basis[field] == view["basis"][field] == expected


def test_withheld_desk_range_does_not_contact_the_provider(desk, monkeypatch):
    client, state, _, transcript = desk
    _, body = inputs(client)
    calculate = valuation_draft.family_valuation_preview

    def withheld(*args, **kwargs):
        return calculate(*args, **kwargs).model_copy(
            update={
                "reverse_value": None,
                "reverse_bound": None,
                "reverse_reason": "target-margin-not-unique",
            }
        )

    monkeypatch.setattr(valuation_draft, "family_valuation_preview", withheld)
    assert post(client, body)[-1]["code"] == "target-margin-not-unique"
    assert not transcript and not state.valuation_drafts.root.exists()


def test_pending_capacity_excludes_previously_saved_reviews(desk):
    from uuid import UUID, uuid4

    client, state, _, _ = desk
    view, body = inputs(client)
    result = post(client, body)[-1]["result"]
    pending = state.valuation_drafts
    record = pending.get(UUID(result["id"]))
    decisions = {s: {} for s in body["scenarios"]}
    for p in result["proposals"]:
        decisions[p["scenario"]][p["field"]] = "unreviewed"
    parent = None
    for _ in range(17):
        staged = record.model_copy(
            update={
                "result": record.result.model_copy(update={"id": uuid4()}),
                "parent_model_id": parent,
            }
        )
        pending.put(staged)
        save = {
            "family": "cash-flow",
            "formulaVersion": view["formulaVersion"],
            "scenarios": body["scenarios"],
            "draftReview": {"id": str(staged.result.id), "decisions": decisions},
        }
        response = client.post(PATH + "/models", json=save)
        assert response.status_code == 200, response.text
        parent = response.json()["models"][0]["id"]
    assert [p.stem for p in pending.root.glob("*.json")] == [result["id"]]
    assert client.post(PATH + "/models", json=save).status_code == 200
    for _ in range(17):
        pending.put(
            record.model_copy(update={"result": record.result.model_copy(update={"id": uuid4()})})
        )
    assert len(list(pending.root.glob("*.json"))) == 16


@pytest.mark.parametrize(
    "industry",
    [
        "Semiconductors",
        "Data Infrastructure",
        "Computer Hardware",
        "Power",
        "Banks",
        "Retail",
        "Unclassified",
    ],
)
def test_each_published_profile_identifier_reopens_the_same_template(industry):
    from trading_max.research.fundamentals import _sector_profile, sector_profile_by_label

    profile, key = _sector_profile("", industry)
    assert sector_profile_by_label(key) == profile
    assert sector_profile_by_label(profile.label) == profile


def test_final_consent_check_cleans_up_a_revoked_pending_write(desk, monkeypatch):
    client, state, prefs, _ = desk
    _, body = inputs(client)
    write = state.valuation_drafts.put

    def revoke(record):
        write(record)
        prefs.share_valuation_assumptions = False
        prefs.revision += 1

    monkeypatch.setattr(state.valuation_drafts, "put", revoke)
    assert post(client, body)[-1]["code"] == "valuation-draft-settings-changed"
    assert not list(state.valuation_drafts.root.glob("*.json"))
