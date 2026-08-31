from __future__ import annotations

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
