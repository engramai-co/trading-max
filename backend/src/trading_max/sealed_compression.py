"""Losslessly retire raw recovery aliases after durable compressed verification.

Callers hold deployment/repository locks and gate all retained recovery readers.
No manifest, recovery date or original file identity changes.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import tempfile
from pathlib import Path

from .backup_repository import _stamp, atomic_json
from .infrastructure.durable_files import sync_directory
from .infrastructure.object_packs import MAX_BYTES
from .pack_maintenance import COLD_BYTES, LoosePacker
from .physical_recovery import compression_enabled, digest_file, raw_path


def verify_gzip(path: Path, digest: str, size: int) -> None:
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("compressed recovery must not be a symlink")
    actual = hashlib.sha256()
    length = 0
    with gzip.open(path, "rb") as stream:
        while block := stream.read(1024 * 1024):
            length += len(block)
            if length > size:
                raise ValueError("compressed recovery exceeds original size")
            actual.update(block)
    if length != size or actual.hexdigest() != digest:
        raise ValueError("compressed recovery checksum mismatch")


def store_gzip(repository, source: Path, digest: str) -> int:
    """Independent streamed copy, also for files larger than the pack size limit."""
    if source.is_symlink() or source.parent.is_symlink():
        raise ValueError("recovery source must not be a symlink")
    target = repository.blob_path(digest)
    before = _stamp(source)
    if target.exists():
        verify_gzip(target, digest, before[2])
        return 0
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    actual = hashlib.sha256()
    with tempfile.NamedTemporaryFile(prefix=".compressed-", dir=target.parent, delete=False) as out:
        temporary = Path(out.name)
        try:
            with (
                source.open("rb") as stream,
                gzip.GzipFile(
                    filename="", fileobj=out, mode="wb", compresslevel=3, mtime=0
                ) as encoded,
            ):
                while block := stream.read(1024 * 1024):
                    actual.update(block)
                    encoded.write(block)
            out.flush()
            os.fsync(out.fileno())
            if actual.hexdigest() != digest or before != _stamp(source):
                raise ValueError("recovery source changed during compression")
            verify_gzip(temporary, digest, before[2])
            size = temporary.stat().st_size
            temporary.replace(target)
            sync_directory(target.parent)
            return size
        finally:
            temporary.unlink(missing_ok=True)


def raw_candidates(repository):
    for path in sorted((repository.root / "physical").glob("*/*")):
        if len(path.name) == 64:
            if raw_path(repository, path.name) != path:
                raise ValueError("non-canonical recovery object")
            yield path


def _finish_large(repository, journal_path: Path, journal: dict) -> None:
    if journal.get("repository") != str(repository.root):
        raise ValueError("compression journal belongs to another repository")
    digest, size = journal["sha256"], journal["size"]
    source = raw_path(repository, digest)
    verify_gzip(repository.blob_path(digest), digest, size)
    if source.exists():
        if source.stat().st_size != size or digest_file(source) != digest:
            raise ValueError("raw recovery source changed; preserved")
        source.unlink()
        sync_directory(source.parent)
    atomic_json(journal_path, {**journal, "status": "complete"})


def compress_repository(repository, journals: Path, **budgets) -> dict:
    if not compression_enabled(repository):
        raise ValueError("compressed recovery has not passed activation")
    if journals.is_symlink():
        raise ValueError("compression journals must not be symlinks")
    journals.mkdir(parents=True, exist_ok=True, mode=0o700)
    for path in sorted(journals.glob("large-*.json")):
        if path.is_symlink():
            raise ValueError("compression journal must not be a symlink")
        journal = json.loads(path.read_bytes())
        if journal.get("status") != "complete":
            _finish_large(repository, path, journal)
    originals = list(raw_candidates(repository))
    result = LoosePacker(repository.root, repository.packs, journals / "small").run(
        (
            (p, "blob/" + p.name, "recovery-raw")
            for p in originals
            if p.exists() and p.stat().st_size <= MAX_BYTES
        ),
        target_bytes=COLD_BYTES,
        **budgets,
    )
    window = budgets.get("window")
    for source in originals:
        if not source.exists() or source.stat().st_size <= MAX_BYTES:
            continue
        size = source.stat().st_size
        if window and window.stopped():
            break
        if result["convertedFiles"] >= budgets.get("max_files", 4096) or result[
            "logicalBytes"
        ] + size > budgets.get("max_bytes", 256 * 1024 * 1024):
            if window:
                window.reason = "item-or-byte-budget"
            break
        written = store_gzip(repository, source, source.name)
        journal = {
            "schemaVersion": 1,
            "repository": str(repository.root),
            "status": "prepared",
            "sha256": source.name,
            "size": size,
        }
        path = journals / ("large-" + source.name + ".json")
        atomic_json(path, journal)
        _finish_large(repository, path, journal)
        result["convertedFiles"] += 1
        result["logicalBytes"] += size
        result["retiredFileBytes"] += size
        result["sealedFileBytes"] += written
        if window:
            window.report(**result)
    return result
