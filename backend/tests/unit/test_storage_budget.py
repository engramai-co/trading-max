import json
import os
from datetime import UTC, datetime, timedelta

from trading_max.storage_budget import bound_filing_cache, usage, write_budget_report


def test_complete_footprint_counts_nested_roots_once_and_does_not_follow_links(tmp_path):
    service = tmp_path / "service"
    release = service / "releases/one"
    release.mkdir(parents=True)
    artifact = release / "runtime"
    artifact.write_bytes(b"x" * 9000)
    (service / "app").symlink_to(release, target_is_directory=True)
    os.link(artifact, service / "second-name")
    (service / "unknown-extra-file").write_bytes(b"x" * 7)
    result = usage({"releases": service / "releases", "other": service})
    assert result["fileBytes"] == 9007
    assert result["files"] == 2
    assert result["categories"]["other"]["fileBytes"] == 7
    assert result["allocatedBytes"] >= result["fileBytes"]


def test_cache_budget_never_touches_broker_records_and_protects_recent_files(tmp_path):
    cache = tmp_path / "research-cache/disclosures"
    cache.mkdir(parents=True)
    old = cache / ("a" * 64 + ".html")
    recent = cache / ("b" * 64 + ".json")
    unknown = cache / "original-broker-record.json"
    for path in (old, recent, unknown):
        path.write_bytes(b"x" * 20000)
    now = datetime.now(UTC)
    os.utime(old, (0, (now - timedelta(days=3)).timestamp()))
    report = bound_filing_cache(tmp_path, budget=15000, now=now)
    assert report["removedFiles"] == 1
    assert not old.exists()
    assert recent.exists() and unknown.exists()
    assert report["pending"] is True


def test_daily_capacity_history_is_bounded_and_predicts_growth_without_deleting_state(tmp_path):
    service = tmp_path / "service"
    state = tmp_path / "state"
    service.mkdir()
    state.mkdir()
    record = state / "financial-record"
    start = datetime(2026, 1, 1, tzinfo=UTC)
    for day in range(100):
        record.write_bytes(b"x" * (day + 1) * 1000)
        report = write_budget_report(
            service,
            state,
            tmp_path / "logs",
            tmp_path / "legacy",
            budget=120000,
            now=start + timedelta(days=day),
        )
    assert report["dailyGrowthBytes"] > 0
    assert report["projectedDaysRemaining"] is not None
    assert (
        len(json.loads((service / "maintenance/storage-budget/history.json").read_text())["days"])
        == 90
    )
    assert record.stat().st_size == 100000
    assert report["status"] in {"warning", "critical", "over-budget"}


def test_daily_incremental_history_and_backups_remain_independent_and_lossless(tmp_path):
    import sqlite3

    from trading_max.backup_repository import BackupRepository
    from trading_max.infrastructure import ContentAddressedArtifactStore, SnapshotStore

    state = tmp_path / "state"
    state.mkdir()
    with sqlite3.connect(state / "trading_max.db") as db:
        db.execute("CREATE TABLE observations(value INTEGER)")
    writer = ContentAddressedArtifactStore(
        state / "artifacts", history_mode="chunked", storage_mode="chunked"
    )
    snapshots = SnapshotStore(state, artifacts=writer)
    repository = BackupRepository(tmp_path / "recovery")
    start = datetime(2026, 1, 1, tzinfo=UTC)
    points = [
        {
            "bucket_at": (start + timedelta(minutes=10 * i)).isoformat(),
            "value": i / 7,
            "source_artifact_ids": ["synthetic-" + str(i)],
        }
        for i in range(1000)
    ]
    logical = 0
    saved = []
    for day in range(35):
        points.append(
            {"bucket_at": (start + timedelta(days=10 + day)).isoformat(), "value": day / 3}
        )
        item = writer.put_json(key="account/nav/valuation_history.json", payload={"points": points})
        snapshots.publish(scope="accounts", source="synthetic-daily", artifacts=[item])
        logical += writer.logical_size(item.ref.artifact_id)
        saved.append((repository.create(state)["id"], item.ref.artifact_id, len(points)))
    for index in (0, -1):
        backup, artifact_id, count = saved[index]
        restored = tmp_path / ("restored-" + str(index))
        repository.restore(backup, restored)
        recovered = ContentAddressedArtifactStore(restored / "artifacts")
        assert len(recovered.get_json(artifact_id).payload["points"]) == count
        assert recovered.content_bytes(artifact_id) == writer.content_bytes(artifact_id)
    live = usage({"state": state})
    backup_usage = usage({"recovery": repository.root})
    assert live["fileBytes"] < logical / 2
    assert backup_usage["fileBytes"] < logical / 2
