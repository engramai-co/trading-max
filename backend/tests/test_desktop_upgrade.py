"""Recovery must survive interruption without losing either state generation."""

import json
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from trading_max import __version__
from trading_max.backup_repository import BackupRepository, exclusive_lock
from trading_max.desktop_upgrade import WorkspaceUpgrade, recover_interrupted
from trading_max.desktop_workspace import MANIFEST, WorkspaceError, create_workspace
from trading_max.infrastructure import SqliteDatabase


@pytest.fixture
def older(tmp_path):
    workspace = create_workspace(tmp_path, "真实路径 空格 synthetic")
    root = Path(workspace["path"])
    manifest = json.loads((root / MANIFEST).read_text())
    manifest["app_version"] = "1.9.0"
    (root / MANIFEST).write_text(json.dumps(manifest))
    database = SqliteDatabase(root / "trading_max.db")
    database.connection.execute("CREATE TABLE recovery_test (amount INTEGER)")
    database.connection.execute("INSERT INTO recovery_test VALUES (123)")
    database.close()
    (root / "workspace-confirmation.json").write_text('{"confirmed":"synthetic"}')
    (root / "imports").mkdir()
    (root / "imports/original.csv").write_text("synthetic-original")
    (root / "logs").mkdir()
    (root / "logs/launcher.log").write_text("preserved-diagnostic")
    (root / "secrets").mkdir()
    (root / "secrets/placeholder").write_text("synthetic-not-a-credential")
    (root / "runtime.lock").touch()
    return WorkspaceUpgrade(root, tmp_path / "recovery", workspace["id"])


def amount(root):
    with closing(sqlite3.connect(root / "trading_max.db")) as connection:
        return connection.execute("SELECT amount FROM recovery_test").fetchone()[0]


def modify(upgrade):
    with closing(sqlite3.connect(upgrade.root / "trading_max.db")) as connection, connection:
        connection.execute("UPDATE recovery_test SET amount=456")
        connection.execute("CREATE TABLE new_version (value TEXT)")
    (upgrade.root / "imports/original.csv").write_text("changed-during-failed-start")
    (upgrade.root / "new-record.json").write_text('{"keep":"failed-start"}')


def test_successful_upgrade_commits_once_and_never_rewinds_later_data(older):
    before = older.prepare()
    assert before["fromVersion"] == "1.9.0"
    assert BackupRepository(older.home / "repository").verify(before["backupId"])["files"] > 0
    older.commit()
    assert json.loads((older.root / MANIFEST).read_text())["app_version"] == __version__
    modify(older)
    assert older.prepare() is None
    assert not older.rollback()
    assert amount(older.root) == 456
    assert len(list((older.home / "repository/snapshots").glob("*.json"))) == 1


def test_failed_start_restores_full_baseline_and_preserves_failed_records(older):
    lock_inode = (older.root / "runtime.lock").stat().st_ino
    older.prepare()
    modify(older)
    assert older.rollback()
    assert amount(older.root) == 123
    assert (older.root / "imports/original.csv").read_text() == "synthetic-original"
    assert (older.root / "workspace-confirmation.json").exists()
    assert not (older.root / "new-record.json").exists()
    journal = older.read()
    failed = older.home / journal["transactionId"] / "failed-start"
    assert amount(failed) == 456
    assert (failed / "new-record.json").exists()
    assert (older.root / "runtime.lock").stat().st_ino == lock_inode
    assert (older.root / "logs/launcher.log").read_text() == "preserved-diagnostic"
    assert (older.root / "secrets/placeholder").read_text() == "synthetic-not-a-credential"
    assert not (failed / "secrets").exists()
    assert not older.rollback()


@pytest.mark.parametrize("fail_phase", ["evacuating", "restoring"])
def test_interrupted_entry_move_resumes_before_manifest_inspection(older, fail_phase):
    older.prepare()
    modify(older)
    real_rename = Path.rename
    did_interrupt = False

    def interrupt(source, target):
        nonlocal did_interrupt
        result = real_rename(source, target)
        phase = older.read()["phase"]
        if phase == fail_phase and not did_interrupt:
            did_interrupt = True
            raise KeyboardInterrupt("simulated process interruption after atomic rename")
        return result

    with patch.object(Path, "rename", interrupt), pytest.raises(KeyboardInterrupt):
        older.rollback()
    assert did_interrupt
    recover_interrupted(older.root, older.home.parent)
    assert older.read()["phase"] == "rolled-back"
    assert amount(older.root) == 123
    assert (older.root / MANIFEST).is_file()


def test_interrupted_upgrade_does_not_touch_an_active_workspace(older):
    older.prepare()
    modify(older)
    with (
        exclusive_lock(older.root / "runtime.lock"),
        pytest.raises(RuntimeError, match="lock"),
    ):
        recover_interrupted(older.root, older.home.parent)
    assert amount(older.root) == 456
    recover_interrupted(older.root, older.home.parent)
    assert amount(older.root) == 123


def test_capture_failure_never_starts_a_transaction_or_changes_original(older):
    original = (older.root / MANIFEST).read_bytes()
    with (
        patch.object(BackupRepository, "create", side_effect=OSError("disk full")),
        pytest.raises(OSError, match="disk full"),
    ):
        older.prepare()
    assert older.read() is None
    assert (older.root / MANIFEST).read_bytes() == original
    assert amount(older.root) == 123


def test_backup_time_budget_stops_before_startup(older):
    with (
        patch("trading_max.desktop_upgrade.time.monotonic", side_effect=[0, 301]),
        pytest.raises(TimeoutError, match="5 分钟"),
    ):
        older.prepare()
    assert older.read() is None
    assert amount(older.root) == 123


def test_corrupt_backup_leaves_live_state_untouched(older):
    before = older.prepare()
    modify(older)
    repository = BackupRepository(older.home / "repository")
    manifest = repository.read_manifest(before["backupId"])
    repository.blob_path(manifest["files"]["trading_max.db"]["sha256"]).write_bytes(b"bad")
    with pytest.raises((OSError, ValueError)):
        older.rollback()
    assert amount(older.root) == 456
    assert older.read()["phase"] == "prepared"


@pytest.mark.parametrize("name", ["../outside", "/outside", "secrets", "runtime.lock"])
def test_tampered_journal_never_escapes_workspace(older, name):
    older.prepare()
    value = older.read()
    value["entries"] = [name]
    older.journal.write_text(json.dumps(value))
    with pytest.raises(WorkspaceError):
        older.rollback()
    assert amount(older.root) == 123


def test_completed_workspace_can_move_without_reviving_old_transaction(older):
    older.prepare()
    older.commit()
    new_root = older.root.with_name("moved")
    older.root.rename(new_root)
    moved = WorkspaceUpgrade(new_root, older.home.parent, older.workspace_id)
    assert moved.prepare() is None
    assert amount(new_root) == 123


def test_new_empty_workspace_needs_no_database_backup(tmp_path):
    workspace = create_workspace(tmp_path, "empty")
    upgrade = WorkspaceUpgrade(Path(workspace["path"]), tmp_path / "recovery", workspace["id"])
    assert upgrade.prepare() is None
    assert not (upgrade.home / "repository").exists()


def test_failed_sql_migration_restores_original_schema(older, tmp_path):
    older.prepare()
    migrations = tmp_path / "failed-migrations"
    migrations.mkdir()
    (migrations / "9999_failure.sql").write_text(
        "CREATE TABLE halfway (value TEXT); INSERT INTO missing_table VALUES (1);"
    )
    with pytest.raises(sqlite3.OperationalError):
        SqliteDatabase(older.root / "trading_max.db", migrations_dir=migrations)
    assert older.rollback()
    with closing(sqlite3.connect(older.root / "trading_max.db")) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master")}
    assert "halfway" not in tables
    assert amount(older.root) == 123


def test_no_space_for_restore_does_not_move_current_data(older):
    older.prepare()
    modify(older)
    with (
        patch("trading_max.desktop_upgrade.shutil.disk_usage") as disk,
        pytest.raises(WorkspaceError, match="空间不足"),
    ):
        disk.return_value.free = 0
        older.rollback()
    assert amount(older.root) == 456
    assert older.read()["phase"] == "prepared"


def test_crash_between_manifest_and_commit_restores_old_version(older):
    older.prepare()
    original_save = older.save

    def crash(value, phase):
        if phase == "committed":
            raise KeyboardInterrupt("simulated crash before commit journal")
        return original_save(value, phase)

    with patch.object(older, "save", crash), pytest.raises(KeyboardInterrupt):
        older.commit()
    assert json.loads((older.root / MANIFEST).read_text())["app_version"] == __version__
    recover_interrupted(older.root, older.home.parent)
    assert json.loads((older.root / MANIFEST).read_text())["app_version"] == "1.9.0"


def test_replaced_workspace_identity_cannot_receive_an_old_rollback(older):
    older.prepare()
    manifest = json.loads((older.root / MANIFEST).read_text())
    manifest["id"] = str(uuid.uuid4())
    (older.root / MANIFEST).write_text(json.dumps(manifest))
    with pytest.raises(WorkspaceError, match="另一工作区"):
        recover_interrupted(older.root, older.home.parent)
    assert json.loads((older.root / MANIFEST).read_text())["id"] == manifest["id"]


@pytest.mark.parametrize("recovering", [False, True])
def test_cross_volume_recovery_stops_before_migration_or_moves(older, recovering):
    if recovering:
        older.prepare()
        modify(older)
    original_stat = Path.stat

    def different_volume(path, *args, **kwargs):
        result = original_stat(path, *args, **kwargs)
        return SimpleNamespace(st_dev=result.st_dev + 1) if path == older.home else result

    with (
        patch.object(Path, "stat", different_volume),
        pytest.raises(WorkspaceError, match="同一磁盘卷"),
    ):
        older.rollback() if recovering else older.prepare()
    assert amount(older.root) == (456 if recovering else 123)
    if recovering:
        assert older.read()["phase"] == "prepared"
    else:
        assert older.read() is None
        assert not (older.home / "repository").exists()
