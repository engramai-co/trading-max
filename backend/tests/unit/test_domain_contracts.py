from decimal import Decimal

from trading_max.domain import (
    InstrumentId,
    LlmSynthesis,
    Money,
    TaxonomyAssignment,
)


def test_money_and_research_provenance_are_explicit() -> None:
    money = Money(amount=Decimal("12.34"), currency="gbp")
    synthesis = LlmSynthesis(
        lens="daily_cio_brief",
        model="fake",
        prompt_version="overview-v1",
        input_artifact_ids=["a" * 64],
        content="fixture",
    )
    assignment = TaxonomyAssignment(
        instrument=InstrumentId(ticker="TSM", exchange="NYSE"),
        taxonomy_id="semiconductor-memory",
        label="Semiconductor memory",
        confidence=0.91,
    )

    assert money.currency == "GBP"
    assert synthesis.input_artifact_ids == ["a" * 64]
    assert assignment.method == "llm"
