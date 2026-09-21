"""Device login sessions and native credential persistence around Pi OAuth."""

from __future__ import annotations

import json
import math
import os
import secrets
import subprocess
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

from trading_max.synthesis.providers.pi import (
    PI_ROOT,
    PiProvider,
    ProviderError,
    _invoke,
    _node,
    bridge_environment,
)

from .credentials import CredentialStore, CredentialStoreError, secret_fingerprint
from .llm_routing import provider_spec
from .models import OAuthLoginStatus
from .settings import SettingsRepository

PROVIDER = "openai-codex"
REFERENCE = "openai-codex:default"


def _credential(value: object) -> dict:
    if not isinstance(value, dict) or value.get("type") != "oauth":
        raise ValueError("invalid OAuth credential")
    if any(
        not isinstance(value.get(k), str) or not value[k]
        for k in ("access", "refresh", "accountId")
    ):
        raise ValueError("invalid OAuth credential")
    if not isinstance(value.get("expires"), (float, int)) or not math.isfinite(value["expires"]):
        raise ValueError("invalid OAuth expiry")
    return value


@contextmanager
def _credential_lock(path: Path):
    """Serialize refresh across API/worker processes; the lock file has no secrets."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise CredentialStoreError("invalid credential lock")
    with path.open("a+b") as handle:
        path.chmod(0o600)
        deadline = time.monotonic() + 60
        if os.name == "nt":
            import msvcrt

            handle.write(b"\0")
            handle.flush()
        while True:
            try:
                if os.name == "nt":
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise CredentialStoreError("credential store busy") from None
                time.sleep(0.05)
        yield


class OAuthCredentialVault:
    def __init__(self, root: Path, credentials: CredentialStore):
        self.credentials = credentials
        self.lock_path = root / ".openai-oauth.lock"

    def authorize(self) -> dict:
        try:
            with _credential_lock(self.lock_path):
                stored = self.credentials.get(REFERENCE)
                if not stored:
                    raise ProviderError(provider=PROVIDER, code="provider_not_configured")
                credential = _credential(json.loads(stored))
                result = _invoke(
                    {
                        "provider": PROVIDER,
                        "operation": "resolve",
                        "credential": credential,
                    },
                    30,
                )
                refreshed = _credential(result["credential"])
                # Save a rotated refresh token BEFORE any inference request can fail.
                if refreshed != credential:
                    self.credentials.put(REFERENCE, json.dumps(refreshed))
                return {"apiKey": result["auth"]["apiKey"]}
        except (CredentialStoreError, OSError, KeyError, TypeError, ValueError):
            raise ProviderError(provider=PROVIDER, code="provider_auth_failed") from None

    def provider(self, model: str) -> PiProvider:
        return PiProvider(
            api_key="",
            model=model,
            provider_name=PROVIDER,
            base_url=provider_spec(PROVIDER).base_url,
            authorization=self.authorize,
        )

    def save(self, credential: dict, preferences: SettingsRepository, model: str, default: bool):
        encoded = json.dumps(_credential(credential))
        with _credential_lock(self.lock_path):
            previous = self.credentials.get(REFERENCE)
            self.credentials.put(REFERENCE, encoded)
            try:
                preferences.save_integration(
                    provider=PROVIDER,
                    profile=None,
                    enabled=True,
                    model=model,
                    base_url=provider_spec(PROVIDER).base_url,
                    credential_fingerprint=secret_fingerprint(encoded),
                    test_status="succeeded",
                    use_as_default=default,
                )
            except Exception:
                if previous:
                    self.credentials.put(REFERENCE, previous)
                else:
                    self.credentials.delete(REFERENCE)
                raise

    def delete(self, preferences: SettingsRepository):
        with _credential_lock(self.lock_path):
            self.credentials.delete(REFERENCE)
            preferences.remove_integration(provider=PROVIDER, profile=None)


class OAuthLoginManager:
    """One bounded, cancellable device login. Never expose OAuth tokens to HTTP."""

    def __init__(self, vault: OAuthCredentialVault, preferences: SettingsRepository):
        self.vault, self.preferences = vault, preferences
        self._lock = threading.RLock()
        self._session: OAuthLoginStatus | None = None
        self._process: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None

    def start(self, model: str, use_as_default: bool) -> OAuthLoginStatus:
        with self._lock:
            if self._session and self._session.state in {"starting", "pending"}:
                self.cancel(self._session.session_id)
            self._session = OAuthLoginStatus(
                session_id=secrets.token_urlsafe(24),
                state="starting",
                expires_at=datetime.now(UTC) + timedelta(minutes=15),
            )
            self._thread = threading.Thread(
                target=self._run,
                args=(self._session.session_id, model, use_as_default),
                name="trading-max-oauth",
                daemon=True,
            )
            self._thread.start()
            return self._session.model_copy()

    def status(self, session_id: str) -> OAuthLoginStatus:
        with self._lock:
            if not self._session or self._session.session_id != session_id:
                raise KeyError("oauth_session_not_found")
            return self._session.model_copy()

    def _finish(self, session_id: str, state: str, error: str | None = None):
        if self._session and self._session.session_id == session_id:
            self._session = self._session.model_copy(
                update={
                    "state": state,
                    "error_code": error,
                    "user_code": None,
                    "verification_url": None,
                }
            )

    def cancel(self, session_id: str):
        with self._lock:
            current = self.status(session_id)
            if current.state not in {"starting", "pending"}:
                return
            self._finish(session_id, "cancelled")
            if self._process and self._process.poll() is None:
                self._process.terminate()

    def disconnect(self):
        with self._lock:
            if self._session:
                self.cancel(self._session.session_id)
            self.vault.delete(self.preferences)

    def close(self):
        with self._lock:
            if self._session:
                self.cancel(self._session.session_id)
            process, thread = self._process, self._thread
        if process and process.poll() is None:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
        if thread:
            thread.join(timeout=3)

    def _run(self, session_id: str, model: str, default: bool):
        process = None
        watchdog = None
        try:
            process = subprocess.Popen(  # noqa: S603
                [_node(), str(PI_ROOT / "index.mjs")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                env=bridge_environment(),
            )
            watchdog = threading.Timer(
                905, lambda: process.kill() if process.poll() is None else None
            )
            watchdog.daemon = True
            watchdog.start()
            with self._lock:
                if self.status(session_id).state != "starting":
                    return
                self._process = process
            process.stdin.write(json.dumps({"provider": PROVIDER, "operation": "login"}))
            process.stdin.close()
            for line in process.stdout:
                # Pipe is private. Never log a line: final messages contain credentials.
                event = json.loads(line)
                with self._lock:
                    if self.status(session_id).state not in {"starting", "pending"}:
                        return
                    if event.get("type") == "device_code":
                        # The SDK's fixed device-verification origin is the only browser destination.
                        if event.get("verificationUri") != "https://auth.openai.com/codex/device":
                            raise ValueError("invalid verification URL")
                        code = event.get("userCode")
                        if not isinstance(code, str) or not 1 <= len(code) <= 64:
                            raise ValueError("invalid device code")
                        self._session = self._session.model_copy(
                            update={
                                "state": "pending",
                                "user_code": code,
                                "verification_url": event["verificationUri"],
                            }
                        )
                    elif "credential" in event:
                        self.vault.save(event["credential"], self.preferences, model, default)
                        self._finish(session_id, "connected")
                        return
                    else:
                        expired = event.get("error") == "oauth_expired"
                        self._finish(
                            session_id,
                            "expired" if expired else "error",
                            "oauth_expired" if expired else "oauth_login_failed",
                        )
                        return
            raise RuntimeError("OAuth child exited")
        except Exception as exc:
            with self._lock:
                if (
                    self._session
                    and self._session.session_id == session_id
                    and self._session.state in {"starting", "pending"}
                ):
                    self._finish(
                        session_id,
                        "error",
                        "credential_store_unavailable"
                        if isinstance(exc, CredentialStoreError)
                        else "oauth_login_failed",
                    )
        finally:
            if watchdog:
                watchdog.cancel()
            if process:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                if process.stdout:
                    process.stdout.close()
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
            with self._lock:
                if self._process is process:
                    self._process = None
