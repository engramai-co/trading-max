from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def _installer() -> ModuleType:
    root = Path(__file__).resolve().parents[3]
    path = root / "deploy" / "local" / "install-macos-service.py"
    specification = importlib.util.spec_from_file_location(
        "trading_max_local_service_installer",
        path,
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def test_service_plist_is_loopback_state_aware_and_restartable(tmp_path: Path) -> None:
    installer = _installer()
    program = tmp_path / "checkout" / "deploy" / "local" / "run-api.sh"
    payload = installer._plist(  # noqa: SLF001 - contract test for installer output
        label="com.engram.trading-max.local.api",
        program=program,
        state_root=tmp_path / "state",
        log_root=tmp_path / "logs",
        environment={"PATH": "/usr/bin:/bin"},
        keep_alive=True,
    )

    assert payload["ProgramArguments"] == [str(program)]
    assert payload["WorkingDirectory"] == str(tmp_path / "checkout")
    assert payload["EnvironmentVariables"] == {
        "TRADING_MAX_STATE_ROOT": str(tmp_path / "state"),
        "PATH": "/usr/bin:/bin",
    }
    assert payload["RunAtLoad"] is True
    assert payload["KeepAlive"] == {"SuccessfulExit": False}


def test_backup_plist_is_scheduled_without_keepalive(tmp_path: Path) -> None:
    installer = _installer()
    program = tmp_path / "checkout" / "deploy" / "local" / "run-backup.sh"
    payload = installer._plist(  # noqa: SLF001 - contract test for installer output
        label="com.engram.trading-max.local.backup",
        program=program,
        state_root=tmp_path / "state",
        log_root=tmp_path / "logs",
        environment={"TRADING_MAX_BACKUP_ROOT": str(tmp_path / "backups")},
        calendar={"Hour": 3, "Minute": 15},
    )

    assert payload["StartCalendarInterval"] == {"Hour": 3, "Minute": 15}
    assert "KeepAlive" not in payload
    assert "RunAtLoad" not in payload
