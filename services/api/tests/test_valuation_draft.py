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

from services.api.tests.test_valuation_evidence import LONDON, MATURE, _publish
from services.api.trading_max_api.agent.service import BoundModel
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.research_journal import ResearchJournalStore
from services.api.trading_max_api.routes import research, valuation_draft
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
    _, body = inputs(client, family if override else None)
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
    assert fields == expect
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


def test_closing_stream_cancels_model_and_releases_workspace(desk):
    client, state, _, _ = desk
    _, body = inputs(client)

    async def exercise():
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def block(messages, info):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def bind():
            return BoundModel(FunctionModel(block), {})

        state.assistant.bind_model = bind

        async def connected():
            return False

        request = SimpleNamespace(app=SimpleNamespace(state=state), is_disconnected=connected)
        response = await valuation_draft.valuation_draft(
            "SYNM", valuation_draft.DraftInput.model_validate(body), request
        )
        assert '"preparing"' in await anext(response.body_iterator)
        await asyncio.wait_for(started.wait(), 3)
        await response.body_iterator.aclose()
        assert cancelled.is_set()
        assert not state.valuation_drafts.running.locked()

    asyncio.run(exercise())
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
        return BoundModel(
            selecting(
                transcript,
                ["base.discount_rate.saved-assumption"]
                if prefs.share_valuation_assumptions
                else [],
            ),
            {},
        )

    state.assistant.bind_model = bind
    for shared in (True, False):
        prefs.share_valuation_assumptions = shared
        result = post(client, body)[-1]["result"]
        origins = [r for r in result["origins"].values() if r["source"] == "saved-assumption"]
        assert bool(origins) is shared
        if shared:
            assert origins[0]["modelId"] == journal["models"][0]["id"]
            assert origins[0]["scenarios"]["base"]["discountRate"] == 0.345678
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


def test_ambiguous_receipt_requires_a_new_verified_share_basis(desk):
    client, state, _, transcript = desk
    _, body = inputs(client)

    def ambiguous(batches):
        stored = batches["research/valuation.json"]["rows"][0]["assumptions"]
        stored.pop("shareUnit")
        stored["isAdr"] = True

    _publish(state.store, MATURE, inject=ambiguous)
    assert client.get("/v2/research/SYNM/valuation-preview").status_code == 422
    assert post(client, body)[-1]["code"] == "complete-ttm-currency-and-share-count-required"
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
