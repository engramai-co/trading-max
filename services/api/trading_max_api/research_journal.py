"""Private research notes and immutable, reproducible model versions."""

from __future__ import annotations

import threading
import uuid
from datetime import UTC, date, datetime
from pathlib import Path

from pydantic import AnyHttpUrl, Field, field_validator
from trading_max.domain import DomainModel
from trading_max.research.facts import fingerprint
from trading_max.research.valuation_preview import ValuationPreview, ValuationPreviewRequest

from .valuation_assumptions import _atomic_write


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


class ResearchModelSaveRequest(ValuationPreviewRequest):
    reason: str = Field(default="", max_length=4000)


class ResearchJournal(DomainModel):
    schema_version: int = 1
    ticker: str
    notes: list[ResearchNote] = Field(default_factory=list)
    models: list[SavedResearchModel] = Field(default_factory=list)


class ResearchJournalStore:
    def __init__(self, state_root: Path) -> None:
        self.root = state_root / "research-journal"
        self.lock = threading.RLock()

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

    def save_model(self, model: ValuationPreview, reason: str = "") -> ResearchJournal:
        with self.lock:
            state = self.load(model.basis.ticker)
            reason = reason.strip()
            model_id = fingerprint([model.id, reason]) if reason else model.id
            if not any(m.id == model_id for m in state.models):
                state.models.insert(
                    0,
                    SavedResearchModel(
                        id=model_id, saved_at=datetime.now(UTC), preview=model, reason=reason
                    ),
                )
                self._save(state)
            return state
