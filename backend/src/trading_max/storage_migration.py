"""Bounded, resumable physical compaction without changing logical records."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .backup_repository import BackupRepository, atomic_json, exclusive_lock
from .domain import ArtifactRef
from .infrastructure import ContentAddressedArtifactStore, compressed_json
from .infrastructure.artifacts import _canonical_json, _identity
from .infrastructure.history_chunks import HISTORY_KEYS, atomic_bytes, canonical, sync_directory

_DIGEST = re.compile(r"[0-9a-f]{64}")


def verified_envelope(raw: bytes, expected_id: str) -> dict:
    envelope = json.loads(raw)
    ref = ArtifactRef.model_validate(envelope["ref"])
    payload = envelope["payload"]
    if not isinstance(payload, dict):
        raise ValueError("artifact payload must be an object")
    identity = _identity(
        schema_version=ref.schema_version,
        key=ref.key,
        kind=ref.kind,
        media_type=ref.media_type,
        as_of=ref.as_of,
        producer_version=ref.producer_version,
        dependency_artifact_ids=ref.dependency_artifact_ids,
        quality=ref.quality,
        payload=payload,
    )
    digest = hashlib.sha256(_canonical_json(identity)).hexdigest()
    if ref.artifact_id != expected_id or ref.sha256 != expected_id or digest != expected_id:
        raise ValueError("artifact identity mismatch during migration")
    return envelope


def compact_envelope(raw: bytes, artifact_id: str, store: ContentAddressedArtifactStore) -> bytes:
    envelope = verified_envelope(raw, artifact_id)
    if envelope["ref"]["key"] in HISTORY_KEYS:
        return canonical(store.history.encode(raw))
    if len(raw) > 64 * 1024:
        return canonical(store.json_chunks.encode(raw))
    return compressed_json.encode(raw)


def _stamp(path: Path) -> tuple[int, int, int, int]:
    s = path.stat()
    return s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


class StateCompactor:
    def __init__(self, state: Path, journals: Path):
        self.state = state.resolve(strict=True)
        self.journals = journals.absolute()
        if journals.is_symlink():
            raise ValueError("migration journals must not be symlinks")
        self.journals.mkdir(parents=True, exist_ok=True)
        self.store = ContentAddressedArtifactStore(self.state / "artifacts")

    def logical(self, relative: str, kind: str) -> bytes:
        path = self.state / relative
        if path.resolve() != path or not path.is_relative_to(self.state):
            raise ValueError("migration path escapes state")
        return (
            self.store.content_bytes(path.name)
            if kind == "artifact"
            else compressed_json.decode(path.read_bytes())
        )

    def recover(self) -> None:
        for path in self.journals.glob("state-*.json"):
            journal = json.loads(path.read_text())
            if journal.get("state") != str(self.state):
                raise ValueError("migration journal belongs to another state")
            if journal["status"] == "complete":
                continue
            for item in journal["items"]:
                current = self.state / item["path"]
                if current.resolve() != current or not current.is_relative_to(self.state):
                    raise ValueError("migration journal escapes state")
                digest = hashlib.sha256(current.read_bytes()).hexdigest()
                if digest == item["beforeSha256"]:
                    item["status"] = "unchanged"
                elif (
                    digest == item["afterSha256"]
                    and hashlib.sha256(self.logical(item["path"], item["kind"])).hexdigest()
                    == item["beforeSha256"]
                ):
                    item["status"] = "converted"
                else:
                    raise ValueError("interrupted migration has unexpected file content")
            journal["status"] = "complete"
            atomic_json(path, journal)

    def candidates(self):
        content = self.state / "artifacts/sha256"
        for path in sorted(content.glob("*")):
            if (
                _DIGEST.fullmatch(path.name)
                and not path.with_name(path.name + ".meta.json").exists()
            ):
                yield path, "artifact"
        for path in sorted((self.state / "snapshots").glob("*/manifest.json")):
            yield path, "snapshot"
        # Filing documents are immutable URL-keyed sources. Expiring parsed/result
        # caches are rewritten naturally, never raced by an in-place migration.
        for path in sorted((self.state / "research-cache/disclosures").glob("*.html")):
            if _DIGEST.fullmatch(path.stem):
                yield path, "cache"

    def run(self, *, max_files: int = 256, max_bytes: int = 256 * 1024 * 1024) -> dict:
        if max_files < 1 or max_bytes < 1:
            raise ValueError("migration budgets must be positive")
        with exclusive_lock(self.journals / ".state.lock"):
            self.recover()
            journal = {
                "schemaVersion": 1,
                "state": str(self.state),
                "startedAt": datetime.now(UTC).isoformat(),
                "status": "running",
                "items": [],
            }
            journal_path = self.journals / ("state-" + uuid.uuid4().hex + ".json")
            read_bytes = changed = saved = 0
            for path, kind in self.candidates():
                if path.is_symlink() or path.parent.is_symlink():
                    raise ValueError("migration must not follow symlinks")
                before = _stamp(path)
                if before[1] < 4096:
                    continue
                with path.open("rb") as stream:
                    prefix = stream.read(64)
                if prefix.startswith((compressed_json.MAGIC, b'{"$format":')):
                    continue
                if changed >= max_files or read_bytes + before[1] > max_bytes:
                    break
                raw = path.read_bytes()
                read_bytes += len(raw)
                physical = (
                    compact_envelope(raw, path.name, self.store)
                    if kind == "artifact"
                    else compressed_json.encode(raw)
                )
                if len(physical) >= len(raw):
                    continue
                if _stamp(path) != before:
                    raise RuntimeError("source changed during migration; original preserved")
                relative = path.relative_to(self.state).as_posix()
                item = {
                    "path": relative,
                    "kind": kind,
                    "beforeBytes": len(raw),
                    "afterBytes": len(physical),
                    "beforeSha256": hashlib.sha256(raw).hexdigest(),
                    "afterSha256": hashlib.sha256(physical).hexdigest(),
                    "status": "prepared",
                }
                if len(journal["items"]) >= 128:
                    journal["status"] = "complete"
                    atomic_json(journal_path, journal)
                    journal = {**journal, "status": "running", "items": []}
                    journal_path = self.journals / ("state-" + uuid.uuid4().hex + ".json")
                journal["items"].append(item)
                atomic_json(journal_path, journal)
                # Prepared journal and durable chunks precede the atomic swap.
                if _stamp(path) != before:
                    raise RuntimeError("source changed before representation replacement")
                atomic_bytes(path, physical)
                os.utime(path, ns=(before[2], before[2]))
                try:
                    if self.logical(relative, kind) != raw:
                        raise ValueError("post-migration parity failed")
                except Exception:
                    atomic_bytes(path, raw)
                    os.utime(path, ns=(before[2], before[2]))
                    raise
                item["status"] = "converted"
                atomic_json(journal_path, journal)
                saved += len(raw) - len(physical)
                changed += 1
            journal["status"] = "complete"
            atomic_json(journal_path, journal)
            return {
                "journal": str(journal_path),
                "convertedFiles": changed,
                "readBytes": read_bytes,
                "envelopeBytesSaved": saved,
            }


def compact_repository(
    repository: BackupRepository, *, max_files=128, max_bytes=256 * 1024 * 1024
) -> dict:
    """Keep manifest hashes and exact restored bytes; replace only redundant blobs."""
    if max_files < 1 or max_bytes < 1:
        raise ValueError("migration budgets must be positive")
    with exclusive_lock(repository.lock):
        entries = {}
        for path in sorted(repository.snapshots.glob("*.json")):
            manifest = json.loads(path.read_text())
            if manifest.get("schemaVersion") != 1:
                raise ValueError("unsupported backup manifest")
            files = manifest["files"]
            for name, entry in files.items():
                artifact_id = name.removeprefix("artifacts/sha256/")
                if (
                    _DIGEST.fullmatch(artifact_id)
                    and name + ".meta.json" not in files
                    and entry["size"] > 64 * 1024
                ):
                    entries[entry["sha256"]] = (artifact_id, entry["size"])
        store = ContentAddressedArtifactStore(repository.root / "packed")
        converted = read_bytes = retired_bytes = 0
        journal = {"schemaVersion": 1, "startedAt": datetime.now(UTC).isoformat(), "items": []}
        journal_path = repository.root / "migrations" / (uuid.uuid4().hex + ".json")
        for digest, (artifact_id, size) in sorted(entries.items()):
            blob = repository.blob_path(digest)
            if not blob.is_file():
                continue
            with gzip.open(blob, "rb") as handle:
                prefix = handle.read(64)
            if prefix.startswith((compressed_json.MAGIC, b'{"$format":')):
                continue
            if converted >= max_files or read_bytes + size > max_bytes:
                break
            before = _stamp(blob)
            with gzip.open(blob, "rb") as handle:
                raw = handle.read(size + 1)
            read_bytes += len(raw)
            if len(raw) != size or hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError("original backup blob is corrupt")
            if raw.startswith((compressed_json.MAGIC, b'{"$format":')):
                continue
            envelope = verified_envelope(raw, artifact_id)
            descriptor = (
                store.history.encode(raw)
                if envelope["ref"]["key"] in HISTORY_KEYS
                else store.json_chunks.encode(raw)
            )
            packed = repository.packed_path(digest)
            item = {
                "sha256": digest,
                "originalCompressedBytes": before[1],
                "logicalBytes": size,
                "status": "prepared",
            }
            if len(journal["items"]) >= 128:
                atomic_json(journal_path, journal)
                journal = {**journal, "items": []}
                journal_path = repository.root / "migrations" / (uuid.uuid4().hex + ".json")
            journal["items"].append(item)
            atomic_json(journal_path, journal)
            atomic_bytes(packed, canonical(descriptor))
            try:
                with repository.open_blob(digest) as handle:
                    if handle.read(size + 1) != raw:
                        raise ValueError("packed recovery parity failed; original preserved")
            except Exception:
                # A failed new representation must not shadow the valid original.
                packed.unlink()
                sync_directory(packed.parent)
                raise
            if _stamp(blob) != before:
                raise RuntimeError("backup blob changed during compaction")
            blob.unlink()
            sync_directory(blob.parent)
            item["status"] = "converted"
            atomic_json(journal_path, journal)
            converted += 1
            retired_bytes += before[1]
        return {
            "journal": str(journal_path),
            "convertedFiles": converted,
            "readBytes": read_bytes,
            "originalBlobBytesRetired": retired_bytes,
        }
