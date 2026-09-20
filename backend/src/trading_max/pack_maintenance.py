"""Bounded conversion of verified loose records into immutable object packs.

The operator/managed wrapper holds the deployment and backup-repository locks
and validates independent recovery and all retained readers before entry.
Financial record retention is unchanged; this only retires exact duplicates.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import re
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .backup_repository import BackupRepository, atomic_json
from .infrastructure import ContentAddressedArtifactStore, SnapshotStore, compressed_json
from .infrastructure.durable_files import atomic_bytes, sync_directory
from .infrastructure.manifest_catalog import FORMAT as CATALOG_FORMAT
from .infrastructure.object_packs import MAX_BYTES, ObjectPacks, stamp

_DIGEST = re.compile(r"[0-9a-f]{64}")
POLICY = "object-pack-policy.json"
HOT_BYTES = 256 * 1024
COLD_BYTES = 8 * 1024 * 1024


def enabled(root: Path) -> bool:
    path = root / POLICY
    if not path.exists():
        return False
    if path.is_symlink():
        raise ValueError("pack policy must not be a symlink")
    return json.loads(path.read_text()) == {"schemaVersion": 1, "enabled": True}


def enable(root: Path) -> None:
    atomic_json(root / POLICY, {"schemaVersion": 1, "enabled": True})


def _read(path: Path, encoding: str) -> tuple[bytes, str]:
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("packing must not follow symlinks")
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("loose packed source exceeds size limit")
    physical = path.read_bytes()
    digest = hashlib.sha256(physical).hexdigest()
    if encoding == "gzip":
        with gzip.GzipFile(fileobj=io.BytesIO(physical)) as handle:
            raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES or hashlib.sha256(raw).hexdigest() != path.stem:
            raise ValueError("loose packed source checksum mismatch or size limit")
    elif encoding == "json":
        metadata = compressed_json.header(physical)
        if metadata and metadata[0] > MAX_BYTES:
            raise ValueError("decoded packed source exceeds size limit")
        raw = compressed_json.decode(physical)
    elif encoding == "raw":
        raw = physical
    else:
        raise ValueError("unsupported loose record encoding")
    return raw, digest


class LoosePacker:
    def __init__(self, root: Path, packs: ObjectPacks, journals: Path):
        self.root = root.resolve(strict=True)
        self.packs = packs
        self.journals = journals.absolute()
        if self.journals.is_symlink():
            raise ValueError("pack journals must not be symlinks")
        self.journals.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _path(self, relative: str) -> Path:
        path = self.root / relative
        if path.resolve() != path or not path.is_relative_to(self.root) or path == self.root:
            raise ValueError("pack journal path escapes source root")
        return path

    def _finish(self, path: Path, journal: dict) -> None:
        journal["status"] = "complete"
        atomic_json(path, journal)
        archive = path.with_suffix(".json.gz")
        atomic_bytes(archive, gzip.compress(path.read_bytes(), compresslevel=9, mtime=0))
        if gzip.decompress(archive.read_bytes()) != path.read_bytes():
            raise ValueError("pack journal compression failed")
        path.unlink()
        sync_directory(path.parent)

    def recover(self) -> None:
        self.packs.recover_pending()
        for path in sorted(self.journals.glob("pack-*.json")):
            journal = json.loads(path.read_text())
            if journal.get("root") != str(self.root) or journal.get("pool") != str(self.packs.root):
                raise ValueError("pack journal belongs to another store")
            for item in journal["items"]:
                source = self._path(item["path"])
                present = self.packs.contains(item["key"])
                if not present:
                    if (
                        not source.is_file()
                        or hashlib.sha256(source.read_bytes()).hexdigest() != item["physicalSha256"]
                    ):
                        raise ValueError("interrupted pack lost its original source")
                    continue  # Not committed: preserve original and retry in a new batch.
                raw = self.packs.read(item["key"])
                if (
                    len(raw) != item["logicalBytes"]
                    or hashlib.sha256(raw).hexdigest() != item["logicalSha256"]
                ):
                    raise ValueError("interrupted pack failed recovery checksum")
                if source.exists():
                    if hashlib.sha256(source.read_bytes()).hexdigest() != item["physicalSha256"]:
                        raise ValueError("interrupted pack source changed; preserved")
                    source.unlink()
                    sync_directory(source.parent)
            self._finish(path, journal)

    def run(
        self, candidates, *, target_bytes=HOT_BYTES, max_files=4096, max_bytes=256 * 1024 * 1024
    ) -> dict:
        if not 0 < target_bytes <= MAX_BYTES or min(max_files, max_bytes) <= 0:
            raise ValueError("packing budgets must be positive and bounded")
        self.recover()
        count = retired = consumed = sealed = 0
        pending = {}
        items = []
        pending_bytes = 0

        def flush():
            nonlocal count, retired, sealed, pending, pending_bytes, items
            if not pending:
                return
            journal_path = self.journals / ("pack-" + uuid.uuid4().hex + ".json")
            journal = {
                "schemaVersion": 1,
                "root": str(self.root),
                "pool": str(self.packs.root),
                "status": "prepared",
                "startedAt": datetime.now(UTC).isoformat(),
                "items": items,
            }
            atomic_json(journal_path, journal)
            result = self.packs.add(pending)
            # Read back the committed representation before retiring any aliases.
            for item in items:
                if self.packs.read(item["key"]) != pending[item["key"]]:
                    raise ValueError("packed record comparison failed; original preserved")
            touched = set()
            for item in items:
                source = self._path(item["path"])
                if (
                    list(stamp(source)) != item["stamp"]
                    or hashlib.sha256(source.read_bytes()).hexdigest() != item["physicalSha256"]
                ):
                    raise ValueError("loose source changed; packing stopped")
                source.unlink()
                touched.add(source.parent)
                count += 1
                retired += item["physicalBytes"]
            for directory in touched:
                sync_directory(directory)
            sealed += result["bytes"]
            self._finish(journal_path, journal)
            pending, items, pending_bytes = {}, [], 0

        for path, key, encoding in candidates:
            if not path.exists() and self.packs.contains(key):
                self.packs.read(key)  # A resumed journal already retired this alias.
                continue
            if count + len(items) >= max_files:
                break
            relative = path.relative_to(self.root).as_posix()
            self._path(relative)
            before = stamp(path)
            raw, physical_digest = _read(path, encoding)
            if consumed + len(raw) > max_bytes:
                break
            if pending and (pending_bytes + len(raw) > target_bytes or len(items) >= 4096):
                flush()
            if stamp(path) != before:
                raise ValueError("loose source changed while reading; preserved")
            items.append(
                {
                    "path": relative,
                    "key": key,
                    "stamp": list(before),
                    "physicalBytes": before[2],
                    "physicalSha256": physical_digest,
                    "logicalBytes": len(raw),
                    "logicalSha256": hashlib.sha256(raw).hexdigest(),
                }
            )
            pending[key] = raw
            pending_bytes += len(raw)
            consumed += len(raw)
        flush()
        return {
            "convertedFiles": count,
            "logicalBytes": consumed,
            "retiredFileBytes": retired,
            "sealedFileBytes": sealed,
        }


def artifact_candidates(root: Path):
    for family, prefix in [("json-chunks", "json"), ("history-chunks", "history")]:
        for path in sorted((root / family).glob("*/*.gz")):
            if _DIGEST.fullmatch(path.stem):
                yield path, prefix + "/" + path.stem, "gzip"
    for path in sorted((root / "sha256").glob("*")):
        if _DIGEST.fullmatch(path.name) and not path.with_name(path.name + ".meta.json").exists():
            yield path, "artifact/" + path.name, "json"


def pack_state(state: Path, journals: Path, **budgets) -> dict:
    cutoff = time.time_ns()
    store = ContentAddressedArtifactStore(state / "artifacts")
    snapshot = SnapshotStore(state, artifacts=store).latest()
    hot = set()
    pending = [ref.artifact_id for ref in snapshot.manifest.artifacts] if snapshot else []
    while pending:
        artifact_id = pending.pop()
        key = "artifact/" + artifact_id
        if key in hot:
            continue
        hot.add(key)
        ref = store.get_ref(artifact_id)
        pending.extend(ref.dependency_artifact_ids)
        if store.path_for(artifact_id).with_name(artifact_id + ".meta.json").exists():
            continue
        descriptor = store.descriptor(artifact_id)
        if descriptor:
            for path in store.logical_paths(descriptor):
                prefix = "json" if path.parent.parent.name == "json-chunks" else "history"
                hot.add(prefix + "/" + path.stem)
    # Leave newly published loose records for the next cycle so classification
    # is tied to the pinned snapshot, not a changing latest pointer.
    candidates = [c for c in artifact_candidates(store.root) if c[0].stat().st_mtime_ns <= cutoff]
    cold = LoosePacker(store.root, store.packs, journals / "cold").run(
        (c for c in candidates if c[1] not in hot), target_bytes=COLD_BYTES, **budgets
    )
    remaining_files = budgets.get("max_files", 4096) - cold["convertedFiles"]
    remaining_bytes = budgets.get("max_bytes", 256 * 1024 * 1024) - cold["logicalBytes"]
    if remaining_files > 0 and remaining_bytes > 0:
        warm = LoosePacker(store.root, store.packs, journals / "hot").run(
            (c for c in candidates if c[1] in hot and c[0].exists()),
            target_bytes=HOT_BYTES,
            max_files=remaining_files,
            max_bytes=remaining_bytes,
        )
        return {key: cold[key] + warm[key] for key in cold}
    return cold


def pack_repository(repository: BackupRepository, journals: Path, **budgets) -> dict:
    """Caller holds repository lock; retain all original restore identities."""
    store = repository.packed_store
    store.root.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = LoosePacker(store.root, store.packs, journals / "chunks").run(
        artifact_candidates(store.root), target_bytes=COLD_BYTES, **budgets
    )

    def candidates():
        for path in sorted(repository.root.glob("packed/*.json")):
            if _DIGEST.fullmatch(path.stem):
                yield path, "descriptor/" + path.stem, "raw"
        for path in sorted(repository.blobs.glob("*/*.gz")):
            if _DIGEST.fullmatch(path.stem):
                yield path, "blob/" + path.stem, "gzip"

    remaining_files = budgets.get("max_files", 4096) - result["convertedFiles"]
    remaining_bytes = budgets.get("max_bytes", 256 * 1024 * 1024) - result["logicalBytes"]
    if remaining_files > 0 and remaining_bytes > 0:
        other = LoosePacker(repository.root, repository.packs, journals / "blobs").run(
            candidates(),
            target_bytes=COLD_BYTES,
            max_files=remaining_files,
            max_bytes=remaining_bytes,
        )
        result = {key: result[key] + other[key] for key in result}
    return result


def compact_manifests(repository: BackupRepository, *, max_files=64) -> dict:
    """Replace only manifests that round-trip exactly; keep their original dates."""
    count = original = after = 0
    for path in sorted(repository.snapshots.glob("*.json")):
        if count >= max_files:
            break
        raw = path.read_bytes()
        if json.loads(raw).get("$format") == CATALOG_FORMAT:
            continue
        before = stamp(path)
        descriptor = repository.manifest_catalog.encode(raw, path.stem)
        if stamp(path) != before:
            raise ValueError("backup manifest changed during cataloging")
        atomic_json(path, descriptor)
        os.utime(path, ns=(before[3], before[3]))
        if repository.manifest_bytes(path.stem) != raw:
            atomic_bytes(path, raw)
            raise ValueError("backup manifest readback mismatch")
        count += 1
        original += len(raw)
        after += path.stat().st_size
    return {"convertedManifests": count, "originalBytes": original, "descriptorBytes": after}


def nightly_packs(service: Path, state: Path, backup_id: str) -> dict:
    """Append sealed batches after a fresh verified backup; never force activation."""
    from .backup_repository import exclusive_lock
    from .storage_compatibility import verify_retained_readers

    repository = BackupRepository(service / "backups/repository")
    if not enabled(state) or not enabled(repository.root):
        return {"enabled": False}
    with exclusive_lock(service / ".deployment.lock"), exclusive_lock(repository.lock):
        readers = verify_retained_readers(service, object_packs=True)
        manifest = repository.read_manifest(backup_id)
        if manifest.get("sourceState") != str(state.resolve()):
            raise ValueError("nightly recovery does not belong to the active state")
        if datetime.fromisoformat(manifest["createdAt"]) < datetime.now(UTC) - timedelta(days=1):
            raise ValueError("nightly packing needs a recovery point from the last 24 hours")
        if not repository._verify(manifest).get("snapshotRunId"):
            raise ValueError("nightly packing requires independent published-state recovery")
        journals = service / "maintenance/object-packs"
        result = {
            "enabled": True,
            "readers": readers,
            "state": pack_state(state, journals / "state"),
            "backups": pack_repository(repository, journals / "backups"),
            "catalog": compact_manifests(repository),
        }
        atomic_json(journals / "latest.json", result)
        return result
