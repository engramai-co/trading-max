"""Auditable growing research-taxonomy contracts and decision workflow.

GICS remains separate reference metadata. This module owns only Trading Max
research themes. An unclassified instrument is represented by workflow state,
never by a synthetic catch-all theme in the catalog.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, ClassVar, Literal, Protocol

from pydantic import Field

from trading_max.domain import DomainModel, InstrumentId

THEME_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
UNCLASSIFIED_THEME_ID = ""
# Import-compatible alias; deliberately not a catalog theme.
DEFAULT_THEME_ID = UNCLASSIFIED_THEME_ID

TaxonomyWorkflowStatus = Literal["classifying", "assigned", "needs-review", "unclassified"]
TaxonomyWorkflowOutcome = Literal[
    "create_new",
    "assign_existing",
    "merge_with_existing",
    "remain_pending",
    "manual_review",
]
TaxonomyWorkflowStage = Literal[
    "existing-assignment", "candidate-proposal", "candidate-critique", "admission"
]


class TaxonomyTheme(DomainModel):
    id: str = Field(min_length=2, max_length=48)
    label_zh: str = Field(min_length=1)
    label_en: str = Field(min_length=1)
    description_zh: str = ""
    description_en: str = ""
    inclusion_criteria: list[str] = Field(default_factory=list)
    exclusion_criteria: list[str] = Field(default_factory=list)
    order: int = Field(default=1, ge=1)
    taxonomy: Literal["llm-taxonomy"] = "llm-taxonomy"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TaxonomyAssignmentRecord(DomainModel):
    instrument: InstrumentId
    taxonomy_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    method: Literal["llm", "manual", "fallback"] = "llm"
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    rationale: str | None = None
    manual_override: bool = False
    source_artifact_ids: list[str] = Field(default_factory=list)
    model: str | None = None
    workflow_decision_id: str | None = None
    taxonomy_version: int | None = None
    input_hash: str | None = None
    assigned_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TaxonomyCatalog(DomainModel):
    schema_version: int = Field(default=2, ge=1)
    taxonomy_version: int = Field(default=1, ge=1)
    themes: list[TaxonomyTheme] = Field(default_factory=list)
    assignments: list[TaxonomyAssignmentRecord] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TaxonomyApplyResult(DomainModel):
    accepted: bool
    created_theme: bool = False
    assignment: TaxonomyAssignmentRecord | None = None
    warning: str | None = None


class TaxonomyCandidate(DomainModel):
    theme_id: str = ""
    label_zh: str = ""
    label_en: str = ""
    description_zh: str = ""
    description_en: str = ""
    inclusion_criteria: list[str] = Field(default_factory=list)
    exclusion_criteria: list[str] = Field(default_factory=list)
    nearest_existing_taxonomy_id: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class TaxonomyWorkflowJudgment(DomainModel):
    pass_index: int = Field(ge=1)
    stage: TaxonomyWorkflowStage
    role: str = Field(min_length=1)
    verdict: str = Field(min_length=1)
    taxonomy_id: str | None = None
    alternative_taxonomy_id: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    alternative_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = ""
    provider: str = "deterministic"
    model: str = "none"
    prompt_version: str = Field(min_length=1)
    input_hash: str = Field(min_length=64, max_length=64)
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TaxonomyWorkflowDecision(DomainModel):
    schema_version: int = Field(default=1, ge=1)
    decision_id: str = Field(min_length=1)
    instrument: InstrumentId
    taxonomy_version: int = Field(ge=1)
    status: TaxonomyWorkflowStatus
    outcome: TaxonomyWorkflowOutcome
    assigned_taxonomy_id: str | None = None
    assigned_label_zh: str | None = None
    assigned_label_en: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    candidate: TaxonomyCandidate | None = None
    judgments: list[TaxonomyWorkflowJudgment] = Field(default_factory=list)
    provider: str = "deterministic"
    model: str = "none"
    prompt_versions: list[str] = Field(default_factory=list)
    input_hash: str = Field(min_length=64, max_length=64)
    rationale: str = ""
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    completed_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TaxonomyJudge(Protocol):
    def __call__(
        self,
        stage: TaxonomyWorkflowStage,
        role: str,
        prompt_version: str,
        payload: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...


def _text(value: Any) -> str:
    return str(value or "").strip()


def _confidence(value: Any) -> float:
    try:
        return min(1.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _hash_payload(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


class GrowingTaxonomy:
    """Apply validated assignments to a serializable research-theme catalog."""

    def __init__(
        self,
        catalog: TaxonomyCatalog | None = None,
        *,
        min_new_theme_confidence: float = 0.78,
    ) -> None:
        if not 0.0 <= min_new_theme_confidence <= 1.0:
            raise ValueError("min_new_theme_confidence must be between 0 and 1")
        self.catalog = catalog or TaxonomyCatalog()
        self.min_new_theme_confidence = min_new_theme_confidence
        # Drop the legacy queue-as-theme representation.
        self.catalog.themes = [theme for theme in self.catalog.themes if theme.id != "new-ideas"]
        self.catalog.assignments = [
            assignment
            for assignment in self.catalog.assignments
            if assignment.taxonomy_id != "new-ideas"
        ]

    def _theme(self, theme_id: str) -> TaxonomyTheme | None:
        return next((theme for theme in self.catalog.themes if theme.id == theme_id), None)

    def _assignment(self, ticker: str) -> TaxonomyAssignmentRecord | None:
        return next(
            (item for item in self.catalog.assignments if item.instrument.ticker == ticker),
            None,
        )

    def _upsert(self, assignment: TaxonomyAssignmentRecord) -> None:
        previous = self._assignment(assignment.instrument.ticker)
        if previous is None:
            self.catalog.assignments.append(assignment)
        else:
            self.catalog.assignments[self.catalog.assignments.index(previous)] = assignment
        self.catalog.updated_at = datetime.now(UTC)

    def apply_llm(
        self,
        *,
        instrument: InstrumentId,
        theme_id: str,
        label: str,
        confidence: float,
        rationale: str | None = None,
        create_theme: bool = False,
        theme_label_zh: str | None = None,
        theme_label_en: str | None = None,
        theme_description_zh: str | None = None,
        theme_description_en: str | None = None,
        theme_inclusion_criteria: list[str] | None = None,
        theme_exclusion_criteria: list[str] | None = None,
        source_artifact_ids: list[str] | None = None,
        model: str | None = None,
        workflow_decision_id: str | None = None,
        input_hash: str | None = None,
    ) -> TaxonomyApplyResult:
        if not THEME_ID_PATTERN.fullmatch(theme_id):
            raise ValueError(f"invalid taxonomy theme id: {theme_id}")
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("taxonomy confidence must be between 0 and 1")
        current = self._assignment(instrument.ticker)
        if current is not None and current.manual_override:
            return TaxonomyApplyResult(
                accepted=False,
                assignment=current,
                warning="manual override is authoritative",
            )

        theme = self._theme(theme_id)
        created_theme = False
        if theme is None:
            labels = (_text(theme_label_zh), _text(theme_label_en))
            if not create_theme or confidence < self.min_new_theme_confidence or not all(labels):
                return TaxonomyApplyResult(
                    accepted=False,
                    warning=(
                        "new theme rejected: admission, confidence, and bilingual labels "
                        "are all required"
                    ),
                )
            theme = TaxonomyTheme(
                id=theme_id,
                label_zh=labels[0],
                label_en=labels[1],
                description_zh=_text(theme_description_zh),
                description_en=_text(theme_description_en),
                inclusion_criteria=[
                    _text(item) for item in (theme_inclusion_criteria or []) if _text(item)
                ],
                exclusion_criteria=[
                    _text(item) for item in (theme_exclusion_criteria or []) if _text(item)
                ],
                order=max((item.order for item in self.catalog.themes), default=0) + 1,
            )
            self.catalog.themes.append(theme)
            self.catalog.taxonomy_version += 1
            created_theme = True
        record = TaxonomyAssignmentRecord(
            instrument=instrument,
            taxonomy_id=theme_id,
            label=_text(label) or theme.label_en,
            method="llm",
            confidence=confidence,
            rationale=_text(rationale) or None,
            manual_override=False,
            source_artifact_ids=list(source_artifact_ids or []),
            model=_text(model) or None,
            workflow_decision_id=workflow_decision_id,
            taxonomy_version=self.catalog.taxonomy_version,
            input_hash=input_hash,
        )
        self._upsert(record)
        return TaxonomyApplyResult(
            accepted=True,
            created_theme=created_theme,
            assignment=record,
        )

    def apply_manual_override(
        self,
        *,
        instrument: InstrumentId,
        theme_id: str,
        rationale: str | None = None,
    ) -> TaxonomyAssignmentRecord:
        theme = self._theme(theme_id)
        if theme is None:
            raise ValueError(f"unknown taxonomy theme: {theme_id}")
        record = TaxonomyAssignmentRecord(
            instrument=instrument,
            taxonomy_id=theme.id,
            label=theme.label_en,
            method="manual",
            confidence=1.0,
            rationale=_text(rationale) or None,
            manual_override=True,
            taxonomy_version=self.catalog.taxonomy_version,
        )
        self._upsert(record)
        return record

    def payload(self) -> dict[str, Any]:
        return self.catalog.model_dump(mode="json", by_alias=True)


class TaxonomyWorkflowEngine:
    """Execute the role-distinct 3 -> 2 -> 3 growing-taxonomy workflow."""

    EXISTING_ROLES = ("fit-judge", "boundary-judge", "counterexample-judge")
    CANDIDATE_ROLES = ("candidate-proposer", "candidate-critic")
    ADMISSION_ROLES = ("stability-judge", "novelty-judge", "utility-judge")
    PROMPT_VERSIONS: ClassVar[dict[str, str]] = {
        "existing-assignment": "taxonomy-existing-v1",
        "candidate-proposal": "taxonomy-proposal-v1",
        "candidate-critique": "taxonomy-critique-v1",
        "admission": "taxonomy-admission-v1",
    }

    def __init__(
        self,
        catalog: TaxonomyCatalog,
        *,
        min_assignment_confidence: float = 0.72,
        min_assignment_margin: float = 0.12,
        min_admission_confidence: float = 0.78,
    ) -> None:
        self.catalog = GrowingTaxonomy(catalog).catalog
        self.min_assignment_confidence = min_assignment_confidence
        self.min_assignment_margin = min_assignment_margin
        self.min_admission_confidence = min_admission_confidence

    def _judgment(
        self,
        *,
        pass_index: int,
        stage: TaxonomyWorkflowStage,
        role: str,
        result: Mapping[str, Any],
        provider: str,
        model: str,
        payload: Mapping[str, Any],
    ) -> TaxonomyWorkflowJudgment:
        return TaxonomyWorkflowJudgment(
            pass_index=pass_index,
            stage=stage,
            role=role,
            verdict=_text(result.get("verdict") or result.get("outcome") or "remain_pending"),
            taxonomy_id=_text(result.get("taxonomyId") or result.get("taxonomy_id")) or None,
            alternative_taxonomy_id=(
                _text(result.get("alternativeTaxonomyId") or result.get("alternative_taxonomy_id"))
                or None
            ),
            confidence=_confidence(result.get("confidence")),
            alternative_confidence=_confidence(
                result.get("alternativeConfidence") or result.get("alternative_confidence")
            ),
            rationale=_text(result.get("rationale")),
            provider=provider,
            model=model,
            prompt_version=self.PROMPT_VERSIONS[stage],
            input_hash=_hash_payload(payload),
        )

    @staticmethod
    def _candidate(result: Mapping[str, Any]) -> TaxonomyCandidate:
        return TaxonomyCandidate(
            theme_id=_text(result.get("themeId") or result.get("theme_id")),
            label_zh=_text(result.get("labelZh") or result.get("label_zh")),
            label_en=_text(result.get("labelEn") or result.get("label_en")),
            description_zh=_text(result.get("descriptionZh") or result.get("description_zh")),
            description_en=_text(result.get("descriptionEn") or result.get("description_en")),
            inclusion_criteria=[
                _text(item) for item in result.get("inclusionCriteria", []) if _text(item)
            ],
            exclusion_criteria=[
                _text(item) for item in result.get("exclusionCriteria", []) if _text(item)
            ],
            nearest_existing_taxonomy_id=(
                _text(
                    result.get("nearestExistingTaxonomyId")
                    or result.get("nearest_existing_taxonomy_id")
                )
                or None
            ),
            confidence=_confidence(result.get("confidence")),
        )

    def run(
        self,
        *,
        decision_id: str,
        instrument: InstrumentId,
        evidence: Mapping[str, Any],
        judge: TaxonomyJudge | None,
        provider: str = "deterministic",
        model: str = "none",
    ) -> TaxonomyWorkflowDecision:
        started = datetime.now(UTC)
        base = {
            "instrument": instrument.model_dump(mode="json", by_alias=True),
            "evidence": dict(evidence),
            "taxonomyVersion": self.catalog.taxonomy_version,
            "themes": [
                theme.model_dump(mode="json", by_alias=True) for theme in self.catalog.themes
            ],
        }
        workflow_hash = _hash_payload(base)
        if judge is None:
            return TaxonomyWorkflowDecision(
                decision_id=decision_id,
                instrument=instrument,
                taxonomy_version=self.catalog.taxonomy_version,
                status="unclassified",
                outcome="remain_pending",
                provider="deterministic",
                model="none",
                prompt_versions=[],
                input_hash=workflow_hash,
                rationale="No configured taxonomy model; no classification was fabricated.",
                started_at=started,
            )

        judgments: list[TaxonomyWorkflowJudgment] = []
        existing_ids = {theme.id for theme in self.catalog.themes}
        for index, role in enumerate(self.EXISTING_ROLES, start=1):
            payload = {**base, "stage": "existing-assignment", "role": role}
            raw = judge(
                "existing-assignment", role, self.PROMPT_VERSIONS["existing-assignment"], payload
            )
            judgments.append(
                self._judgment(
                    pass_index=index,
                    stage="existing-assignment",
                    role=role,
                    result=raw,
                    provider=provider,
                    model=model,
                    payload=payload,
                )
            )
        votes = Counter(
            item.taxonomy_id
            for item in judgments
            if item.taxonomy_id in existing_ids and item.verdict in {"assign", "assign_existing"}
        )
        winner, vote_count = votes.most_common(1)[0] if votes else (None, 0)
        supporting = [item for item in judgments if item.taxonomy_id == winner]
        mean_confidence = sum((item.confidence for item in supporting), 0.0) / max(
            1, len(supporting)
        )
        mean_margin = sum(
            (item.confidence - item.alternative_confidence for item in supporting), 0.0
        ) / max(1, len(supporting))
        if (
            winner
            and vote_count >= 2
            and mean_confidence >= self.min_assignment_confidence
            and mean_margin >= self.min_assignment_margin
        ):
            theme = next(theme for theme in self.catalog.themes if theme.id == winner)
            return TaxonomyWorkflowDecision(
                decision_id=decision_id,
                instrument=instrument,
                taxonomy_version=self.catalog.taxonomy_version,
                status="assigned",
                outcome="assign_existing",
                assigned_taxonomy_id=winner,
                assigned_label_zh=theme.label_zh,
                assigned_label_en=theme.label_en,
                confidence=mean_confidence,
                judgments=judgments,
                provider=provider,
                model=model,
                prompt_versions=sorted({item.prompt_version for item in judgments}),
                input_hash=workflow_hash,
                rationale=f"{vote_count}/3 existing-taxonomy consensus.",
                started_at=started,
            )

        proposal_payload = {
            **base,
            "stage": "candidate-proposal",
            "priorJudgments": [item.model_dump(mode="json", by_alias=True) for item in judgments],
        }
        proposal_raw = judge(
            "candidate-proposal",
            self.CANDIDATE_ROLES[0],
            self.PROMPT_VERSIONS["candidate-proposal"],
            proposal_payload,
        )
        candidate = self._candidate(proposal_raw)
        judgments.append(
            self._judgment(
                pass_index=4,
                stage="candidate-proposal",
                role=self.CANDIDATE_ROLES[0],
                result=proposal_raw,
                provider=provider,
                model=model,
                payload=proposal_payload,
            )
        )
        critique_payload = {
            **base,
            "stage": "candidate-critique",
            "candidate": candidate.model_dump(mode="json", by_alias=True),
        }
        critique_raw = judge(
            "candidate-critique",
            self.CANDIDATE_ROLES[1],
            self.PROMPT_VERSIONS["candidate-critique"],
            critique_payload,
        )
        judgments.append(
            self._judgment(
                pass_index=5,
                stage="candidate-critique",
                role=self.CANDIDATE_ROLES[1],
                result=critique_raw,
                provider=provider,
                model=model,
                payload=critique_payload,
            )
        )
        revised = critique_raw.get("candidate")
        if isinstance(revised, Mapping):
            revised_candidate = self._candidate(revised)
            if (
                revised_candidate.theme_id
                and revised_candidate.label_zh
                and revised_candidate.label_en
            ):
                candidate = revised_candidate
        for offset, role in enumerate(self.ADMISSION_ROLES, start=6):
            payload = {
                **base,
                "stage": "admission",
                "role": role,
                "candidate": candidate.model_dump(mode="json", by_alias=True),
                "critique": dict(critique_raw),
            }
            raw = judge("admission", role, self.PROMPT_VERSIONS["admission"], payload)
            judgments.append(
                self._judgment(
                    pass_index=offset,
                    stage="admission",
                    role=role,
                    result=raw,
                    provider=provider,
                    model=model,
                    payload=payload,
                )
            )

        admission = [item for item in judgments if item.stage == "admission"]
        outcome_votes = Counter(item.verdict for item in admission)
        outcome_text, count = (
            outcome_votes.most_common(1)[0] if outcome_votes else ("remain_pending", 0)
        )
        allowed = {
            "create_new",
            "assign_existing",
            "merge_with_existing",
            "remain_pending",
            "manual_review",
        }
        if count < 2 or outcome_text not in allowed:
            outcome_text = "manual_review"
        outcome: TaxonomyWorkflowOutcome = outcome_text  # type: ignore[assignment]
        supporters = [item for item in admission if item.verdict == outcome]
        final_confidence = sum((item.confidence for item in supporters), 0.0) / max(
            1, len(supporters)
        )
        assigned_id: str | None = None
        status: TaxonomyWorkflowStatus = "unclassified"
        label_zh: str | None = None
        label_en: str | None = None
        if outcome == "create_new":
            valid_candidate = (
                bool(THEME_ID_PATTERN.fullmatch(candidate.theme_id))
                and bool(candidate.label_zh)
                and bool(candidate.label_en)
                and bool(candidate.description_zh)
                and bool(candidate.description_en)
                and bool(candidate.inclusion_criteria)
                and bool(candidate.exclusion_criteria)
                and candidate.theme_id not in existing_ids
            )
            if (
                not valid_candidate
                or final_confidence < self.min_admission_confidence
                or _text(critique_raw.get("verdict")) == "reject"
            ):
                outcome = "manual_review"
            else:
                assigned_id = candidate.theme_id
                label_zh, label_en = candidate.label_zh, candidate.label_en
                status = "assigned"
        elif outcome in {"assign_existing", "merge_with_existing"}:
            targets = Counter(
                item.taxonomy_id for item in supporters if item.taxonomy_id in existing_ids
            )
            assigned_id, target_votes = targets.most_common(1)[0] if targets else (None, 0)
            if (
                assigned_id is None
                or target_votes < 2
                or final_confidence < self.min_assignment_confidence
            ):
                outcome = "manual_review"
                assigned_id = None
            else:
                theme = next(theme for theme in self.catalog.themes if theme.id == assigned_id)
                label_zh, label_en = theme.label_zh, theme.label_en
                status = "assigned"
        if outcome == "manual_review":
            status = "needs-review"
        elif outcome == "remain_pending":
            status = "unclassified"

        return TaxonomyWorkflowDecision(
            decision_id=decision_id,
            instrument=instrument,
            taxonomy_version=self.catalog.taxonomy_version,
            status=status,
            outcome=outcome,
            assigned_taxonomy_id=assigned_id,
            assigned_label_zh=label_zh,
            assigned_label_en=label_en,
            confidence=final_confidence,
            candidate=candidate,
            judgments=judgments,
            provider=provider,
            model=model,
            prompt_versions=sorted({item.prompt_version for item in judgments}),
            input_hash=workflow_hash,
            rationale=f"{count}/3 admission consensus for {outcome_text}.",
            started_at=started,
        )


__all__ = [
    "DEFAULT_THEME_ID",
    "UNCLASSIFIED_THEME_ID",
    "GrowingTaxonomy",
    "TaxonomyApplyResult",
    "TaxonomyAssignmentRecord",
    "TaxonomyCandidate",
    "TaxonomyCatalog",
    "TaxonomyJudge",
    "TaxonomyTheme",
    "TaxonomyWorkflowDecision",
    "TaxonomyWorkflowEngine",
    "TaxonomyWorkflowJudgment",
    "TaxonomyWorkflowOutcome",
    "TaxonomyWorkflowStage",
    "TaxonomyWorkflowStatus",
]
