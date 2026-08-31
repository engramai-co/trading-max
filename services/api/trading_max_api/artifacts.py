"""Typed snapshot and artifact access for the API.

The API deliberately has no knowledge of repository-shaped research folders.
Workers publish immutable, content-addressed artifacts and this adapter only
reads snapshot manifests and their referenced bytes.  A snapshot is therefore
the sole source of truth for every API response.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotIntegrityError,
    SnapshotStore,
    StoredArtifact,
    StoredBytes,
)

from .models import ArtifactInfo, JobScope, SnapshotManifest


def _safe_key(key: str) -> str:
    from posixpath import normpath

    normalized = normpath(key)
    if normalized.startswith("/") or normalized == ".." or normalized.startswith("../"):
        raise ValueError(f"unsafe artifact key: {key}")
    if not normalized:
        raise ValueError(f"unsafe artifact key: {key}")
    return normalized


def _artifact_id(info: ArtifactInfo) -> str:
    prefix = "artifacts/sha256/"
    if not info.source_path.startswith(prefix):
        raise RuntimeError(f"typed artifact has an invalid source path: {info.source_path}")
    artifact_id = info.source_path.removeprefix(prefix)
    if len(artifact_id) != 64 or any(
        character not in "0123456789abcdef" for character in artifact_id
    ):
        raise RuntimeError(f"typed artifact has an invalid id: {artifact_id}")
    return artifact_id


class ArtifactStore:
    """Read and publish only typed immutable snapshots."""

    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root.expanduser().resolve()
        self.immutable_artifacts = ContentAddressedArtifactStore(self.data_root / "artifacts")
        self.immutable_snapshots = SnapshotStore(self.data_root)
        self.jobs_root = self.data_root / "jobs"
        self.logs_root = self.data_root / "logs"
        self._manifest_lock = threading.RLock()
        self._latest_signature: tuple[int, int, int] | None = None
        self._latest_cache: SnapshotManifest | None = None
        self._manifest_cache: OrderedDict[str, SnapshotManifest] = OrderedDict()
        for directory in (self.jobs_root, self.logs_root):
            directory.mkdir(parents=True, exist_ok=True)

    def latest_manifest(self) -> SnapshotManifest | None:
        latest_path = self.immutable_snapshots.latest_path
        try:
            stat = latest_path.stat()
        except FileNotFoundError:
            return None
        signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
        with self._manifest_lock:
            if self._latest_cache is not None and self._latest_signature == signature:
                return self._latest_cache
            try:
                latest = self.immutable_snapshots.latest()
            except (FileNotFoundError, SnapshotIntegrityError):
                return None
            if latest is None:
                return None
            manifest = self._api_manifest(latest.manifest)
            self._remember_manifest(manifest)
            self._latest_signature = signature
            self._latest_cache = manifest
            return manifest

    def load_manifest(self, run_id: str) -> SnapshotManifest:
        with self._manifest_lock:
            cached = self._manifest_cache.get(run_id)
            if cached is not None:
                self._manifest_cache.move_to_end(run_id)
                return cached
        try:
            manifest = self._api_manifest(self.immutable_snapshots.load(run_id).manifest)
        except FileNotFoundError:
            raise FileNotFoundError(f"snapshot not found: {run_id}") from None
        with self._manifest_lock:
            self._remember_manifest(manifest)
        return manifest

    def _remember_manifest(self, manifest: SnapshotManifest) -> None:
        self._manifest_cache[manifest.run_id] = manifest
        self._manifest_cache.move_to_end(manifest.run_id)
        while len(self._manifest_cache) > 1_024:
            self._manifest_cache.popitem(last=False)

    def _api_manifest(self, manifest) -> SnapshotManifest:
        artifacts: list[ArtifactInfo] = []
        for ref in manifest.artifacts:
            path = self.immutable_artifacts.path_for(ref.artifact_id)
            artifacts.append(
                ArtifactInfo(
                    key=ref.key,
                    source_path=f"artifacts/sha256/{ref.artifact_id}",
                    size_bytes=path.stat().st_size if path.is_file() else 0,
                    sha256=ref.sha256,
                    media_type=ref.media_type,
                    schema_version=ref.schema_version,
                    kind=ref.kind,
                    data_as_of=ref.as_of,
                    generated_at=ref.generated_at,
                    model_version=ref.producer_version,
                    dependency_hashes={
                        f"artifact:{dependency}": dependency
                        for dependency in ref.dependency_artifact_ids
                    },
                    warnings=ref.quality.warnings,
                )
            )
        return SnapshotManifest(
            schema_version=2,
            run_id=manifest.run_id,
            created_at=manifest.created_at,
            scope=manifest.scope,
            source=manifest.source,
            artifacts=artifacts,
        )

    def publish_typed(
        self,
        *,
        scope: JobScope,
        source: str,
        artifacts: list[StoredArtifact | StoredBytes],
    ) -> SnapshotManifest:
        published = self.immutable_snapshots.publish(
            scope=scope,
            source=source,
            artifacts=artifacts,
        )
        manifest = self._api_manifest(published.manifest)
        latest_path = self.immutable_snapshots.latest_path
        stat = latest_path.stat()
        with self._manifest_lock:
            self._remember_manifest(manifest)
            self._latest_signature = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
            self._latest_cache = manifest
        return manifest

    def list_manifests(self, limit: int = 100) -> list[SnapshotManifest]:
        bounded = min(max(limit, 1), 500)
        manifests: list[SnapshotManifest] = []
        snapshots_root = self.immutable_snapshots.snapshots_root
        if not snapshots_root.is_dir():
            return manifests
        directories = sorted(
            (
                path
                for path in snapshots_root.iterdir()
                if path.is_dir() and not path.name.startswith(".")
            ),
            key=lambda path: path.name,
            reverse=True,
        )
        for directory in directories:
            if len(manifests) >= bounded:
                break
            run_id = directory.name
            with self._manifest_lock:
                cached = self._manifest_cache.get(run_id)
                if cached is not None:
                    self._manifest_cache.move_to_end(run_id)
            if cached is not None:
                manifests.append(cached)
                continue
            try:
                snapshot = self.immutable_snapshots.load(run_id, verify_artifacts=False)
            except (FileNotFoundError, SnapshotIntegrityError):
                continue
            manifest = self._api_manifest(snapshot.manifest)
            with self._manifest_lock:
                self._remember_manifest(manifest)
            manifests.append(manifest)
        return manifests

    def ensure_bootstrap(self) -> SnapshotManifest:
        latest = self.latest_manifest()
        if latest is None:
            raise FileNotFoundError("no typed snapshot has been published")
        self.load_manifest(latest.run_id)
        return latest

    def prune_snapshots(
        self,
        *,
        keep_recent: int | None = None,
        keep_monthly: int | None = None,
    ) -> list[str]:
        """Bound immutable snapshot indexes while preserving monthly anchors."""

        recent_limit = keep_recent or int(os.environ.get("TRADING_MAX_SNAPSHOT_KEEP_RECENT", "40"))
        monthly_limit = (
            keep_monthly
            if keep_monthly is not None
            else int(os.environ.get("TRADING_MAX_SNAPSHOT_KEEP_MONTHLY", "24"))
        )
        snapshots = self.immutable_snapshots.list(limit=100_000)
        if len(snapshots) <= recent_limit:
            return []
        keep = {item.manifest.run_id for item in snapshots[:recent_limit]}
        latest = self.latest_manifest()
        if latest is not None:
            keep.add(latest.run_id)
        anchors: dict[str, str] = {}
        for item in snapshots[recent_limit:]:
            anchors[item.manifest.created_at.strftime("%Y-%m")] = item.manifest.run_id
        keep.update(run_id for _, run_id in sorted(anchors.items(), reverse=True)[:monthly_limit])
        removed: list[str] = []
        for item in snapshots:
            run_id = item.manifest.run_id
            if run_id in keep:
                continue
            shutil.rmtree(self.immutable_snapshots.snapshots_root / run_id)
            removed.append(run_id)
        return removed

    def artifact_path(self, run_id: str, key: str) -> tuple[Path, ArtifactInfo]:
        safe_key = _safe_key(key)
        manifest = self.load_manifest(run_id)
        artifact = next(
            (item for item in manifest.artifacts if item.key == safe_key),
            None,
        )
        if artifact is None:
            raise FileNotFoundError(f"artifact not found: {safe_key}")
        artifact_id = _artifact_id(artifact)
        path = self.immutable_artifacts.path_for(artifact_id)
        if not path.is_file():
            raise FileNotFoundError(f"artifact file missing: {safe_key}")
        return path, artifact

    @staticmethod
    def artifact_id(info: ArtifactInfo) -> str:
        """Return the immutable content-store ID referenced by API metadata."""

        return _artifact_id(info)

    def latest_artifact_path(self, key: str) -> tuple[Path, ArtifactInfo]:
        manifest = self.latest_manifest()
        if manifest is None:
            raise FileNotFoundError("no snapshot has been published")
        return self.artifact_path(manifest.run_id, key)

    def read_json(self, run_id: str, key: str) -> dict[str, Any]:
        _, artifact = self.artifact_path(run_id, key)
        if artifact.media_type != "application/json":
            raise TypeError(f"artifact is not JSON: {key}")
        return self.immutable_artifacts.get_json(_artifact_id(artifact)).payload

    def read_text(self, run_id: str, key: str) -> str:
        _, artifact = self.artifact_path(run_id, key)
        artifact_id = _artifact_id(artifact)
        if artifact.media_type == "application/json":
            return (
                json.dumps(
                    self.immutable_artifacts.get_json(artifact_id).payload,
                    ensure_ascii=False,
                )
                + "\n"
            )
        return self.immutable_artifacts.get_bytes(artifact_id).path.read_text(encoding="utf-8")


__all__ = ["ArtifactStore"]
