"""Retire an offline emergency copy only after independently restoring its bytes.

This explicit operator migration preserves the original recovery date and view.
It neither substitutes a newer snapshot nor removes unknown backup directories.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import time
from datetime import UTC, datetime
from pathlib import Path

from .backup_repository import _DIGEST, _safe_relative, _stamp, atomic_json, exclusive_lock
from .infrastructure.durable_files import sync_directory
from .physical_recovery import digest_file, raw_path
from .recovery_checkpoint import copy_independent

FORMAT = "trading-max-offline-apfs-checkpoint-v1"
RECEIPT_FORMAT = "trading-max-checkpoint-retirement-v1"


def _files(tree: Path) -> dict[str, list[int]]:
    """Inventory exactly the owned tree, refusing links and special files."""
    if tree.is_symlink() or not tree.is_dir():
        raise ValueError("checkpoint state must be a regular directory")
    result = {}
    for directory, directories, names in os.walk(tree, followlinks=False):
        for name in directories + names:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError("checkpoint contains a symlink or special file")
            if stat.S_ISREG(mode):
                relative = path.relative_to(tree).as_posix()
                _safe_relative(relative)
                result[relative] = _stamp(path)
    return result


def _copy_object(repository, source: Path, digest: str) -> int:
    target = raw_path(repository, digest)
    if target.exists():
        return 0  # Full independent verification checks reused bytes as well.
    target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    temporary = target.with_name(".pending-" + digest)
    temporary.unlink(missing_ok=True)
    try:
        copy_independent(source, temporary)
        if digest_file(temporary) != digest:
            raise ValueError("imported checkpoint copy checksum mismatch")
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        temporary.replace(target)
        sync_directory(target.parent)
        return target.stat().st_size
    finally:
        temporary.unlink(missing_ok=True)


def migrate_checkpoint(repository, directory: Path, *, retire: bool = False) -> dict:
    directory = directory.expanduser().absolute()
    parent = repository.root.parent / "emergency-checkpoints"
    if (
        directory.parent != parent
        or parent.is_symlink()
        or directory.is_symlink()
        or not directory.is_dir()
    ):
        raise ValueError("migration requires this repository's emergency-checkpoints directory")
    with exclusive_lock(repository.lock):
        return _migrate(repository, directory, retire=retire)


def _migrate(repository, directory: Path, *, retire: bool) -> dict:
    started = time.monotonic()
    marker = directory / "manifest.json"
    receipt_path = directory / "retirement.json"
    tree = directory / "state"
    quarantine = directory / ".retiring-state"
    for path in (marker, receipt_path, tree, quarantine):
        if path.is_symlink():
            raise ValueError("checkpoint migration paths must not be symlinks")
    raw = marker.read_bytes()
    source = json.loads(raw)
    manifest_digest = hashlib.sha256(raw).hexdigest()
    if source.get("format") != FORMAT or source.get("restoreState") != str(tree):
        raise ValueError("unrecognized offline checkpoint")
    source_state = Path(source["sourceState"])
    if (
        not source_state.is_absolute()
        or directory.is_relative_to(source_state)
        or source_state.is_relative_to(directory)
    ):
        raise ValueError("emergency checkpoint must be independent of live state")
    instant = datetime.fromisoformat(source["createdAt"])
    if instant.utcoffset() is None:
        raise ValueError("checkpoint date requires a timezone")
    backup_id = instant.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ-") + manifest_digest[:12]
    manifest_path = repository.manifest_path(backup_id)
    expected = source.get("files")
    if not isinstance(expected, dict) or "trading_max.db" not in expected:
        raise ValueError("checkpoint file manifest is missing")
    for name, entry in expected.items():
        _safe_relative(name)
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("sha256"), str)
            or not _DIGEST.fullmatch(entry["sha256"])
            or type(entry.get("size")) is not int
            or entry["size"] < 0
            or type(entry.get("sqliteBackup")) is not bool
        ):
            raise ValueError("invalid checkpoint file metadata")
    receipt = json.loads(receipt_path.read_bytes()) if receipt_path.exists() else None
    if receipt and (
        receipt.get("format") != RECEIPT_FORMAT
        or receipt.get("sourceManifestSha256") != manifest_digest
        or receipt.get("backupId") != backup_id
        or receipt.get("phase") not in {"imported", "retiring", "retired"}
    ):
        raise ValueError("checkpoint retirement receipt does not match its source")
    if receipt and receipt["phase"] == "retired":
        if tree.exists() or quarantine.exists():
            raise ValueError("retired checkpoint state unexpectedly reappeared")
        return {**receipt["result"], "alreadyRetired": True}
    resuming = bool(receipt and receipt["phase"] == "retiring")
    if quarantine.exists() and (not resuming or tree.exists()):
        raise ValueError("unexpected checkpoint retirement staging tree")
    current = quarantine if quarantine.exists() else tree
    stamps = _files(current) if current.exists() else {}
    if (not resuming or tree.exists()) and stamps.keys() != expected.keys():
        raise ValueError("checkpoint files differ from the original manifest")
    if not stamps.keys() <= expected.keys():
        raise ValueError("unexpected files in checkpoint retirement staging")
    if resuming and not manifest_path.is_file():
        raise ValueError("retirement needs its published recovery manifest")

    files = {}
    written = reused = 0
    for number, (name, stamp) in enumerate(stamps.items(), 1):
        path = current / name
        entry = expected[name]
        if stamp[2] != entry["size"] or digest_file(path) != entry["sha256"]:
            raise ValueError("checkpoint bytes differ from the original manifest")
        files[name] = {
            "sha256": entry["sha256"],
            "size": entry["size"],
            "sqlite": entry["sqliteBackup"],
            "mode": path.stat().st_mode & 0o700,
        }
        if not resuming:
            present = raw_path(repository, entry["sha256"]).is_file()
            written += _copy_object(repository, path, entry["sha256"])
            reused += int(present)
        if number % 128 == 0:
            repository._progress(
                "importing-checkpoint", files=number, totalFiles=len(stamps), writtenBytes=written
            )
    manifest = {
        "schemaVersion": 1,
        "artifactEncoding": "sealed",
        "id": backup_id,
        "createdAt": source["createdAt"],
        "sourceState": source["sourceState"],
        "label": "imported-emergency-checkpoint",
        "importedCheckpointSha256": manifest_digest,
        "files": files,
    }
    if manifest_path.exists():
        manifest = repository.read_manifest(backup_id)
        if (
            manifest.get("importedCheckpointSha256") != manifest_digest
            or manifest.get("sourceState") != source["sourceState"]
            or manifest.get("createdAt") != source["createdAt"]
            or manifest.get("artifactEncoding") != "sealed"
            or {
                name: (e["sha256"], e["size"], e.get("sqlite"))
                for name, e in manifest["files"].items()
            }
            != {name: (e["sha256"], e["size"], e["sqliteBackup"]) for name, e in expected.items()}
        ):
            raise ValueError("published checkpoint does not match its original manifest")
    # This restores every independent repository object into a disposable tree,
    # checks all digests, SQLite databases, pack locators and historical refs.
    restore_started = time.monotonic()
    repository._progress("restoring-imported-checkpoint", backupId=backup_id)
    verified = repository._verify(manifest)
    restore_seconds = round(time.monotonic() - restore_started, 3)
    if not source.get("snapshotRunId") or verified["snapshotRunId"] != source["snapshotRunId"]:
        raise ValueError("restored checkpoint snapshot identity mismatch")
    if marker.read_bytes() != raw or (current.exists() and _files(current) != stamps):
        raise ValueError("checkpoint changed during migration")
    manifest["verification"] = verified
    if not manifest_path.exists():
        repository._publish_manifest(backup_id, manifest)
        if repository.read_manifest(backup_id) != manifest:
            raise ValueError("published checkpoint manifest failed read-back verification")
    result = {
        "id": backup_id,
        "createdAt": source["createdAt"],
        "manifest": str(manifest_path),
        "receipt": str(receipt_path),
        **verified,
        "writtenBytes": written,
        "reusedFiles": reused,
        "restoreSeconds": restore_seconds,
        "retiredBytes": 0,
        "phase": "retiring" if resuming else "imported",
    }
    receipt = {
        "format": RECEIPT_FORMAT,
        "sourceManifestSha256": manifest_digest,
        "backupId": backup_id,
        "phase": "retiring" if resuming else "imported",
        "result": result,
    }
    atomic_json(receipt_path, receipt)
    if retire:
        repository._progress("checkpoint-retirement-ready", backupId=backup_id)
        receipt["phase"] = "retiring"
        atomic_json(receipt_path, receipt)
        if tree.exists():
            if marker.read_bytes() != raw or _files(tree) != stamps:
                raise ValueError("checkpoint changed before retirement")
            tree.rename(quarantine)
            sync_directory(directory)
        repository._progress("checkpoint-retirement-detached", backupId=backup_id)
        if quarantine.exists():
            shutil.rmtree(quarantine)
            sync_directory(directory)
        result.update(retiredBytes=sum(e["size"] for e in expected.values()), phase="retired")
        receipt["phase"] = "retired"
    result["seconds"] = round(time.monotonic() - started, 3)
    atomic_json(receipt_path, receipt)
    return result
