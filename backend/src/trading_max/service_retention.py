"""Plan and bound cleanup of operator-owned releases and recovery copies.

Never touches live application state. Unknown paths are not cleanup candidates.
Plans are invalidated by deployment changes and targets are re-inventoried before
an atomic rename into a private cleanup journal, followed by physical removal.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .backup_repository import BackupRepository, atomic_json, exclusive_lock

_RELEASE = re.compile(r"(?:previous-)?[0-9a-f]{12}-[a-z0-9_]{8}")
_ARCHIVE = re.compile(r"trading_max-\d{8}T\d{6}Z\.tar\.gz")
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
        digest.update(
            json.dumps(
                [
                    str(item.relative_to(path)),
                    info.st_dev,
                    info.st_ino,
                    info.st_mode,
                    info.st_size,
                    info.st_mtime_ns,
                    info.st_ctime_ns,
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
            if path != self.repository.manifest_path(path.stem):
                raise ValueError("invalid backup manifest location")
            manifest = json.loads(path.read_text())
            if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), dict):
                raise ValueError("unrecognized backup manifest; cleanup stopped")
            manifests[path.stem] = manifest
        keep_backups = retained_dates(
            [(name, datetime.fromisoformat(data["createdAt"])) for name, data in manifests.items()]
        ) | set(context["protectedBackupIds"])
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
        for digest in referenced_digests:
            referenced.update(self.repository.blob_files(digest))
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
            if not re.fullmatch(
                r"[0-9a-f]{64}\.json|(?:history|json)-chunks/[0-9a-f]{2}/[0-9a-f]{64}\.gz",
                relative,
            ):
                raise ValueError("unknown packed backup file")
            if path not in referenced and path.stat().st_mtime < self.cutoff:
                candidates.append(("backup-blob", path))
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
            if item["kind"] in {"backup-manifest", "backup-blob", "release"}
        ]
        plan["candidateBytes"] = sum(item["bytes"] for item in plan["items"])
        plan_path = self.service / "maintenance-plans" / (verified_backup_id + ".json")
        if plan_path.parent.is_symlink():
            raise ValueError("maintenance plan directory must not be a symlink")
        atomic_json(plan_path, plan)
        if not plan["items"]:
            return {"plan": str(plan_path), "removedItems": 0, "removedBytes": 0}
        result = self.apply(
            plan, verified_backup_id=verified_backup_id, max_items=64, max_bytes=2_000_000_000
        )
        return {"plan": str(plan_path), **result}

    def apply(
        self,
        plan: dict,
        *,
        verified_backup_id: str,
        max_items: int = 2,
        max_bytes: int = 5_000_000_000,
    ) -> dict:
        if max_items < 1 or max_bytes < 1:
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
            backup = json.loads(backup_path.read_text())
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
            total = 0
            for item in plan["items"]:
                if (item["kind"], item["path"]) not in eligible:
                    raise ValueError("cleanup target is no longer eligible")
                if item["path"] == str(backup_path.relative_to(self.service)):
                    continue
                if len(selected) >= max_items or total + item["bytes"] > max_bytes:
                    continue
                if any(previous["path"] == item["path"] for previous in selected):
                    raise ValueError("duplicate cleanup target")
                actual = inventory(self.service / item["path"])
                if any(actual[key] != item[key] for key in actual):
                    raise ValueError("cleanup target changed; generate a new plan")
                selected.append(item)
                total += item["bytes"]
            transaction = self.service / "maintenance" / uuid.uuid4().hex
            transaction.mkdir(parents=True, mode=0o700)
            journal = {
                "schemaVersion": 1,
                "backupId": verified_backup_id,
                "startedAt": self.now.isoformat(),
                "items": [],
                "removedBytes": 0,
            }
            journal_path = transaction / "journal.json"
            atomic_json(journal_path, journal)
            for index, item in enumerate(selected):
                source = self.service / item["path"]
                trash = transaction / str(index)
                record = {**item, "quarantine": str(trash), "status": "pending"}
                journal["items"].append(record)
                atomic_json(journal_path, journal)
                if inventory(source)["fingerprint"] != item["fingerprint"]:
                    raise ValueError("cleanup target changed immediately before removal")
                source.rename(trash)
                record["status"] = "detached"
                atomic_json(journal_path, journal)
                if trash.is_dir():
                    shutil.rmtree(trash)
                else:
                    trash.unlink()
                record["status"] = "removed"
                if item["kind"] == "release":
                    for name, deployment in context["records"].items():
                        if str(source) in (deployment["candidate"], deployment["previous"]):
                            deployment["retiredRuntimePaths"] = sorted(
                                set(deployment.get("retiredRuntimePaths", [])) | {str(source)}
                            )
                            atomic_json(self.service / "deployments" / (name + ".json"), deployment)
                journal["removedBytes"] += item["bytes"]
                atomic_json(journal_path, journal)
            return {
                "journal": str(journal_path),
                "removedItems": len(selected),
                "removedBytes": journal["removedBytes"],
            }
