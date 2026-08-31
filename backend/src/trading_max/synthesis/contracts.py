"""Versioned structured-output contracts for LLM synthesis."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pydantic import Field

from trading_max.domain import DomainModel


class LocalizedText(DomainModel):
    zh: str
    en: str


class SynthesisEvidence(DomainModel):
    label: LocalizedText
    detail: LocalizedText
    metric: str | None = None
    source_refs: list[str] = Field(default_factory=list)


class TaxonomyAssignment(DomainModel):
    ticker: str
    theme_id: str
    confidence: float = Field(ge=0, le=1)
    rationale: LocalizedText | None = None
    create_theme: bool = False
    theme_label_zh: str | None = None
    theme_label_en: str | None = None
    theme_description_zh: str | None = None
    theme_description_en: str | None = None


class SynthesisContent(DomainModel):
    headline: LocalizedText
    summary: LocalizedText
    evidence: list[SynthesisEvidence] = Field(default_factory=list)
    counterpoints: list[LocalizedText] = Field(default_factory=list)
    risks: list[LocalizedText] = Field(default_factory=list)
    invalidation_conditions: list[LocalizedText] = Field(default_factory=list)
    next_observations: list[LocalizedText] = Field(default_factory=list)
    taxonomy_assignments: list[TaxonomyAssignment] = Field(default_factory=list)


class SynthesisResponse(SynthesisContent):
    schema_version: int = Field(default=1, ge=1)
    confidence: float = Field(ge=0, le=1)
    source_refs: list[str] = Field(default_factory=list)


class AnalysisDefinition(DomainModel):
    analysis_id: str
    title: str
    prompt_version: str = "v1"


class ProviderUsage(DomainModel):
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)


class SynthesisResult(DomainModel):
    response: SynthesisResponse
    provider: str
    model: str
    usage: ProviderUsage = Field(default_factory=ProviderUsage)
    latency_ms: int = Field(default=0, ge=0)
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fake: bool = False


JsonObject = dict[str, Any]


@dataclass(frozen=True, slots=True)
class ProviderRequest:
    definition: AnalysisDefinition
    context: JsonObject
