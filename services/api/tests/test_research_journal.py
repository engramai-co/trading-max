import pytest
from trading_max.research.valuation_preview import (
    FrozenValuationBasis,
    ScenarioInputs,
    ValuationPreviewRequest,
    preview,
)

from services.api.trading_max_api.research_journal import ResearchJournalStore, ResearchNoteInput


def test_notes_retain_revisions_and_reject_concurrent_writes(tmp_path):
    store = ResearchJournalStore(tmp_path)
    state = store.save_note(
        "TEST",
        ResearchNoteInput(
            title=" Thesis ",
            thesis="Evidence",
            evidence_urls=["https://example.com/filing"],
            expected_revision=0,
        ),
    )
    note = state.notes[0]
    assert note.revisions[0].content.title == "Thesis"
    store.save_note(
        "TEST", ResearchNoteInput(title="Changed", archived=True, expected_revision=1), note.id
    )
    with pytest.raises(ValueError, match="revision-conflict"):
        store.save_note("TEST", ResearchNoteInput(title="Stale", expected_revision=1), note.id)
    saved = ResearchJournalStore(tmp_path).load("TEST").notes[0]
    assert len(saved.revisions) == 2
    assert saved.revisions[0].content.thesis == "Evidence"
    assert saved.revisions[-1].content.archived
    with pytest.raises(ValueError):
        ResearchNoteInput(title=" ")
    with pytest.raises(ValueError):
        ResearchNoteInput(title="X", evidence_urls=["javascript:alert(1)"])


def test_model_versions_are_frozen_deduplicated_and_can_be_linked_to_notes(tmp_path):
    store = ResearchJournalStore(tmp_path)
    basis = FrozenValuationBasis(
        ticker="TEST",
        quote_id="q1",
        data_version="v1",
        currency="USD",
        spot=100,
        revenue=1000,
        shares=10,
        start_margin=0.2,
    )
    inputs = ScenarioInputs(
        revenue_cagr=0.1,
        target_fcf_margin=0.2,
        discount_rate=0.1,
        exit_fcf_multiple=15,
        share_cagr=0,
    )
    request = ValuationPreviewRequest(scenarios=dict.fromkeys(("bear", "base", "bull"), inputs))
    model = preview(basis, request)
    store.save_model(model)
    store.save_model(model)
    assert len(store.load("TEST").models) == 1
    newer = preview(
        basis.model_copy(update={"spot": 120, "quote_id": "q2", "data_version": "v2"}), request
    )
    store.save_model(newer)
    assert store.load("TEST").models[1].preview.basis.spot == 100
    store.save_note("TEST", ResearchNoteInput(title="Thesis", model_id=model.id))
    assert store.load("TEST").notes[0].revisions[0].content.model_id == model.id
