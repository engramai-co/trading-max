"""Consistent, credential-free backups for a local Trading Max state root."""

from __future__ import annotations

import sqlite3
import tarfile
import tempfile
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from shutil import copy2

EXCLUDED_COMPONENTS = {"secrets", "logs", "__pycache__"}
EXCLUDED_SUFFIXES = {".env", ".log", ".db-shm", ".db-wal"}
DATABASE_NAME = "trading_max.db"


def _included_files(state_root: Path) -> Iterator[Path]:
    for path in sorted(state_root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"state root contains unsupported symlink: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(state_root)
        if any(component in EXCLUDED_COMPONENTS for component in relative.parts):
            continue
        if path.name == DATABASE_NAME or any(
            path.name.endswith(suffix) for suffix in EXCLUDED_SUFFIXES
        ):
            continue
        yield path


def create_backup(
    state_root: Path,
    destination: Path,
    *,
    retain: int = 14,
    now: datetime | None = None,
) -> Path:
    """Create and verify one atomic archive, then prune older archives."""

    state_root = state_root.expanduser().resolve()
    destination = destination.expanduser().resolve()
    if not state_root.is_dir():
        raise FileNotFoundError(f"state root does not exist: {state_root}")
    if retain < 1:
        raise ValueError("retain must be at least 1")
    if destination == state_root or destination.is_relative_to(state_root):
        raise ValueError("backup destination must be outside the state root")
    database_path = state_root / DATABASE_NAME
    if not database_path.is_file():
        raise FileNotFoundError(f"database does not exist: {database_path}")
    destination.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now(UTC)).astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    archive = destination / f"trading_max-{stamp}.tar.gz"
    if archive.exists():
        raise FileExistsError(f"backup already exists: {archive}")

    with tempfile.TemporaryDirectory(
        prefix=".trading-max-backup-",
        dir=destination,
    ) as temporary:
        staging = Path(temporary)
        state_stage = staging / "state"
        state_stage.mkdir()
        staged_database = state_stage / DATABASE_NAME
        with (
            sqlite3.connect(database_path) as source,
            sqlite3.connect(staged_database) as target,
        ):
            source.backup(target)
            integrity = target.execute("PRAGMA integrity_check").fetchone()
        if integrity != ("ok",):
            raise RuntimeError(f"backup database integrity check failed: {integrity}")
        for source in _included_files(state_root):
            relative = source.relative_to(state_root)
            target = state_stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            copy2(source, target)

        temporary_archive = staging / archive.name
        with tarfile.open(temporary_archive, mode="w:gz") as handle:
            handle.add(state_stage, arcname="state", recursive=True)
        with tarfile.open(temporary_archive, mode="r:gz") as handle:
            names = handle.getnames()
        if "state" not in names or f"state/{DATABASE_NAME}" not in names:
            raise RuntimeError("backup verification failed: database is missing")
        temporary_archive.replace(archive)

    archives = sorted(
        destination.glob("trading_max-*.tar.gz"),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    for stale in archives[retain:]:
        stale.unlink()
    return archive
