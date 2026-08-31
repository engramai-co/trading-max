#!/usr/bin/env python3
"""Install the current checkout as a per-user macOS launchd service."""

from __future__ import annotations

import argparse
import os
import plistlib
import subprocess
from pathlib import Path

LABEL_PREFIX = "com.engram.trading-max.local"


def _plist(
    *,
    label: str,
    program: Path,
    state_root: Path,
    log_root: Path,
    environment: dict[str, str],
    keep_alive: bool = False,
    calendar: dict[str, int] | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "Label": label,
        "ProgramArguments": [str(program)],
        "EnvironmentVariables": {
            "TRADING_MAX_STATE_ROOT": str(state_root),
            **environment,
        },
        "WorkingDirectory": str(program.parents[2]),
        "StandardOutPath": str(log_root / f"{label}.out.log"),
        "StandardErrorPath": str(log_root / f"{label}.err.log"),
        "ProcessType": "Interactive",
    }
    if keep_alive:
        payload["RunAtLoad"] = True
        payload["KeepAlive"] = {"SuccessfulExit": False}
        payload["ThrottleInterval"] = 10
    if calendar:
        payload["StartCalendarInterval"] = calendar
    return payload


def _run(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - fixed system commands and arguments
        list(arguments),
        check=check,
        capture_output=True,
        text=True,
    )


def install(app_root: Path, state_root: Path, backup_root: Path) -> None:
    app_root = app_root.expanduser().resolve()
    state_root = state_root.expanduser().resolve()
    backup_root = backup_root.expanduser().resolve()
    if not (app_root / ".git").is_dir():
        raise ValueError(f"not a Git checkout: {app_root}")
    if not (state_root / "secrets" / "trading_max.env").is_file():
        raise ValueError("state root is not initialized; run trading-max setup first")
    if not (app_root / "apps" / "web" / ".next" / "BUILD_ID").is_file():
        raise ValueError("web build is missing; run npm --prefix apps/web run build")

    agents = Path.home() / "Library" / "LaunchAgents"
    log_root = Path.home() / "Library" / "Logs" / "Trading Max"
    agents.mkdir(parents=True, exist_ok=True)
    log_root.mkdir(parents=True, exist_ok=True)
    backup_root.mkdir(parents=True, exist_ok=True)
    environment = {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    }
    definitions = {
        "api": _plist(
            label=f"{LABEL_PREFIX}.api",
            program=app_root / "deploy/local/run-api.sh",
            state_root=state_root,
            log_root=log_root,
            environment=environment,
            keep_alive=True,
        ),
        "worker": _plist(
            label=f"{LABEL_PREFIX}.worker",
            program=app_root / "deploy/local/run-worker.sh",
            state_root=state_root,
            log_root=log_root,
            environment=environment,
            keep_alive=True,
        ),
        "web": _plist(
            label=f"{LABEL_PREFIX}.web",
            program=app_root / "deploy/local/run-web.sh",
            state_root=state_root,
            log_root=log_root,
            environment=environment,
            keep_alive=True,
        ),
        "backup": _plist(
            label=f"{LABEL_PREFIX}.backup",
            program=app_root / "deploy/local/run-backup.sh",
            state_root=state_root,
            log_root=log_root,
            environment={
                **environment,
                "TRADING_MAX_BACKUP_ROOT": str(backup_root),
                "TRADING_MAX_BACKUP_RETAIN": "14",
            },
            calendar={"Hour": 3, "Minute": 15},
        ),
    }
    domain = f"gui/{os.getuid()}"
    for name, payload in definitions.items():
        path = agents / f"{LABEL_PREFIX}.{name}.plist"
        target = f"{domain}/{LABEL_PREFIX}.{name}"
        _run("/bin/launchctl", "bootout", target, check=False)
        with path.open("wb") as stream:
            plistlib.dump(payload, stream, sort_keys=True)
        path.chmod(0o600)
        _run("/bin/launchctl", "bootstrap", domain, str(path))
        if name != "backup":
            _run("/bin/launchctl", "kickstart", "-k", target)


def uninstall() -> None:
    agents = Path.home() / "Library" / "LaunchAgents"
    domain = f"gui/{os.getuid()}"
    for name in ("api", "worker", "web", "backup"):
        label = f"{LABEL_PREFIX}.{name}"
        _run("/bin/launchctl", "bootout", f"{domain}/{label}", check=False)
        (agents / f"{label}.plist").unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("install", "uninstall"))
    parser.add_argument("--app-root", type=Path, default=Path(__file__).parents[2])
    parser.add_argument(
        "--state-root",
        type=Path,
        default=Path.home() / "Library/Application Support/Trading Max",
    )
    parser.add_argument(
        "--backup-root",
        type=Path,
        default=Path.home() / "Backups/Trading Max",
    )
    args = parser.parse_args()
    if args.command == "install":
        install(args.app_root, args.state_root, args.backup_root)
        print("Trading Max local services installed")
    else:
        uninstall()
        print("Trading Max local services removed; state and backups were preserved")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
