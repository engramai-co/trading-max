"""Shared credential-namespace policy for local Trading Max installations."""

from __future__ import annotations

import os
from collections.abc import Mapping

DEFAULT_CREDENTIAL_SERVICE = "com.engram.trading-max.credentials"
CREDENTIAL_SERVICE_ENV = "TRADING_MAX_CREDENTIAL_SERVICE"
LEGACY_CREDENTIAL_LOOKUP_ENV = "TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP"


def configured_credential_service(
    environment: Mapping[str, str] | None = None,
) -> str:
    """Return the credential service selected for this installation."""

    values = os.environ if environment is None else environment
    configured = values.get(CREDENTIAL_SERVICE_ENV, "").strip()
    return configured or DEFAULT_CREDENTIAL_SERVICE


def legacy_credential_lookup_enabled(
    environment: Mapping[str, str] | None = None,
) -> bool:
    """Allow legacy global lookups only for the historical default installation.

    A non-default credential service denotes an isolated installation and must
    never inherit credentials from another Trading Max state root. Operators
    can explicitly disable migration on the default installation as well.
    """

    values = os.environ if environment is None else environment
    explicit = values.get(LEGACY_CREDENTIAL_LOOKUP_ENV)
    if explicit is not None:
        return explicit.strip().lower() in {"1", "true", "yes", "on"}
    return configured_credential_service(values) == DEFAULT_CREDENTIAL_SERVICE


__all__ = [
    "CREDENTIAL_SERVICE_ENV",
    "DEFAULT_CREDENTIAL_SERVICE",
    "LEGACY_CREDENTIAL_LOOKUP_ENV",
    "configured_credential_service",
    "legacy_credential_lookup_enabled",
]
