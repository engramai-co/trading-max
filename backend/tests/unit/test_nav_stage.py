from __future__ import annotations

from pathlib import Path

from trading_max.application.nav_stages import AccountIntradayNavStage, AccountNavStage
from trading_max.application.stages import StageContext
from trading_max.infrastructure import (
    ContentAddressedArtifactStore,
    SnapshotStore,
)


def test_one_point_legacy_nav_requires_reconstruction() -> None:
    one_point = b"Date,SyntheticNAVGBP,DailyReturn,TWRWealth\n2026-08-15,100,,\n"
    established = one_point + b"2026-08-16,101,0.01,1.01\n"

    assert AccountNavStage._needs_reconstruction(None)
    assert AccountNavStage._needs_reconstruction(one_point)
    assert not AccountNavStage._needs_reconstruction(established)


def test_ineligible_old_reconstruction_is_retried_after_adapter_upgrade() -> None:
    old = (
        b"Date,SyntheticNAVGBP,DailyReturn,TWRWealth,ValuationSource,PerformanceStatus\n"
        b"2026-08-14,100,,,synthetic_reconstruction,missing_dated_cash_events\n"
        b"2026-08-15,101,,,broker_native,missing_dated_cash_events\n"
    )
    eligible = old.replace(b"missing_dated_cash_events", b"eligible")

    assert AccountNavStage._needs_reconstruction(old)
    assert not AccountNavStage._needs_reconstruction(eligible)
    assert AccountNavStage._needs_reconstruction(eligible, producer_version="nav-v3")
    assert not AccountNavStage._needs_reconstruction(eligible, producer_version="nav-v4")


def test_account_nav_stage_appends_current_account_to_both_histories(
    tmp_path: Path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    nav = (
        b"Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
        b"WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
        b"2026-08-01,10,90,100,0,0,,,\n"
    )
    refs = [
        artifacts.put_bytes(
            key=f"account/nav/daily_nav_{code.lower()}.csv",
            content=nav,
            kind="nav_series",
            media_type="text/csv",
            producer_version="fixture",
        )
        for code in ("A", "B")
    ]
    SnapshotStore(tmp_path).publish(
        scope="accounts",
        source="fixture",
        artifacts=refs,
    )
    account_refs = []
    for profile in ("invest", "isa"):
        account = artifacts.put_json(
            key=f"account/{profile}.json",
            payload={
                "fetched_at": "2026-08-02T20:00:00Z",
                "total_value_gbp": 110,
                "cash_gbp": 12,
                "investments_value_gbp": 98,
                "positions": [],
            },
            kind="account",
            producer_version="fixture",
        )
        account_refs.append(account.ref.artifact_id)

    result = AccountNavStage(
        artifacts,
        SnapshotStore(tmp_path),
    ).run(
        StageContext(
            job_id="job",
            scope="accounts",
            upstream_artifact_ids=tuple(account_refs),
        )
    )

    assert len(result.artifacts) == 2
    for ref in result.artifacts:
        stored = artifacts.get_bytes(ref.artifact_id)
        assert "2026-08-02" in stored.path.read_text(encoding="utf-8")
        assert "0.00000000" in stored.path.read_text(encoding="utf-8")


def test_account_nav_stage_initializes_first_verified_broker_baseline(
    tmp_path: Path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    accounts = []
    for profile in ("invest", "isa"):
        stored = artifacts.put_json(
            key=f"account/{profile}.json",
            payload={
                "fetched_at": "2026-08-02T20:00:00Z",
                "total_value_gbp": 110,
                "cash_gbp": 12,
                "investments_value_gbp": 98,
            },
            kind="account",
            producer_version="fixture",
        )
        accounts.append(stored.ref.artifact_id)

    result = AccountNavStage(artifacts, SnapshotStore(tmp_path)).run(
        StageContext(
            job_id="job",
            scope="accounts",
            upstream_artifact_ids=tuple(accounts),
        )
    )

    assert len(result.artifacts) == 2
    assert len(result.warnings) == 2
    for ref in result.artifacts:
        stored = artifacts.get_bytes(ref.artifact_id)
        text = stored.path.read_text(encoding="utf-8")
        assert "2026-08-02" in text
        assert ",110.00000000," in text
        assert ref.quality.status == "warning"
        assert ref.dependency_artifact_ids == [
            next(
                artifact_id
                for artifact_id in accounts
                if artifacts.get_ref(artifact_id).key.endswith(
                    "invest.json" if ref.key.endswith("_a.csv") else "isa.json"
                )
            )
        ]


def test_account_nav_stage_rejects_a_partial_existing_ledger(tmp_path: Path) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    nav = artifacts.put_bytes(
        key="account/nav/daily_nav_a.csv",
        content=b"Date,SyntheticNAVGBP\n2026-08-01,100\n",
        kind="nav_series",
        media_type="text/csv",
        producer_version="fixture",
    )
    snapshots = SnapshotStore(tmp_path)
    snapshots.publish(scope="accounts", source="fixture", artifacts=[nav])
    accounts = []
    for profile in ("invest", "isa"):
        stored = artifacts.put_json(
            key=f"account/{profile}.json",
            payload={
                "fetched_at": "2026-08-02T20:00:00Z",
                "total_value_gbp": 110,
                "cash_gbp": 12,
                "investments_value_gbp": 98,
            },
            kind="account",
            producer_version="fixture",
        )
        accounts.append(stored.ref.artifact_id)

    try:
        AccountNavStage(artifacts, snapshots).run(
            StageContext(
                job_id="job",
                scope="accounts",
                upstream_artifact_ids=tuple(accounts),
            )
        )
    except Exception as exc:
        assert getattr(exc, "code", None) == "account.nav_missing"
        assert "incomplete" in str(exc)
    else:
        raise AssertionError("a partial trusted NAV ledger should fail loudly")


def test_intraday_nav_stage_publishes_a_rolling_anchor_without_daily_nav(
    tmp_path: Path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    daily = artifacts.put_bytes(
        key="account/nav/daily_nav_a.csv",
        content=b"Date,SyntheticNAVGBP\n2026-08-01,100\n",
        kind="nav_series",
        media_type="text/csv",
        producer_version="fixture",
    )
    SnapshotStore(tmp_path).publish(
        scope="accounts",
        source="fixture",
        artifacts=[daily],
    )
    account_refs = []
    for profile, value in (("invest", 110), ("isa", 210)):
        stored = artifacts.put_json(
            key=f"account/intraday/{profile}.json",
            payload={
                "fetched_at": "2026-08-02T20:00:01Z",
                "total_value_gbp": value,
                "cash_gbp": 12,
            },
            kind="account",
            producer_version="fixture",
        )
        account_refs.append(stored.ref.artifact_id)

    result = AccountIntradayNavStage(
        artifacts,
        SnapshotStore(tmp_path),
    ).run(
        StageContext(
            job_id="intraday-job",
            scope="intraday",
            trigger="intraday",
            upstream_artifact_ids=tuple(account_refs),
        )
    )

    assert len(result.artifacts) == 1
    anchor = artifacts.get_json(result.artifacts[0].artifact_id).payload
    assert len(anchor["points"]) == 1
    assert anchor["points"][0]["total_value_gbp"] == 320
    assert anchor["points"][0]["flow_status"] == "unverified"


def test_three_intraday_publications_keep_history_and_previous_artifacts(
    tmp_path: Path,
) -> None:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    research = artifacts.put_json(
        key="research/technical.json",
        payload={"as_of": "2026-08-01", "rows": []},
        kind="technical",
        producer_version="fixture",
    )
    SnapshotStore(tmp_path).publish(
        scope="all",
        source="fixture",
        artifacts=[research],
    )
    snapshot_store = SnapshotStore(tmp_path)
    for index in range(3):
        account_refs = []
        timestamp = f"2026-08-02T20:{index * 10:02d}:01Z"
        for profile, value in (("invest", 110 + index), ("isa", 210 + index)):
            stored = artifacts.put_json(
                key=f"account/{profile}.json",
                payload={
                    "fetched_at": timestamp,
                    "total_value_gbp": value,
                    "cash_gbp": 12,
                },
                kind="account",
                producer_version="fixture",
            )
            account_refs.append(stored.ref)
        result = AccountIntradayNavStage(
            artifacts,
            snapshot_store,
        ).run(
            StageContext(
                job_id=f"intraday-{index}",
                scope="intraday",
                trigger="intraday",
                upstream_artifact_ids=tuple(ref.artifact_id for ref in account_refs),
            )
        )
        previous = snapshot_store.latest()
        assert previous is not None
        refs = {ref.key: ref for ref in previous.manifest.artifacts}
        refs.update({ref.key: ref for ref in account_refs})
        refs.update({ref.key: ref for ref in result.artifacts})
        snapshot_store.publish(
            scope="intraday",
            source="fixture",
            artifacts=list(refs.values()),
        )

    latest = snapshot_store.latest()
    assert latest is not None
    assert any(ref.key == "research/technical.json" for ref in latest.manifest.artifacts)
    anchor_ref = next(
        ref for ref in latest.manifest.artifacts if ref.key == "account/nav/intraday_anchors.json"
    )
    anchor = artifacts.get_json(anchor_ref.artifact_id).payload
    assert len(anchor["points"]) == 3
