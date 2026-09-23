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
from .desktop_workspace import MANIFEST, WorkspaceError, _version, read_manifest
from .infrastructure.history_chunks import sync_directory

_PRESERVE = {"runtime.lock", "runtime-status.json", "logs", "secrets"}
_TERMINAL = {"committed", "rolled-back"}


def recover_interrupted(root: Path, recovery: Path) -> None:
    """Recover before compatibility inspection, including a moved manifest."""
    if not recovery.exists():
        return
    if recovery.is_symlink() or not root.is_dir() or root.is_symlink():
        raise WorkspaceError("工作区或恢复目录无法识别。")
    matches = []
    for folder in recovery.iterdir():
        try:
            uuid.UUID(folder.name)
        except ValueError:
            continue
        journal = folder / "transaction.json"
        if folder.is_symlink() or journal.is_symlink():
            raise WorkspaceError("恢复记录不能是符号链接。")
        if not journal.is_file() or journal.stat().st_size > 65536:
            continue
        value = json.loads(journal.read_text())
        if isinstance(value, dict) and value.get("root") == str(root.absolute()):
            matches.append(folder.name)
    if len(matches) > 1:
        raise WorkspaceError("这个目录有多个工作区恢复记录，未自动覆盖资料。")
    if matches:
        upgrade = WorkspaceUpgrade(root, recovery, matches[0])
        value = upgrade.read()
        if value and value["phase"] not in _TERMINAL:
            with exclusive_lock(root / "runtime.lock"):
                upgrade.rollback()


class WorkspaceUpgrade:
    def __init__(self, root: Path, recovery: Path, workspace_id: str, *, progress=None):
        self.root = root.absolute()
        self.workspace_id = str(uuid.UUID(workspace_id))
        if self.workspace_id != workspace_id:
            raise WorkspaceError("工作区标识无法识别。")
        if not recovery.is_absolute() or recovery.resolve() != recovery or recovery.is_symlink():
            raise WorkspaceError("恢复目录必须是独立的本机目录。")
        self.home = recovery / self.workspace_id
        if self.home == self.root or self.home.is_relative_to(self.root):
            raise WorkspaceError("恢复目录不能位于工作区内。")
        for path in (recovery, self.home):
            if path.exists() and (path.is_symlink() or not path.is_dir()):
                raise WorkspaceError("恢复目录不可用；原有资料未修改。")
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.journal = self.home / "transaction.json"
        self.progress = progress

    def read(self) -> dict | None:
        if not self.journal.exists():
            return None
        if self.journal.is_symlink() or self.journal.stat().st_size > 65536:
            raise WorkspaceError("恢复记录无法识别；未覆盖资料。")
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
            raise WorkspaceError("恢复记录与工作区不匹配；未覆盖资料。")
        if str(uuid.UUID(value["transactionId"])) != value["transactionId"]:
            raise WorkspaceError("恢复事务标识无法识别。")
        for name in value.get("entries", []):
            if not isinstance(name, str) or Path(name).name != name or name in {".", "..", ""}:
                raise WorkspaceError("恢复记录包含不安全的路径。")
            if name in _PRESERVE:
                raise WorkspaceError("恢复记录不能替换凭据或进程锁。")
        return value

    def save(self, value: dict, phase: str) -> None:
        value["phase"] = phase
        atomic_json(self.journal, value)

    def check_recovery_volume(self) -> None:
        # Recovery uses atomic entry renames. Refuse an unsupported cross-volume
        # upgrade before migrations, rather than discovering EXDEV on rollback.
        if self.root.stat().st_dev != self.home.stat().st_dev:
            raise WorkspaceError("工作区与恢复目录需要位于同一磁盘卷；本次操作未修改资料。")

    def prepare(self) -> dict | None:
        """Recover an interrupted attempt first; capture before starting services."""
        previous = self.read()
        if previous and previous["phase"] not in _TERMINAL:
            self.rollback()
        manifest = read_manifest(self.root)
        if manifest["id"] != self.workspace_id:
            raise WorkspaceError("工作区标识已变化；未启动服务。")
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
                raise TimeoutError("升级备份超过 5 分钟；原有资料未修改，请稍后重试。")

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
            raise WorkspaceError("恢复尚未完成，不能确认升级。")
        manifest = read_manifest(self.root)
        if manifest["id"] != self.workspace_id or value["toVersion"] != __version__:
            raise WorkspaceError("升级版本或工作区已变化。")
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
            raise WorkspaceError("工作区标记不能是符号链接；未恢复资料。")
        if current_manifest.exists():
            if current_manifest.stat().st_size > 8192:
                raise WorkspaceError("工作区标记无法识别；未恢复资料。")
            identity = json.loads(current_manifest.read_text())
            if not isinstance(identity, dict) or identity.get("id") != self.workspace_id:
                raise WorkspaceError("这个目录已变成另一工作区；未恢复或覆盖资料。")
        elif value["phase"] == "prepared":
            raise WorkspaceError("原工作区标记已丢失；未自动覆盖资料。")
        transaction = self.home / value["transactionId"]
        if transaction.is_symlink():
            raise WorkspaceError("恢复事务目录无法识别。")
        transaction.mkdir(mode=0o700, exist_ok=True)
        restored = transaction / "restored"
        failed = transaction / "failed-start"
        for path in (restored, failed):
            if path.is_symlink():
                raise WorkspaceError("恢复事务目录包含符号链接。")
        if value["phase"] == "prepared":
            # A killed verify/restore leaves only disposable staging. Verify the
            # whole recovery point again before any live entry is moved.
            if restored.exists():
                shutil.rmtree(restored)
            repository = BackupRepository(self.home / "repository")
            required = repository.read_manifest(value["backupId"])["verification"]["logicalBytes"]
            if shutil.disk_usage(self.home).free < required + 64 * 1024**2:
                raise WorkspaceError("磁盘空间不足以验证恢复副本；现有资料未移动。")
            repository.restore(value["backupId"], restored)
            old_manifest = json.loads((restored / MANIFEST).read_text())
            if old_manifest.get("id") != self.workspace_id:
                raise WorkspaceError("备份工作区标识不匹配；未覆盖资料。")
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
                        raise WorkspaceError("恢复目录出现冲突；已保留两份资料。")
                    source.rename(target)
                    sync_directory(self.root)
                    sync_directory(failed)
                elif not target.exists():
                    raise WorkspaceError("恢复中缺少待保留资料；未继续覆盖。")
            self.save(value, "restoring")
        if value["phase"] == "restoring":
            for source in sorted(restored.iterdir()):
                if source.name in _PRESERVE:
                    continue
                target = self.root / source.name
                if target.exists() or target.is_symlink():
                    raise WorkspaceError("原目录出现新资料；未覆盖这些文件。")
                source.rename(target)
                sync_directory(restored)
                sync_directory(self.root)
            self.save(value, "rolled-back")
            # Baseline is now restored. Remove only unused staging/lock copies;
            # retain failed-start files and the verified recovery point.
            shutil.rmtree(restored)
        return True
