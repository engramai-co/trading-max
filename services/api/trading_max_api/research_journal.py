"""Private research notes and immutable, reproducible model versions."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Literal

from pydantic import AnyHttpUrl, Field, field_validator
from trading_max.domain import DomainModel
from trading_max.infrastructure.singleflight import SingleFlightCache
from trading_max.research.facts import fingerprint
from trading_max.research.valuation_preview import (
    LockedInput,
    ValuationPreview,
    ValuationPreviewRequest,
    locked_set,
    project,
)

from .artifacts import ArtifactStore
from .dashboard_models import ValuationRow
from .models import SnapshotManifest
from .valuation_assumptions import _atomic_write, _prepared_write
from .valuation_drafts import (
    DraftAudit,
    DraftReview,
    ValuationDraftStore,
    reviewed_publication,
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


class ConsensusBaseline(DomainModel):
    """Consensus when a version was saved: the baseline later estimates are compared with."""

    metric: Literal["consensusRevenueGrowth"]
    period_end: date
    value: float
    as_of: datetime | date | None = None


class SavedResearchModel(DomainModel):
    id: str
    saved_at: datetime
    preview: ValuationPreview
    reason: str = ""
    draft_audit: DraftAudit | None = Field(default=None, exclude_if=lambda audit: audit is None)
    # Versions without locks keep the earlier journal format.
    locked_inputs: list[LockedInput] = Field(
        default_factory=list, exclude_if=lambda locked: not locked
    )
    # Recorded at each save, apart from the assumptions' own references. Versions saved
    # before it was recorded have none and are compared with their references.
    consensus: list[ConsensusBaseline] | None = Field(
        default=None, exclude_if=lambda consensus: consensus is None
    )


class ResearchModelSaveRequest(ValuationPreviewRequest):
    family_selection: Literal["automatic", "override"] | None = None
    draft_review: DraftReview | None = None
    reason: str = Field(default="", max_length=4000)
    locked_inputs: list[LockedInput] = Field(default_factory=list, max_length=27)

    def preview_request(self) -> ValuationPreviewRequest:
        return ValuationPreviewRequest.model_validate(
            self.model_dump(exclude={"reason", "draft_review", "family_selection", "locked_inputs"})
        )


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
        self.latest = SingleFlightCache(capacity=256)

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

    def _newest(self, path: Path) -> tuple[str, SavedResearchModel | None] | None:
        """A journal's security and the version an editor opens from, read once per write."""
        try:
            stat = path.stat()
        except FileNotFoundError:
            return None

        def read():
            journal = ResearchJournal.model_validate_json(path.read_text())
            return journal.ticker, next((m for m in journal.models if m.preview.scenarios), None)

        return self.latest.get_or_compute((path.name, stat.st_ino, stat.st_mtime_ns), read)

    def latest_model(self, ticker: str) -> SavedResearchModel | None:
        newest = self._newest(self._path(ticker))
        return newest[1] if newest else None

    def latest_models(self) -> list[tuple[str, SavedResearchModel]]:
        """Each security's newest saved version, in no particular order."""
        found = []
        for path in sorted(self.root.glob("*.json")) if self.root.is_dir() else ():
            try:
                newest = self._newest(path)
            except ValueError:
                continue  # an unreadable journal fails where it is opened, not here
            if newest and newest[1] is not None:
                found.append((newest[0], newest[1]))
        return found

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
        calculate: Callable[[ValuationPreviewRequest, SnapshotManifest], ValuationPreview],
        store: ArtifactStore,
        consensus: Callable[[SnapshotManifest], list[ConsensusBaseline]] | None = None,
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
                    drafts.discard(review.id)
                    return state  # the response to an earlier successful save may have been lost
            draft = drafts.get(review.id)
            manifest = store.latest_manifest()
            parent = state.models[0].id if state.models else None
            if (
                draft.evidence.binding.ticker != ticker.upper()
                or manifest is None
                or draft.evidence.binding.snapshot_run_id != manifest.run_id
                or draft.parent_model_id != parent
                or draft.horizon != body.horizon
                or draft.formula_version != body.formula_version
                or draft.evidence.family != body.family
            ):
                raise ValueError("valuation-draft-review-required")
            kept = {(item.scenario, item.field) for item in draft.locked_inputs}
            if any((p.scenario, p.field) in kept for p in draft.result.proposals):
                raise ValueError("valuation-draft-review-required")
            verify_decisions(draft, review, body.scenarios)
            result = calculate(body.preview_request(), manifest)
            if not result.scenarios or result.basis != draft.review_basis:
                raise ValueError("valuation-draft-review-required")
            result.family_selection = draft.result.family_selection
            audit = DraftAudit(draft=draft, review=review, request_digest=digest)
            state.models.insert(
                0,
                self._model_version(
                    result,
                    body.reason,
                    audit,
                    body.locked_inputs,
                    consensus(manifest) if consensus else None,
                ),
            )
            path = self._path(ticker)
            with (
                _prepared_write(path, state.model_dump(mode="json")) as temporary,
                reviewed_publication(store, manifest.run_id),
            ):
                temporary.replace(path)
            drafts.discard(review.id)
            return state

    @staticmethod
    def _model_version(
        model: ValuationPreview,
        reason: str,
        audit: DraftAudit | None,
        locked: list[LockedInput] | None = None,
        consensus: list[ConsensusBaseline] | None = None,
    ) -> SavedResearchModel:
        reason = reason.strip()
        locked = locked_set(locked or [])
        model_id = fingerprint([model.id, reason]) if reason else model.id
        if model.family_selection == "override":
            model_id = fingerprint([model_id, "family-override"])
        if audit:
            model_id = fingerprint([model_id, str(audit.review.id)])
        if locked:
            model_id = fingerprint([model_id, "locked", [[i.scenario, i.field] for i in locked]])
        return SavedResearchModel(
            id=model_id,
            saved_at=datetime.now(UTC),
            preview=model,
            reason=reason,
            draft_audit=audit,
            locked_inputs=locked,
            consensus=consensus,
        )

    def save_model(
        self,
        model: ValuationPreview,
        reason: str = "",
        audit: DraftAudit | None = None,
        locked: list[LockedInput] | None = None,
        consensus: list[ConsensusBaseline] | None = None,
    ) -> ResearchJournal:
        with self.lock:
            state = self.load(model.basis.ticker)
            version = self._model_version(model, reason, audit, locked, consensus)
            if not any(m.id == version.id for m in state.models):
                state.models.insert(0, version)
                self._save(state)
            return state
