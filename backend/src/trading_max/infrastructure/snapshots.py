"""Immutable snapshot publication for the Trading Max application state.

Snapshots are a small index over content-addressed artifacts. The index is
written only after every artifact has been stored successfully, and the
latest.json pointer is replaced atomically. Readers therefore either see the
previous complete snapshot or the new complete snapshot; they can never
observe a half-published run.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from trading_max.domain import ArtifactRef, JobScope, SnapshotManifest

from .artifacts import ContentAddressedArtifactStore, StoredArtifact, StoredBytes


class SnapshotIntegrityError(RuntimeError):
    """The latest pointer or manifest does not match its stored bytes."""


def _canonical_json(value: Mapping[str, object]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


@dataclass(frozen=True, slots=True)
class StoredSnapshot:
    """A published manifest and its on-disk immutable location."""

    manifest: SnapshotManifest
    path: Path


class SnapshotStore:
    """Publish and read manifests without filesystem-time discovery."""

    def __init__(self, root: Path) -> None:
        self.root = root.expanduser().resolve()
        self.artifacts = ContentAddressedArtifactStore(self.root / "artifacts")
        self.snapshots_root = self.root / "snapshots"
        self.latest_path = self.root / "latest.json"

    def publish(
        self,
        *,
        scope: JobScope,
        source: str,
        artifacts: Iterable[StoredArtifact | StoredBytes | ArtifactRef],
        created_at: datetime | None = None,
    ) -> StoredSnapshot:
        refs = [
            item.ref if isinstance(item, (StoredArtifact, StoredBytes)) else item
            for item in artifacts
        ]
        if not refs:
            raise ValueError("cannot publish an empty snapshot")
        self.snapshots_root.mkdir(parents=True, exist_ok=True)
        now = created_at or datetime.now(UTC)
        run_id = now.strftime("%Y%m%dT%H%M%S") + f"-{now.microsecond:06d}Z-{uuid.uuid4().hex[:8]}"
        manifest = SnapshotManifest(
            run_id=run_id,
            created_at=now,
            scope=scope,
            source=source,
            artifacts=refs,
        )
        raw = manifest.model_dump(mode="json", by_alias=False)
        content = _canonical_json(raw)
        manifest_hash = hashlib.sha256(content).hexdigest()
        final = self.snapshots_root / run_id / "manifest.json"
        _atomic_write(final, content + b"\n")
        pointer = {
            "schema_version": 1,
            "run_id": run_id,
            "manifest_sha256": manifest_hash,
            "published_at": now.isoformat(),
        }
        _atomic_write(self.latest_path, _canonical_json(pointer) + b"\n")
        return StoredSnapshot(manifest=manifest, path=final)

    def load(self, run_id: str, *, verify_artifacts: bool = True) -> StoredSnapshot:
        path = self.snapshots_root / run_id / "manifest.json"
        if not path.is_file():
            raise FileNotFoundError(f"snapshot not found: {run_id}")
        try:
            manifest = SnapshotManifest.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise SnapshotIntegrityError(f"invalid snapshot manifest: {run_id}") from exc
        if verify_artifacts:
            for ref in manifest.artifacts:
                if ref.media_type == "application/json":
                    self.artifacts.get_json(ref.artifact_id)
                else:
                    self.artifacts.get_bytes(ref.artifact_id)
        return StoredSnapshot(manifest=manifest, path=path)

    def list(self, *, limit: int = 100) -> list[StoredSnapshot]:
        """Return valid typed snapshots in manifest order.

        The latest pointer remains the only way to resolve the current state;
        this method is intentionally an audit/history read and never infers a
        current snapshot from filesystem mtimes.
        """

        if limit <= 0:
            return []
        snapshots: list[StoredSnapshot] = []
        if not self.snapshots_root.is_dir():
            return snapshots
        for directory in self.snapshots_root.iterdir():
            if not directory.is_dir() or directory.name.startswith("."):
                continue
            try:
                # History listings are index reads. Verifying every artifact of
                # every historical snapshot here re-hashes the entire store on
                # each call; readers validate the payloads they actually load.
                snapshots.append(self.load(directory.name, verify_artifacts=False))
            except (FileNotFoundError, SnapshotIntegrityError):
                continue
        snapshots.sort(key=lambda item: item.manifest.created_at, reverse=True)
        return snapshots[:limit]

    def latest(self) -> StoredSnapshot | None:
        if not self.latest_path.is_file():
            return None
        try:
            pointer = json.loads(self.latest_path.read_text(encoding="utf-8"))
            run_id = str(pointer["run_id"])
            expected = str(pointer["manifest_sha256"])
            snapshot = self.load(run_id)
            actual = hashlib.sha256(
                _canonical_json(snapshot.manifest.model_dump(mode="json", by_alias=False))
            ).hexdigest()
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise SnapshotIntegrityError("invalid latest snapshot pointer") from exc
        if actual != expected:
            raise SnapshotIntegrityError(f"snapshot manifest digest mismatch: {run_id}")
        return snapshot


__all__ = ["SnapshotIntegrityError", "SnapshotStore", "StoredSnapshot"]
