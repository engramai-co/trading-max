"""Private, replayable valuation proposals. Only the journal can accept a reviewed draft."""

from __future__ import annotations

from pathlib import Path
from threading import Lock
from typing import Literal
from uuid import UUID

from pydantic import Field, FiniteFloat, model_validator
from trading_max.domain import DomainModel
from trading_max.research.facts import fingerprint
from trading_max.research.valuation_basis import Family
from trading_max.research.valuation_evidence import (
    Assumption,
    EvidenceId,
    EvidenceItem,
    FrozenValuationEvidence,
    Metric,
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


class TemplateInputs(DomainModel):
    profile: str
    growth_cap: float
    margin_cap: float
    profile_discount: float
    exit_multiple: float
    share_cagr: float
    effective_discount_rate: float
    annual_revenue_growth: float | None
    basis: FrozenValuationBasis


class TemplateOrigin(DomainModel):
    source: Literal["sector-template"] = "sector-template"
    inputs: TemplateInputs
    scenarios: dict[Scenario, ScenarioInputs]
    evidence_ids: tuple[EvidenceId, ...] = Field(min_length=1)


class SavedOrigin(DomainModel):
    source: Literal["saved-assumption"] = "saved-assumption"
    model_id: str | None
    scenarios: dict[Scenario, ScenarioInputs]


DraftOrigin = TemplateOrigin | SavedOrigin


class Proposal(DomainModel):
    scenario: Scenario
    field: Assumption
    value: FiniteFloat
    category: Category
    source: Source
    origin_id: str | None = None
    evidence_ids: tuple[EvidenceId, ...] = ()


class DraftResult(DomainModel):
    id: UUID
    proposals: list[Proposal]
    origins: dict[str, DraftOrigin]
    # Only cited rows appear in the review interface.
    evidence: dict[EvidenceId, EvidenceItem]

    @model_validator(mode="after")
    def resolve_values(self):
        for key, origin in self.origins.items():
            if key != fingerprint(origin.model_dump(mode="json")):
                raise ValueError("valuation-draft-origin-invalid")
            if isinstance(origin, TemplateOrigin) and not self.evidence.keys() >= set(
                origin.evidence_ids
            ):
                raise ValueError("valuation-draft-origin-evidence-missing")
        for p in self.proposals:
            if p.source in {"sector-template", "saved-assumption"}:
                origin = self.origins.get(p.origin_id)
                if not origin or origin.source != p.source or p.scenario not in origin.scenarios:
                    raise ValueError("valuation-draft-origin-missing")
                value = getattr(origin.scenarios[p.scenario], p.field)
            else:
                rows = [self.evidence.get(key) for key in p.evidence_ids]
                if not rows or any(row is None or row.state != "available" for row in rows):
                    raise ValueError("valuation-draft-proposal-evidence-missing")
                if p.source in {"common-roe", "statement-margin"}:
                    if (
                        len(rows) != 2
                        or rows[1].value <= 0
                        or rows[1].metric
                        != (Metric.BOOK if p.source == "common-roe" else Metric.REVENUE)
                    ):
                        raise ValueError("valuation-draft-ratio-invalid")
                    value = rows[0].value / rows[1].value
                else:
                    if len(rows) != 1:
                        raise ValueError("valuation-draft-source-invalid")
                    value = rows[0].value
            if value != p.value:
                raise ValueError("valuation-draft-proposal-value-mismatch")
        return self


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
    review_basis: FrozenValuationBasis
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


class ValuationDraftStore:
    """Bound pending proposals independently of the journal. Saving copies their audit record."""

    def __init__(self, state_root: Path):
        self.root = state_root / "valuation-drafts"
        self.running = Lock()
        self._files = Lock()

    def put(self, record: DraftRecord) -> None:
        with self._files:
            _atomic_write(self.root / f"{record.result.id}.json", record.model_dump(mode="json"))
            for stale in sorted(
                self.root.glob("*.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True
            )[16:]:
                stale.unlink(missing_ok=True)

    def discard(self, draft_id: UUID) -> None:
        with self._files:
            (self.root / f"{draft_id}.json").unlink(missing_ok=True)

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
