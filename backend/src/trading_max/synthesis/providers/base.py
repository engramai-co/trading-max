"""Provider protocol shared by fake and network-backed implementations."""

from __future__ import annotations

from typing import Protocol

from ..contracts import AnalysisDefinition, JsonObject, SynthesisResult


class SynthesisProvider(Protocol):
    name: str
    model: str
    fake: bool

    def analyze(
        self,
        definition: AnalysisDefinition,
        context: JsonObject,
    ) -> SynthesisResult:
        """Return validated evidence-bound synthesis."""
