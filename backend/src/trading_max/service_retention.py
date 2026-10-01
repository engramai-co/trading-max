"""Plan and bound cleanup of operator-owned releases and recovery copies.

Never touches live application state. Unknown paths are not cleanup candidates.
Plans are invalidated by deployment changes and targets are re-inventoried before
an atomic rename into a private cleanup journal, followed by physical removal.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .backup_repository import BackupRepository, atomic_json, exclusive_lock
from .infrastructure.durable_files import durable_directory, sync_directory
from .infrastructure.verified_chunks import ChunkPathCache

_RELEASE = re.compile(r"(?:previous-)?[0-9a-f]{12}-[a-z0-9_]{8}")
_ARCHIVE = re.compile(r"trading_max-\d{8}T\d{6}Z\.tar\.gz")
_SMALL_FILE_KINDS = {"backup-blob", "runtime-dependency"}
_TERMINAL = {"healthy", "rolled-back", "failed-before-cutover"}
_KNOWN = _TERMINAL | {
    "building",
    "built",
    "preflight-backup",
    "stopping",
    "backing-up",
    "activating",
    "configuring",
    "migrating",
    "starting",
    "checking",
    "rolling-back",
    "rollback-failed",
}


def inventory(path: Path) -> dict:
    """Fingerprint names, inode metadata and link targets without following links."""
    if path.is_symlink():
        raise ValueError("cleanup target must not be a symlink")
    digest = hashlib.sha256()
    size = files = 0
    seen = set()
    paths = [path]
    if path.is_dir():
        for directory, directories, names in os.walk(path, followlinks=False):
            directories.sort()
            paths.extend(Path(directory) / name for name in sorted(directories + names))
    for item in paths:
        info = item.lstat()
        shared_immutable = (
            stat.S_ISREG(info.st_mode)
            and stat.S_IMODE(info.st_mode) in {0o444, 0o555}
            and info.st_nlink > 1
        )
        content_digest = None
        if shared_immutable:
            # Unlinking another retired release changes this inode's ctime.
            # Compare immutable file content instead, so a bounded batch
            # can retire multiple aliases without weakening tamper detection.
            with item.open("rb") as stream:
                content_digest = hashlib.file_digest(stream, "sha256").hexdigest()
        digest.update(
            json.dumps(
                [
                    str(item.relative_to(path)),
                    info.st_dev,
                    info.st_ino,
                    info.st_mode,
                    info.st_size,
                    info.st_mtime_ns,
                    None if shared_immutable else info.st_ctime_ns,
                    info.st_uid,
                    info.st_gid,
                    content_digest,
                    str(item.readlink()) if item.is_symlink() else None,
                ]
            ).encode()
        )
        identity = (info.st_dev, info.st_ino)
        if stat.S_ISREG(info.st_mode) and identity not in seen:
            size += info.st_size
            files += 1
            seen.add(identity)
    return {"fingerprint": digest.hexdigest(), "bytes": size, "files": files}


def retained_dates(
    items: list[tuple[str, datetime]], *, recent=3, daily=7, weekly=4, monthly=6
) -> set[str]:
    ordered = sorted(items, key=lambda item: item[1], reverse=True)
    keep = {name for name, _ in ordered[:recent]}
    for limit, key in (
        (daily, lambda d: d.date()),
        (weekly, lambda d: d.isocalendar()[:2]),
        (monthly, lambda d: (d.year, d.month)),
    ):
        buckets = {}
        for name, instant in ordered:
            buckets.setdefault(key(instant), name)
        keep.update(list(buckets.values())[:limit])
    return keep


def _cleanup_batches(items: list[dict]):
    """Bound journal rewrites and deployment yield latency independently of backlog."""
    batch = []
    size = 0
    for item in items:
        if batch and (
            len(batch) >= 64
            or size + item["bytes"] > 8 * 1024 * 1024
            or item["kind"] not in _SMALL_FILE_KINDS
        ):
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += item["bytes"]
        if item["kind"] not in _SMALL_FILE_KINDS:
            yield batch
            batch, size = [], 0
    if batch:
        yield batch


def retain_immutable_coverage(manifests: dict[str, dict], keep: set[str]) -> set[str]:
    """A date policy must not retire the last backup of immutable history.

    Compare original file digests, including binary sidecars and import sources.
    A representation change can conservatively retain an extra point; never
    infer that equal paths with different bytes prove equivalent observations.
    """
    keep = set(keep)

    def identities(manifest):
        return {
            (name, entry["sha256"])
            for name, entry in manifest["files"].items()
            if name.startswith(
                (
                    "artifacts/",
                    "snapshots/",
                    "imports/",
                    "trading212/",
                    "raw/",
                    "legacy-archive-compat/",
                )
            )
        }

    covered = set()
    for name in keep:
        if name in manifests:
            covered.update(identities(manifests[name]))
    for name, manifest in sorted(
        manifests.items(),
        key=lambda item: datetime.fromisoformat(item[1]["createdAt"]),
        reverse=True,
    ):
        if name in keep:
            continue
        required = identities(manifest)
        if not required.issubset(covered):
            keep.add(name)
            covered.update(required)
    return keep


class ServiceRetention:
    def __init__(self, service: Path, *, now: datetime | None = None, min_age_hours: int = 24):
        self.service = service.expanduser().resolve()
        self.now = now or datetime.now(UTC)
        if min_age_hours < 24:
            raise ValueError("cleanup grace must be at least 24 hours")
        self.cutoff = self.now.timestamp() - timedelta(hours=min_age_hours).total_seconds()
        self.min_age_hours = min_age_hours
        self.releases = self.service / "releases"
        self.backups = self.service / "backups"
        for directory in (
            self.releases,
            self.backups,
            self.service / "deployments",
            self.service / "maintenance",
        ):
            if directory.is_symlink():
                raise ValueError("managed directories must not be symlinks")
        app = self.service / "app"
        if not app.is_symlink() or app.resolve(strict=True).parent != self.releases:
            raise ValueError("cleanup requires the immutable release layout")
        self.repository = BackupRepository(self.backups / "repository")

    def _context(self) -> dict:
        active = (self.service / "app").resolve(strict=True)
        records = {}
        digest = hashlib.sha256(str(active).encode())
        for path in sorted((self.service / "deployments").glob("*.json")):
            if not _RELEASE.fullmatch(path.stem):
                continue  # Older acceptance reports share this directory.
            if path.is_symlink():
                raise ValueError("deployment record must not be a symlink")
            content = path.read_bytes()
            data = json.loads(content)
            if data.get("phase") not in _KNOWN:
                raise ValueError("unknown deployment phase; cleanup stopped")
            for field in ("candidate", "previous"):
                target = Path(data[field])
                if target.parent != self.releases or not _RELEASE.fullmatch(target.name):
                    raise ValueError("deployment record escapes releases")
            records[path.stem] = data
            digest.update(path.name.encode() + content)
        protected = {str(active)}
        current = str(active)
        for _ in range(2):
            record = next(
                (
                    r
                    for r in records.values()
                    if r["candidate"] == current and r["phase"] == "healthy"
                ),
                None,
            )
            if record is None:
                break
            current = record["previous"]
            protected.add(current)
        for data in records.values():
            if data["phase"] not in _TERMINAL:
                protected.update((data["candidate"], data["previous"]))
        # A retained executable can still have a live process after a failed stop.
        process = subprocess.run(
            ["/bin/ps", "-axo", "command="], check=True, capture_output=True, text=True
        )
        for name in _RELEASE.findall(process.stdout):
            path = str(self.releases / name)
            if path in process.stdout:
                protected.add(path)
        protected_ids = {Path(path).name for path in protected}
        backup_ids = set()
        for name, record in records.items():
            if (name in protected_ids or record["phase"] not in _TERMINAL) and record.get(
                "backupManifest"
            ):
                backup_ids.add(Path(record["backupManifest"]).stem)
        return {
            "active": str(active),
            "records": records,
            "protected": sorted(protected),
            "protectedBackupIds": sorted(backup_ids),
            "fingerprint": digest.hexdigest(),
        }

    @staticmethod
    def _clean_release(path: Path) -> bool:
        if not (path / ".git").is_dir():
            return False
        result = subprocess.run(  # noqa: S603 - fixed Git executable, validated release path
            [
                "/usr/bin/git",
                "--no-optional-locks",
                "-C",
                str(path),
                "status",
                "--porcelain",
                "--untracked-files=normal",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.returncode == 0 and not result.stdout.strip()

    def _eligible(self, context: dict) -> list[tuple[str, Path]]:
        # Read each old catalog/descriptor pack once per planning operation;
        # retained legacy points must not turn bounded nightly cleanup into a
        # repeated historical decompression scan.
        with self.repository.packs.scan_reads(), self.repository.packed_store.packs.scan_reads():
            return self._eligible_files(context)

    def _pending_checkpoint_retirements(self, manifests: dict[str, dict]) -> set[str]:
        from .checkpoint_migration import RECEIPT_FORMAT

        parent = self.backups / "emergency-checkpoints"
        if parent.is_symlink():
            raise ValueError("emergency checkpoint directory must not be a symlink")
        keep = set()
        for path in parent.glob("*/retirement.json"):
            if path.is_symlink() or path.parent.is_symlink():
                raise ValueError("checkpoint receipt must not be a symlink")
            receipt = json.loads(path.read_bytes())
            if receipt.get("format") != RECEIPT_FORMAT:
                raise ValueError("unknown checkpoint retirement receipt")
            if receipt.get("phase") != "retiring":
                continue
            backup_id = receipt["backupId"]
            self.repository.manifest_path(backup_id)
            manifest = manifests.get(backup_id, {})
            if not manifest or manifest.get("importedCheckpointSha256") != receipt.get(
                "sourceManifestSha256"
            ):
                raise ValueError("pending retirement recovery manifest is missing or changed")
            keep.add(backup_id)
        return keep

    def _eligible_files(self, context: dict) -> list[tuple[str, Path]]:
        candidates: list[tuple[str, Path]] = []
        known = {
            path
            for record in context["records"].values()
            for path in (record["candidate"], record["previous"])
        }
        for path in sorted(self.releases.iterdir()):
            if (
                str(path) in known
                and str(path) not in context["protected"]
                and _RELEASE.fullmatch(path.name)
                and not path.is_symlink()
                and path.is_dir()
                and path.stat().st_mtime < self.cutoff
                and self._clean_release(path)
            ):
                candidates.append(("release", path))
        archives = []
        for directory in self.backups.iterdir():
            if (
                not _RELEASE.fullmatch(directory.name)
                or directory.is_symlink()
                or not directory.is_dir()
            ):
                continue
            for path in directory.iterdir():
                if _ARCHIVE.fullmatch(path.name) and path.is_file() and not path.is_symlink():
                    archives.append(path)
        keep_archives = retained_dates(
            [(str(p), datetime.fromtimestamp(p.stat().st_mtime, UTC)) for p in archives],
            daily=0,
            weekly=4,
            monthly=6,
        )
        for path in archives:
            if (
                str(path) not in keep_archives
                and str(self.releases / path.parent.name) not in context["protected"]
                and path.stat().st_mtime < self.cutoff
            ):
                candidates.append(("archive", path))
        manifests = {}
        for path in self.repository.snapshots.glob("*.json"):
            self.repository._progress("retention-manifests", files=len(manifests))
            if path != self.repository.manifest_path(path.stem):
                raise ValueError("invalid backup manifest location")
            manifest = self.repository.read_manifest(path.stem)
            if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), dict):
                raise ValueError("unrecognized backup manifest; cleanup stopped")
            manifests[path.stem] = manifest
        keep_backups = retained_dates(
            [(name, datetime.fromisoformat(data["createdAt"])) for name, data in manifests.items()]
        ) | set(context["protectedBackupIds"])
        keep_backups.update(self._pending_checkpoint_retirements(manifests))
        keep_backups = retain_immutable_coverage(manifests, keep_backups)
        referenced = set()
        referenced_digests = set()
        for name, manifest in manifests.items():
            # All existing manifests root blobs, even those proposed for retirement.
            # A later plan collects orphan blobs after the grace period.
            for entry in manifest["files"].values():
                referenced_digests.add(entry["sha256"])
            path = self.repository.manifest_path(name)
            if name not in keep_backups and path.stat().st_mtime < self.cutoff:
                candidates.append(("backup-manifest", path))
        path_cache = {}
        chunk_paths = ChunkPathCache()
        for number, digest in enumerate(referenced_digests, 1):
            referenced.update(
                self.repository.blob_files(digest, path_cache=path_cache, chunk_paths=chunk_paths)
            )
            if number % 128 == 0:
                self.repository._progress(
                    "retention-references", files=number, totalFiles=len(referenced_digests)
                )
        physical_root = self.repository.root / "physical"
        if physical_root.is_symlink():
            raise ValueError("physical recovery store must not be a symlink")
        from .physical_recovery import raw_path

        for path in physical_root.glob("*/*"):
            if path.is_symlink() or path != raw_path(self.repository, path.name):
                raise ValueError("unknown physical recovery object")
            if path not in referenced and path.stat().st_mtime < self.cutoff:
                candidates.append(("backup-blob", path))
        for directory in self.repository.blobs.iterdir():
            if not re.fullmatch(r"[0-9a-f]{2}", directory.name) or directory.is_symlink():
                raise ValueError("unknown backup blob directory")
            for path in directory.iterdir():
                if not path.name.endswith(".gz") or path != self.repository.blob_path(
                    path.name[:-3]
                ):
                    raise ValueError("unknown backup blob")
                if path not in referenced and path.stat().st_mtime < self.cutoff:
                    candidates.append(("backup-blob", path))
        # Packed backup chunks can be shared by multiple original file blobs.
        # Only known representation paths outside the retained closure qualify.
        packed = self.repository.root / "packed"
        if packed.is_symlink():
            raise ValueError("packed backup directory must not be a symlink")
        for path in packed.rglob("*") if packed.exists() else []:
            if path.is_symlink():
                raise ValueError("packed backup files must not be symlinks")
            if not path.is_file():
                continue
            relative = path.relative_to(packed).as_posix()
            if relative.startswith("object-packs/"):
                continue  # Sealed packs need record-aware compaction, not loose-file GC.
            if not re.fullmatch(
                r"[0-9a-f]{64}\.json|(?:history|json)-chunks/[0-9a-f]{2}/[0-9a-f]{64}\.gz",
                relative,
            ):
                raise ValueError("unknown packed backup file")
            if path not in referenced and path.stat().st_mtime < self.cutoff:
                candidates.append(("backup-blob", path))
        toolchains = self.service / "toolchains/node-blobs"
        if toolchains.is_symlink() or toolchains.parent.is_symlink():
            raise ValueError("shared toolchains must not be symlinks")
        for path in toolchains.iterdir() if toolchains.exists() else []:
            if path.is_symlink() or not re.fullmatch(r"[0-9a-f]{64}", path.name):
                continue
            info = path.stat()
            # Any retained runtime, including non-current releases, roots its
            # immutable executable via a hard link. Financial data is not linked.
            if not path.is_file() or info.st_nlink != 1 or info.st_mtime >= self.cutoff:
                continue
            with path.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != path.name:
                    raise ValueError("unreferenced shared Node runtime checksum mismatch")
            candidates.append(("toolchain", path))
        from .shared_runtime import orphan_dependencies

        candidates.extend(
            ("runtime-dependency", path)
            for path in orphan_dependencies(self.service / "toolchains/package-blobs", self.cutoff)
        )
        return candidates

    def plan(self) -> dict:
        with (
            exclusive_lock(self.service / ".deployment.lock"),
            exclusive_lock(self.repository.lock),
        ):
            context = self._context()
            items = [
                {"kind": kind, "path": str(path.relative_to(self.service)), **inventory(path)}
                for kind, path in self._eligible(context)
            ]
            return {
                "schemaVersion": 1,
                "service": str(self.service),
                "createdAt": self.now.isoformat(),
                "minAgeHours": self.min_age_hours,
                "context": context["fingerprint"],
                "protected": context["protected"],
                "items": items,
                "candidateBytes": sum(item["bytes"] for item in items),
            }

    def maintain_repository(self, verified_backup_id: str) -> dict:
        """Nightly bounded cleanup after a verified backup; protect rollback runtimes."""
        plan = self.plan()
        plan["items"] = [
            item
            for item in plan["items"]
            if item["kind"]
            in {"backup-manifest", "backup-blob", "release", "toolchain", "runtime-dependency"}
        ]
        plan["candidateBytes"] = sum(item["bytes"] for item in plan["items"])
        plan_path = self.service / "maintenance-plans" / (verified_backup_id + ".json")
        if plan_path.parent.is_symlink():
            raise ValueError("maintenance plan directory must not be a symlink")
        atomic_json(plan_path, plan)
        if not plan["items"]:
            return {"plan": str(plan_path), "removedItems": 0, "removedBytes": 0}
        result = self.apply(
            plan,
            verified_backup_id=verified_backup_id,
            max_items=16_384,
            max_bytes=2_000_000_000,
            max_seconds=60,
        )
        return {"plan": str(plan_path), **result}

    def apply(
        self,
        plan: dict,
        *,
        verified_backup_id: str,
        max_items: int = 2,
        max_bytes: int = 5_000_000_000,
        max_seconds: float = 60,
    ) -> dict:
        started = time.monotonic()
        if max_items < 1 or max_bytes < 1 or not math.isfinite(max_seconds) or max_seconds <= 0:
            raise ValueError("cleanup limits must be positive")
        if plan.get("schemaVersion") != 1 or plan.get("service") != str(self.service):
            raise ValueError("cleanup plan belongs to another service")
        if datetime.fromisoformat(plan["createdAt"]) < self.now - timedelta(hours=24):
            raise ValueError("cleanup plan expired; generate a new plan")
        if plan.get("minAgeHours") != self.min_age_hours:
            raise ValueError("cleanup policy changed")
        with (
            exclusive_lock(self.service / ".deployment.lock"),
            exclusive_lock(self.repository.lock),
        ):
            # An interrupted removal can leave a detached directory. Preserve it
            # for operator inspection instead of quietly stacking more cleanups.
            for journal_path in (self.service / "maintenance").glob("*/journal.json"):
                if journal_path.parent.is_symlink() or journal_path.is_symlink():
                    raise ValueError("maintenance journal must not be a symlink")
                journal = json.loads(journal_path.read_text())
                if any(item["status"] != "removed" for item in journal["items"]):
                    raise ValueError("unfinished cleanup journal; inspect quarantine first")
            context = self._context()
            if context["fingerprint"] != plan["context"]:
                raise ValueError("deployment changed; generate a new cleanup plan")
            backup_path = self.repository.manifest_path(verified_backup_id)
            backup = self.repository.read_manifest(verified_backup_id)
            active_record = context["records"].get(Path(context["active"]).name, {})
            live_state = active_record.get("state")
            if not live_state or backup.get("sourceState") != str(Path(live_state).resolve()):
                raise ValueError("cleanup backup must belong to the active application state")
            if datetime.fromisoformat(backup["createdAt"]) < self.now - timedelta(days=1):
                raise ValueError("cleanup needs a recovery snapshot from the last 24 hours")
            if not self.repository._verify(backup).get("snapshotRunId"):
                raise ValueError("cleanup requires a verified published state snapshot")
            eligible = {
                (kind, str(path.relative_to(self.service)))
                for kind, path in self._eligible(context)
            }
            selected = []
            selected_paths = set()
            candidate_items = candidate_bytes = 0
            total = 0
            for item in plan["items"]:
                if (item["kind"], item["path"]) not in eligible:
                    raise ValueError("cleanup target is no longer eligible")
                if item["path"] == str(backup_path.relative_to(self.service)):
                    continue
                candidate_items += 1
                candidate_bytes += item["bytes"]
                if len(selected) >= max_items or total + item["bytes"] > max_bytes:
                    continue
                if item["path"] in selected_paths:
                    raise ValueError("duplicate cleanup target")
                actual = inventory(self.service / item["path"])
                if any(actual[key] != item[key] for key in actual):
                    raise ValueError("cleanup target changed; generate a new plan")
                selected.append(item)
                selected_paths.add(item["path"])
                total += item["bytes"]
            cleanup_started = time.monotonic()
            from .background_backup import deployment_requested

            journals = []
            removed_items = removed_bytes = 0
            limit_reason = None
            for batch in _cleanup_batches(selected):
                # Only yield between committed batches, never leave a partial
                # quarantine merely because a time budget or deployment is due.
                if deployment_requested(self.service):
                    raise InterruptedError("cleanup yielded to requested deployment")
                self.repository._progress(
                    "retention-remove", files=removed_items, totalFiles=len(selected)
                )
                if time.monotonic() - cleanup_started >= max_seconds:
                    limit_reason = "time-budget"
                    break
                journals.append(self._remove_batch(batch, context, verified_backup_id))
                removed_items += len(batch)
                removed_bytes += sum(item["bytes"] for item in batch)
            return {
                "journal": journals[0] if journals else None,
                "journals": journals,
                "removedItems": removed_items,
                "removedBytes": removed_bytes,
                "remainingItems": candidate_items - removed_items,
                "remainingBytes": candidate_bytes - removed_bytes,
                "limitReason": limit_reason
                or ("item-or-byte-budget" if removed_items < candidate_items else None),
                "seconds": round(time.monotonic() - started, 3),
                "cleanupSeconds": round(time.monotonic() - cleanup_started, 3),
            }

    def _remove_batch(self, items: list[dict], context: dict, backup_id: str) -> str:
        transaction = self.service / "maintenance" / uuid.uuid4().hex
        durable_directory(transaction)
        journal = {
            "schemaVersion": 1,
            "backupId": backup_id,
            "startedAt": datetime.now(UTC).isoformat(),
            "items": [
                {**item, "quarantine": str(transaction / str(i)), "status": "pending"}
                for i, item in enumerate(items)
            ],
            "removedBytes": 0,
        }
        journal_path = transaction / "journal.json"
        atomic_json(journal_path, journal)
        parents = set()
        for record in journal["items"]:
            source = self.service / record["path"]
            if inventory(source)["fingerprint"] != record["fingerprint"]:
                raise ValueError("cleanup target changed immediately before removal")
            source.rename(record["quarantine"])
            parents.add(source.parent)
        for parent in parents | {transaction}:
            sync_directory(parent)
        for record in journal["items"]:
            record["status"] = "detached"
        atomic_json(journal_path, journal)
        for record in journal["items"]:
            trash = Path(record["quarantine"])
            if trash.is_dir():
                shutil.rmtree(trash)
            else:
                trash.unlink()
            if record["kind"] == "release":
                source = str(self.service / record["path"])
                for name, deployment in context["records"].items():
                    if source in (deployment["candidate"], deployment["previous"]):
                        deployment["retiredRuntimePaths"] = sorted(
                            set(deployment.get("retiredRuntimePaths", [])) | {source}
                        )
                        atomic_json(self.service / "deployments" / (name + ".json"), deployment)
        sync_directory(transaction)
        for record in journal["items"]:
            record["status"] = "removed"
        journal["removedBytes"] = sum(item["bytes"] for item in items)
        atomic_json(journal_path, journal)
        return str(journal_path)
