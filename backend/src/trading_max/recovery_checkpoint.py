"""Short, independent physical checkpoints; expensive archival runs separately.

The caller holds the recovery repository lock, also used by managed pack
retirement. Publishers may append immutable objects concurrently. Pin latest
and SQLite locators before inventory; never copy a live WAL database as a file.
"""

from __future__ import annotations

import ctypes
import errno
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import uuid
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from .backup import DATABASE_NAME, _included_files
from .backup_repository import _safe_relative, _stamp, atomic_json, exclusive_lock
from .infrastructure import SnapshotStore
from .infrastructure.durable_files import atomic_bytes, sync_directory

FORMAT = "trading-max-checkpoint-v1"
SQLITE = b"SQLite format 3\x00"


def copy_independent(source: Path, target: Path) -> None:
    """APFS clone when available, portable copy otherwise; never hard-link live data."""
    if source.is_symlink() or not source.is_file() or target.exists() or target.is_symlink():
        raise ValueError("copy requires a regular source and absent destination")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if sys.platform == "darwin":
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        clone = library.clonefile
        clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        clone.restype = ctypes.c_int
        if clone(os.fsencode(source), os.fsencode(target), 0) == 0:
            if (source.stat().st_dev, source.stat().st_ino) == (
                target.stat().st_dev,
                target.stat().st_ino,
            ):
                raise ValueError("recovery copies must not hard-link live state")
            return
        error = ctypes.get_errno()
        if error not in {errno.EXDEV, errno.ENOTSUP, errno.EINVAL}:
            raise OSError(error, "independent file clone failed")
    shutil.copyfile(source, target)
    target.chmod(0o600)


def copy_database(source: Path, target: Path, progress=None) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if source.is_symlink() or not source.is_file():
        raise ValueError("invalid checkpoint database")
    with (
        closing(sqlite3.connect(source.as_uri() + "?mode=rw", uri=True)) as reader,
        closing(sqlite3.connect(target)) as writer,
    ):
        reader.execute("PRAGMA query_only=ON")
        reader.backup(
            writer,
            pages=512,
            progress=(lambda *_: progress({"phase": "checkpoint-database"})) if progress else None,
        )
        # A self-contained image must not need source WAL sidecars on recovery.
        writer.execute("PRAGMA journal_mode=DELETE")
        if writer.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("checkpoint database integrity failed")
        if writer.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("checkpoint database foreign key check failed")
    target.chmod(0o600)


def check_snapshot(root: Path) -> str | None:
    store = SnapshotStore(root)
    try:
        snapshot = store.latest()
        return snapshot.manifest.run_id if snapshot else None
    finally:
        store.artifacts.packs.close()


def checkpoint(repository, state: Path, *, label="manual", wait_seconds=0) -> dict:
    """Capture online without waiting for historical logical-envelope expansion."""
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            with exclusive_lock(repository.lock):
                return _capture(repository, state, label=label)
        except RuntimeError as exc:
            if "holds the lock" not in str(exc) or time.monotonic() >= deadline:
                raise
            repository._progress("waiting-for-backup-yield")
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))


def _capture(repository, state: Path, *, label: str) -> dict:
    state = state.expanduser().resolve(strict=True)
    if not (state / DATABASE_NAME).is_file():
        raise FileNotFoundError("checkpoint requires an initialized state database")
    if repository.root == state or repository.root.is_relative_to(state):
        raise ValueError("checkpoint must be outside live state")
    parent = repository.root / "checkpoints"
    if parent.is_symlink():
        raise ValueError("checkpoint directory must not be a symlink")
    parent.mkdir(mode=0o700, exist_ok=True)
    # A killed process cannot run TemporaryDirectory cleanup. Only discard our
    # explicitly marked, unpublished staging trees while holding the writer lock.
    for abandoned in parent.glob(".capture-*"):
        marker = abandoned / "capture.json"
        if abandoned.is_symlink() or marker.is_symlink():
            raise ValueError("checkpoint staging must not follow symlinks")
        if marker.is_file() and json.loads(marker.read_bytes()) == {
            "format": FORMAT,
            "phase": "capturing",
        }:
            shutil.rmtree(abandoned)
    instant = datetime.now(UTC)
    backup_id = instant.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
    started = time.monotonic()
    files = {}
    with tempfile.TemporaryDirectory(prefix=".capture-", dir=parent) as temporary:
        stage = Path(temporary)
        atomic_json(stage / "capture.json", {"format": FORMAT, "phase": "capturing"})
        tree = stage / "state"
        tree.mkdir(mode=0o700)
        pointer = state / "latest.json"
        if pointer.is_file():
            if pointer.is_symlink():
                raise ValueError("latest pointer must not be a symlink")
            atomic_bytes(tree / "latest.json", pointer.read_bytes())
            files["latest.json"] = {"sourceStamp": None, "sqlite": False}
        # The index must precede inventory: all packs already referenced by the
        # saved locator will then be present, even during append-only publication.
        for name in (DATABASE_NAME, "artifacts/object-packs/index.sqlite3"):
            source = state / name
            if source.is_file():
                copy_database(source, tree / name, repository.progress)
                files[name] = {"sourceStamp": None, "sqlite": True}
        sources = list(_included_files(state))
        for number, source in enumerate(sources, 1):
            name = source.relative_to(state).as_posix()
            if name in files or name.startswith("research-cache/disclosures/"):
                continue
            _safe_relative(name)
            before = _stamp(source)
            target = tree / name
            with source.open("rb") as stream:
                database = stream.read(16) == SQLITE
            if database:
                copy_database(source, target, repository.progress)
            else:
                copy_independent(source, target)
                if before != _stamp(source):
                    raise RuntimeError("source changed during checkpoint; retry preserved state")
            files[name] = {"sourceStamp": None if database else before, "sqlite": database}
            if number % 128 == 0:
                repository._progress("checkpoint-copy", files=number, totalFiles=len(sources))
        # Validate the pinned view and every locator target, not the moving live
        # pointer. Comprehensive archival verification is explicitly still pending.
        index = tree / "artifacts/object-packs/index.sqlite3"
        if index.exists():
            with closing(sqlite3.connect(index.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
                for (digest,) in db.execute("SELECT digest FROM packs"):
                    if f"artifacts/object-packs/blocks/{digest}.pack" not in files:
                        raise ValueError("checkpoint locator references a missing pack")
        run_id = check_snapshot(tree)
        for name, entry in files.items():
            path = tree / name
            entry.update(
                size=path.stat().st_size,
                mode=path.stat().st_mode & 0o700,
                checkpointStamp=_stamp(path),
            )
        # Flush the cloned/copy tree before publishing the durable queue item.
        if hasattr(os, "sync"):
            os.sync()
        metadata = {
            "format": FORMAT,
            "id": backup_id,
            "createdAt": instant.isoformat(),
            "sourceState": str(state),
            "label": label,
            "snapshotRunId": run_id,
            "files": files,
            "checkpointSeconds": round(time.monotonic() - started, 3),
            "verification": "sqlite-and-current-snapshot; archive-verification-pending",
        }
        atomic_json(stage / "checkpoint.json", metadata)
        final = parent / backup_id
        stage.rename(final)
        sync_directory(parent)
    result = {
        "id": backup_id,
        "manifest": str(repository.manifest_path(backup_id)),
        "checkpoint": str(final / "checkpoint.json"),
        "snapshotRunId": run_id,
        "files": len(files),
        "physicalBytes": sum(e["size"] for e in files.values()),
        "checkpointSeconds": metadata["checkpointSeconds"],
        "archiveStatus": "queued",
    }
    repository._progress("checkpoint-published", **result)
    return result
