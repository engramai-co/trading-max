from __future__ import annotations

import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from tools.restore_backup import CONFIRMATION, restore_archive


def _state_archive(path: Path, value: str) -> None:
    state = path.parent / "state"
    state.mkdir()
    (state / "watchlist.json").write_text(value, encoding="utf-8")
    with tarfile.open(path, mode="w:gz") as handle:
        handle.add(state, arcname="state")


def test_restore_requires_confirmation_and_preserves_current_state(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "backup.tar.gz"
    _state_archive(archive, "restored")
    destination = tmp_path / "runtime"
    destination.mkdir()
    (destination / "watchlist.json").write_text("current", encoding="utf-8")

    with pytest.raises(PermissionError):
        restore_archive(
            archive,
            destination,
            confirmation="no",
            safety_backup=tmp_path / "safety",
        )
    assert (destination / "watchlist.json").read_text() == "current"

    safety = restore_archive(
        archive,
        destination,
        confirmation=CONFIRMATION,
        safety_backup=tmp_path / "safety",
    )

    assert safety == (tmp_path / "safety").resolve()
    assert (destination / "watchlist.json").read_text() == "restored"
    assert (tmp_path / "safety" / "watchlist.json").read_text() == "current"


def test_restore_cli_help_runs_without_repository_pythonpath(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[3]
    environment = dict(os.environ)
    environment.pop("PYTHONPATH", None)
    result = subprocess.run(  # noqa: S603 - execute the repository CLI with help only
        [sys.executable, str(root / "tools/restore_backup.py"), "--help"],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "--safety-backup" in result.stdout
