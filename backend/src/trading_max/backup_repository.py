"""Independent, deduplicated local recovery copies with verified publication.

Manifests reference compressed file blobs, never hard links to live state.
Existing tar backups remain supported by trading_max.backup.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import sqlite3
import tempfile
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from .backup import DATABASE_NAME, EXCLUDED_COMPONENTS, EXCLUDED_SUFFIXES, _included_files
from .infrastructure import SnapshotStore

_DIGEST = re.compile(r"[0-9a-f]{64}")
_BACKUP_ID = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{12}")
_BLOCK = 1024 * 1024


@contextmanager
def exclusive_lock(path: Path):
    """Fail instead of racing another backup, cleanup or deployment."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError("lock path must not be a symlink")
    with path.open("a+b") as handle:
        path.chmod(0o600)
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                handle.write(b"\0")
                handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("another maintenance operation holds the lock") from exc
        yield


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        Path(name).replace(path)
    finally:
        Path(name).unlink(missing_ok=True)


def _safe_relative(value: str) -> Path:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts or "\\" in value or ":" in value:
        raise ValueError("unsafe backup path")
    if (
        any(part in EXCLUDED_COMPONENTS for part in path.parts)
        or any(path.name.endswith(suffix) for suffix in EXCLUDED_SUFFIXES)
        or ".env." in path.name
    ):
        raise ValueError("excluded backup path")
    if path.as_posix() != value or value == ".":
        raise ValueError("non-canonical backup path")
    return Path(*path.parts)


def _stamp(path: Path) -> list[int]:
    info = path.stat()
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


class BackupRepository:
    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.blobs = self.root / "blobs"
        self.snapshots = self.root / "snapshots"
        for path in (self.root, self.blobs, self.snapshots):
            if path.is_symlink():
                raise ValueError("backup repository directories must not be symlinks")
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = self.root / ".repository.lock"

    def blob_path(self, digest: str) -> Path:
        if not _DIGEST.fullmatch(digest):
            raise ValueError("invalid backup digest")
        path = self.blobs / digest[:2] / (digest + ".gz")
        if path.parent.is_symlink() or path.is_symlink():
            raise ValueError("backup blobs must not be symlinks")
        return path

    def manifest_path(self, backup_id: str) -> Path:
        if not _BACKUP_ID.fullmatch(backup_id):
            raise ValueError("invalid backup id")
        path = self.snapshots / (backup_id + ".json")
        if path.is_symlink():
            raise ValueError("backup manifests must not be symlinks")
        return path

    def _store(self, source: Path, scratch: Path) -> dict:
        if source.is_symlink():
            raise ValueError("backup source must not be a symlink")
        digest = hashlib.sha256()
        temporary = scratch / (uuid.uuid4().hex + ".gz")
        size = 0
        with source.open("rb") as stream, temporary.open("wb") as compressed:
            before = os.fstat(stream.fileno())
            with gzip.GzipFile(
                filename="", mode="wb", compresslevel=3, fileobj=compressed, mtime=0
            ) as output:
                while block := stream.read(_BLOCK):
                    digest.update(block)
                    output.write(block)
                    size += len(block)
            after = os.fstat(stream.fileno())
            compressed.flush()
            os.fsync(compressed.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise RuntimeError("source changed during backup; retry without pruning")
        sha = digest.hexdigest()
        final = self.blob_path(sha)
        final.parent.mkdir(exist_ok=True, mode=0o700)
        if final.exists():
            temporary.unlink()
        else:
            temporary.chmod(0o600)
            temporary.replace(final)
        return {"sha256": sha, "size": size, "mode": before.st_mode & 0o700}

    def create(self, state: Path, *, label: str = "manual", now: datetime | None = None) -> dict:
        state = state.expanduser().resolve()
        if not state.is_dir() or not (state / DATABASE_NAME).is_file():
            raise FileNotFoundError("backup requires an initialized state database")
        if self.root == state or self.root.is_relative_to(state):
            raise ValueError("backup destination must be outside state")
        if (state / DATABASE_NAME).is_symlink():
            raise ValueError("database must not be a symlink")
        with (
            exclusive_lock(self.lock),
            tempfile.TemporaryDirectory(prefix=".capture-", dir=self.root) as temporary,
        ):
            scratch = Path(temporary)
            # Pin the publication pointer before inventorying immutable artifacts.
            pointer = state / "latest.json"
            captured_pointer = scratch / "latest.json"
            if pointer.is_file():
                if pointer.is_symlink():
                    raise ValueError("latest pointer must not be a symlink")
                captured_pointer.write_bytes(pointer.read_bytes())
            database = scratch / DATABASE_NAME
            with (
                sqlite3.connect(f"file:{state / DATABASE_NAME}?mode=ro", uri=True) as source,
                sqlite3.connect(database) as target,
            ):
                source.backup(target)
            catalog_path = self.root / "catalog.json"
            catalog = json.loads(catalog_path.read_text()) if catalog_path.is_file() else {}
            next_catalog: dict = {}
            files = {DATABASE_NAME: self._store(database, scratch)}
            for source in _included_files(state):
                relative = source.relative_to(state).as_posix()
                _safe_relative(relative)
                stamp = _stamp(source)
                cache_key = str(source)
                cached = catalog.get(cache_key)
                immutable = relative.startswith("artifacts/sha256/") and bool(
                    re.fullmatch(r"[0-9a-f]{64}(\.meta\.json)?", source.name)
                )
                if (
                    immutable
                    and cached
                    and cached.get("stamp") == stamp
                    and self.blob_path(cached["file"]["sha256"]).is_file()
                ):
                    entry = cached["file"]
                else:
                    entry = self._store(
                        captured_pointer if relative == "latest.json" else source, scratch
                    )
                files[relative] = entry
                if immutable:
                    next_catalog[cache_key] = {"stamp": stamp, "file": entry}
            instant = now or datetime.now(UTC)
            backup_id = (
                instant.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:12]
            )
            manifest = {
                "schemaVersion": 1,
                "id": backup_id,
                "createdAt": instant.isoformat(),
                "label": label,
                "sourceState": str(state),
                "files": files,
            }
            # No manifest or retention change is published until a full restore read
            # verifies decompression, file digests, database and snapshot references.
            verified = self._verify(manifest)
            manifest["verification"] = verified
            atomic_json(self.manifest_path(backup_id), manifest)
            atomic_json(catalog_path, next_catalog)
            return {"id": backup_id, "manifest": str(self.manifest_path(backup_id)), **verified}

    def _verify(self, manifest: dict, restore_to: Path | None = None) -> dict:
        if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), dict):
            raise ValueError("unsupported backup manifest")
        files = manifest["files"]
        if DATABASE_NAME not in files:
            raise ValueError("backup database is missing")
        with tempfile.TemporaryDirectory(prefix=".verify-", dir=self.root) as temporary:
            db = Path(temporary) / DATABASE_NAME
            indexes: dict[str, dict] = {}
            total = 0
            for name, entry in files.items():
                relative = _safe_relative(name)
                if not isinstance(entry.get("size"), int) or entry["size"] < 0:
                    raise ValueError("invalid backup size")
                digest = hashlib.sha256()
                size = 0
                index = name == "latest.json" or (
                    name.startswith("snapshots/") and name.endswith("/manifest.json")
                )
                metadata = bytearray()
                output = (
                    restore_to / relative if restore_to else db if name == DATABASE_NAME else None
                )
                if output:
                    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with gzip.open(self.blob_path(entry["sha256"]), "rb") as source:
                    handle = output.open("wb") if output else None
                    try:
                        while block := source.read(_BLOCK):
                            size += len(block)
                            if size > entry["size"]:
                                raise ValueError("backup blob exceeds declared size")
                            digest.update(block)
                            if handle:
                                handle.write(block)
                            if index:
                                if size > 16 * _BLOCK:
                                    raise ValueError("backup snapshot index exceeds limit")
                                metadata.extend(block)
                    finally:
                        if handle:
                            handle.close()
                            output.chmod(entry.get("mode", 0o600) & 0o700)
                if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
                    raise ValueError("backup blob checksum mismatch")
                total += size
                if index:
                    indexes[name] = json.loads(metadata)
            database = restore_to / DATABASE_NAME if restore_to else db
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise ValueError("backup database integrity check failed")
            for name, snapshot in indexes.items():
                if name == "latest.json":
                    continue
                for ref in snapshot["artifacts"]:
                    artifact_id = ref["artifact_id"]
                    if (
                        not _DIGEST.fullmatch(artifact_id)
                        or "artifacts/sha256/" + artifact_id not in files
                    ):
                        raise ValueError("backup snapshot references a missing artifact")
                    for dependency in ref.get("dependency_artifact_ids", []):
                        if "artifacts/sha256/" + dependency not in files:
                            raise ValueError("backup snapshot references a missing dependency")
            pointer = indexes.get("latest.json")
            if pointer:
                latest = indexes.get("snapshots/" + pointer["run_id"] + "/manifest.json")
                if latest is None:
                    raise ValueError("backup latest manifest is missing")
                canonical = json.dumps(
                    latest, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                ).encode()
                if hashlib.sha256(canonical).hexdigest() != pointer["manifest_sha256"]:
                    raise ValueError("backup latest manifest checksum mismatch")
                # Validate the actual current artifact identities as a restored app
                # would. This catches a corrupted source object, even if its backup
                # blob faithfully preserved those already-corrupt bytes.
                if restore_to is None:
                    check_root = Path(temporary) / "latest-state"
                    required = {"latest.json", "snapshots/" + pointer["run_id"] + "/manifest.json"}
                    for ref in latest["artifacts"]:
                        name = "artifacts/sha256/" + ref["artifact_id"]
                        required.add(name)
                        if name + ".meta.json" in files:
                            required.add(name + ".meta.json")
                    for name in required:
                        target = check_root / _safe_relative(name)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with (
                            gzip.open(self.blob_path(files[name]["sha256"]), "rb") as source,
                            target.open("wb") as output,
                        ):
                            while block := source.read(_BLOCK):
                                output.write(block)
                else:
                    check_root = restore_to
                SnapshotStore(check_root).latest()
            return {
                "files": len(files),
                "logicalBytes": total,
                "snapshotRunId": pointer["run_id"] if pointer else None,
                "verifiedAt": datetime.now(UTC).isoformat(),
            }

    def verify(self, backup_id: str) -> dict:
        with exclusive_lock(self.lock):
            return self._verify(json.loads(self.manifest_path(backup_id).read_text()))

    def restore(self, backup_id: str, destination: Path) -> dict:
        destination = destination.expanduser().absolute()
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(
                "restore requires a new destination; existing state is never replaced"
            )
        if destination.is_relative_to(self.root):
            raise ValueError("restore destination must be outside the backup repository")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with (
            exclusive_lock(self.lock),
            tempfile.TemporaryDirectory(prefix=".restore-", dir=destination.parent) as temporary,
        ):
            staging = Path(temporary) / "state"
            staging.mkdir(mode=0o700)
            result = self._verify(json.loads(self.manifest_path(backup_id).read_text()), staging)
            if destination.exists() or destination.is_symlink():
                raise FileExistsError("restore destination appeared during verification")
            staging.rename(destination)
            return result


__all__ = ["BackupRepository", "atomic_json", "exclusive_lock"]
