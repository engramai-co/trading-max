from __future__ import annotations

import pytest
from trading_max.domain import InstrumentId
from trading_max.research.taxonomy import (
    GrowingTaxonomy,
    TaxonomyCatalog,
    TaxonomyTheme,
    TaxonomyWorkflowEngine,
)


def _instrument(ticker: str = "NVDA") -> InstrumentId:
    return InstrumentId(ticker=ticker, exchange="NASDAQ", isin="US67066G1040")


def _catalog() -> TaxonomyCatalog:
    return TaxonomyCatalog(
        taxonomy_version=7,
        themes=[
            TaxonomyTheme(
                id="ai-infrastructure",
                label_zh="AI 基础设施",
                label_en="AI infrastructure",
                order=1,
            ),
            TaxonomyTheme(
                id="optical-networking",
                label_zh="光互连与网络",
                label_en="Optical networking",
                order=2,
            ),
        ],
    )


def test_existing_theme_assignment_is_auditable() -> None:
    taxonomy = GrowingTaxonomy(_catalog())

    result = taxonomy.apply_llm(
        instrument=_instrument(),
        theme_id="ai-infrastructure",
        label="AI infrastructure",
        confidence=0.82,
        rationale="Awaiting evidence",
        source_artifact_ids=["a" * 64],
        model="trading_max-fake-v1",
    )

    assert result.accepted is True
    assert result.created_theme is False
    assert result.assignment.method == "llm"
    assert taxonomy.payload()["assignments"][0]["sourceArtifactIds"] == ["a" * 64]


def test_high_confidence_bilingual_assignment_grows_catalog() -> None:
    taxonomy = GrowingTaxonomy(_catalog())

    result = taxonomy.apply_llm(
        instrument=_instrument("MRVL"),
        theme_id="commerce-logistics",
        label="Commerce and logistics",
        confidence=0.91,
        create_theme=True,
        theme_label_zh="光互连与网络",
        theme_label_en="Optical interconnect & networking",
        theme_description_zh="连接计算与数据中心的光学基础设施。",
        theme_description_en="Optical infrastructure connecting compute and data centers.",
    )

    assert result.accepted is True
    assert result.created_theme is True
    assert any(theme.id == "commerce-logistics" for theme in taxonomy.catalog.themes)


def test_low_confidence_new_theme_remains_unclassified_without_growth() -> None:
    taxonomy = GrowingTaxonomy(_catalog())

    result = taxonomy.apply_llm(
        instrument=_instrument("SKHY"),
        theme_id="unproven-theme",
        label="Unproven",
        confidence=0.61,
        create_theme=True,
        theme_label_zh="未证实",
        theme_label_en="Unproven",
    )

    assert result.accepted is False
    assert result.assignment is None
    assert result.warning is not None
    assert not any(theme.id == "unproven-theme" for theme in taxonomy.catalog.themes)


def test_manual_override_is_not_replaced_by_llm() -> None:
    taxonomy = GrowingTaxonomy(_catalog())
    manual = taxonomy.apply_manual_override(
        instrument=_instrument(),
        theme_id="optical-networking",
        rationale="Keep this ticker in the review queue.",
    )

    result = taxonomy.apply_llm(
        instrument=_instrument(),
        theme_id="ai-infrastructure",
        label="AI infrastructure",
        confidence=0.99,
    )

    assert manual.manual_override is True
    assert result.accepted is False
    assert result.assignment is not None
    assert result.assignment.taxonomy_id == "optical-networking"
    assert result.warning == "manual override is authoritative"


@pytest.mark.parametrize("theme_id", ["", "bad theme", "A_THEME"])
def test_theme_ids_are_strictly_validated(theme_id: str) -> None:
    with pytest.raises(ValueError, match="invalid taxonomy theme id"):
        GrowingTaxonomy().apply_llm(
            instrument=_instrument(),
            theme_id=theme_id,
            label="Invalid",
            confidence=0.8,
        )


def test_legacy_queue_theme_is_removed_without_fabricating_an_assignment() -> None:
    legacy = TaxonomyCatalog(
        themes=[
            TaxonomyTheme(
                id="new-ideas",
                label_zh="新想法",
                label_en="New ideas",
            )
        ]
    )

    taxonomy = GrowingTaxonomy(legacy)

    assert taxonomy.catalog.themes == []
    assert taxonomy.catalog.assignments == []


def test_existing_assignment_requires_two_of_three_votes_confidence_and_margin() -> None:
    calls: list[tuple[str, str]] = []

    def judge(stage: str, role: str, _prompt: str, _payload: object) -> dict:
        calls.append((stage, role))
        if role == "counterexample-judge":
            return {"verdict": "no_match", "confidence": 0.7}
        return {
            "verdict": "assign_existing",
            "taxonomyId": "ai-infrastructure",
            "confidence": 0.86,
            "alternativeConfidence": 0.55,
        }

    decision = TaxonomyWorkflowEngine(_catalog()).run(
        decision_id="decision-existing",
        instrument=_instrument(),
        evidence={"description": "accelerated compute"},
        judge=judge,
        provider="opencode",
        model="ds-v4-flash-07-31",
    )

    assert calls == [
        ("existing-assignment", "fit-judge"),
        ("existing-assignment", "boundary-judge"),
        ("existing-assignment", "counterexample-judge"),
    ]
    assert decision.status == "assigned"
    assert decision.outcome == "assign_existing"
    assert decision.assigned_taxonomy_id == "ai-infrastructure"
    assert len(decision.judgments) == 3
    assert decision.input_hash and all(item.input_hash for item in decision.judgments)


def test_existing_votes_without_confidence_margin_continue_to_candidate_passes() -> None:
    calls: list[tuple[str, str]] = []

    def judge(stage: str, role: str, _prompt: str, _payload: object) -> dict:
        calls.append((stage, role))
        if stage == "existing-assignment":
            return {
                "verdict": "assign_existing",
                "taxonomyId": "ai-infrastructure",
                "confidence": 0.8,
                "alternativeConfidence": 0.75,
            }
        if stage == "candidate-proposal":
            return {
                "verdict": "propose",
                "themeId": "power-systems",
                "labelZh": "电力系统",
                "labelEn": "Power systems",
                "descriptionZh": "电力系统与分布式发电基础设施。",
                "descriptionEn": "Power systems and distributed-generation infrastructure.",
                "inclusionCriteria": ["Power-generation or grid infrastructure exposure"],
                "exclusionCriteria": ["Pure software without power-system exposure"],
                "confidence": 0.9,
            }
        if stage == "candidate-critique":
            return {"verdict": "accept", "confidence": 0.84}
        return {"verdict": "create_new", "confidence": 0.88}

    decision = TaxonomyWorkflowEngine(_catalog()).run(
        decision_id="decision-new",
        instrument=_instrument("BE"),
        evidence={"description": "fuel cells and power systems"},
        judge=judge,
        provider="opencode",
        model="ds-v4-flash-07-31",
    )

    assert calls[3:5] == [
        ("candidate-proposal", "candidate-proposer"),
        ("candidate-critique", "candidate-critic"),
    ]
    assert calls[5:] == [
        ("admission", "stability-judge"),
        ("admission", "novelty-judge"),
        ("admission", "utility-judge"),
    ]
    assert decision.status == "assigned"
    assert decision.outcome == "create_new"
    assert decision.assigned_taxonomy_id == "power-systems"
    assert decision.candidate is not None
    assert len(decision.judgments) == 8


def test_split_admission_vote_requires_review_instead_of_growing_taxonomy() -> None:
    outcomes = iter(("create_new", "merge_with_existing", "remain_pending"))

    def judge(stage: str, _role: str, _prompt: str, _payload: object) -> dict:
        if stage == "existing-assignment":
            return {"verdict": "no_match", "confidence": 0.9}
        if stage == "candidate-proposal":
            return {
                "themeId": "power-systems",
                "labelZh": "电力系统",
                "labelEn": "Power systems",
                "confidence": 0.9,
            }
        if stage == "candidate-critique":
            return {"verdict": "accept", "confidence": 0.9}
        return {"verdict": next(outcomes), "confidence": 0.9}

    decision = TaxonomyWorkflowEngine(_catalog()).run(
        decision_id="decision-review",
        instrument=_instrument("BE"),
        evidence={},
        judge=judge,
    )

    assert decision.status == "needs-review"
    assert decision.outcome == "manual_review"
    assert decision.assigned_taxonomy_id is None


def test_missing_provider_remains_pending_without_calling_or_fabricating_category() -> None:
    decision = TaxonomyWorkflowEngine(_catalog()).run(
        decision_id="decision-no-provider",
        instrument=_instrument("GOOGL"),
        evidence={"name": "Alphabet"},
        judge=None,
    )

    assert decision.status == "unclassified"
    assert decision.outcome == "remain_pending"
    assert decision.assigned_taxonomy_id is None
    assert decision.candidate is None
    assert decision.judgments == []
    assert decision.provider == "deterministic"
    assert "No configured taxonomy model" in decision.rationale
    assert "fabricated" in decision.rationale
