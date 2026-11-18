from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api.tests.test_valuation_draft import HEADERS, PATH, inputs
from services.api.tests.test_valuation_evidence import AS_OF, MATURE, _publish
from services.api.tests.test_valuation_maintenance import Archive, next_report, save
from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.evidence_notices import EvidenceNoticeStore
from services.api.trading_max_api.models import SecuritySearchResult
from services.api.trading_max_api.research import ResearchLedger
from services.api.trading_max_api.research_journal import ResearchJournalStore
from services.api.trading_max_api.routes import (
    research,
    valuation_draft,
    valuation_maintenance,
    valuation_notices,
)
from services.api.trading_max_api.valuation_assumptions import ValuationAssumptionsStore
from services.api.trading_max_api.valuation_drafts import ValuationDraftStore
from services.api.trading_max_api.watchlist import WatchlistStore

NOTICES = "/v1/valuation/evidence-notices"
REFERENCE = {
    "metric": "revenueGrowth",
    "scenario": "base",
    "period": "2027-12-31",
    "asOf": AS_OF.isoformat(),
    "value": 0.15,
    "source": "yahoo-finance-consensus",
    "adjustment": 0,
}


@pytest.fixture
def desk(tmp_path):
    app = FastAPI()
    for module in (research, valuation_draft, valuation_maintenance, valuation_notices):
        app.include_router(module.router)
    state = app.state
    state.store = ArtifactStore(tmp_path)
    _publish(state.store, MATURE)
    watchlist = WatchlistStore(tmp_path)
    watchlist.add(
        SecuritySearchResult(
            ticker="SYNM", name="Synthetic Mature", exchange="NYSE", bloomberg_ticker="", figi=""
        )
    )
    state.settings = SimpleNamespace(api_token="synthetic")
    state.research = ResearchLedger(state.store, watchlist)
    state.research_journal = ResearchJournalStore(tmp_path)
    state.valuation_drafts = ValuationDraftStore(tmp_path)
    state.valuation_assumptions = ValuationAssumptionsStore(tmp_path)
    state.estimate_history = Archive()
    state.evidence_notices = EvidenceNoticeStore(tmp_path)
    switch = SimpleNamespace(evidence_notices_enabled=False)
    state.settings_repository = SimpleNamespace(get_automation_preferences=lambda: switch)
    bound = []

    async def bind():
        bound.append(True)
        raise AssertionError("a notice never contacts a model")

    state.assistant = SimpleNamespace(bind_model=bind)
    with TestClient(app, headers=HEADERS) as client:
        yield client, state, switch, bound


def notices(client):
    response = client.get(NOTICES)
    assert response.status_code == 200, response.text
    return response.json()


def test_notices_are_off_by_default_and_compare_nothing(desk):
    client, state, _, _ = desk
    view, body = inputs(client)
    save(client, view, body["scenarios"])
    _publish(state.store, MATURE, inject=next_report)

    def unexpected(*_):
        raise AssertionError("nothing is read while notices are off")

    state.research_journal.latest_models = unexpected
    assert notices(client) == {"enabled": False, "runId": None, "notices": []}


def test_new_evidence_is_announced_once_and_never_drafts_or_saves(desk):
    client, state, switch, bound = desk
    switch.evidence_notices_enabled = True
    view, body = inputs(client)
    state.estimate_history.add(AS_OF, 2.5)
    journal = save(client, view, body["scenarios"], references=[REFERENCE])
    model_id = journal["models"][0]["id"]
    assert notices(client)["notices"] == []

    state.estimate_history.add(datetime.now(UTC), 2.7)
    restated = replace(MATURE, restated=True)
    _publish(state.store, restated, inject=next_report)
    [notice] = notices(client)["notices"]
    assert (notice["ticker"], notice["modelId"]) == ("SYNM", model_id)
    items = {(item["kind"], item.get("metric")): item for item in notice["items"]}
    assert set(items) == {
        ("statements", None),
        ("restatement", None),
        ("estimate", "consensusEps"),
        ("estimate", "consensusRevenueGrowth"),
    }
    assert items["statements", None]["periodId"] == "ttm:2026-03-31"
    assert items["restatement", None]["periodId"] == "ttm:2025-12-31"
    eps = items["estimate", "consensusEps"]
    assert (eps["saved"], eps["current"], eps["currency"]) == (2.5, 2.7, "USD")
    growth = items["estimate", "consensusRevenueGrowth"]
    assert (growth["saved"], growth["current"]) == (0.15, 0.31)
    # The same evidence is one notice, however often it is asked for.
    assert notices(client)["notices"] == [notice]
    # An unreadable journal of another security leaves this notice in place.
    (state.research_journal.root / "unreadable.json").write_text("{")
    assert notices(client)["notices"] == [notice]

    keys = [item["key"] for item in notice["items"]]
    opened = client.post(NOTICES + "/SYNM/seen", json={"modelId": model_id, "keys": keys})
    assert opened.status_code == 200, opened.text
    assert opened.json()["notices"] == []
    # Publishing the same evidence again announces nothing.
    _publish(state.store, restated, inject=next_report)
    assert notices(client)["notices"] == []

    # A further step of the EPS consensus is new evidence; nothing else repeats.
    state.estimate_history.add(datetime.now(UTC), 2.95)
    _publish(state.store, restated, inject=next_report)
    [later] = notices(client)["notices"]
    assert [(i["kind"], i["saved"], i["current"]) for i in later["items"]] == [
        ("estimate", 2.5, 2.95)
    ]
    # A notice only reads: no draft, no model call and no new version.
    assert client.get(PATH + "/journal").json()["models"] == journal["models"]
    assert not list(state.valuation_drafts.root.glob("*.json")) and not bound


def test_only_the_newest_version_carries_a_notice(desk):
    client, state, switch, _ = desk
    switch.evidence_notices_enabled = True
    view, body = inputs(client)
    first = save(client, view, body["scenarios"])["models"][0]["id"]
    _publish(state.store, MATURE, inject=next_report)
    [notice] = notices(client)["notices"]
    assert notice["modelId"] == first
    # A version saved on the new statements has nothing new to show.
    view, body = inputs(client)
    second = save(client, view, body["scenarios"])["models"][0]["id"]
    assert second != first and notices(client)["notices"] == []
    key = notice["items"][0]["key"]
    stale = client.post(NOTICES + "/SYNM/seen", json={"modelId": first, "keys": [key]})
    assert (stale.status_code, stale.json()["detail"]) == (409, "research-model-not-latest")


def test_review_finds_the_version_saved_by_the_end_of_a_decision_day(desk):
    client, state, _, _ = desk
    view, body = inputs(client)
    save(client, view, body["scenarios"])
    body["scenarios"]["base"]["revenueCagr"] += 0.02
    save(client, view, body["scenarios"])
    store = state.research_journal
    journal = store.load("SYNM")
    newer, older = journal.models
    older.saved_at = datetime(2026, 8, 3, 22, 30, tzinfo=UTC)
    newer.saved_at = datetime(2026, 8, 5, 0, 15, tzinfo=UTC)
    store._save(journal)

    def at(day):
        response = client.get(PATH + "/models/as-of", params={"day": day})
        assert response.status_code == 200, response.text
        return response.json()["model"]

    assert at("2026-08-02") is None
    # A decision's day is the broker's UTC trade day, so a late save that day counts.
    assert at("2026-08-03")["id"] == older.id
    assert at("2026-08-04")["id"] == older.id
    version = at("2026-08-05")
    assert (version["id"], version["family"], version["horizon"], version["currency"]) == (
        newer.id,
        "cash-flow",
        5,
        "USD",
    )
    assert client.get(PATH + "/models/as-of", params={"day": "3 Aug"}).status_code == 422
