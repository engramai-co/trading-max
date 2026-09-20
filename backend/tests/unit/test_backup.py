from __future__ import annotations

import sqlite3
import stat
import tarfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import trading_max.backup as backup
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
    assert stat.S_IMODE(archive.stat().st_mode) == 0o600
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


def test_backup_excludes_environment_file_variants(tmp_path: Path) -> None:
    state = tmp_path / "state"
    _state(state)
    filenames = [".env", ".env.local", ".env.production", "trading_max.env.bak"]
    for filename in filenames:
        (state / filename).write_text("SECRET=synthetic", encoding="utf-8")

    archive = create_backup(state, tmp_path / "backups")

    with tarfile.open(archive, mode="r:gz") as handle:
        names = handle.getnames()
    assert not any(f"state/{filename}" in names for filename in filenames)


def test_backup_rejects_a_database_symlink_before_opening_its_target(
    tmp_path: Path, monkeypatch
) -> None:
    state = tmp_path / "state"
    _state(state)
    database = state / "trading_max.db"
    outside = tmp_path / "outside.db"
    database.rename(outside)
    database.symlink_to(outside)

    def must_not_open(*_args, **_kwargs):
        pytest.fail("backup opened a database outside its state root")

    monkeypatch.setattr(backup.sqlite3, "connect", must_not_open)
    with pytest.raises(ValueError, match="symlink"):
        create_backup(state, tmp_path / "backups")


def test_packed_archive_rejects_retiring_source_then_materializes_independent_originals(
    tmp_path, monkeypatch
):
    from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore

    state = tmp_path / "state"
    _state(state)
    store = ContentAddressedArtifactStore(state / "artifacts")
    item = store.put_json(key="fixture.json", payload={"value": "unchanged"})
    aid = item.ref.artifact_id
    original = store.content_bytes(aid)
    SnapshotStore(state, artifacts=store).publish(
        scope="accounts", source="fixture", artifacts=[item]
    )
    store.packs.add({"artifact/" + aid: original})
    real_content = ContentAddressedArtifactStore.content_bytes

    def retire_then_read(self, artifact_id):
        if self.root == store.root:
            self.path_for(artifact_id).unlink(missing_ok=True)
        return real_content(self, artifact_id)

    monkeypatch.setattr(ContentAddressedArtifactStore, "content_bytes", retire_then_read)
    # A changing source must abort without publishing or pruning recovery.
    with pytest.raises(FileNotFoundError):
        create_backup(state, tmp_path / "backups")
    assert not list((tmp_path / "backups").glob("*.tar.gz"))
    archive = create_backup(state, tmp_path / "backups")
    store.packs.close()
    import shutil

    shutil.rmtree(state)
    with tarfile.open(archive, "r:gz") as handle:
        assert handle.extractfile("state/artifacts/sha256/" + aid).read() == original
        assert not any("object-packs" in n for n in handle.getnames())
    assert not list((tmp_path / "backups").glob(".trading-max-backup-*"))
