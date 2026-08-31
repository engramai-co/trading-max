"""Deterministic output hygiene for provider-generated synthesis."""

from __future__ import annotations

import re
from collections.abc import Iterable

from .contracts import LocalizedText, SynthesisEvidence, SynthesisResponse

_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)


def _key(value: str) -> str:
    """Normalize text enough to catch exact bilingual duplicates."""

    return _NON_WORD.sub("", value.casefold())


def _localized_key(value: LocalizedText) -> tuple[str, str]:
    return (_key(value.zh), _key(value.en))


def _dedupe_localized(
    items: Iterable[LocalizedText],
    *,
    seen: set[tuple[str, str]],
    limit: int,
) -> list[LocalizedText]:
    result: list[LocalizedText] = []
    for item in items:
        item_key = _localized_key(item)
        if item_key in seen or not any(item_key):
            continue
        seen.add(item_key)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def _dedupe_evidence(
    items: Iterable[SynthesisEvidence],
    *,
    limit: int,
) -> list[SynthesisEvidence]:
    result: list[SynthesisEvidence] = []
    seen: set[tuple[tuple[str, str], tuple[str, str], str]] = set()
    for item in items:
        item_key = (
            _localized_key(item.label),
            _localized_key(item.detail),
            _key(item.metric or ""),
        )
        if item_key in seen or not any(item_key[0]) or not any(item_key[1]):
            continue
        seen.add(item_key)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def normalize_response(response: SynthesisResponse) -> SynthesisResponse:
    """Remove duplicate/filler audit points without changing provider semantics.

    The LLM prompt defines the intended roles; this boundary is a deterministic
    last line of defence for retries, provider drift, and cached artifacts. It
    only removes exact normalized duplicates and caps unbounded lists. It does
    not attempt semantic rewriting or silently merge distinct observations.
    """

    content = response.model_copy(deep=True)
    content.evidence = _dedupe_evidence(content.evidence, limit=4)
    seen: set[tuple[str, str]] = set()
    content.counterpoints = _dedupe_localized(content.counterpoints, seen=seen, limit=3)
    content.risks = _dedupe_localized(content.risks, seen=seen, limit=3)
    content.invalidation_conditions = _dedupe_localized(
        content.invalidation_conditions, seen=seen, limit=3
    )
    content.next_observations = _dedupe_localized(content.next_observations, seen=seen, limit=3)
    return response.model_copy(
        update={
            "headline": content.headline,
            "summary": content.summary,
            "evidence": content.evidence,
            "counterpoints": content.counterpoints,
            "risks": content.risks,
            "invalidation_conditions": content.invalidation_conditions,
            "next_observations": content.next_observations,
            "taxonomy_assignments": content.taxonomy_assignments,
        }
    )


__all__ = ["normalize_response"]
