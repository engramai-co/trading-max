"""Evidence-bound LLM synthesis contracts and providers."""

from .contracts import (
    AnalysisDefinition,
    LocalizedText,
    SynthesisContent,
    SynthesisResponse,
    SynthesisResult,
)
from .providers import (
    DeepSeekProvider,
    FakeProvider,
    OpenAIChatProvider,
    OpenAIResponsesProvider,
    OpenCodeProvider,
    ProviderError,
    create_provider,
)
from .service import SynthesisArtifact, SynthesisService

__all__ = [
    "AnalysisDefinition",
    "DeepSeekProvider",
    "FakeProvider",
    "LocalizedText",
    "OpenAIChatProvider",
    "OpenAIResponsesProvider",
    "OpenCodeProvider",
    "ProviderError",
    "SynthesisArtifact",
    "SynthesisContent",
    "SynthesisResponse",
    "SynthesisResult",
    "SynthesisService",
    "create_provider",
]
