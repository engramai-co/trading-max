from __future__ import annotations

import importlib.util
import plistlib
import subprocess
from pathlib import Path
from types import ModuleType

import pytest


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


@pytest.mark.parametrize("linked_worktree", [False, True])
def test_installer_accepts_checkout_and_retains_selected_node(
    tmp_path: Path, monkeypatch, linked_worktree: bool
) -> None:
    installer = _installer()
    source = tmp_path / "source"
    source.mkdir()
    installer._run("git", "init", "-b", "main", str(source))
    installer._run(
        "git",
        "-C",
        str(source),
        "-c",
        "user.name=CI",
        "-c",
        "user.email=ci@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "synthetic checkout",
    )
    checkout = source
    if linked_worktree:
        checkout = tmp_path / "linked checkout"
        installer._run("git", "-C", str(source), "worktree", "add", "--detach", str(checkout))
        assert (checkout / ".git").is_file()
    state = tmp_path / "state"
    (state / "secrets").mkdir(parents=True)
    (state / "secrets/trading_max.env").touch()
    build = checkout / "apps/web/.next"
    (build / "standalone").mkdir(parents=True)
    (build / "BUILD_ID").write_text("synthetic")
    (build / "standalone/server.js").touch()
    node = tmp_path / "custom node 22" / "node"
    node.parent.mkdir()
    node.write_text('#!/bin/sh\nprintf "v22.0.0\\n"\n')
    node.chmod(0o700)
    monkeypatch.setenv("TRADING_MAX_NODE_BINARY", str(node))
    home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", lambda: home)
    run = installer._run
    launches = []

    def run_without_launchd(*arguments: str, check: bool = True):
        if arguments[0] == "/bin/launchctl":
            launches.append(arguments)
            return subprocess.CompletedProcess(arguments, 0, "", "")
        return run(*arguments, check=check)

    monkeypatch.setattr(installer, "_run", run_without_launchd)
    installer.install(checkout, state, tmp_path / "backups")

    agents = home / "Library/LaunchAgents"
    for name in ("api", "worker", "web", "backup"):
        payload = plistlib.loads((agents / f"{installer.LABEL_PREFIX}.{name}.plist").read_bytes())
        assert payload["EnvironmentVariables"]["TRADING_MAX_NODE_BINARY"] == str(node)
        assert payload["WorkingDirectory"] == str(checkout)
    assert len([command for command in launches if command[1] == "bootstrap"]) == 4


def test_installer_rejects_directory_inside_checkout_before_writing_services(
    tmp_path: Path, monkeypatch
) -> None:
    installer = _installer()
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    installer._run("git", "init", str(checkout))
    nested = checkout / "nested"
    nested.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    with pytest.raises(ValueError, match="not a Git checkout"):
        installer.install(nested, tmp_path / "state", tmp_path / "backups")
    assert not (tmp_path / "home").exists()
