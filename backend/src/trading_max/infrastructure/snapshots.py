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
import threading
import uuid
from collections.abc import Callable, Iterable, Mapping
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from heapq import nlargest
from pathlib import Path
from weakref import WeakValueDictionary

from trading_max.domain import ArtifactRef, JobScope, SnapshotManifest

from . import compressed_json
from .artifacts import ContentAddressedArtifactStore, StoredArtifact, StoredBytes
from .history_chunks import atomic_bytes

_PROCESS_LOCKS_GUARD = threading.Lock()
_PROCESS_LOCKS: WeakValueDictionary[Path, threading.RLock] = WeakValueDictionary()
_LOCK_STATE = threading.local()


def _process_lock(root: Path) -> threading.RLock:
    with _PROCESS_LOCKS_GUARD:
        lock = _PROCESS_LOCKS.get(root)
        if lock is None:
            lock = threading.RLock()
            _PROCESS_LOCKS[root] = lock
        return lock


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
    atomic_bytes(path, content)


@dataclass(frozen=True, slots=True)
class StoredSnapshot:
    """A published manifest and its on-disk immutable location."""

    manifest: SnapshotManifest
    path: Path


class SnapshotStore:
    """Publish and read manifests without filesystem-time discovery."""

    def __init__(
        self, root: Path, *, artifacts: ContentAddressedArtifactStore | None = None
    ) -> None:
        self.root = root.expanduser().resolve()
        self.artifacts = artifacts or ContentAddressedArtifactStore(self.root / "artifacts")
        if self.artifacts.root != self.root / "artifacts":
            raise ValueError("snapshot artifact store must use the same state root")
        self.snapshots_root = self.root / "snapshots"
        self.latest_path = self.root / "latest.json"
        self._process_lock = _process_lock(self.root)

    @contextmanager
    def publication_lock(self):
        """Order pointer replacements and commits that require the pointer to stay current."""
        self.root.mkdir(parents=True, exist_ok=True)
        depths = getattr(_LOCK_STATE, "depths", None)
        if depths is None:
            depths = {}
            _LOCK_STATE.depths = depths
        # The pointer itself is replaced by rename. Lock a stable inode shared
        # by API, worker and CLI processes, including separate store instances.
        # A per-root RLock serializes threads in the same process and makes
        # nested acquisitions on one thread reentrant without re-entering flock.
        with self._process_lock:
            depth = depths.get(self.root, 0)
            if depth > 0:
                depths[self.root] = depth + 1
                try:
                    yield
                finally:
                    depths[self.root] = depth
                return
            with (self.root / ".publication.lock").open("a+b") as handle:
                if os.name == "nt":
                    import msvcrt

                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle, fcntl.LOCK_EX)
                depths[self.root] = 1
                try:
                    yield
                finally:
                    depths.pop(self.root, None)

    def publish(
        self,
        *,
        scope: JobScope,
        source: str,
        artifacts: Iterable[StoredArtifact | StoredBytes | ArtifactRef],
        created_at: datetime | None = None,
        prepare: Callable[[str], None] | None = None,
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
        stored = content + b"\n"
        if self.artifacts.storage_mode != "legacy":
            stored = compressed_json.encode(stored)
        pointer = {
            "schema_version": 1,
            "run_id": run_id,
            "manifest_sha256": manifest_hash,
            "published_at": now.isoformat(),
        }
        with self.publication_lock():
            # Preserve proof of visibility before another run can supersede
            # the pointer. The current run needs no receipt until that happens.
            try:
                previous = self.latest(verify_artifacts=False)
            except SnapshotIntegrityError:
                previous = None
            if previous is not None:
                receipt = previous.path.with_name(".published")
                if not receipt.is_file():
                    _atomic_write(receipt, b"")
            if prepare is not None:
                prepare(run_id)
            pending = final.with_name(".pending-publication")
            _atomic_write(pending, b"")
            try:
                _atomic_write(final, stored)
                _atomic_write(self.latest_path, _canonical_json(pointer) + b"\n")
            except BaseException:
                # A process crash can leave this marker behind. History also
                # checks for visibility before exposing a marked manifest.
                if not self.was_published(run_id):
                    final.unlink(missing_ok=True)
                    pending.unlink(missing_ok=True)
                    with suppress(OSError):
                        pending.parent.rmdir()
                raise
            pending.unlink(missing_ok=True)
        return StoredSnapshot(manifest=manifest, path=final)

    def was_published(self, run_id: str) -> bool:
        """Distinguish a visible run from an intent that never replaced the pointer."""
        if Path(run_id).name != run_id or run_id in {".", ".."}:
            return False
        with self.publication_lock():
            if (self.snapshots_root / run_id / ".published").is_file():
                return True
            try:
                return json.loads(self.latest_path.read_text(encoding="utf-8"))["run_id"] == run_id
            except (FileNotFoundError, KeyError, TypeError, ValueError):
                return False

    def find_publication(self, source: str) -> str | None:
        """Recover a published job by source if its queue intent is unavailable."""
        with self.publication_lock():
            current = self.latest(verify_artifacts=False)
            if current is not None and current.manifest.source == source:
                return current.manifest.run_id
            for snapshot in self.list(limit=100_000):
                run_id = snapshot.manifest.run_id
                if snapshot.manifest.source == source and self.was_published(run_id):
                    return run_id
        return None

    def load(self, run_id: str, *, verify_artifacts: bool = True) -> StoredSnapshot:
        path = self.snapshots_root / run_id / "manifest.json"
        if not path.is_file() or (
            path.with_name(".pending-publication").is_file() and not self.was_published(run_id)
        ):
            raise FileNotFoundError(f"snapshot not found: {run_id}")
        try:
            manifest = SnapshotManifest.model_validate_json(
                compressed_json.decode(path.read_bytes())
            )
        except Exception as exc:
            raise SnapshotIntegrityError(f"invalid snapshot manifest: {run_id}") from exc
        if verify_artifacts:
            for ref in manifest.artifacts:
                self.artifacts.get_ref(ref.artifact_id)
        return StoredSnapshot(manifest=manifest, path=path)

    def list(self, *, limit: int = 100, scan_limit: int | None = None) -> list[StoredSnapshot]:
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
        directories = (
            path
            for path in self.snapshots_root.iterdir()
            if not path.name.startswith(".") and path.is_dir()
        )
        if scan_limit is not None:
            # Typed run IDs sort by publication time, bounding manifest reads.
            directories = iter(nlargest(scan_limit, directories, key=lambda path: path.name))
        for directory in directories:
            try:
                # History listings are index reads. Verifying every artifact of
                # every historical snapshot here re-hashes the entire store on
                # each call; readers validate the payloads they actually load.
                snapshots.append(self.load(directory.name, verify_artifacts=False))
            except (FileNotFoundError, SnapshotIntegrityError):
                continue
        snapshots.sort(key=lambda item: item.manifest.created_at, reverse=True)
        return snapshots[:limit]

    def latest(self, *, verify_artifacts: bool = True) -> StoredSnapshot | None:
        if not self.latest_path.is_file():
            return None
        try:
            pointer = json.loads(self.latest_path.read_text(encoding="utf-8"))
            run_id = str(pointer["run_id"])
            expected = str(pointer["manifest_sha256"])
            snapshot = self.load(run_id, verify_artifacts=verify_artifacts)
            actual = hashlib.sha256(
                _canonical_json(snapshot.manifest.model_dump(mode="json", by_alias=False))
            ).hexdigest()
        except (OSError, KeyError, TypeError, ValueError) as exc:
            raise SnapshotIntegrityError("invalid latest snapshot pointer") from exc
        if actual != expected:
            raise SnapshotIntegrityError(f"snapshot manifest digest mismatch: {run_id}")
        return snapshot


__all__ = ["SnapshotIntegrityError", "SnapshotStore", "StoredSnapshot"]
