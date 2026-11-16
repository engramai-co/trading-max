"""Verified recovery around the first startup of a newer desktop runtime.

The caller holds runtime.lock and stops every owned child before rollback.
Never replace the workspace directory or its lock inode during recovery.
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path

from . import __version__
from .backup_repository import BackupRepository, atomic_json, exclusive_lock
from .desktop_workspace import MANIFEST, WorkspaceError, _text, _version, read_manifest
from .infrastructure.history_chunks import sync_directory

_PRESERVE = {"runtime.lock", "runtime-status.json", "logs", "secrets"}
_TERMINAL = {"committed", "rolled-back"}


def recover_interrupted(root: Path, recovery: Path) -> None:
    """Recover before compatibility inspection, including a moved manifest."""
    if not recovery.exists():
        return
    if recovery.is_symlink() or not root.is_dir() or root.is_symlink():
        raise WorkspaceError(
            _text(
                "工作区或恢复目录无法识别。", "The workspace or recovery folder is not recognised."
            )
        )
    matches = []
    for folder in recovery.iterdir():
        try:
            uuid.UUID(folder.name)
        except ValueError:
            continue
        journal = folder / "transaction.json"
        if folder.is_symlink() or journal.is_symlink():
            raise WorkspaceError(
                _text("恢复记录不能是符号链接。", "The recovery record cannot be a symbolic link.")
            )
        if not journal.is_file() or journal.stat().st_size > 65536:
            continue
        value = json.loads(journal.read_text())
        if isinstance(value, dict) and value.get("root") == str(root.absolute()):
            matches.append(folder.name)
    if len(matches) > 1:
        raise WorkspaceError(
            _text(
                "这个目录有多个工作区恢复记录，未自动覆盖数据。",
                "This folder has several workspace recovery records. No data was overwritten.",
            )
        )
    if matches:
        upgrade = WorkspaceUpgrade(root, recovery, matches[0])
        value = upgrade.read()
        if value and value["phase"] not in _TERMINAL:
            # A folder removed after the initial check must not be recreated.
            with exclusive_lock(root / "runtime.lock", create_parent=False):
                upgrade.rollback()


class WorkspaceUpgrade:
    def __init__(self, root: Path, recovery: Path, workspace_id: str, *, progress=None):
        self.root = root.absolute()
        self.workspace_id = str(uuid.UUID(workspace_id))
        if self.workspace_id != workspace_id:
            raise WorkspaceError(
                _text("工作区标识无法识别。", "The workspace identifier is not recognised.")
            )
        if not recovery.is_absolute() or recovery.resolve() != recovery or recovery.is_symlink():
            raise WorkspaceError(
                _text(
                    "恢复目录必须是独立的本地目录。",
                    "The recovery folder must be a separate local folder.",
                )
            )
        self.home = recovery / self.workspace_id
        if self.home == self.root or self.home.is_relative_to(self.root):
            raise WorkspaceError(
                _text(
                    "恢复目录不能位于工作区内。",
                    "The recovery folder cannot be inside the workspace.",
                )
            )
        for path in (recovery, self.home):
            if path.exists() and (path.is_symlink() or not path.is_dir()):
                raise WorkspaceError(
                    _text(
                        "恢复目录不可用；原有数据未修改。",
                        "The recovery folder is unavailable. Existing data was not changed.",
                    )
                )
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.journal = self.home / "transaction.json"
        self.progress = progress

    def read(self) -> dict | None:
        if not self.journal.exists():
            return None
        if self.journal.is_symlink() or self.journal.stat().st_size > 65536:
            raise WorkspaceError(
                _text(
                    "恢复记录无法识别；未覆盖数据。",
                    "The recovery record is not recognised. No data was overwritten.",
                )
            )
        value = json.loads(self.journal.read_text())
        if (
            isinstance(value, dict)
            and value.get("workspaceId") == self.workspace_id
            and value.get("phase") in _TERMINAL
            and value.get("root") != str(self.root)
        ):
            return None  # A completed workspace can be moved to another folder.
        if (
            not isinstance(value, dict)
            or value.get("schema") != 1
            or value.get("workspaceId") != self.workspace_id
            or value.get("root") != str(self.root)
            or value.get("phase") not in _TERMINAL | {"prepared", "evacuating", "restoring"}
        ):
            raise WorkspaceError(
                _text(
                    "恢复记录与工作区不匹配；未覆盖数据。",
                    "The recovery record does not match the workspace. No data was overwritten.",
                )
            )
        if str(uuid.UUID(value["transactionId"])) != value["transactionId"]:
            raise WorkspaceError(
                _text(
                    "恢复事务标识无法识别。",
                    "The recovery transaction identifier is not recognised.",
                )
            )
        for name in value.get("entries", []):
            if not isinstance(name, str) or Path(name).name != name or name in {".", "..", ""}:
                raise WorkspaceError(
                    _text(
                        "恢复记录包含不安全的路径。", "The recovery record contains an unsafe path."
                    )
                )
            if name in _PRESERVE:
                raise WorkspaceError(
                    _text(
                        "恢复记录不能替换凭据或进程锁。",
                        "The recovery record cannot replace credentials or the process lock.",
                    )
                )
        return value

    def save(self, value: dict, phase: str) -> None:
        value["phase"] = phase
        atomic_json(self.journal, value)

    def check_recovery_volume(self) -> None:
        # Recovery uses atomic entry renames. Refuse an unsupported cross-volume
        # upgrade before migrations, rather than discovering EXDEV on rollback.
        if self.root.stat().st_dev != self.home.stat().st_dev:
            raise WorkspaceError(
                _text(
                    "工作区与恢复目录需要位于同一磁盘卷；本次操作未修改数据。",
                    "The workspace and recovery folder must be on the same volume. No data was changed.",
                )
            )

    def prepare(self) -> dict | None:
        """Recover an interrupted attempt first; capture before starting services."""
        previous = self.read()
        if previous and previous["phase"] not in _TERMINAL:
            self.rollback()
        manifest = read_manifest(self.root)
        if manifest["id"] != self.workspace_id:
            raise WorkspaceError(
                _text(
                    "工作区标识已变化；未启动服务。",
                    "The workspace identifier changed. The service was not started.",
                )
            )
        if _version(manifest["app_version"]) == _version(__version__):
            return None
        # No database exists until the first API startup. This empty folder has
        # nothing to migrate and the identity remains unchanged on failure.
        if not (self.root / "trading_max.db").exists():
            return None
        self.check_recovery_volume()
        deadline = time.monotonic() + 300

        def report(value):
            if self.progress:
                self.progress(value)
            if time.monotonic() > deadline:
                raise TimeoutError(
                    _text(
                        "升级备份超过 5 分钟；原有数据未修改，请稍后重试。",
                        "The upgrade backup took more than 5 minutes. Existing data was not changed; try again later.",
                    )
                )

        repository = BackupRepository(self.home / "repository", progress=report)
        result = repository.create(self.root, label=f"desktop-before-{__version__}")
        value = {
            "schema": 1,
            "workspaceId": self.workspace_id,
            "root": str(self.root),
            "transactionId": str(uuid.uuid4()),
            "fromVersion": manifest["app_version"],
            "toVersion": __version__,
            "backupId": result["id"],
            "snapshotRunId": result["snapshotRunId"],
        }
        self.save(value, "prepared")
        return value

    def commit(self) -> None:
        value = self.read()
        if not value or value["phase"] in _TERMINAL:
            return
        if value["phase"] != "prepared":
            raise WorkspaceError(
                _text(
                    "恢复尚未完成，不能确认升级。",
                    "Recovery has not finished, so the upgrade cannot be confirmed.",
                )
            )
        manifest = read_manifest(self.root)
        if manifest["id"] != self.workspace_id or value["toVersion"] != __version__:
            raise WorkspaceError(
                _text("升级版本或工作区已变化。", "The upgrade version or workspace changed.")
            )
        manifest["app_version"] = __version__
        atomic_json(self.root / MANIFEST, manifest)
        self.save(value, "committed")

    def rollback(self) -> bool:
        value = self.read()
        if not value or value["phase"] in _TERMINAL:
            return False
        self.check_recovery_volume()
        current_manifest = self.root / MANIFEST
        if current_manifest.is_symlink():
            raise WorkspaceError(
                _text(
                    "工作区标记不能是符号链接；未恢复数据。",
                    "The workspace marker cannot be a symbolic link. No data was restored.",
                )
            )
        if current_manifest.exists():
            if current_manifest.stat().st_size > 8192:
                raise WorkspaceError(
                    _text(
                        "工作区标记无法识别；未恢复数据。",
                        "The workspace marker is not recognised. No data was restored.",
                    )
                )
            identity = json.loads(current_manifest.read_text())
            if not isinstance(identity, dict) or identity.get("id") != self.workspace_id:
                raise WorkspaceError(
                    _text(
                        "这个目录已变成另一工作区；未恢复或覆盖数据。",
                        "This folder is now another workspace. No data was restored or overwritten.",
                    )
                )
        elif value["phase"] == "prepared":
            raise WorkspaceError(
                _text(
                    "原工作区标记已丢失；未自动覆盖数据。",
                    "The original workspace marker is missing. No data was overwritten.",
                )
            )
        transaction = self.home / value["transactionId"]
        if transaction.is_symlink():
            raise WorkspaceError(
                _text(
                    "恢复事务目录无法识别。", "The recovery transaction folder is not recognised."
                )
            )
        transaction.mkdir(mode=0o700, exist_ok=True)
        restored = transaction / "restored"
        failed = transaction / "failed-start"
        for path in (restored, failed):
            if path.is_symlink():
                raise WorkspaceError(
                    _text(
                        "恢复事务目录包含符号链接。",
                        "The recovery transaction folder contains symbolic links.",
                    )
                )
        if value["phase"] == "prepared":
            # A killed verify/restore leaves only disposable staging. Verify the
            # whole recovery point again before any live entry is moved.
            if restored.exists():
                shutil.rmtree(restored)
            repository = BackupRepository(self.home / "repository")
            required = repository.read_manifest(value["backupId"])["verification"]["logicalBytes"]
            if shutil.disk_usage(self.home).free < required + 64 * 1024**2:
                raise WorkspaceError(
                    _text(
                        "磁盘空间不足以验证恢复副本；现有数据未移动。",
                        "There is not enough disk space to verify the recovery copy. Existing data was not moved.",
                    )
                )
            repository.restore(value["backupId"], restored)
            old_manifest = json.loads((restored / MANIFEST).read_text())
            if old_manifest.get("id") != self.workspace_id:
                raise WorkspaceError(
                    _text(
                        "备份工作区标识不匹配；未覆盖数据。",
                        "The backup’s workspace identifier does not match. No data was overwritten.",
                    )
                )
            failed.mkdir(mode=0o700, exist_ok=True)
            value["entries"] = sorted(
                p.name for p in self.root.iterdir() if p.name not in _PRESERVE
            )
            self.save(value, "evacuating")
        if value["phase"] == "evacuating":
            for name in value["entries"]:
                source, target = self.root / name, failed / name
                if source.exists() or source.is_symlink():
                    if target.exists() or target.is_symlink():
                        raise WorkspaceError(
                            _text(
                                "恢复目录出现冲突；已保留两份数据。",
                                "The recovery folder has a conflict. Both copies of the data were kept.",
                            )
                        )
                    source.rename(target)
                    sync_directory(self.root)
                    sync_directory(failed)
                elif not target.exists():
                    raise WorkspaceError(
                        _text(
                            "恢复中缺少待保留数据；未继续覆盖。",
                            "Data to keep is missing from the recovery. Overwriting stopped.",
                        )
                    )
            self.save(value, "restoring")
        if value["phase"] == "restoring":
            for source in sorted(restored.iterdir()):
                if source.name in _PRESERVE:
                    continue
                target = self.root / source.name
                if target.exists() or target.is_symlink():
                    raise WorkspaceError(
                        _text(
                            "原目录出现新数据；未覆盖这些文件。",
                            "New data appeared in the original folder. Those files were not overwritten.",
                        )
                    )
                source.rename(target)
                sync_directory(restored)
                sync_directory(self.root)
            self.save(value, "rolled-back")
            # Baseline is now restored. Remove only unused staging/lock copies;
            # retain failed-start files and the verified recovery point.
            shutil.rmtree(restored)
        return True
