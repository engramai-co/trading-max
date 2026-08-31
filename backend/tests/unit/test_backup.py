from __future__ import annotations

import sqlite3
import tarfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from trading_max.backup import create_backup


def _state(root: Path, value: str = "fixture") -> None:
    root.mkdir()
    with sqlite3.connect(root / "trading_max.db") as database:
        database.execute("CREATE TABLE sample (value TEXT NOT NULL)")
        database.execute("INSERT INTO sample VALUES (?)", (value,))
    (root / "watchlist.json").write_text(value, encoding="utf-8")
    (root / "logs").mkdir()
    (root / "logs" / "api.log").write_text("private log", encoding="utf-8")
    (root / "secrets").mkdir()
    (root / "secrets" / "trading_max.env").write_text(
        "TOKEN=secret",
        encoding="utf-8",
    )


def test_backup_is_consistent_and_excludes_credentials(tmp_path: Path) -> None:
    state = tmp_path / "state"
    destination = tmp_path / "backups"
    _state(state)

    archive = create_backup(
        state,
        destination,
        now=datetime(2026, 8, 12, tzinfo=UTC),
    )

    with tarfile.open(archive, mode="r:gz") as handle:
        names = handle.getnames()
        handle.extract("state/trading_max.db", tmp_path, filter="data")
    assert "state/watchlist.json" in names
    assert not any("secrets" in name or name.endswith(".log") for name in names)
    with sqlite3.connect(tmp_path / "state" / "trading_max.db") as database:
        assert database.execute("SELECT value FROM sample").fetchone() == ("fixture",)


def test_backup_retention_and_validation(tmp_path: Path) -> None:
    state = tmp_path / "state"
    destination = tmp_path / "backups"
    _state(state)
    first = datetime(2026, 8, 12, tzinfo=UTC)
    for offset in range(3):
        create_backup(
            state,
            destination,
            retain=2,
            now=first + timedelta(seconds=offset),
        )
    assert len(list(destination.glob("trading_max-*.tar.gz"))) == 2

    with pytest.raises(ValueError, match="retain"):
        create_backup(state, destination, retain=0)
    with pytest.raises(ValueError, match="outside"):
        create_backup(state, state / "backups")


def test_backup_requires_an_initialized_database(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir()

    with pytest.raises(FileNotFoundError, match="database"):
        create_backup(state, tmp_path / "backups")
