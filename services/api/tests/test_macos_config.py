from __future__ import annotations

import importlib.util
import io
import stat
import sys
from pathlib import Path

from services.api.trading_max_api.credentials import InMemoryCredentialStore

SCRIPT = Path(__file__).resolve().parents[3] / "deploy" / "macos" / "configure-host.py"


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "trading_max_configure_host",
        SCRIPT,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load configure-host.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_host_config_uses_keychain_metadata_and_removes_plaintext_key(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_module()
    home = tmp_path / "home"
    state_root = home / "Library" / "Application Support" / "Trading Max"
    env_path = state_root / "secrets" / "trading_max.env"
    env_path.parent.mkdir(parents=True)
    env_path.write_text(
        "TRADING_MAX_LLM_PROVIDER=fake\n"
        "TRADING_MAX_LLM_MODEL=trading_max-fake-v1\n"
        "DEEPSEEK_API_KEY=must-stay\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(module, "HOME", home)
    monkeypatch.setattr(module, "SERVICE_ROOT", home / "Services" / "trading_max")
    monkeypatch.setattr(module, "STATE_ROOT", state_root)
    monkeypatch.setattr(module, "ENV_PATH", env_path)
    store = InMemoryCredentialStore()
    monkeypatch.setattr(module, "credential_store", lambda: store)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "configure-host.py",
            "--llm-provider",
            "deepseek",
            "--llm-model",
            "deepseek-v4-flash",
        ],
    )

    assert module.main() == 0
    content = env_path.read_text(encoding="utf-8")
    assert "DEEPSEEK_API_KEY" not in content
    assert store.get("deepseek:default") == "must-stay"
    assert "TRADING_MAX_LLM_PROVIDER=deepseek" in content
    assert "TRADING_MAX_LLM_MODEL=deepseek-v4-flash" in content
    assert "PORTFOLIO_BACKEND_URL=http://127.0.0.1:8421" in content
    assert "PORTFOLIO_BACKEND_TOKEN=" in content
    assert "TRADING_MAX_INTRADAY_ENABLED=true" in content
    assert "TRADING_MAX_INTRADAY_INTERVAL_SECONDS=600" in content
    assert "TRADING_MAX_FULL_REFRESH_TIMES=06:30,12:00,17:30,22:30" in content
    assert "TRADING_MAX_NIGHTLY_HOUR" not in content
    assert "TRADING_MAX_NIGHTLY_MINUTE" not in content
    assert "TRADING_MAX_INTRADAY_WINDOW_START=00:00" in content
    assert "TRADING_MAX_INTRADAY_WINDOW_END=00:00" in content
    assert "TRADING_MAX_INTRADAY_WEEKDAYS=1,2,3,4,5,6,7" in content
    assert "TRADING_MAX_CREDENTIAL_SERVICE=com.engram.trading-max.credentials" in content
    assert stat.S_IMODE(env_path.stat().st_mode) == 0o600


def test_host_config_reads_deepseek_key_from_stdin(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_module()
    home = tmp_path / "home"
    state_root = home / "Library" / "Application Support" / "Trading Max"
    env_path = state_root / "secrets" / "trading_max.env"
    env_path.parent.mkdir(parents=True)
    monkeypatch.setattr(module, "HOME", home)
    monkeypatch.setattr(module, "SERVICE_ROOT", home / "Services" / "trading_max")
    monkeypatch.setattr(module, "STATE_ROOT", state_root)
    monkeypatch.setattr(module, "ENV_PATH", env_path)
    store = InMemoryCredentialStore()
    monkeypatch.setattr(module, "credential_store", lambda: store)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "configure-host.py",
            "--llm-provider",
            "deepseek",
            "--llm-model",
            "deepseek-v4-flash",
            "--deepseek-api-key-stdin",
        ],
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO("sk-from-stdin\n"))

    assert module.main() == 0
    content = env_path.read_text(encoding="utf-8")
    assert "DEEPSEEK_API_KEY" not in content
    assert store.get("deepseek:default") == "sk-from-stdin"
    assert "TRADING_MAX_LLM_PROVIDER=deepseek" in content
    assert "TRADING_MAX_LLM_MODEL=deepseek-v4-flash" in content


def test_host_config_defers_without_erasing_plaintext_when_keychain_is_locked(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_module()
    home = tmp_path / "home"
    state_root = home / "Library" / "Application Support" / "Trading Max"
    env_path = state_root / "secrets" / "trading_max.env"
    env_path.parent.mkdir(parents=True)
    env_path.write_text(
        "T212_INVEST_API_KEY=key\n"
        "T212_INVEST_API_SECRET=secret\n"
        "DEEPSEEK_API_KEY=deepseek-secret\n",
        encoding="utf-8",
    )

    class LockedCredentialStore:
        def put(self, reference: str, secret: str) -> None:
            raise RuntimeError(f"locked: {reference}:{secret[:1]}")

    monkeypatch.setattr(module, "HOME", home)
    monkeypatch.setattr(module, "SERVICE_ROOT", home / "Services" / "trading_max")
    monkeypatch.setattr(module, "STATE_ROOT", state_root)
    monkeypatch.setattr(module, "ENV_PATH", env_path)
    monkeypatch.setattr(module, "credential_store", LockedCredentialStore)
    monkeypatch.setattr(
        sys,
        "argv",
        ["configure-host.py", "--defer-credential-migration"],
    )

    assert module.main() == 0
    content = env_path.read_text(encoding="utf-8")
    assert "T212_INVEST_API_KEY=key" in content
    assert "T212_INVEST_API_SECRET=secret" in content
    assert "DEEPSEEK_API_KEY=deepseek-secret" in content
    assert stat.S_IMODE(env_path.stat().st_mode) == 0o600
