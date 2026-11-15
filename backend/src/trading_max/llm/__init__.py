"""Shared model connections, native transports and safe provider errors."""

import os

# The SDK's terminal banner is not part of the service's startup output.
os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

from .completion import check_connection
from .model import (
    LOCAL_PROVIDERS,
    REMOTE_BASE_URLS,
    ModelConnection,
    ProviderError,
    build_model,
)

__all__ = [
    "LOCAL_PROVIDERS",
    "REMOTE_BASE_URLS",
    "ModelConnection",
    "ProviderError",
    "build_model",
    "check_connection",
]
