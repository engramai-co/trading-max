"""Private research notes and immutable, reproducible model versions."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path

from pydantic import AnyHttpUrl, Field, field_validator
from trading_max.domain import DomainModel
from trading_max.infrastructure.singleflight import SingleFlightCache
from trading_max.research.facts import fingerprint
from trading_max.research.valuation_preview import (
    ValuationPreview,
    ValuationPreviewRequest,
    project,
)

from .dashboard_models import ValuationRow
from .valuation_assumptions import _atomic_write
from .valuation_drafts import (
    DraftAudit,
    DraftReview,
    ValuationDraftStore,
    basis_digest,
    verify_decisions,
)


class ResearchNoteInput(DomainModel):
    title: str = Field(min_length=1, max_length=200)
    thesis: str = Field(default="", max_length=20000)
    invalidation: str = Field(default="", max_length=10000)
    evidence_urls: list[AnyHttpUrl] = Field(default_factory=list, max_length=20)
    model_id: str | None = None
    review_date: date | None = None
    archived: bool = False
    expected_revision: int | None = None

    @field_validator("title")
    @classmethod
    def meaningful_title(cls, title: str) -> str:
        if not title.strip():
            raise ValueError("research-note-title-required")
        return title.strip()


class NoteRevision(DomainModel):
    revision: int
    saved_at: datetime
    content: ResearchNoteInput


class ResearchNote(DomainModel):
    id: str
    ticker: str
    revisions: list[NoteRevision]


class SavedResearchModel(DomainModel):
    id: str
    saved_at: datetime
    preview: ValuationPreview
    reason: str = ""
    draft_audit: DraftAudit | None = None


class ResearchModelSaveRequest(ValuationPreviewRequest):
    draft_review: DraftReview | None = None
    reason: str = Field(default="", max_length=4000)


class BaselineSelection(DomainModel):
    model_id: str | None


class ResearchJournal(DomainModel):
    baseline_model_id: str | None = None
    schema_version: int = 1
    ticker: str
    notes: list[ResearchNote] = Field(default_factory=list)
    models: list[SavedResearchModel] = Field(default_factory=list)


class ResearchJournalStore:
    def __init__(self, state_root: Path) -> None:
        self.root = state_root / "research-journal"
        self.lock = threading.RLock()
        self.baselines = SingleFlightCache(capacity=128)

    def _path(self, ticker: str) -> Path:
        return self.root / (fingerprint(ticker.upper()) + ".json")

    def load(self, ticker: str) -> ResearchJournal:
        with self.lock:
            path = self._path(ticker)
            if not path.is_file():
                return ResearchJournal(ticker=ticker.upper())
            return ResearchJournal.model_validate_json(path.read_text())

    def _save(self, state: ResearchJournal) -> None:
        _atomic_write(self._path(state.ticker), state.model_dump(mode="json"))

    def set_baseline(self, ticker: str, model_id: str | None) -> ResearchJournal:
        with self.lock:
            state = self.load(ticker)
            if model_id is not None and not any(
                m.id == model_id and m.preview.scenarios for m in state.models
            ):
                raise KeyError("research-model-not-found")
            if state.baseline_model_id != model_id:
                state.baseline_model_id = model_id
                self._save(state)
            return state

    def overview_valuation(self, row: ValuationRow) -> ValuationRow:
        """Overlay only the overview reading; preserve the immutable batch projection."""
        try:
            stat = self._path(row.ticker).stat()
        except FileNotFoundError:
            return row

        def baseline():
            journal = self.load(row.ticker)
            saved = next((m for m in journal.models if m.id == journal.baseline_model_id), None)
            if saved is None:
                return None
            model = saved.preview
            value = project(
                model.basis, model.scenarios["base"].inputs, 5, model.formula_version
            ).value
            return saved.id, model.basis.currency, value

        result = self.baselines.get_or_compute(
            (row.ticker, stat.st_ino, stat.st_mtime_ns), baseline
        )
        if result is None:
            return row
        model_id, currency, value = result
        if currency != row.currency or row.spot <= 0:
            value = None
        return row.model_copy(
            update={
                "ev5": value,
                "ev5_upside": value / row.spot - 1 if value is not None else None,
                "baseline_model_id": model_id,
            }
        )

    def save_note(
        self, ticker: str, content: ResearchNoteInput, note_id: str | None = None
    ) -> ResearchJournal:
        with self.lock:
            state = self.load(ticker)
            note = next((n for n in state.notes if n.id == note_id), None)
            if note_id and note is None:
                raise KeyError("research-note-not-found")
            revision = note.revisions[-1].revision if note else 0
            if content.expected_revision is not None and content.expected_revision != revision:
                raise ValueError("research-note-revision-conflict")
            if content.model_id and not any(m.id == content.model_id for m in state.models):
                raise ValueError("research-model-not-found")
            if note is None:
                note = ResearchNote(id=str(uuid.uuid4()), ticker=ticker.upper(), revisions=[])
                state.notes.append(note)
            note.revisions.append(
                NoteRevision(revision=revision + 1, saved_at=datetime.now(UTC), content=content)
            )
            self._save(state)
            return state

    def save_reviewed(
        self,
        ticker: str,
        body: ResearchModelSaveRequest,
        drafts: ValuationDraftStore,
        calculate: Callable[[ValuationPreviewRequest], ValuationPreview],
    ) -> ResearchJournal:
        with self.lock:
            review = body.draft_review
            state = self.load(ticker)
            digest = fingerprint(body.model_dump(mode="json"))
            for saved in state.models:
                audit = saved.draft_audit
                if audit and audit.review.id == review.id:
                    if audit.request_digest != digest:
                        raise ValueError("valuation-draft-review-required")
                    return state  # the response to an earlier successful save may have been lost
            draft = drafts.get(review.id)
            parent = state.models[0].id if state.models else None
            if (
                draft.evidence.binding.ticker != ticker.upper()
                or draft.parent_model_id != parent
                or draft.horizon != body.horizon
                or draft.formula_version != body.formula_version
                or draft.evidence.family != body.family
            ):
                raise ValueError("valuation-draft-review-required")
            verify_decisions(draft, review, body.scenarios)
            result = calculate(
                ValuationPreviewRequest.model_validate(
                    body.model_dump(exclude={"reason", "draft_review"})
                )
            )
            if not result.scenarios or basis_digest(result.basis) != draft.basis_digest:
                raise ValueError("valuation-draft-review-required")
            return self.save_model(
                result, body.reason, DraftAudit(draft=draft, review=review, request_digest=digest)
            )

    def save_model(
        self, model: ValuationPreview, reason: str = "", audit: DraftAudit | None = None
    ) -> ResearchJournal:
        with self.lock:
            state = self.load(model.basis.ticker)
            reason = reason.strip()
            model_id = fingerprint([model.id, reason]) if reason else model.id
            if audit:
                model_id = fingerprint([model_id, str(audit.review.id)])
            if not any(m.id == model_id for m in state.models):
                state.models.insert(
                    0,
                    SavedResearchModel(
                        id=model_id,
                        saved_at=datetime.now(UTC),
                        preview=model,
                        reason=reason,
                        draft_audit=audit,
                    ),
                )
                self._save(state)
            return state
