"""Desktop folders must never adopt another installation's state implicitly."""

import json
import sqlite3
from pathlib import Path

import pytest
from trading_max.desktop_workspace import (
    MANIFEST,
    WorkspaceError,
    create_workspace,
    inspect_workspace,
)


def test_create_and_reopen_preserve_identity(tmp_path):
    workspace = create_workspace(tmp_path, "我的投资记录 with spaces")
    root = Path(workspace["path"])
    original = (root / MANIFEST).read_bytes()
    assert inspect_workspace(root) == workspace
    assert (root / MANIFEST).read_bytes() == original
    assert root.stat().st_mode & 0o777 == 0o700
    assert (root / MANIFEST).stat().st_mode & 0o777 == 0o600
    assert list(root.iterdir()) == [root / MANIFEST]
    with pytest.raises(WorkspaceError, match="已存在"):
        create_workspace(tmp_path, root.name)


@pytest.mark.parametrize("name", ["../oops", "nested/folder", "..", "", "x:y", "a\n"])
def test_bad_names_do_not_create_directories(tmp_path, name):
    with pytest.raises(WorkspaceError):
        create_workspace(tmp_path, name)
    assert not list(tmp_path.iterdir())


def test_unknown_future_demo_and_symlink_workspaces_are_rejected(tmp_path):
    with pytest.raises(WorkspaceError, match="不是桌面工作区"):
        inspect_workspace(tmp_path)
    value = create_workspace(tmp_path, "valid")
    root = Path(value["path"])
    original = (root / MANIFEST).read_text()
    data = json.loads(original)
    data["app_version"] = "999.0.0"
    (root / MANIFEST).write_text(json.dumps(data))
    with pytest.raises(WorkspaceError, match="较新"):
        inspect_workspace(root)
    (root / MANIFEST).write_text(original)
    (root / "DESKTOP_PREVIEW_ONLY").touch()
    with pytest.raises(WorkspaceError, match="演示"):
        inspect_workspace(root)
    (root / "DESKTOP_PREVIEW_ONLY").unlink()
    (root / "foreign-data").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(WorkspaceError, match="符号链接"):
        inspect_workspace(root)


def test_newer_database_is_rejected_without_migration(tmp_path):
    value = create_workspace(tmp_path, "database")
    root = Path(value["path"])
    with sqlite3.connect(root / "trading_max.db") as database:
        database.execute("CREATE TABLE schema_migrations (version TEXT)")
        database.execute("INSERT INTO schema_migrations VALUES ('999_future.sql')")
    before = (root / "trading_max.db").read_bytes()
    with pytest.raises(WorkspaceError, match="数据库来自较新"):
        inspect_workspace(root)
    assert (root / "trading_max.db").read_bytes() == before


def test_cannot_nest_in_workspace_or_checkout(tmp_path):
    value = create_workspace(tmp_path, "parent")
    with pytest.raises(WorkspaceError):
        create_workspace(Path(value["path"]), "nested")
    checkout = tmp_path / "source"
    checkout.mkdir()
    (checkout / ".git").touch()
    with pytest.raises(WorkspaceError):
        create_workspace(checkout, "data")
