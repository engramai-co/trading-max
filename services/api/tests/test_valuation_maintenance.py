from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from trading_max.research.estimate_history import ConsensusEstimate, EstimateObservation

from services.api.tests.test_valuation_draft import HEADERS, PATH, inputs, post, selecting
from services.api.tests.test_valuation_evidence import AS_OF, MATURE, _publish
from services.api.trading_max_api.agent.service import BoundModel
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.research_journal import ResearchJournalStore
from services.api.trading_max_api.routes import research, valuation_draft, valuation_maintenance
from services.api.trading_max_api.valuation_assumptions import ValuationAssumptionsStore
from services.api.trading_max_api.valuation_drafts import ValuationDraftStore
from services.api.trading_max_api.watchlist import WatchlistStore

REVIEW = PATH.replace("/v1/", "/v2/") + "/valuation-maintenance"


class Archive:
    """An estimate archive whose rows are visible only after their observation time."""

    def __init__(self):
        self.rows: list[EstimateObservation] = []

    def add(self, observed_at, eps):
        self.rows.append(
            EstimateObservation(
                ticker="SYNM",
                listing=MATURE.listing,
                observed_at=observed_at,
                consensus=[
                    ConsensusEstimate(
                        period="+1y", period_end=date(2027, 12, 31), currency="USD", mean_eps=eps
                    )
                ],
            )
        )

    def valuation_window(self, ticker, listing, *, cutoff):
        assert (ticker, listing) == ("SYNM", MATURE.listing)
        visible = [row for row in self.rows if row.observed_at <= cutoff]
        return sorted(visible, key=lambda row: row.observed_at, reverse=True)[:16]


@pytest.fixture
def desk(tmp_path, monkeypatch):
    app = FastAPI()
    for module in (research, valuation_draft, valuation_maintenance):
        app.include_router(module.router)
    state = app.state
    state.store = ArtifactStore(tmp_path)
    _publish(state.store, MATURE)
    state.settings = SimpleNamespace(api_token="synthetic")
    state.research = ResearchLedger(state.store, WatchlistStore(tmp_path))
    state.research_journal = ResearchJournalStore(tmp_path)
    state.valuation_drafts = ValuationDraftStore(tmp_path)
    state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    state.estimate_history = Archive()
    prefs = SimpleNamespace(
        revision=1, enabled=True, accepted_consent_revision=2, share_valuation_assumptions=True
    )
    monkeypatch.setattr(valuation_draft, "ASSISTANT_CONSENT_REVISION", 2)
    state.settings_repository = SimpleNamespace(get_assistant_preferences=lambda: prefs)
    transcript = []
    bound = []

    async def bind():
        bound.append(True)
        return BoundModel(selecting(transcript, state.choices), {})

    state.choices = None
    state.assistant = SimpleNamespace(bind_model=bind)
    with TestClient(app, headers=HEADERS) as client:
        yield client, state, transcript, bound


def save(client, view, scenarios, **extra):
    response = client.post(
        PATH + "/models",
        json={"scenarios": scenarios, "formulaVersion": view["formulaVersion"], **extra},
    )
    assert response.is_success, response.text
    return response.json()


def next_report(batches):
    """A new quarter, a restated prior quarter and a revised revenue consensus."""
    for batch in batches.values():
        batch["generated_at"] = "2026-05-12T18:00:00+00:00"
    financials = batches["research/financials.json"]["rows"][0]["financials"]
    financials["quarterlyIncomeStatement"][0]["2026-03-31"] = 1200
    for row in financials["quarterlyCashflow"]:
        row["2026-03-31"] = row["2025-12-31"]
    estimate = batches["research/analyst.json"]["rows"][0]["analyst"]["revenueEstimate"][0]
    estimate["growth"] = 0.31


def review(client, body):
    response = client.post(REVIEW, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_new_evidence_splits_the_change_from_the_saved_version(desk):
    client, state, transcript, bound = desk
    view, body = inputs(client)
    scenarios = body["scenarios"]
    scenarios["base"]["revenueCagr"] = 0.15
    reference = {
        "metric": "revenueGrowth",
        "scenario": "base",
        "period": "2027-12-31",
        "asOf": AS_OF.isoformat(),
        "value": 0.15,
        "source": "yahoo-finance-consensus",
        "adjustment": 0,
    }
    state.estimate_history.add(AS_OF, 2.5)
    journal = save(
        client,
        view,
        scenarios,
        references=[reference],
        lockedInputs=[{"scenario": "base", "field": "discount_rate"}],
    )
    saved_model = journal["models"][0]
    state.estimate_history.add(datetime.now(UTC), 2.7)
    _publish(state.store, replace(MATURE, restated=True, raw_spot=30), inject=next_report)
    reopened, body = inputs(client)
    assert reopened["defaultSource"] == "saved-model"
    assert reopened["savedModel"]["id"] == saved_model["id"]
    proposed = json.loads(json.dumps(body["scenarios"]))
    proposed["base"]["revenueCagr"] = 0.31
    request = {
        "modelId": saved_model["id"],
        "horizon": 5,
        "scenarios": proposed,
        "dataVersion": reopened["basis"]["dataVersion"],
        "lockedInputs": [{"scenario": "base", "field": "discount_rate"}],
    }
    result = review(client, request)
    desk_reading = client.post(
        PATH.replace("/v1/", "/v2/") + "/valuation-preview",
        json={
            "family": "cash-flow",
            "formulaVersion": view["formulaVersion"],
            "horizon": 5,
            "scenarios": proposed,
        },
    ).json()
    for key, step in result["scenarios"].items():
        assert step["saved"] == pytest.approx(
            saved_model["preview"]["scenarios"][key]["value"], rel=1e-12
        )
        assert step["proposal"] == desk_reading["scenarios"][key]["value"]
        parts = step["statementsEffect"] + step["priceFxEffect"] + step["assumptionsEffect"]
        assert parts == pytest.approx(step["proposal"] - step["saved"], rel=1e-12, abs=1e-12)
        assert step["restatementEffect"] == pytest.approx(step["restated"] - step["saved"])
    assert result["scenarios"]["bear"]["assumptionsEffect"] == 0
    assert result["scenarios"]["base"]["assumptionsEffect"] > 0
    assert (result["saved"]["periodId"], result["current"]["periodId"]) == (
        "ttm:2025-12-31",
        "ttm:2026-03-31",
    )
    assert (result["saved"]["spot"], result["current"]["spot"]) == (25, 30)
    assert result["restatementCheck"] == "restated"
    assert result["restatementGap"] is None and result["uncheckedFigures"] == []
    assert [(r["metric"], r["saved"], r["current"]) for r in result["restatements"]] == [
        ("revenue", 4000, 3850)
    ]
    assert result["newStatements"] and result["newEstimates"] and result["fxSeparated"]
    assert {(e["metric"], e["saved"], e["current"]) for e in result["estimates"]} == {
        ("consensusEps", 2.5, 2.7),
        ("consensusRevenueGrowth", 0.15, 0.31),
    }
    assert [(a["scenario"], a["field"], a["locked"]) for a in result["assumptions"]] == [
        ("base", "revenue_cagr", False)
    ]
    assert result["lockedInputs"] == [{"scenario": "base", "field": "discount_rate"}]
    assert {f["metric"] for f in result["figures"]} >= {"revenue", "startMargin"}
    # A comparison neither writes nor asks a model.
    assert client.get(PATH + "/journal").json()["models"] == journal["models"]
    assert not list(state.valuation_drafts.root.glob("*.json")) and not bound and not transcript


def test_unknown_stale_and_changed_currency_comparisons_are_refused(desk):
    client, state, _, _ = desk
    view, body = inputs(client)
    model = save(client, view, body["scenarios"])["models"][0]
    request = {"modelId": model["id"], "horizon": 5, "scenarios": body["scenarios"]}
    assert client.post(REVIEW, json={**request, "modelId": "other"}).status_code == 404
    stale = view["basis"]["dataVersion"]
    _publish(state.store, MATURE, inject=next_report)
    response = client.post(REVIEW, json={**request, "dataVersion": stale})
    assert response.status_code == 409
    _publish(state.store, replace(MATURE, quote_unit="EUR", reporting="EUR"))
    response = client.post(REVIEW, json=request)
    assert (response.status_code, response.json()["detail"]) == (422, "valuation-currency-changed")


def test_unchanged_evidence_reports_no_new_statements_or_estimates(desk):
    client, _, _, _ = desk
    view, body = inputs(client)
    model = save(client, view, body["scenarios"])["models"][0]
    result = review(client, {"modelId": model["id"], "horizon": 10, "scenarios": body["scenarios"]})
    assert result["restatementCheck"] == "unchanged" and result["restatements"] == []
    assert result["restatementGap"] is None
    assert not result["newStatements"] and not result["newEstimates"]
    assert result["figures"] == [] and result["assumptions"] == [] and result["conflicts"] == []
    for step in result["scenarios"].values():
        assert step["saved"] == step["proposal"]
        assert step["statementsEffect"] == step["priceFxEffect"] == step["assumptionsEffect"] == 0


def test_saved_versions_record_locks_only_when_present(desk):
    client, state, _, _ = desk
    view, body = inputs(client)
    plain = save(client, view, body["scenarios"])["models"][0]
    stored = json.loads(next(state.research_journal.root.glob("*.json")).read_text())
    assert "lockedInputs" not in stored["models"][0]
    reopened, _ = inputs(client)
    assert reopened["savedModel"] == {
        "id": plain["id"],
        "savedAt": plain["savedAt"],
        "previewId": plain["preview"]["id"],
        "lockedInputs": [],
    }
    locks = [
        {"scenario": "bull", "field": "share_cagr"},
        {"scenario": "base", "field": "discount_rate"},
        {"scenario": "bull", "field": "share_cagr"},
    ]
    locked = save(client, view, body["scenarios"], lockedInputs=locks)["models"][0]
    assert locked["id"] != plain["id"]
    ordered = [locks[1], locks[0]]
    assert locked["lockedInputs"] == ordered
    assert inputs(client)[0]["savedModel"]["lockedInputs"] == ordered
    assert (
        client.post(
            PATH + "/models",
            json={
                "scenarios": body["scenarios"],
                "lockedInputs": [{"scenario": "base", "field": "unknown"}],
            },
        ).status_code
        == 422
    )


def test_a_draft_from_a_saved_version_respects_locked_inputs(desk):
    client, state, transcript, _ = desk
    view, body = inputs(client)
    body["scenarios"]["base"]["discountRate"] = 0.123456
    lock = [{"scenario": "base", "field": "revenue_cagr"}]
    save(client, view, body["scenarios"], lockedInputs=lock)
    _publish(state.store, MATURE, inject=next_report)
    reopened, body = inputs(client)
    body["lockedInputs"] = reopened["savedModel"]["lockedInputs"]
    state.choices = ["bull.revenue_cagr.consensus-growth"]
    result = post(client, body)[-1]["result"]
    candidates = transcript[0]["candidates"]
    assert "base.revenue_cagr.consensus-growth" not in candidates
    assert not any(key.startswith("base.revenue_cagr.") for key in candidates)
    assert [(p["scenario"], p["field"]) for p in result["proposals"]] == [("bull", "revenue_cagr")]
    # The evaluation starts from the saved version when its numbers may be shared.
    assert "0.123456" in json.dumps(transcript)
    decisions = {s: {} for s in body["scenarios"]}
    decisions["bull"]["revenue_cagr"] = "accepted"
    accepted = json.loads(json.dumps(body["scenarios"]))
    accepted["bull"]["revenueCagr"] = result["proposals"][0]["value"]
    journal = client.post(
        PATH + "/models",
        json={
            "family": "cash-flow",
            "formulaVersion": view["formulaVersion"],
            "scenarios": accepted,
            "lockedInputs": lock,
            "draftReview": {"id": result["id"], "decisions": decisions},
        },
    )
    assert journal.status_code == 200, journal.text
    version = journal.json()["models"][0]
    assert version["lockedInputs"] == lock
    assert version["draftAudit"]["draft"]["promptVersion"] == "valuation-maintenance-v1"
    assert version["draftAudit"]["draft"]["lockedInputs"] == lock


def test_selecting_a_locked_field_or_locking_every_field_never_proposes_it(desk):
    client, state, transcript, bound = desk
    view, body = inputs(client)
    save(client, view, body["scenarios"])
    _, body = inputs(client)
    body["lockedInputs"] = [{"scenario": "base", "field": "revenue_cagr"}]
    state.choices = ["base.revenue_cagr.consensus-growth"]
    events = post(client, body)
    assert events[-1]["phase"] == "error"
    assert not list(state.valuation_drafts.root.glob("*.json"))
    fields = ["revenue_cagr", "target_fcf_margin", "discount_rate", "exit_fcf_multiple"]
    fields += ["share_cagr", "ramp_years"]
    body["lockedInputs"] = [{"scenario": s, "field": f} for s in body["scenarios"] for f in fields]
    bound.clear()
    transcript.clear()
    assert post(client, body)[-1] == {"phase": "error", "code": "valuation-inputs-locked"}
    assert not bound and not transcript


def test_a_record_cannot_be_saved_with_a_proposal_on_a_locked_input(desk):
    client, state, _, _ = desk
    view, body = inputs(client)
    result = post(client, body)[-1]["result"]
    path = state.valuation_drafts.root / f"{result['id']}.json"
    record = json.loads(path.read_text())
    proposal = result["proposals"][0]
    record["lockedInputs"] = [{"scenario": proposal["scenario"], "field": proposal["field"]}]
    path.write_text(json.dumps(record))
    decisions = {s: {} for s in body["scenarios"]}
    for p in result["proposals"]:
        decisions[p["scenario"]][p["field"]] = "unreviewed"
    response = client.post(
        PATH + "/models",
        json={
            "family": "cash-flow",
            "formulaVersion": view["formulaVersion"],
            "scenarios": body["scenarios"],
            "draftReview": {"id": result["id"], "decisions": decisions},
        },
    )
    assert (response.status_code, response.json()["detail"]) == (
        409,
        "valuation-draft-review-required",
    )
    assert client.get(PATH + "/journal").json()["models"] == []
