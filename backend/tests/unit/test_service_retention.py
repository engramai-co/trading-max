from __future__ import annotations

import gzip
import hashlib
import json
import os
import sqlite3
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from trading_max.backup_repository import BackupRepository, exclusive_lock
from trading_max.infrastructure import SnapshotStore
from trading_max.service_retention import ServiceRetention, retained_dates


def host(root: Path):
    now = datetime.now(UTC)
    service = root / "service"
    (service / "releases").mkdir(parents=True)
    (service / "backups").mkdir()
    (service / "deployments").mkdir()
    releases = []
    for i in range(6):
        name = str(i) * 12 + "-aaaaaaaa"
        release = service / "releases" / name
        release.mkdir()
        (release / "runtime").write_text("synthetic runtime " * 8)
        subprocess.run(  # noqa: S603 - synthetic temporary repositories
            ["/usr/bin/git", "init", "-q", str(release)], check=True
        )
        subprocess.run(  # noqa: S603 - synthetic temporary repositories
            ["/usr/bin/git", "-C", str(release), "add", "runtime"], check=True
        )
        subprocess.run(  # noqa: S603 - synthetic temporary repositories
            [
                "/usr/bin/git",
                "-C",
                str(release),
                "-c",
                "user.name=Synthetic",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        os.utime(release, (now.timestamp() - 172800,) * 2)
        releases.append(release)
        record = {
            "candidate": str(release),
            "previous": str(releases[max(i - 1, 0)]),
            "phase": "healthy",
            "state": str(root / "state"),
        }
        (service / "deployments" / (name + ".json")).write_text(json.dumps(record))
    (service / "app").symlink_to(releases[-1])
    state = root / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as db:
        db.execute("CREATE TABLE example(value TEXT)")
    store = SnapshotStore(state)
    item = store.artifacts.put_json(key="fixture.json", payload={"ok": True})
    store.publish(scope="accounts", source="synthetic", artifacts=[item])
    backup = BackupRepository(service / "backups/repository").create(state, now=now)
    return service, releases, backup


def test_cleanup_is_bounded_and_preserves_current_rollback_and_unknown_paths(tmp_path):
    service, releases, backup = host(tmp_path)
    unknown = service / "releases/user-work"
    unknown.mkdir()
    (unknown / "important").write_text("keep")
    maintenance = ServiceRetention(service)
    plan = maintenance.plan()
    assert len(plan["items"]) == 3
    assert set(plan["protected"]) == {str(p) for p in releases[-3:]}
    result = maintenance.apply(plan, verified_backup_id=backup["id"], max_items=1)
    assert result["removedItems"] == 1
    assert all(p.exists() for p in releases[-3:])
    assert unknown.exists()
    assert (tmp_path / "state/latest.json").exists()
    journal = json.loads(Path(result["journal"]).read_text())
    assert journal["items"][0]["status"] == "removed"
    assert not Path(journal["items"][0]["quarantine"]).exists()


@pytest.mark.parametrize("change", ["deployment", "target", "corrupt-backup", "wrong-state"])
def test_changed_or_unrecoverable_inputs_stop_before_deletion(tmp_path, change):
    service, releases, backup = host(tmp_path)
    maintenance = ServiceRetention(service)
    plan = maintenance.plan()
    if change == "deployment":
        (service / "app").unlink()
        (service / "app").symlink_to(releases[-2])
    elif change == "target":
        (releases[0] / "runtime").write_text("user changes")
    elif change == "wrong-state":
        manifest = json.loads(Path(backup["manifest"]).read_text())
        manifest["sourceState"] = str(tmp_path / "other-state")
        Path(backup["manifest"]).write_text(json.dumps(manifest))
    else:
        repo = maintenance.repository
        manifest = json.loads(Path(backup["manifest"]).read_text())
        repo.blob_path(manifest["files"]["trading_max.db"]["sha256"]).write_bytes(
            gzip.compress(b"bad")
        )
    with pytest.raises(ValueError):
        maintenance.apply(plan, verified_backup_id=backup["id"])
    assert all(p.exists() for p in releases)


def test_deployment_lock_and_interrupted_recovery_are_protected(tmp_path):
    service, releases, backup = host(tmp_path)
    record = service / "deployments" / (releases[1].name + ".json")
    data = json.loads(record.read_text())
    data["phase"] = "rollback-failed"
    record.write_text(json.dumps(data))
    maintenance = ServiceRetention(service)
    with exclusive_lock(service / ".deployment.lock"), pytest.raises(RuntimeError, match="lock"):
        maintenance.plan()
    plan = maintenance.plan()
    assert str(releases[0]) in plan["protected"]
    assert str(releases[1]) in plan["protected"]
    assert len(plan["items"]) == 1
    assert (
        maintenance.apply(plan, verified_backup_id=backup["id"], max_bytes=1)["removedItems"] == 0
    )


def test_date_buckets_do_not_keep_every_deployment_on_the_same_day():
    start = datetime(2026, 9, 1, tzinfo=UTC)
    items = [(str(i), start + timedelta(minutes=i)) for i in range(50)]
    assert retained_dates(items) == {"47", "48", "49"}


def test_referenced_backup_blobs_are_never_cleanup_candidates(tmp_path):
    service, _, backup = host(tmp_path)
    maintenance = ServiceRetention(service)
    blob = maintenance.repository.blob_path("f" * 64)
    blob.parent.mkdir(exist_ok=True)
    blob.write_bytes(gzip.compress(b"unpublished"))
    os.utime(blob, (datetime.now(UTC).timestamp() - 172800,) * 2)
    plan = maintenance.plan()
    blobs = [item for item in plan["items"] if item["kind"] == "backup-blob"]
    assert [item["path"] for item in blobs] == [str(blob.relative_to(service))]
    assert not any(item["path"].endswith(backup["id"] + ".json") for item in plan["items"])


def test_nightly_maintenance_retires_only_old_unprotected_runtimes_and_orphans(tmp_path):
    service, releases, backup = host(tmp_path)
    maintenance = ServiceRetention(service)
    blob = maintenance.repository.blob_path("f" * 64)
    blob.parent.mkdir(exist_ok=True)
    blob.write_bytes(gzip.compress(b"unpublished"))
    os.utime(blob, (datetime.now(UTC).timestamp() - 172800,) * 2)
    result = maintenance.maintain_repository(backup["id"])
    assert result["removedItems"] == 4
    assert not blob.exists()
    assert not any(path.exists() for path in releases[:3])
    assert all(path.exists() for path in releases[3:])
    assert maintenance.repository.verify(backup["id"])["snapshotRunId"]


def test_interrupted_quarantine_stops_subsequent_cleanup(tmp_path):
    service, releases, backup = host(tmp_path)
    maintenance = ServiceRetention(service)
    plan = maintenance.plan()
    journal = service / "maintenance/unfinished/journal.json"
    journal.parent.mkdir(parents=True)
    journal.write_text(json.dumps({"items": [{"status": "detached"}]}))
    with pytest.raises(ValueError, match="unfinished cleanup"):
        maintenance.apply(plan, verified_backup_id=backup["id"])
    assert all(path.exists() for path in releases)


def test_nightly_keeps_linked_node_and_retires_only_old_unreferenced_verified_binary(tmp_path):
    service, releases, backup = host(tmp_path)
    pool = service / "toolchains/node-blobs"
    pool.mkdir(parents=True)
    paths = []
    for data in [b"linked runtime", b"unreferenced runtime", b"recent runtime"]:
        path = pool / hashlib.sha256(data).hexdigest()
        path.write_bytes(data)
        os.utime(path, (datetime.now(UTC).timestamp() - 172800,) * 2)
        paths.append(path)
    os.link(paths[0], releases[-1] / "node")
    os.utime(paths[2], None)
    unknown = pool / "user-work"
    unknown.write_text("keep")
    maintenance = ServiceRetention(service)
    plan = maintenance.plan()
    toolchains = [p for p in plan["items"] if p["kind"] == "toolchain"]
    assert [p["path"] for p in toolchains] == [str(paths[1].relative_to(service))]
    maintenance.maintain_repository(backup["id"])
    assert paths[0].exists() and paths[2].exists() and unknown.exists()
    assert not paths[1].exists()
