"""Independent, deduplicated local recovery copies with verified publication.

Manifests reference compressed file blobs, never hard links to live state.
Existing tar backups remain supported by trading_max.backup.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import os
import re
import sqlite3
import tarfile
import tempfile
import time
import uuid
from collections.abc import Callable
from contextlib import ExitStack, closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from .backup import DATABASE_NAME, EXCLUDED_COMPONENTS, EXCLUDED_SUFFIXES, _included_files
from .infrastructure import ContentAddressedArtifactStore, SnapshotStore, compressed_json
from .infrastructure.history_chunks import (
    atomic_bytes,
    durable_directory,
    read_descriptor,
    sync_directory,
)
from .infrastructure.manifest_catalog import FORMAT as CATALOG_FORMAT
from .infrastructure.manifest_catalog import ManifestCatalog
from .infrastructure.object_packs import ObjectPacks
from .infrastructure.verified_chunks import VerifiedChunkCache

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
    atomic_bytes(path, json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


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
    def __init__(self, root: Path, *, progress: Callable[[dict], None] | None = None):
        self.root = root.expanduser().resolve()
        self.blobs = self.root / "blobs"
        self.snapshots = self.root / "snapshots"
        for path in (self.root, self.blobs, self.snapshots):
            if path.is_symlink():
                raise ValueError("backup repository directories must not be symlinks")
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = self.root / ".repository.lock"
        self.packs = ObjectPacks(self.root / "object-packs")
        self.manifest_catalog = ManifestCatalog(self.packs)
        self.packed_store = ContentAddressedArtifactStore(self.root / "packed")
        self.progress = progress

    def _progress(self, phase: str, **details) -> None:
        if self.progress:
            self.progress({"phase": phase, **details})

    def packed_path(self, digest: str) -> Path:
        if not _DIGEST.fullmatch(digest):
            raise ValueError("invalid backup digest")
        root = self.root / "packed"
        path = root / (digest + ".json")
        if root.is_symlink() or path.is_symlink():
            raise ValueError("packed backup must not be a symlink")
        return path

    def packed_descriptor(self, digest: str) -> dict | None:
        path = self.packed_path(digest)
        if path.is_file():
            descriptor = read_descriptor(path)
            if descriptor is None:
                raise ValueError("packed backup descriptor is invalid")
            return descriptor
        if self.packs.contains("descriptor/" + digest):
            descriptor = json.loads(self.packs.read("descriptor/" + digest))
            if descriptor.get("$format") not in {"trading-max-history-v1", "trading-max-json-v1"}:
                raise ValueError("packed backup descriptor is invalid")
            return descriptor
        return None

    def has_blob(self, digest: str) -> bool:
        return (
            self.blob_path(digest).is_file()
            or self.packed_path(digest).is_file()
            or self.packs.contains("blob/" + digest)
            or self.packs.contains("descriptor/" + digest)
        )

    def manifest_bytes(self, backup_id: str) -> bytes:
        raw = self.manifest_path(backup_id).read_bytes()
        value = json.loads(raw)
        if value.get("$format") == CATALOG_FORMAT:
            if value.get("id") != backup_id:
                raise ValueError("backup catalog identity mismatch")
            return self.manifest_catalog.decode(value)
        return raw

    def read_manifest(self, backup_id: str) -> dict:
        return json.loads(self.manifest_bytes(backup_id))

    def blob_files(self, digest: str) -> list[Path]:
        descriptor = self.packed_descriptor(digest)
        plain = self.blob_path(digest)
        if descriptor is None:
            return [plain if plain.is_file() else self.packs.source("blob/" + digest)]
        if descriptor["envelopeSha256"] != digest:
            raise ValueError("packed backup identity mismatch")
        store = self.packed_store
        packed = self.packed_path(digest)
        paths = [
            packed if packed.is_file() else self.packs.source("descriptor/" + digest),
            *store.physical_paths(descriptor),
        ]
        if plain.exists():
            paths.append(plain)
        return paths

    def open_blob(self, digest: str):
        """Read the original file bytes regardless of recovery representation."""
        return self._open_blob(digest)

    def _open_blob(self, digest: str, store: ContentAddressedArtifactStore | None = None):
        descriptor = self.packed_descriptor(digest)
        if descriptor is None:
            path = self.blob_path(digest)
            if path.is_file():
                return gzip.open(path, "rb")
            raw = self.packs.read("blob/" + digest)
            if hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError("packed backup blob checksum mismatch")
            return io.BytesIO(raw)
        if descriptor["envelopeSha256"] != digest:
            raise ValueError("packed backup identity mismatch")
        store = store or ContentAddressedArtifactStore(self.root / "packed")
        return io.BytesIO(store.physical_store(descriptor).decode(descriptor))

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

    def _publish_manifest(self, backup_id: str, manifest: dict) -> None:
        from .pack_maintenance import enabled

        if enabled(self.root):
            raw = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
            atomic_json(self.manifest_path(backup_id), self.manifest_catalog.encode(raw, backup_id))
        else:
            atomic_json(self.manifest_path(backup_id), manifest)

    def _store_stream(self, stream, scratch: Path, *, mode: int = 0o600) -> dict:
        digest = hashlib.sha256()
        temporary = scratch / (uuid.uuid4().hex + ".gz")
        size = 0
        with temporary.open("wb") as compressed:
            with gzip.GzipFile(
                filename="", mode="wb", compresslevel=3, fileobj=compressed, mtime=0
            ) as output:
                while block := stream.read(_BLOCK):
                    digest.update(block)
                    output.write(block)
                    size += len(block)
            compressed.flush()
            os.fsync(compressed.fileno())
        sha = digest.hexdigest()
        final = self.blob_path(sha)
        durable_directory(final.parent)
        if self.has_blob(sha):
            temporary.unlink()
        else:
            temporary.chmod(0o600)
            temporary.replace(final)
            sync_directory(final.parent)
        return {"sha256": sha, "size": size, "mode": mode & 0o700}

    def _store(self, source: Path, scratch: Path) -> dict:
        if source.is_symlink():
            raise ValueError("backup source must not be a symlink")
        with source.open("rb") as stream:
            before = os.fstat(stream.fileno())
            result = self._store_stream(stream, scratch, mode=before.st_mode)
            after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise RuntimeError("source changed during backup; retry without pruning")
        return result

    def import_archive(self, archive: Path, *, max_bytes: int = 64 * 1024**3) -> dict:
        """Retain a legacy recovery date and exact file bytes; never delete its source."""
        if archive.is_symlink():
            raise ValueError("archive must not be a symlink")
        archive = archive.expanduser().resolve(strict=True)
        match = re.fullmatch(r"trading_max-(\d{8}T\d{6}Z)\.tar\.gz", archive.name)
        if not match or max_bytes <= 0:
            raise ValueError("import requires a dated Trading Max archive and positive byte budget")
        recovered_at = datetime.strptime(match[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        before = _stamp(archive)
        with archive.open("rb") as stream:
            archive_digest = hashlib.file_digest(stream, "sha256").hexdigest()
        backup_id = recovered_at.strftime("%Y%m%dT%H%M%SZ") + "-" + archive_digest[:12]
        with (
            exclusive_lock(self.lock),
            tempfile.TemporaryDirectory(prefix=".import-", dir=self.root) as temporary,
        ):
            existing = self.manifest_path(backup_id)
            if existing.exists():
                manifest = self.read_manifest(backup_id)
                if manifest.get("sourceArchive", {}).get("sha256") != archive_digest:
                    raise ValueError("import backup identity conflict")
                verified = self._verify(manifest)
                return {"id": backup_id, "manifest": str(existing), "reused": True, **verified}
            files = {}
            root_metadata = None
            seen = set()
            total = 0
            with tarfile.open(archive, mode="r|gz") as handle:
                for member in handle:
                    if member.name in seen:
                        raise ValueError("archive contains duplicate paths")
                    seen.add(member.name)
                    if member.name == "._state":
                        # BSD tar records the root directory's extended attributes
                        # outside state. Preserve this bounded AppleDouble sidecar
                        # in the private manifest, never as an executable/state path.
                        if not member.isfile() or not 0 <= member.size <= _BLOCK:
                            raise ValueError("invalid archive root metadata")
                        with handle.extractfile(member) as source:
                            raw_metadata = source.read(_BLOCK + 1)
                        if len(raw_metadata) != member.size:
                            raise ValueError("archive root metadata size mismatch")
                        root_metadata = {
                            "name": member.name,
                            "sha256": hashlib.sha256(raw_metadata).hexdigest(),
                            "base64": base64.b64encode(raw_metadata).decode("ascii"),
                        }
                        continue
                    if member.name == "state" and member.isdir():
                        continue
                    if not member.name.startswith("state/"):
                        raise ValueError("archive contains a path outside state")
                    relative = member.name.removeprefix("state/")
                    _safe_relative(relative)
                    if member.isdir():
                        continue
                    if not member.isfile():
                        raise ValueError("archive contains a link or unsupported file type")
                    total += member.size
                    if member.size < 0 or total > max_bytes:
                        raise ValueError("archive exceeds import byte budget")
                    source = handle.extractfile(member)
                    if source is None:
                        raise ValueError("archive file cannot be read")
                    with source:
                        entry = self._store_stream(source, Path(temporary), mode=member.mode)
                    if entry["size"] != member.size:
                        raise ValueError("archive member size mismatch")
                    files[relative] = entry
            if _stamp(archive) != before:
                raise RuntimeError("archive changed during import")
            manifest = {
                "schemaVersion": 1,
                "id": backup_id,
                "createdAt": recovered_at.isoformat(),
                "importedAt": datetime.now(UTC).isoformat(),
                "label": "legacy-archive-import",
                "sourceState": None,
                "sourceArchive": {
                    "name": archive.name,
                    "sha256": archive_digest,
                    "bytes": before[2],
                    "rootMetadata": root_metadata,
                },
                "files": files,
            }
            verified = self._verify(manifest)
            manifest["verification"] = verified
            self._publish_manifest(backup_id, manifest)
            return {"id": backup_id, "manifest": str(existing), "reused": False, **verified}

    def _logical_artifact(self, source: Path, store, scratch: Path) -> dict:
        """Share one logical envelope across legacy and compact live layouts."""
        from .storage_migration import verified_envelope

        physical = store.source_path(source.name)
        before = _stamp(physical)
        raw = store.content_bytes(source.name)
        envelope = verified_envelope(raw, source.name)
        if _stamp(physical) != before:
            raise RuntimeError("artifact changed during backup; retry without pruning")
        digest = hashlib.sha256(raw).hexdigest()
        entry = {"sha256": digest, "size": len(raw), "mode": physical.stat().st_mode & 0o700}
        if self.has_blob(digest):
            return entry  # The complete manifest verification checks existing bytes.
        if len(raw) <= 64 * 1024:
            return self._store_stream(io.BytesIO(raw), scratch, mode=entry["mode"])
        from .infrastructure.history_chunks import HISTORY_KEYS, canonical

        packed = ContentAddressedArtifactStore(self.root / "packed")
        descriptor = (
            packed.history.encode(raw)
            if envelope["ref"]["key"] in HISTORY_KEYS
            else packed.json_chunks.encode(raw)
        )
        atomic_bytes(self.packed_path(digest), canonical(descriptor))
        return entry

    def create(
        self,
        state: Path,
        *,
        label: str = "manual",
        now: datetime | None = None,
        artifact_encoding: str = "physical",
    ) -> dict:
        if artifact_encoding not in {"physical", "logical"}:
            raise ValueError("unsupported backup artifact encoding")
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
            ExitStack() as reads,
        ):
            self._progress("capturing")
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
                closing(
                    sqlite3.connect(f"{(state / DATABASE_NAME).as_uri()}?mode=rw", uri=True)
                ) as source,
                closing(sqlite3.connect(database)) as target,
            ):
                # A stopped WAL database may have no -wal/-shm sidecars. SQLite
                # needs a writable handle to initialize them before reading.
                # Never create a missing source or allow SQL writes; backup()
                # still captures a consistent snapshot, including live WAL rows.
                source.execute("PRAGMA query_only=ON")
                source.backup(target)
            catalog_path = self.root / "catalog.json"
            catalog = json.loads(catalog_path.read_text()) if catalog_path.is_file() else {}
            next_catalog: dict = {}
            source_artifacts = ContentAddressedArtifactStore(state / "artifacts")
            reads.enter_context(source_artifacts.packs.scan_reads())
            source_artifacts.json_chunks.read_cache = source_artifacts.history.read_cache = (
                VerifiedChunkCache()
            )
            chunk_stamps: dict[Path, list[int]] = {}
            if source_artifacts.packs.index.exists():
                # Packed logical artifacts restore to standalone original JSON.
                # Do not copy a live derived SQLite index or create a second
                # physical backup of the same immutable records.
                artifact_encoding = "logical"
            files = {DATABASE_NAME: self._store(database, scratch)}
            sources = list(_included_files(state))
            if artifact_encoding == "logical":
                present = {p.name for p in sources if p.parent == source_artifacts.content_root}
                sources.extend(
                    source_artifacts.path_for(a)
                    for a in source_artifacts.artifact_ids()
                    if a not in present
                )
            last_progress = time.monotonic()
            for position, source in enumerate(sources, 1):
                if self.progress and time.monotonic() - last_progress >= 5:
                    self._progress("capturing", files=position, totalFiles=len(sources))
                    last_progress = time.monotonic()
                relative = source.relative_to(state).as_posix()
                # Public filings and parser result caches can be fetched again.
                # Keep old manifests/imports fully readable, but do not perpetuate
                # this disposable cache in every new recovery point.
                if relative.startswith("research-cache/disclosures/"):
                    continue
                if artifact_encoding == "logical" and relative.startswith(
                    (
                        "artifacts/history-chunks/",
                        "artifacts/json-chunks/",
                        "artifacts/object-packs/",
                    )
                ):
                    continue  # Logical envelopes own independent repository chunks.
                _safe_relative(relative)
                physical_source = (
                    source_artifacts.source_path(source.name)
                    if relative.startswith("artifacts/sha256/") and _DIGEST.fullmatch(source.name)
                    else source
                )
                stamp = _stamp(physical_source)
                if physical_source != source:
                    stamp.extend(
                        [
                            str(physical_source),
                            list(source_artifacts.packs.location("artifact/" + source.name)),
                        ]
                    )
                cache_key = str(source)
                cached = catalog.get(cache_key)
                logical_artifact = (
                    artifact_encoding == "logical"
                    and relative.startswith("artifacts/sha256/")
                    and bool(_DIGEST.fullmatch(source.name))
                    and not source.with_name(source.name + ".meta.json").exists()
                )
                encoding = "logical" if logical_artifact else "physical"
                if logical_artifact:
                    descriptor = source_artifacts.descriptor(source.name)
                    if descriptor:
                        closure = []
                        for chunk in source_artifacts.logical_paths(descriptor):
                            physical_chunk = chunk
                            location = None
                            if not chunk.is_file():
                                kind = (
                                    "json"
                                    if chunk.parent.parent.name == "json-chunks"
                                    else "history"
                                )
                                location = source_artifacts.packs.location(kind + "/" + chunk.stem)
                                if location is None:
                                    raise ValueError("logical backup source chunk is missing")
                                physical_chunk = source_artifacts.packs.path(location[0])
                            if physical_chunk not in chunk_stamps:
                                chunk_stamps[physical_chunk] = _stamp(physical_chunk)
                            closure.append(
                                [
                                    str(chunk),
                                    str(physical_chunk),
                                    chunk_stamps[physical_chunk],
                                    location,
                                ]
                            )
                        stamp.append(hashlib.sha256(json.dumps(closure).encode()).hexdigest())
                immutable = (
                    relative.startswith("artifacts/sha256/")
                    and bool(re.fullmatch(r"[0-9a-f]{64}(\.meta\.json)?", source.name))
                ) or (
                    relative.startswith(("artifacts/history-chunks/", "artifacts/json-chunks/"))
                    and bool(re.fullmatch(r"[0-9a-f]{64}\.gz", source.name))
                )
                if (
                    immutable
                    and cached
                    and cached.get("stamp") == stamp
                    and cached.get("artifactEncoding", "physical") == encoding
                    and self.has_blob(cached["file"]["sha256"])
                ):
                    entry = cached["file"]
                elif logical_artifact:
                    entry = self._logical_artifact(source, source_artifacts, scratch)
                else:
                    entry = self._store(
                        captured_pointer if relative == "latest.json" else source, scratch
                    )
                files[relative] = entry
                if immutable:
                    next_catalog[cache_key] = {
                        "stamp": stamp,
                        "file": entry,
                        "artifactEncoding": encoding,
                    }
            reads.close()  # Release capture caches before independent recovery verification.
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
                "artifactEncoding": artifact_encoding,
                "files": files,
            }
            # No manifest or retention change is published until a full restore read
            # verifies decompression, file digests, database and snapshot references.
            verified = self._verify(manifest)
            manifest["verification"] = verified
            self._publish_manifest(backup_id, manifest)
            atomic_json(catalog_path, next_catalog)
            self._progress("backup-published", backupId=backup_id, **verified)
            return {"id": backup_id, "manifest": str(self.manifest_path(backup_id)), **verified}

    def _verify(self, manifest: dict, restore_to: Path | None = None) -> dict:
        if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), dict):
            raise ValueError("unsupported backup manifest")
        root_metadata = manifest.get("sourceArchive", {}).get("rootMetadata")
        if root_metadata:
            raw_metadata = base64.b64decode(root_metadata["base64"], validate=True)
            if (
                root_metadata["name"] != "._state"
                or len(raw_metadata) > _BLOCK
                or hashlib.sha256(raw_metadata).hexdigest() != root_metadata["sha256"]
            ):
                raise ValueError("archive root metadata checksum mismatch")
        files = manifest["files"]
        packed = ContentAddressedArtifactStore(self.root / "packed")
        packed.json_chunks.read_cache = packed.history.read_cache = VerifiedChunkCache()
        if DATABASE_NAME not in files:
            raise ValueError("backup database is missing")
        with (
            tempfile.TemporaryDirectory(prefix=".verify-", dir=self.root) as temporary,
            self.packs.scan_reads(),
            packed.packs.scan_reads(),
        ):
            started = last_progress = time.monotonic()
            self._progress("verifying", files=0, totalFiles=len(files))
            db = Path(temporary) / DATABASE_NAME
            indexes: dict[str, dict] = {}
            physical: dict[str, dict] = {}
            total = 0
            for position, (name, entry) in enumerate(files.items(), 1):
                relative = _safe_relative(name)
                if not isinstance(entry.get("size"), int) or entry["size"] < 0:
                    raise ValueError("invalid backup size")
                digest = hashlib.sha256()
                size = 0
                index = name == "latest.json" or (
                    name.startswith("snapshots/") and name.endswith("/manifest.json")
                )
                metadata = bytearray()
                history_descriptor = False
                output = (
                    restore_to / relative if restore_to else db if name == DATABASE_NAME else None
                )
                if output:
                    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with self._open_blob(entry["sha256"], packed) as source:
                    handle = output.open("wb") if output else None
                    try:
                        while block := source.read(_BLOCK):
                            if size == 0 and name.startswith("artifacts/sha256/"):
                                history_descriptor = block.startswith(b'{"$format":')
                            size += len(block)
                            if size > entry["size"]:
                                raise ValueError("backup blob exceeds declared size")
                            digest.update(block)
                            if handle:
                                handle.write(block)
                            if index or history_descriptor:
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
                if self.progress and time.monotonic() - last_progress >= 5:
                    self._progress(
                        "verifying",
                        files=position,
                        totalFiles=len(files),
                        logicalBytes=total,
                        elapsedSeconds=round(time.monotonic() - started, 1),
                    )
                    last_progress = time.monotonic()
                if index:
                    decoded_index = compressed_json.decode(bytes(metadata))
                    if len(decoded_index) > 16 * _BLOCK:
                        raise ValueError("backup snapshot index exceeds limit")
                    indexes[name] = json.loads(decoded_index)
                elif history_descriptor:
                    physical[name] = json.loads(metadata)
            format_root = Path(temporary) / "format"
            formats = ContentAddressedArtifactStore(format_root / "artifacts")
            referenced_chunks = {}
            for name, descriptor in physical.items():
                references = [
                    p.relative_to(format_root).as_posix() for p in formats.logical_paths(descriptor)
                ]
                if any(reference not in files for reference in references):
                    raise ValueError("backup history references a missing chunk")
                referenced_chunks[name] = references
            database = restore_to / DATABASE_NAME if restore_to else db
            # This is a verified, self-contained backup image. Immutable mode
            # prevents SQLite from adding WAL/SHM files to the recovery tree;
            # a connection context alone also does not close its file handles.
            with closing(
                sqlite3.connect(database.as_uri() + "?mode=ro&immutable=1", uri=True)
            ) as connection:
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
                        required.update(referenced_chunks.get(name, []))
                        if name + ".meta.json" in files:
                            required.add(name + ".meta.json")
                    for name in required:
                        target = check_root / _safe_relative(name)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with (
                            self._open_blob(files[name]["sha256"], packed) as source,
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
            return self._verify(self.read_manifest(backup_id))

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
            result = self._verify(self.read_manifest(backup_id), staging)
            if destination.exists() or destination.is_symlink():
                raise FileExistsError("restore destination appeared during verification")
            staging.rename(destination)
            return result


__all__ = ["BackupRepository", "atomic_json", "exclusive_lock"]
