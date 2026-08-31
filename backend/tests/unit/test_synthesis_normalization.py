from trading_max.synthesis.contracts import (
    LocalizedText,
    SynthesisEvidence,
    SynthesisResponse,
)
from trading_max.synthesis.normalization import normalize_response


def _text(value: str) -> LocalizedText:
    return LocalizedText(zh=value, en=value)


def test_normalize_response_deduplicates_and_bounds_audit_sections() -> None:
    response = SynthesisResponse(
        headline=_text("Headline"),
        summary=_text("Summary"),
        evidence=[
            SynthesisEvidence(label=_text(f"Fact {index}"), detail=_text("Detail"))
            for index in range(5)
        ]
        + [SynthesisEvidence(label=_text("Fact 0"), detail=_text("Detail"))],
        counterpoints=[_text("Counterpoint 1")] * 2
        + [_text(f"Counterpoint {index}") for index in range(2, 5)],
        risks=[_text("Counterpoint 1"), _text("Risk 2")],
        invalidation_conditions=[_text("Risk 2"), _text("Invalidation")],
        next_observations=[_text("Invalidation"), _text("Next")],
        confidence=0.5,
    )

    normalized = normalize_response(response)

    assert len(normalized.evidence) == 4
    assert [item.en for item in normalized.counterpoints] == [
        "Counterpoint 1",
        "Counterpoint 2",
        "Counterpoint 3",
    ]
    assert [item.en for item in normalized.risks] == ["Risk 2"]
    assert [item.en for item in normalized.invalidation_conditions] == ["Invalidation"]
    assert [item.en for item in normalized.next_observations] == ["Next"]
