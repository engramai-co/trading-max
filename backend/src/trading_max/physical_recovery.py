"""Incremental recovery of physical chunks and packs, without expanding history.

The SQLite journal is a disposable acceleration index. Published manifests and
independent, checksum-addressed files remain authoritative. Each publication
reads every physical file, checks the complete reference graph and opens the
current snapshot; no historical logical envelope is repeatedly reconstructed.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import time
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from .backup import DATABASE_NAME
from .backup_repository import _DIGEST, _safe_relative, _stamp, atomic_json, exclusive_lock
from .infrastructure import ContentAddressedArtifactStore, compressed_json
from .infrastructure.durable_files import sync_directory
from .infrastructure.object_packs import decode as decode_pack
from .recovery_checkpoint import FORMAT, check_snapshot, copy_independent


def raw_path(repository, digest: str) -> Path:
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        raise ValueError("invalid recovery digest")
    path = repository.root / "physical" / digest[:2] / digest
    if any(p.is_symlink() for p in (path, path.parent, path.parent.parent)):
        raise ValueError("recovery objects must not be symlinks")
    return path


def digest_file(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_tree(tree: Path, files: dict, progress=None) -> dict:
    """Check stored bytes/locators once and dependencies without expanding versions."""
    if DATABASE_NAME not in files:
        raise ValueError("recovery database is missing")
    store = ContentAddressedArtifactStore(tree / "artifacts")
    artifact_ids = set()
    chunks = set()
    descriptors = []
    packed_records = {}
    snapshot_refs = set()

    def artifact(artifact_id: str, raw: bytes) -> None:
        if not _DIGEST.fullmatch(artifact_id):
            raise ValueError("invalid recovery artifact id")
        value = json.loads(compressed_json.decode(raw))
        if "$format" in value:
            if value.get("artifactId") != artifact_id:
                raise ValueError("recovery descriptor identity mismatch")
            descriptors.append(value)
        else:
            # Small/legacy JSON records are checked directly. Large historical
            # chunked envelopes are validated by their immutable physical closure.
            from .storage_migration import verified_envelope

            verified_envelope(compressed_json.decode(raw), artifact_id)
        artifact_ids.add(artifact_id)

    try:
        for number, name in enumerate(files, 1):
            path = tree / _safe_relative(name)
            if path.is_symlink() or not path.is_file():
                raise ValueError("recovery file is missing or a symlink")
            if name == DATABASE_NAME or files[name].get("sqlite"):
                with closing(
                    sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
                ) as db:
                    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                        raise ValueError("recovery database integrity failed")
                    if db.execute("PRAGMA foreign_key_check").fetchall():
                        raise ValueError("recovery database foreign key check failed")
            if name.startswith("artifacts/object-packs/blocks/") and name.endswith(".pack"):
                content = path.read_bytes()
                if hashlib.sha256(content).hexdigest() != path.stem:
                    raise ValueError("recovery pack checksum mismatch")
                entries, data = decode_pack(content)
                for key, (offset, length, digest) in entries.items():
                    location = (path.stem, offset, length, digest)
                    if key in packed_records and any(
                        row[3] != digest for row in packed_records[key]
                    ):
                        raise ValueError("conflicting recovery pack records")
                    packed_records.setdefault(key, set()).add(location)
                    if key.startswith("artifact/"):
                        artifact(key[9:], data[offset : offset + length])
                    elif key.startswith(("json/", "history/")):
                        if digest != key.split("/", 1)[1]:
                            raise ValueError("recovery chunk identity mismatch")
                        chunks.add(key)
            elif name.startswith(
                ("artifacts/json-chunks/", "artifacts/history-chunks/")
            ) and name.endswith(".gz"):
                raw = gzip.decompress(path.read_bytes())
                if hashlib.sha256(raw).hexdigest() != path.stem:
                    raise ValueError("recovery chunk checksum mismatch")
                chunks.add(("json/" if "json-chunks/" in name else "history/") + path.stem)
            elif name.startswith("artifacts/sha256/") and _DIGEST.fullmatch(path.name):
                if name + ".meta.json" in files:
                    store.get_ref(path.name)
                    artifact_ids.add(path.name)
                else:
                    artifact(path.name, path.read_bytes())
            elif name.startswith("snapshots/") and name.endswith("/manifest.json"):
                manifest = json.loads(compressed_json.decode(path.read_bytes()))
                for ref in manifest["artifacts"]:
                    snapshot_refs.add(ref["artifact_id"])
                    snapshot_refs.update(ref.get("dependency_artifact_ids", []))
            if progress and number % 128 == 0:
                progress(
                    {
                        "phase": "verifying-physical-closure",
                        "files": number,
                        "totalFiles": len(files),
                    }
                )
        index = tree / "artifacts/object-packs/index.sqlite3"
        if packed_records and not index.is_file():
            raise ValueError("recovery pack index missing")
        if index.is_file():
            with closing(sqlite3.connect(index.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
                indexed = {
                    r[0]: tuple(r[1:])
                    for r in db.execute("SELECT key,pack,offset,size,digest FROM records")
                }
            # Unindexed sealed files may precede an interrupted publication;
            # every indexed entry must match the self-describing pack exactly.
            if any(
                location not in packed_records.get(key, set()) for key, location in indexed.items()
            ):
                raise ValueError("recovery locator does not match sealed records")
            accessible = {k[9:] for k in indexed if k.startswith("artifact/")}
            artifact_ids = {
                a for a in artifact_ids if f"artifacts/sha256/{a}" in files
            } | accessible
            chunks = {
                c
                for c in chunks
                if c in indexed
                or (
                    f"artifacts/{'json-chunks' if c.startswith('json/') else 'history-chunks'}/{c.split('/')[1][:2]}/{c.split('/')[1]}.gz"
                    in files
                )
            }
        if not snapshot_refs.issubset(artifact_ids):
            raise ValueError("recovery snapshot references a missing artifact or dependency")
        for descriptor in descriptors:
            for chunk in store.logical_paths(descriptor):
                key = (
                    "json/" if chunk.parent.parent.name == "json-chunks" else "history/"
                ) + chunk.stem
                if key not in chunks:
                    raise ValueError("recovery descriptor references a missing chunk")
        return {
            "snapshotRunId": check_snapshot(tree),
            "artifacts": len(artifact_ids),
            "chunks": len(chunks),
        }
    finally:
        store.packs.close()


def archive_checkpoint(repository, checkpoint_id: str) -> dict:
    repository.manifest_path(checkpoint_id)  # Validate before using it as a directory.
    with exclusive_lock(repository.lock):
        directory = repository.root / "checkpoints" / checkpoint_id
        metadata_path = directory / "checkpoint.json"
        if directory.is_symlink() or metadata_path.is_symlink():
            raise ValueError("checkpoint must not be a symlink")
        metadata = json.loads(metadata_path.read_bytes())
        if metadata.get("format") != FORMAT or metadata.get("id") != checkpoint_id:
            raise ValueError("invalid checkpoint metadata")
        if metadata.get("archived"):
            # Repeated task delivery is harmless; the result still names the
            # published recovery point, never a queued/partial one.
            repository.read_manifest(checkpoint_id)
            tree = directory / "state"
            if tree.exists():
                shutil.rmtree(tree)
            return metadata["result"]
        tree = directory / "state"
        started = time.monotonic()
        files = {}
        reused = written = 0
        journal = repository.root / "physical-journal.sqlite3"
        if journal.is_symlink():
            raise ValueError("recovery journal must not be a symlink")
        with closing(sqlite3.connect(journal)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            db.execute(
                "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, stamp TEXT, digest TEXT NOT NULL) WITHOUT ROWID"
            )
            try:
                for number, (name, source_entry) in enumerate(metadata["files"].items(), 1):
                    source = tree / _safe_relative(name)
                    if source.is_symlink() or _stamp(source) != source_entry["checkpointStamp"]:
                        raise ValueError("checkpoint changed before archival")
                    key = metadata["sourceState"] + "/" + name
                    stamp = json.dumps(source_entry["sourceStamp"])
                    previous = db.execute(
                        "SELECT stamp,digest FROM files WHERE path=?", (key,)
                    ).fetchone()
                    cached = previous and source_entry["sourceStamp"] and previous[0] == stamp
                    digest = previous[1] if cached else digest_file(source)
                    target = raw_path(repository, digest)
                    if target.is_file():
                        reused += 1
                    else:
                        target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                        temporary = target.with_name(".pending-" + digest)
                        temporary.unlink(missing_ok=True)
                        try:
                            copy_independent(source, temporary)
                            if digest_file(temporary) != digest:
                                raise ValueError("recovery copy checksum mismatch")
                            with temporary.open("rb") as handle:
                                os.fsync(handle.fileno())
                            temporary.chmod(0o600)
                            temporary.replace(target)
                            sync_directory(target.parent)
                        finally:
                            temporary.unlink(missing_ok=True)
                        written += source_entry["size"]
                    files[name] = {
                        "sha256": digest,
                        "size": source_entry["size"],
                        "mode": source_entry["mode"],
                        "sqlite": source_entry["sqlite"],
                    }
                    db.execute("INSERT OR REPLACE INTO files VALUES (?,?,?)", (key, stamp, digest))
                    if number % 128 == 0:
                        db.commit()  # Survives a budget limit, SIGTERM or failed verification.
                        repository._progress(
                            "archiving-physical",
                            files=number,
                            totalFiles=len(metadata["files"]),
                            reusedFiles=reused,
                            writtenBytes=written,
                        )
            finally:
                db.commit()
        # Verify independent repository bytes, including reused objects, on
        # every publication. An acceleration journal never vouches for integrity.
        verify_objects(repository, files, compare=tree)
        verified = validate_tree(tree, files, repository.progress)
        if verified["snapshotRunId"] != metadata["snapshotRunId"]:
            raise ValueError("checkpoint snapshot identity changed")
        verification = {
            "files": len(files),
            "logicalBytes": sum(e["size"] for e in files.values()),
            "verifiedAt": datetime.now(UTC).isoformat(),
            **verified,
        }
        manifest = {
            "schemaVersion": 1,
            "artifactEncoding": "sealed",
            "id": checkpoint_id,
            "createdAt": metadata["createdAt"],
            "sourceState": metadata["sourceState"],
            "label": metadata["label"],
            "files": files,
            "verification": verification,
        }
        repository._publish_manifest(checkpoint_id, manifest)
        result = {
            "id": checkpoint_id,
            "createdAt": metadata["createdAt"],
            "manifest": str(repository.manifest_path(checkpoint_id)),
            **verification,
            "checkpointSeconds": metadata["checkpointSeconds"],
            "archiveSeconds": round(time.monotonic() - started, 3),
            "reusedFiles": reused,
            "writtenBytes": written,
            "archiveStatus": "verified",
        }
        # Publish success before discarding the independent staging tree. If
        # interrupted here the next invocation can safely complete the cleanup.
        atomic_json(
            metadata_path,
            {
                "format": FORMAT,
                "id": checkpoint_id,
                "archived": True,
                "sourceState": metadata["sourceState"],
                "createdAt": metadata["createdAt"],
                "result": result,
            },
        )
        shutil.rmtree(tree)
        repository._progress("backup-published", **result)
        return result


def verify_objects(
    repository, files: dict, destination: Path | None = None, *, compare: Path | None = None
) -> None:
    checked = set()
    for number, (name, entry) in enumerate(files.items(), 1):
        relative = _safe_relative(name)
        size = entry.get("size")
        if type(size) is not int or size < 0:
            raise ValueError("invalid recovery file size")
        source = raw_path(repository, entry["sha256"])
        if not source.is_file() or source.stat().st_size != size:
            raise ValueError("recovery object missing or size mismatch")
        if entry["sha256"] not in checked:
            if digest_file(source) != entry["sha256"]:
                raise ValueError("recovery object checksum mismatch")
            checked.add(entry["sha256"])
        if compare and digest_file(compare / relative) != entry["sha256"]:
            raise ValueError("recovery journal does not match checkpoint bytes")
        if destination:
            target = destination / relative
            copy_independent(source, target)
            target.chmod(entry.get("mode", 0o600) & 0o700)
        if number % 128 == 0:
            repository._progress("verifying-physical-bytes", files=number, totalFiles=len(files))


def verify_manifest(repository, manifest: dict, destination: Path | None = None) -> dict:
    with tempfile.TemporaryDirectory(prefix=".verify-physical-", dir=repository.root) as temporary:
        tree = destination or Path(temporary) / "state"
        tree.mkdir(parents=True, exist_ok=True, mode=0o700)
        verify_objects(repository, manifest["files"], tree)
        verified = validate_tree(tree, manifest["files"], repository.progress)
        return {
            "files": len(manifest["files"]),
            "logicalBytes": sum(e["size"] for e in manifest["files"].values()),
            "verifiedAt": datetime.now(UTC).isoformat(),
            **verified,
        }
