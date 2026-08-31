from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

from services.api.trading_max_api.artifacts import ArtifactStore


def _publish(store: ArtifactStore, when: datetime) -> str:
    artifact = store.immutable_artifacts.put_json(
        key="research/technical.json",
        payload={"as_of": when.date().isoformat(), "rows": []},
        kind="technical",
        producer_version="fixture-v1",
    )
    return store.immutable_snapshots.publish(
        scope="research",
        source="fixture",
        artifacts=[artifact],
        created_at=when,
    ).manifest.run_id


def test_prune_keeps_everything_below_the_recent_limit(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    for index in range(5):
        _publish(store, datetime(2026, 8, index + 1, tzinfo=UTC))

    assert store.prune_snapshots(keep_recent=10) == []
    assert len(list(store.immutable_snapshots.snapshots_root.iterdir())) == 5


def test_prune_removes_old_snapshots_beyond_the_window(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    for day in range(1, 11):
        _publish(store, datetime(2026, 8, day, tzinfo=UTC))

    removed = store.prune_snapshots(keep_recent=3, keep_monthly=0)

    survivors = [item.manifest.run_id for item in store.immutable_snapshots.list(limit=20)]
    assert len(survivors) == 3
    assert len(removed) == 7


def test_prune_retains_one_anchor_per_month(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    for month in (5, 6, 7):
        for day in (1, 2, 3):
            _publish(store, datetime(2026, month, day, tzinfo=UTC))

    store.prune_snapshots(keep_recent=2, keep_monthly=12)

    survivors = {item.manifest.run_id for item in store.immutable_snapshots.list(limit=20)}
    assert any(run_id.startswith("20260501") for run_id in survivors)
    assert any(run_id.startswith("20260601") for run_id in survivors)
    assert any(run_id.startswith("202607") for run_id in survivors)


def test_prune_never_removes_the_published_latest_snapshot(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "runtime")
    run_ids = [_publish(store, datetime(2026, 8, day, tzinfo=UTC)) for day in range(1, 9)]
    pinned = run_ids[0]
    # The latest pointer normally points at the newest run. This test verifies
    # the explicit latest protection independently of recent ordering.
    latest = store.immutable_snapshots.latest()
    assert latest is not None
    pinned_manifest = store.immutable_snapshots.load(pinned).manifest
    manifest_hash = hashlib.sha256(
        json.dumps(
            pinned_manifest.model_dump(mode="json", by_alias=False),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    pointer = store.immutable_snapshots.latest_path
    pointer.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": pinned,
                "manifest_sha256": manifest_hash,
                "published_at": pinned_manifest.created_at.isoformat(),
            }
        ),
        encoding="utf-8",
    )

    store.prune_snapshots(keep_recent=2, keep_monthly=0)

    assert (store.immutable_snapshots.snapshots_root / pinned).is_dir()
