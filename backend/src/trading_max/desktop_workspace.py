"""Explicit desktop workspace identity; inspect before opening any application database."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path

from trading_max import __version__

MANIFEST = "trading-max-workspace.json"
FORMAT = "trading-max-local-workspace"


class WorkspaceError(ValueError):
    """A selected directory cannot safely be used as a desktop workspace."""


def _text(zh: str, en: str) -> str:
    """Workspace errors reach the desktop App in the language it is set to."""
    return en if os.environ.get("TRADING_MAX_APP_LANGUAGE") == "en" else zh


def _version(value: str) -> tuple[int, ...]:
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise WorkspaceError(
            _text(
                "工作区版本无法识别，原有数据未修改。",
                "The workspace version is not recognised. Existing data was not changed.",
            )
        )
    return tuple(map(int, value.split(".")))


def read_manifest(root: Path) -> dict:
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise WorkspaceError(
            _text(
                "请选择这台 Mac 上的工作区文件夹，不能使用符号链接。",
                "Choose a workspace folder on this Mac, not a symbolic link.",
            )
        )
    manifest = root / MANIFEST
    if not manifest.is_file() or manifest.is_symlink() or manifest.stat().st_size > 8192:
        raise WorkspaceError(
            _text(
                "这个文件夹不是桌面工作区。旧版源码数据请继续使用原来的部署方式。",
                "This folder is not a desktop workspace. Keep using the original deployment for source-install data.",
            )
        )
    try:
        value = json.loads(manifest.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("format") != FORMAT or value.get("schema") != 1:
            raise ValueError
        uuid.UUID(value["id"])
        if str(uuid.UUID(value["id"])) != value["id"]:
            raise ValueError
        if not isinstance(value["name"], str) or not 1 <= len(value["name"].strip()) <= 60:
            raise ValueError
        if _version(value["app_version"]) > _version(__version__):
            raise WorkspaceError(
                _text(
                    "工作区来自较新的 App，请更新 App 后打开；未降级或迁移数据。",
                    "This workspace comes from a newer app. Update the app to open it; no data was downgraded or migrated.",
                )
            )
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, WorkspaceError):
            raise
        raise WorkspaceError(
            _text(
                "工作区标记损坏，原有数据未修改。",
                "The workspace marker is damaged. Existing data was not changed.",
            )
        ) from exc
    if (root / "DESKTOP_PREVIEW_ONLY").exists() or (root / ".seeded-v1").exists():
        raise WorkspaceError(
            _text(
                "演示数据不能作为真实账户工作区。",
                "Demo data cannot be used as a real account workspace.",
            )
        )
    return value


def inspect_workspace(root: Path) -> dict:
    value = read_manifest(root)
    # All writable state stays within the selected directory. Do not follow a
    # transplanted state/log/database symlink into another installation.
    for current, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            if (Path(current) / name).is_symlink():
                raise WorkspaceError(
                    _text(
                        "工作区包含符号链接，请使用独立的本地数据目录。",
                        "The workspace contains symbolic links. Use a separate local data folder.",
                    )
                )
    database = root / "trading_max.db"
    if database.exists():
        # Read-only compatibility check: no WAL activation, migration or table writes.
        try:
            with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as connection:
                versions = {
                    row[0] for row in connection.execute("SELECT version FROM schema_migrations")
                }
            supported = {
                path.name
                for path in (Path(__file__).resolve().parents[2] / "migrations").glob("*.sql")
            }
            if versions - supported:
                raise WorkspaceError(
                    _text(
                        "数据库来自较新的版本，请更新 App 后打开。",
                        "The database comes from a newer version. Update the app to open it.",
                    )
                )
        except sqlite3.Error as exc:
            raise WorkspaceError(
                _text(
                    "工作区数据库无法读取，请先恢复备份；未修改数据。",
                    "The workspace database cannot be read. Restore a backup first; no data was changed.",
                )
            ) from exc
    return {"path": str(root.resolve()), "id": value["id"], "name": value["name"]}


def create_workspace(parent: Path, name: str) -> dict:
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise WorkspaceError(
            _text(
                "工作区名称不能包含控制字符。", "Workspace names cannot contain control characters."
            )
        )
    name = name.strip()
    if (
        not 1 <= len(name) <= 60
        or name in {".", ".."}
        or any(ord(c) < 32 or c in "/\\:" for c in name)
    ):
        raise WorkspaceError(
            _text(
                "请使用 1–60 字的工作区名称，不要包含斜杠、冒号或控制字符。",
                "Use a workspace name of 1–60 characters without slashes, colons or control characters.",
            )
        )
    if not parent.is_absolute() or not parent.is_dir():
        raise WorkspaceError(
            _text("请选择这台 Mac 上已有的文件夹。", "Choose an existing folder on this Mac.")
        )
    parent = parent.resolve()
    # Never nest state under another workspace or a checkout/application bundle.
    for ancestor in (parent, *parent.parents):
        if (
            (ancestor / MANIFEST).exists()
            or (ancestor / "DESKTOP_PREVIEW_ONLY").exists()
            or (ancestor / ".git").exists()
            or ancestor.suffix == ".app"
        ):
            raise WorkspaceError(
                _text(
                    "请在工作区、代码仓库和 App 之外选择保存位置。",
                    "Choose a save location outside workspaces, code repositories and the app.",
                )
            )
    root = parent / name
    try:
        root.mkdir(mode=0o700)  # Atomic no-overwrite, including an empty existing directory.
    except FileExistsError as exc:
        raise WorkspaceError(
            _text(
                "同名文件夹已存在，请换一个名称，或选择「打开已有工作区」。",
                "A folder with this name already exists. Choose another name, or choose Open an existing workspace.",
            )
        ) from exc
    value = {
        "format": FORMAT,
        "schema": 1,
        "id": str(uuid.uuid4()),
        "name": name,
        "app_version": __version__,
        "created_at": datetime.now(UTC).isoformat(),
    }
    try:
        with (root / MANIFEST).open("x", encoding="utf-8") as output:
            (root / MANIFEST).chmod(0o600)
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        # Only the directory exclusively created above belongs to this attempt.
        (root / MANIFEST).unlink(missing_ok=True)
        root.rmdir()
        raise
    return {"path": str(root), "id": value["id"], "name": name}
