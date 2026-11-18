"""Private, replayable valuation proposals. Only the journal can accept a reviewed draft."""

from __future__ import annotations

from pathlib import Path
from threading import Lock
from typing import Literal
from uuid import UUID

from pydantic import Field, FiniteFloat
from trading_max.domain import DomainModel
from trading_max.research.facts import fingerprint
from trading_max.research.valuation_basis import Family
from trading_max.research.valuation_evidence import (
    Assumption,
    EvidenceId,
    EvidenceItem,
    FrozenValuationEvidence,
    Scenario,
)
from trading_max.research.valuation_preview import (
    FormulaVersion,
    FrozenValuationBasis,
    ScenarioInputs,
)

from .valuation_assumptions import _atomic_write

Category = Literal["consensus", "reported", "derived", "template", "judgment"]
Source = Literal[
    "sector-template",
    "saved-assumption",
    "consensus-growth",
    "statement-growth",
    "statement-margin",
    "common-roe",
    "cost-of-equity",
    "book-multiple",
]
Decision = Literal["accepted", "rejected", "edited", "unreviewed"]


class DraftInput(DomainModel):
    preview_id: str = Field(min_length=1, max_length=64)
    # None follows the editor's automatic family, including a saved predecessor.
    requested_family: Family | None = None
    horizon: Literal[5, 10]
    scenarios: dict[Scenario, ScenarioInputs] = Field(min_length=3, max_length=3)


class Proposal(DomainModel):
    scenario: Scenario
    field: Assumption
    value: FiniteFloat
    category: Category
    source: Source
    evidence_ids: tuple[EvidenceId, ...] = ()


class DraftResult(DomainModel):
    id: UUID
    proposals: list[Proposal]
    # Only cited rows appear in the review interface.
    evidence: dict[EvidenceId, EvidenceItem]


class DraftEvent(DomainModel):
    phase: Literal[
        "preparing",
        "basis",
        "operating",
        "expectations",
        "market",
        "evaluating",
        "complete",
        "error",
    ]
    result: DraftResult | None = None
    code: str | None = None


class DraftRecord(DomainModel):
    result: DraftResult
    evidence: FrozenValuationEvidence
    prompt_version: Literal["valuation-draft-v1"] = "valuation-draft-v1"
    formula_version: FormulaVersion
    horizon: Literal[5, 10]
    basis_digest: str
    parent_model_id: str | None
    original: dict[Scenario, ScenarioInputs]
    public_evaluation_id: str


class DraftReview(DomainModel):
    id: UUID
    decisions: dict[Scenario, dict[Assumption, Decision]] = Field(min_length=3, max_length=3)


class DraftAudit(DomainModel):
    draft: DraftRecord
    review: DraftReview
    request_digest: str


def basis_digest(basis: FrozenValuationBasis) -> str:
    # Include the actual desk mark and timestamp, FX, shares, evidence and statement hash.
    return fingerprint(basis.model_dump(mode="json"))


class ValuationDraftStore:
    """Bound pending proposals independently of the journal. Saving copies their audit record."""

    def __init__(self, state_root: Path):
        self.root = state_root / "valuation-drafts"
        self.running = Lock()

    def put(self, record: DraftRecord) -> None:
        _atomic_write(self.root / f"{record.result.id}.json", record.model_dump(mode="json"))
        for stale in sorted(
            self.root.glob("*.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True
        )[16:]:
            stale.unlink(missing_ok=True)

    def get(self, draft_id: UUID) -> DraftRecord:
        try:
            return DraftRecord.model_validate_json((self.root / f"{draft_id}.json").read_bytes())
        except FileNotFoundError:
            raise ValueError("valuation-draft-review-required") from None


def verify_decisions(
    draft: DraftRecord, review: DraftReview, scenarios: dict[Scenario, ScenarioInputs]
) -> None:
    # Pending/rejected suggestions leave the original value in place. A manual edit
    # is recorded explicitly, including edits after an initial acceptance.
    expected = {(p.scenario, p.field) for p in draft.result.proposals}
    actual = {(s, f) for s, fields in review.decisions.items() for f in fields}
    if actual != expected or set(scenarios) != set(draft.original):
        raise ValueError("valuation-draft-decisions-invalid")
    for p in draft.result.proposals:
        decision = review.decisions[p.scenario][p.field]
        value = getattr(scenarios[p.scenario], p.field)
        original = getattr(draft.original[p.scenario], p.field)
        if (decision == "accepted" and value != p.value) or (
            decision in {"unreviewed", "rejected"} and value != original
        ):
            raise ValueError("valuation-draft-decisions-invalid")
