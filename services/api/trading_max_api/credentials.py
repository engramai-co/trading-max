"""Operating-system credential storage for Trading Max integrations."""

from __future__ import annotations

import hashlib
import subprocess
import threading
from collections.abc import MutableMapping
from pathlib import Path
from typing import Protocol

from trading_max.credentials import (
    configured_credential_service,
    legacy_credential_lookup_enabled,
)


class CredentialStoreError(RuntimeError):
    """Raised when the host credential manager cannot store or read a secret."""


class CredentialStore(Protocol):
    def get(self, reference: str) -> str | None:
        """Return the secret for an opaque reference, if configured."""

    def put(self, reference: str, secret: str) -> None:
        """Atomically replace the secret for a reference."""

    def delete(self, reference: str) -> None:
        """Delete a secret without returning its value."""


def secret_fingerprint(secret: str) -> str:
    """Return a non-reversible identifier suitable for status displays."""

    return hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12]


class InMemoryCredentialStore:
    """Deterministic adapter used by unit and API contract tests only."""

    def __init__(self, values: MutableMapping[str, str] | None = None) -> None:
        self.values = values if values is not None else {}
        self._lock = threading.RLock()

    def get(self, reference: str) -> str | None:
        with self._lock:
            return self.values.get(reference)

    def put(self, reference: str, secret: str) -> None:
        with self._lock:
            self.values[reference] = secret

    def delete(self, reference: str) -> None:
        with self._lock:
            self.values.pop(reference, None)


class KeyringCredentialStore:
    """Adapter backed by macOS Keychain, Windows Credential Manager, or Secret Service."""

    def __init__(self, *, service: str = "com.engram.trading-max.credentials") -> None:
        try:
            import keyring
        except ImportError as exc:  # pragma: no cover - dependency is locked
            raise CredentialStoreError("keyring dependency is not installed") from exc
        self._keyring = keyring
        self.service = service

    def _security(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        """Use macOS's native CLI when a headless runner rejects keyring calls."""

        executable = Path("/usr/bin/security")
        if not executable.is_file():
            raise CredentialStoreError("macOS security CLI is unavailable")
        return subprocess.run(  # noqa: S603 - fixed absolute executable, no shell
            [str(executable), *arguments],
            check=False,
            capture_output=True,
            text=True,
        )

    @staticmethod
    def _not_found(result: subprocess.CompletedProcess[str]) -> bool:
        error = result.stderr.lower()
        return "could not be found" in error or "item not found" in error

    def get(self, reference: str) -> str | None:
        try:
            return self._keyring.get_password(self.service, reference)
        except Exception as exc:  # keyring backends expose platform-specific errors
            try:
                result = self._security(
                    "find-generic-password",
                    "-a",
                    reference,
                    "-s",
                    self.service,
                    "-w",
                )
            except CredentialStoreError:
                raise CredentialStoreError(
                    "operating-system credential store is unavailable"
                ) from exc
            if result.returncode == 0:
                return result.stdout.rstrip("\n")
            if self._not_found(result):
                return None
            raise CredentialStoreError("operating-system credential store is unavailable") from exc

    def put(self, reference: str, secret: str) -> None:
        try:
            self._keyring.set_password(self.service, reference, secret)
            return
        except Exception as exc:
            try:
                result = self._security(
                    "add-generic-password",
                    "-U",
                    "-a",
                    reference,
                    "-s",
                    self.service,
                    "-w",
                    secret,
                )
            except CredentialStoreError:
                raise CredentialStoreError(
                    "operating-system credential store is unavailable"
                ) from exc
            if result.returncode == 0:
                return
            raise CredentialStoreError("operating-system credential store is unavailable") from exc

    def delete(self, reference: str) -> None:
        try:
            self._keyring.delete_password(self.service, reference)
            return
        except self._keyring.errors.PasswordDeleteError:
            return
        except Exception as exc:
            try:
                result = self._security(
                    "delete-generic-password",
                    "-a",
                    reference,
                    "-s",
                    self.service,
                )
            except CredentialStoreError:
                raise CredentialStoreError(
                    "operating-system credential store is unavailable"
                ) from exc
            if result.returncode == 0 or self._not_found(result):
                return
            raise CredentialStoreError("operating-system credential store is unavailable") from exc


class LegacyAwareCredentialStore:
    """Read the previous DeepSeek item once while hosts complete migration."""

    def __init__(self, primary: KeyringCredentialStore) -> None:
        self.primary = primary
        self.legacy_deepseek = KeyringCredentialStore(service="com.engram.trading-max.deepseek")

    def get(self, reference: str) -> str | None:
        value = self.primary.get(reference)
        if value or reference != "deepseek:default":
            return value
        return self.legacy_deepseek.get("trading-max-api")

    def put(self, reference: str, secret: str) -> None:
        self.primary.put(reference, secret)

    def delete(self, reference: str) -> None:
        self.primary.delete(reference)


def default_credential_store() -> CredentialStore:
    """Create the native OS adapter; never silently fall back to plaintext."""

    primary = KeyringCredentialStore(service=configured_credential_service())
    if legacy_credential_lookup_enabled():
        return LegacyAwareCredentialStore(primary)
    return primary


__all__ = [
    "CredentialStore",
    "CredentialStoreError",
    "InMemoryCredentialStore",
    "KeyringCredentialStore",
    "LegacyAwareCredentialStore",
    "default_credential_store",
    "secret_fingerprint",
]
